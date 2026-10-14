import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ApprovalManager,
  MAX_DENIALS_PER_RUN,
  PermissionDeniedError,
  approvalDescription,
  approvalRiskLabel,
  riskLabel,
} from "../src/approval.js";
import { createTheme } from "../src/ui/theme.js";
import type { ApprovalDecision, ApprovalRequest } from "../src/approval.js";
import {
  RuleStore,
  approvalSubjectDisplay,
  rulesPath,
  shellApprovalSubject,
} from "../src/rules.js";
import type { ApprovalMode, ToolCallPreview } from "../src/types.js";

interface Harness {
  approvals: ApprovalManager;
  /** Every preview the manager sent to the UI, in order. */
  asked: ToolCallPreview[];
}

async function tempAppHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "routercode-approval-test-"));
}

function harness(
  mode: ApprovalMode,
  answer: boolean | (() => boolean),
  options?: { ruleStore?: RuleStore; workspace?: string },
): Harness {
  const approvals = new ApprovalManager(mode, options);
  const asked: ToolCallPreview[] = [];
  approvals.setPromptHandler(async (preview) => {
    asked.push(preview);
    const accepted = typeof answer === "function" ? answer() : answer;
    return { accepted };
  });
  return { approvals, asked };
}

function harnessWithDecisions(mode: ApprovalMode, decisions: ApprovalDecision[]): Harness {
  const approvals = new ApprovalManager(mode);
  const asked: ToolCallPreview[] = [];
  let index = 0;
  approvals.setPromptHandler(async (preview) => {
    asked.push(preview);
    const decision = decisions[index] ?? decisions.at(-1)!;
    index += 1;
    return decision;
  });
  return { approvals, asked };
}

const edit: ApprovalRequest = {
  name: "write_file",
  risk: "edit",
  summary: "src/index.ts überschreiben",
};
const shell: ApprovalRequest = {
  name: "run_command",
  risk: "shell",
  summary: "npm test ausführen",
};
const plainRead: ApprovalRequest = {
  name: "read_file",
  risk: "read",
  summary: "src/index.ts lesen",
};
const secretRead: ApprovalRequest = {
  name: "read_file",
  risk: "secret-read",
  summary: "Vertrauliche Datei lesen: .env",
  policyRule: "dotenv",
};
const protectedWrite: ApprovalRequest = {
  name: "write_file",
  risk: "edit",
  summary: ".git/config überschreiben",
  alwaysAsk: true,
  policyRule: "git-metadata",
};

function localShellSubject(command: string) {
  return shellApprovalSubject({
    platform: "linux",
    executable: "/bin/sh",
    mode: ["-c"],
    cwd: ".",
    command,
  });
}

test("read-only blocks writes and shell commands", async () => {
  const { approvals, asked } = harness("read-only", true);
  await approvals.authorize(plainRead);
  await assert.rejects(approvals.authorize(edit), PermissionDeniedError);
  await assert.rejects(approvals.authorize(shell), PermissionDeniedError);
  await assert.rejects(approvals.authorize(protectedWrite), PermissionDeniedError);
  assert.deepEqual(asked, [], "read-only darf für blockierte Aktionen nicht fragen");
});

test('the planner fence overrides saved allows until explicitly released',async()=>{
  const appHome=await tempAppHome();
  try{
    const ruleStore=await RuleStore.load(appHome),subject=localShellSubject('npm test');
    await ruleStore.remember({workspace:'/ws',tool:'run_command',subject,decision:'allow'});
    const {approvals,asked}=harness('allow-all',true,{ruleStore,workspace:'/ws'});
    const request={...shell,subject};
    approvals.setReadOnlyExecutionFence(true);
    await approvals.authorize(plainRead);
    for(const action of [request,edit,secretRead])await assert.rejects(approvals.authorize(action),PermissionDeniedError);
    assert.equal(asked.length,0);
    approvals.setReadOnlyExecutionFence(false);
    await approvals.authorize(request);
  }finally{await rm(appHome,{recursive:true,force:true});}
});

test("read-only still asks before a secret is read", async () => {
  const denying = harness("read-only", false);
  await assert.rejects(
    denying.approvals.authorize(secretRead),
    PermissionDeniedError,
  );
  assert.equal(denying.asked.length, 1);
  assert.match(
    denying.asked[0]?.details ?? "",
    /Confidential path/,
    "der Nutzer muss erfahren, warum ein Lesezugriff nachfragt",
  );

  const accepting = harness("read-only", true);
  await accepting.approvals.authorize(secretRead);
  assert.equal(accepting.asked.length, 1);
});

test("a rejection by the user is never ignored", async () => {
  for (const mode of ["ask", "auto-edit", "allow-all"] as const) {
    const { approvals, asked } = harness(mode, false);
    await assert.rejects(
      approvals.authorize(protectedWrite),
      PermissionDeniedError,
      `${mode}: Ablehnung wurde verschluckt`,
    );
    assert.equal(asked.length, 1, `${mode}: es wurde gar nicht gefragt`);
  }

  const asking = harness("ask", false);
  await assert.rejects(asking.approvals.authorize(edit), PermissionDeniedError);
  await assert.rejects(asking.approvals.authorize(shell), PermissionDeniedError);
  assert.equal(asking.asked.length, 2);
});

test("ask mode delegates the decision and forwards the preview", async () => {
  const { approvals, asked } = harness("ask", true);
  await approvals.authorize(shell);
  await approvals.authorize(edit);
  assert.deepEqual(
    asked.map((preview) => preview.summary),
    ["npm test ausführen", "src/index.ts überschreiben"],
  );
  assert.deepEqual(
    asked.map((preview) => preview.risk),
    ["shell", "edit"],
  );
});

test("auto-edit never waves shell commands through", async () => {
  const { approvals, asked } = harness("auto-edit", false);
  await assert.rejects(approvals.authorize(shell), PermissionDeniedError);
  assert.equal(asked.length, 1, "auto-edit muss vor Shell-Befehlen fragen");

  const accepting = harness("auto-edit", true);
  await accepting.approvals.authorize(edit);
  assert.equal(accepting.asked.length, 0, "auto-edit fragt bei normalen Edits nicht");
});

// ---------------------------------------------------------------------------
// remote-shell (ssh_command) — its own risk level, see approval.ts's #decide
// ---------------------------------------------------------------------------

const remoteShell: ApprovalRequest = {
  name: "ssh_command",
  risk: "remote-shell",
  subject: { kind: "ssh-command", host: "vps", command: "systemctl restart nginx" },
  summary: "SSH-ZIEL: VPS — systemctl restart nginx",
};

test("remote-shell always asks — in ask AND in auto-edit (a naive 'edit'-like allow would be red here)", async () => {
  for (const mode of ["ask", "auto-edit"] as const) {
    const { approvals, asked } = harness(mode, true);
    await approvals.authorize(remoteShell);
    assert.equal(asked.length, 1, `${mode}: ssh_command muss trotzdem fragen`);
  }
});

test("remote-shell asks even in read-only, unlike plain shell which is denied outright", async () => {
  const { approvals, asked } = harness("read-only", true);
  await approvals.authorize(remoteShell);
  assert.equal(asked.length, 1);
});

test("remote-shell is the one thing allow-all is allowed to wave through", async () => {
  const { approvals, asked } = harness("allow-all", true);
  await approvals.authorize(remoteShell);
  assert.equal(asked.length, 0);
});

test("remote-shell preview always names the host, in caps, regardless of the caller's summary wording", async () => {
  const { approvals, asked } = harness("ask", true);
  await approvals.authorize({ ...remoteShell, summary: "ein Befehl", details: undefined });
  assert.match(asked[0]?.details ?? "", /SSH TARGET \(NOT LOCAL\): VPS/);
});

test("a remembered rule for one SSH host never applies to another", async () => {
  const appHome = await tempAppHome();
  try {
    const ruleStore = await RuleStore.load(appHome);
    const approvals = new ApprovalManager("ask", { ruleStore, workspace: "/ws" });
    approvals.setPromptHandler(async () => ({ accepted: true, remember: "allow" }));
    await approvals.authorize({
      name: "ssh_command",
      risk: "remote-shell",
      subject: { kind: "ssh-command", host: "vps", command: "uptime" },
      summary: "SSH-ZIEL: VPS — uptime",
    });

    // Same command, different host: must still ask, the remembered rule is
    // scoped to "vps", not to the bare command.
    const asked: ToolCallPreview[] = [];
    approvals.setPromptHandler(async (preview) => {
      asked.push(preview);
      return { accepted: true };
    });
    await approvals.authorize({
      name: "ssh_command",
      risk: "remote-shell",
      subject: { kind: "ssh-command", host: "produktion", command: "uptime" },
      summary: "SSH-ZIEL: PRODUKTION — uptime",
    });
    assert.equal(asked.length, 1, "eine vps-Regel darf nicht für produktion gelten");

    // The original host still skips the question.
    const askedAgain: ToolCallPreview[] = [];
    approvals.setPromptHandler(async (preview) => {
      askedAgain.push(preview);
      return { accepted: true };
    });
    await approvals.authorize({
      name: "ssh_command",
      risk: "remote-shell",
      subject: { kind: "ssh-command", host: "vps", command: "uptime" },
      summary: "SSH-ZIEL: VPS — uptime",
    });
    assert.equal(askedAgain.length, 0, "die vps-Regel muss weiterhin greifen");
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("allow-all still stops at protected paths", async () => {
  const { approvals, asked } = harness("allow-all", true);
  await approvals.authorize(edit);
  await approvals.authorize(shell);
  assert.equal(asked.length, 0);

  await approvals.authorize(protectedWrite);
  assert.equal(asked.length, 1, "die Deny-Liste wurde nicht angewandt");
  assert.match(asked[0]?.details ?? "", /git-metadata/);
});

test("a tool is locked after repeated rejections in the same run", async () => {
  const { approvals, asked } = harness("ask", false);
  approvals.beginRun();

  for (let attempt = 1; attempt < MAX_DENIALS_PER_RUN; attempt += 1) {
    await assert.rejects(approvals.authorize(shell), /denied/);
  }
  await assert.rejects(approvals.authorize(shell), /locked/);
  assert.equal(asked.length, MAX_DENIALS_PER_RUN);
  assert.deepEqual(approvals.lockedTools, ["run_command"]);

  // Further attempts do not even reach the user any more.
  await assert.rejects(approvals.authorize(shell), /locked/);
  assert.equal(asked.length, MAX_DENIALS_PER_RUN);

  // Other tools keep their own budget.
  const other = await approvals
    .authorize(edit)
    .then(() => "erlaubt")
    .catch((error: unknown) => (error as Error).message);
  assert.match(String(other), /denied/);

  approvals.beginRun();
  assert.deepEqual(approvals.lockedTools, []);
  await assert.rejects(approvals.authorize(shell), /denied/);
});

test("mode descriptions and risk labels stay honest", () => {
  assert.match(approvalDescription("read-only"), /Read only/);
  assert.match(approvalDescription("ask"), /ask/i);
  assert.match(approvalDescription("auto-edit"), /File changes happen automatically/);
  assert.match(approvalDescription("auto-edit"), /Protected paths/);
  assert.match(approvalDescription("allow-all"), /Dangerous/);

  assert.equal(approvalRiskLabel("secret-read"), "SECRET");
  assert.equal(approvalRiskLabel("shell"), "SHELL");
  assert.equal(approvalRiskLabel("remote-shell"), "SSH");
});

// ---------------------------------------------------------------------------
// K6 — remembered rules
// ---------------------------------------------------------------------------

const npmTest: ApprovalRequest = {
  name: "run_command",
  risk: "shell",
  summary: "npm test ausführen",
  subject: localShellSubject("npm test"),
};
const npmPublish: ApprovalRequest = {
  name: "run_command",
  risk: "shell",
  summary: "npm publish ausführen",
  subject: localShellSubject("npm publish"),
};

test("K6.1 — ask + abgelehnt wirft PermissionDeniedError mit der Begründung", async () => {
  const { approvals } = harnessWithDecisions("ask", [
    { accepted: false, reason: "Testet gerade produktive Daten, zu riskant." },
  ]);
  await assert.rejects(approvals.authorize(shell), (error: unknown) => {
    assert.ok(error instanceof PermissionDeniedError);
    assert.match(
      (error as Error).message,
      /Testet gerade produktive Daten, zu riskant\./,
    );
    return true;
  });
});

test("K6.2 — gemerkte allow-Regel überspringt die Nachfrage, ein anderer Befehl fragt weiter", async () => {
  const appHome = await tempAppHome();
  try {
    const ruleStore = await RuleStore.load(appHome);
    const asked: ToolCallPreview[] = [];
    const approvals = new ApprovalManager("ask", { ruleStore, workspace: "/ws" });

    approvals.setPromptHandler(async (preview) => {
      asked.push(preview);
      return { accepted: true, remember: "allow" };
    });
    await approvals.authorize(npmTest);
    assert.equal(asked.length, 1);

    // Second call with the same exact subject: no question asked.
    await approvals.authorize(npmTest);
    assert.equal(asked.length, 1, "eine gemerkte Regel darf kein zweites Mal fragen");

    // A different subject under the same tool still asks.
    approvals.setPromptHandler(async (preview) => {
      asked.push(preview);
      return { accepted: true };
    });
    await approvals.authorize(npmPublish);
    assert.equal(asked.length, 2, "npm publish ist keine gemerkte Regel und muss fragen");
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("K6.3 — gemerkte deny-Regel schlägt allow-all", async () => {
  const appHome = await tempAppHome();
  try {
    const ruleStore = await RuleStore.load(appHome);
    await ruleStore.remember({
      workspace: "/ws",
      tool: "run_command",
      subject: localShellSubject("rm -rf build"),
      decision: "deny",
    });
    const asked: ToolCallPreview[] = [];
    const approvals = new ApprovalManager("allow-all", { ruleStore, workspace: "/ws" });
    approvals.setPromptHandler(async (preview) => {
      asked.push(preview);
      return { accepted: true };
    });
    const rmRequest: ApprovalRequest = {
      name: "run_command",
      risk: "shell",
      summary: "rm -rf build ausführen",
      subject: localShellSubject("rm -rf build"),
    };
    await assert.rejects(approvals.authorize(rmRequest), PermissionDeniedError);
    assert.equal(asked.length, 0, "eine deny-Regel darf nicht einmal fragen");
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("K6.4 — gemerkte allow-Regel hebt alwaysAsk (policy.ts) niemals auf", async () => {
  const appHome = await tempAppHome();
  try {
    const ruleStore = await RuleStore.load(appHome);
    await ruleStore.remember({
      workspace: "/ws",
      tool: "write_file",
      subject: { kind: "selected-path", path: ".git/config" },
      decision: "allow",
    });
    const asked: ToolCallPreview[] = [];
    const approvals = new ApprovalManager("allow-all", { ruleStore, workspace: "/ws" });
    approvals.setPromptHandler(async (preview) => {
      asked.push(preview);
      return { accepted: true };
    });
    const gitConfigWrite: ApprovalRequest = {
      name: "write_file",
      risk: "edit",
      summary: ".git/config überschreiben",
      subject: { kind: "selected-path", path: ".git/config" },
      alwaysAsk: true,
      policyRule: "git-metadata",
    };
    await approvals.authorize(gitConfigWrite);
    assert.equal(
      asked.length,
      1,
      "ein geschützter Pfad muss trotz gemerkter allow-Regel fragen",
    );
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("K6.5 — RuleStore schreibt mit Modus 0600 und übersteht einen Neustart", async () => {
  const appHome = await tempAppHome();
  try {
    const store = await RuleStore.load(appHome);
    await store.remember({
      workspace: "/ws",
      tool: "run_command",
      subject: localShellSubject("npm test"),
      decision: "allow",
    });

    const info = await stat(rulesPath(appHome));
    // NTFS has no POSIX mode bits — the mode is asserted on POSIX only;
    // the persistence assertions below still run on Windows.
    if (process.platform !== "win32") {
      assert.equal(info.mode & 0o777, 0o600);
    }

    const reopened = await RuleStore.load(appHome);
    assert.equal(reopened.decide("/ws", "run_command", localShellSubject("npm test")), "allow");
    assert.equal(reopened.list("/ws").length, 1);

    const raw = await readFile(rulesPath(appHome), "utf8");
    assert.match(raw, /"decision": "allow"/);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("remembering is unavailable without a safe derived subject and a forged remember result is ignored", async () => {
  const appHome = await tempAppHome();
  try {
    const ruleStore = await RuleStore.load(appHome);
    const approvals = new ApprovalManager("ask", { ruleStore, workspace: "/ws" });
    const previews: ToolCallPreview[] = [];
    approvals.setPromptHandler(async (preview) => {
      previews.push(preview);
      return { accepted: true, remember: "allow" };
    });

    await approvals.authorize({ name: "custom_action", risk: "shell", summary: "Aktion ohne Subject" });
    await approvals.authorize({ name: "custom_action", risk: "shell", summary: "Aktion ohne Subject" });

    assert.equal(previews.length, 2, "ohne Subject darf keine Regel gespeichert werden");
    assert.equal(previews[0]?.rememberAvailable, false);
    assert.equal(previews[0]?.subject, undefined);
    assert.deepEqual(ruleStore.list("/ws"), []);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("rememberable false keeps the exact subject visible but ignores and cannot change stored rules", async () => {
  const appHome = await tempAppHome();
  try {
    const subject = localShellSubject("git diff --");
    const ruleStore = await RuleStore.load(appHome);
    await ruleStore.remember({
      workspace: "/ws",
      tool: "git_diff",
      subject,
      decision: "allow",
    });
    const before = await readFile(rulesPath(appHome), "utf8");
    const approvals = new ApprovalManager("ask", { ruleStore, workspace: "/ws" });
    const previews: ToolCallPreview[] = [];
    approvals.setPromptHandler(async (preview) => {
      previews.push(preview);
      return { accepted: true, remember: "deny" };
    });

    await approvals.authorize({
      name: "git_diff",
      risk: "shell",
      summary: "Hardened Git diff",
      subject,
      rememberable: false,
    });

    assert.equal(previews.length, 1, "stored allow must not bypass a non-rememberable prompt");
    assert.equal(previews[0]?.subject, approvalSubjectDisplay(subject));
    assert.equal(previews[0]?.rememberAvailable, false);
    assert.equal(await readFile(rulesPath(appHome), "utf8"), before);
    assert.equal(ruleStore.decide("/ws", "git_diff", subject), "allow");
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("the preview shows the exact canonical subject used by policy before remember is offered", async () => {
  const subject = localShellSubject("printf '  α  ' | sed 's/α/β/'");
  const { approvals, asked } = harness("ask", true);
  await approvals.authorize({
    name: "run_command",
    risk: "shell",
    summary: "Unicode ausgeben",
    subject,
  });
  assert.equal(asked[0]?.subject, approvalSubjectDisplay(subject));
  assert.equal(asked[0]?.rememberAvailable, true);
});

// F5 (V3 audit principle 3): approval.ts's per-file spot pin + NO_COLOR/
// level-0 parity check — `riskLabel` is exported (see its doc) purely so
// this can call the real migrated function directly with an explicit
// `Theme`, without mocking `console.log`/`confirm` to reach it through
// `authorize()`. Deterministic (no env vars, no chalk auto-detect caching
// concerns): passes a level 1 and a level 0 theme straight in.
test("riskLabel (F5 pin): every risk keeps its exact bracketed text at level 0, and colours it at level 1", () => {
  const plain = createTheme({ level: 0 });
  const colored = createTheme({ level: 1 });
  const esc = String.fromCharCode(27);

  // Ruling 1's default mapping: red/yellow/green survive unchanged in
  // meaning (danger/warn/ok).
  assert.equal(riskLabel("shell", plain), "[SHELL]");
  assert.equal(riskLabel("shell", colored), `${esc}[31m[SHELL]${esc}[39m`);
  assert.equal(riskLabel("edit", plain), "[EDIT]");
  assert.equal(riskLabel("edit", colored), `${esc}[33m[EDIT]${esc}[39m`);
  assert.equal(riskLabel("read", plain), "[READ]");
  assert.equal(riskLabel("read", colored), `${esc}[32m[READ]${esc}[39m`);

  // Ruling 1's documented magenta judgment: secret-read is a confidentiality
  // caution, not a destructive action — `warn`, not `danger`.
  assert.equal(riskLabel("secret-read", plain), "[SECRET]");
  assert.equal(riskLabel("secret-read", colored), `${esc}[33m[SECRET]${esc}[39m`);

  // Ruling 2: the two background-colour banners map to `inverse` (+bold) —
  // the one sanctioned high-attention treatment — and gain brackets so the
  // safety signal survives once inverse degrades to plain text at level 0.
  assert.equal(riskLabel("remote-shell", plain), "[SSH]");
  assert.equal(riskLabel("network-fetch", plain), "[NETWORK]");
  const coloredSsh = riskLabel("remote-shell", colored);
  assert.equal(coloredSsh.includes(`${esc}[7m`), true, "remote-shell must use the inverse role");
  assert.equal(coloredSsh.includes(`${esc}[1m`), true, "remote-shell keeps its bold emphasis");
  assert.equal(coloredSsh.includes("[SSH]"), true);
  const coloredNetwork = riskLabel("network-fetch", colored);
  assert.equal(coloredNetwork.includes(`${esc}[7m`), true, "network-fetch must use the inverse role");
  assert.equal(coloredNetwork.includes("[NETWORK]"), true);
});
