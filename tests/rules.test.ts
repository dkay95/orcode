import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  RuleStore,
  approvalSubjectDisplay,
  approvalSubjectFingerprint,
  canonicalWorkspaceRelativeCwd,
  processApprovalSubject,
  rulesPath,
  shellApprovalSubject,
} from "../src/rules.js";
import type { ApprovalSubject } from "../src/types.js";

async function tempAppHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "routercode-rules-test-"));
}

const POSIX_BASE = shellApprovalSubject({
  platform: "linux",
  executable: "/bin/sh",
  mode: ["-c"],
  cwd: ".",
  command: "printf '%s' \"$NAME\" | sed 's/a/b/' > out.txt && echo fertig",
});

test("shell subjects preserve every byte except CRLF-to-LF and every tuple component", () => {
  const base = approvalSubjectFingerprint(POSIX_BASE);
  const commandVariants = [
    " printf '%s' \"$NAME\" | sed 's/a/b/' > out.txt && echo fertig",
    "printf  '%s' \"$NAME\" | sed 's/a/b/' > out.txt && echo fertig",
    "printf '%s' '$NAME' | sed 's/a/b/' > out.txt && echo fertig",
    "printf '%s' \"$NAME\" > out.txt | sed 's/a/b/' && echo fertig",
    "printf '%s' \"$NAME\" | sed 's/a/b/' >> out.txt && echo fertig",
    "printf '%s' \"$NAME\" | sed 's/a/b/' > out.txt ; echo fertig",
    "NAME=anders printf '%s' \"$NAME\" | sed 's/a/b/' > out.txt && echo fertig",
    "printf '%s' \"${NAME}\" | sed 's/a/b/' > out.txt && echo fertig",
    "printf '%s' \"$NAME\" | sed 's/a/b/' > out.txt && echo fértig",
  ];
  for (const command of commandVariants) {
    assert.notEqual(
      approvalSubjectFingerprint(shellApprovalSubject({ ...POSIX_BASE, command })),
      base,
      command,
    );
  }

  for (const changed of [
    shellApprovalSubject({ ...POSIX_BASE, platform: "darwin" }),
    shellApprovalSubject({ ...POSIX_BASE, executable: "/bin/bash" }),
    shellApprovalSubject({ ...POSIX_BASE, mode: ["--noprofile", "--norc", "-c"] }),
    shellApprovalSubject({ ...POSIX_BASE, cwd: "packages/app" }),
  ]) {
    assert.notEqual(approvalSubjectFingerprint(changed), base);
  }

  const lf = shellApprovalSubject({ ...POSIX_BASE, command: "echo eins\necho zwei" });
  const crlf = shellApprovalSubject({ ...POSIX_BASE, command: "echo eins\r\necho zwei" });
  assert.equal(approvalSubjectFingerprint(crlf), approvalSubjectFingerprint(lf));
  assert.equal(crlf.command, "echo eins\necho zwei");
});

test("POSIX, PowerShell, and cmd.exe shell modes are distinct exact subjects", () => {
  const command = "echo Grüße & echo zwei";
  const subjects = [
    shellApprovalSubject({ platform: "linux", executable: "/bin/sh", mode: ["-c"], cwd: ".", command }),
    shellApprovalSubject({
      platform: "win32",
      executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      mode: ["-NoProfile", "-NonInteractive", "-Command"],
      cwd: ".",
      command,
    }),
    shellApprovalSubject({
      platform: "win32",
      executable: "C:\\Windows\\System32\\cmd.exe",
      mode: ["/d", "/s", "/c"],
      cwd: ".",
      command,
    }),
  ];
  assert.equal(new Set(subjects.map(approvalSubjectFingerprint)).size, subjects.length);
});

test("canonical workspace cwd makes a symlink alias identical but keeps a real subdirectory distinct", async () => {
  const appHome = await tempAppHome();
  const workspace = join(appHome, "workspace");
  const alias = join(appHome, "workspace-link");
  const packageDir = join(workspace, "packages", "app");
  const { mkdir, symlink } = await import("node:fs/promises");
  try {
    await mkdir(packageDir, { recursive: true });
    await symlink(workspace, alias, "dir");
    assert.equal(await canonicalWorkspaceRelativeCwd(workspace, workspace), ".");
    assert.equal(await canonicalWorkspaceRelativeCwd(alias, alias), ".");
    assert.equal(await canonicalWorkspaceRelativeCwd(workspace, packageDir), "packages/app");
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("structured process subjects sort/deduplicate environment names and never persist values", async () => {
  const subject = processApprovalSubject({
    executable: "/usr/bin/git",
    argv: ["status", "--short"],
    cwd: ".",
    forwardedEnvironment: {
      LANG: "de_DE.UTF-8",
      PATH: "/usr/bin",
      EMPTY_SETTING: undefined,
    },
  });
  assert.deepEqual(subject.environment, ["EMPTY_SETTING", "LANG", "PATH"]);
  const display = approvalSubjectDisplay(subject);
  assert.doesNotMatch(display, /de_DE|\/usr\/bin\"/);
  assert.match(display, /EMPTY_SETTING/);

  const sameNamesDifferentValues = processApprovalSubject({
    executable: "/usr/bin/git",
    argv: ["status", "--short"],
    cwd: ".",
    forwardedEnvironment: { PATH: "/opt/bin", LANG: "C", EMPTY_SETTING: "set" },
  });
  assert.equal(
    approvalSubjectFingerprint(subject),
    approvalSubjectFingerprint(sameNamesDifferentValues),
  );
  assert.notEqual(
    approvalSubjectFingerprint(subject),
    approvalSubjectFingerprint(processApprovalSubject({
      executable: "/usr/bin/git",
      argv: ["--short", "status"],
      cwd: ".",
      forwardedEnvironment: { PATH: "/usr/bin", LANG: "C", EMPTY_SETTING: "set" },
    })),
  );

  const appHome = await tempAppHome();
  try {
    const store = await RuleStore.load(appHome);
    await store.remember({ workspace: "/ws", tool: "git_diff", subject, decision: "allow" });
    const persisted = await readFile(rulesPath(appHome), "utf8");
    assert.doesNotMatch(persisted, /de_DE\.UTF-8|\/opt\/bin/);
    assert.match(persisted, /EMPTY_SETTING/);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("all declared approval subject variants are serializable and discriminated", () => {
  const subjects: ApprovalSubject[] = [
    { kind: "selected-path", path: "src/index.ts" },
    { kind: "selected-path-glob", base: "src", pattern: "**/*.ts" },
    POSIX_BASE,
    processApprovalSubject({ executable: "/usr/bin/git", argv: ["status"], cwd: ".", forwardedEnvironment: {} }),
    { kind: "ssh-command", host: "build-host", command: "uname -a" },
    { kind: "url-operation", origin: "https://example.invalid", operation: "inspect" },
    { kind: "mcp-tool", server: "local-fixture", tool: "lookup", effect: "read" },
    { kind: "git-mutation", repository: ".", mutation: "commit --amend" },
  ];
  assert.deepEqual(subjects.map((subject) => JSON.parse(JSON.stringify(subject)).kind), subjects.map((subject) => subject.kind));
  assert.equal(new Set(subjects.map(approvalSubjectFingerprint)).size, subjects.length);
});

test("RuleStore.decide matches only an exact subject fingerprint and deny wins", async () => {
  const appHome = await tempAppHome();
  try {
    const store = await RuleStore.load(appHome);
    const exact = shellApprovalSubject({ ...POSIX_BASE, command: "npm test" });
    const extended = shellApprovalSubject({ ...POSIX_BASE, command: "npm test --watch" });
    assert.equal(store.decide("/ws", "run_command", exact), null);

    await store.remember({
      workspace: "/ws",
      tool: "run_command",
      subject: exact,
      decision: "allow",
    });
    assert.equal(store.decide("/ws", "run_command", exact), "allow");
    assert.equal(store.decide("/ws", "run_command", extended), null);
    // Different workspace: no bleed-through.
    assert.equal(store.decide("/other", "run_command", exact), null);

    await store.remember({
      workspace: "/ws",
      tool: "run_command",
      subject: exact,
      decision: "deny",
    });
    assert.equal(
      store.decide("/ws", "run_command", exact),
      "deny",
      "deny muss gegen eine vorhandene allow-Regel gewinnen",
    );
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("RuleStore.forget entfernt genau die passende Regel", async () => {
  const appHome = await tempAppHome();
  try {
    const store = await RuleStore.load(appHome);
    const rule = await store.remember({
      workspace: "/ws",
      tool: "run_command",
      subject: POSIX_BASE,
      decision: "allow",
    });
    assert.equal(store.list("/ws").length, 1);
    const removed = await store.forget(rule.id);
    assert.equal(removed, true);
    assert.equal(store.list("/ws").length, 0);
    assert.equal(store.decide("/ws", "run_command", POSIX_BASE), null);

    const removedAgain = await store.forget(rule.id);
    assert.equal(removedAgain, false);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("RuleStore: Persistenzdatei ist 0600 und übersteht einen Neustart", async () => {
  const appHome = await tempAppHome();
  try {
    const store = await RuleStore.load(appHome);
    await store.remember({
      workspace: "/ws",
      tool: "write_file",
      subject: { kind: "selected-path-glob", base: "src", pattern: "*.ts" },
      decision: "allow",
    });

    const path = rulesPath(appHome);
    const info = await stat(path);
    // NTFS has no POSIX mode bits — the mode is asserted on POSIX only;
    // the persistence assertions below still run on Windows.
    if (process.platform !== "win32") {
      assert.equal(info.mode & 0o777, 0o600);
    }

    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { version: number; rules: unknown[] };
    assert.equal(parsed.version, 2);
    assert.equal(parsed.rules.length, 1);

    const reopened = await RuleStore.load(appHome);
    assert.equal(
      reopened.decide("/ws", "write_file", { kind: "selected-path-glob", base: "src", pattern: "*.ts" }),
      "allow",
    );
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("RuleStore.load ohne vorhandene Datei liefert einen leeren Store", async () => {
  const appHome = await tempAppHome();
  try {
    const store = await RuleStore.load(appHome);
    assert.deepEqual(store.list("/ws"), []);
    assert.equal(store.decide("/ws", "run_command", POSIX_BASE), null);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("v1 migration never broadens command prefixes and visibly disables ambiguous legacy rules", async () => {
  const appHome = await tempAppHome();
  try {
    await writeFile(rulesPath(appHome), JSON.stringify({
      version: 1,
      rules: [
        { id: "legacy-command", workspace: "/ws", tool: "run_command", match: { kind: "command-prefix", value: "npm test" }, decision: "allow", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "legacy-any", workspace: "/ws", tool: "read_file", match: { kind: "any" }, decision: "allow", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "legacy-path", workspace: "/ws", tool: "write_file", match: { kind: "path-glob", value: "src/index.ts" }, decision: "deny", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
    }), "utf8");

    const store = await RuleStore.load(appHome);
    const migrated = store.list("/ws");
    assert.equal(migrated.length, 3);
    assert.equal(migrated[0]?.match.kind, "disabled");
    assert.match(migrated[0]?.match.kind === "disabled" ? migrated[0].match.reason : "", /command-prefix.*nicht exakt/i);
    assert.equal(migrated[1]?.match.kind, "disabled");
    assert.match(migrated[1]?.match.kind === "disabled" ? migrated[1].match.reason : "", /any.*zu weit/i);
    assert.equal(
      store.decide("/ws", "run_command", shellApprovalSubject({ ...POSIX_BASE, command: "npm test --watch" })),
      null,
    );
    assert.equal(store.decide("/ws", "write_file", { kind: "selected-path", path: "src/index.ts" }), "deny");

    const persisted = JSON.parse(await readFile(rulesPath(appHome), "utf8")) as { version: number };
    assert.equal(persisted.version, 2, "Migration muss atomar als v2 zurückgeschrieben werden");
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("RuleStore rejects unknown future schema versions", async () => {
  const appHome = await tempAppHome();
  try {
    await writeFile(rulesPath(appHome), JSON.stringify({ version: 99, rules: [] }), "utf8");
    await assert.rejects(RuleStore.load(appHome), /unbekannte.*version 99/i);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});
