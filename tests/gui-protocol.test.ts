import assert from "node:assert/strict";
import test from "node:test";

import {
  GUI_ASK_KINDS,
  GUI_EVENT_NAMES,
  GUI_PROTOCOL_MESSAGE_TYPES,
  GUI_PROTOCOL_VERSION,
  GUI_REDACTED_ACCOUNT,
  GUI_REDACTED_FIELD,
  GUI_REQUEST_TYPES,
  GuiOutputBatcher,
  guardOutboundFrame,
  parseDesktopCapabilitySnapshot,
  parseDesktopOnboardingIntent,
  parseDesktopOnboardingView,
  parseDesktopSettingsView,
  projectChatRow,
  sanitizeOutboundText,
} from "../src/gui-protocol.js";

const protocolProvider = {
  providerId: "openrouter",
  providerLabel: "OpenRouter",
  connectionId: null,
  accountLabel: null,
  state: "disconnected",
  setupMethods: ["openrouter-owner-connect"],
  multiProfile: { enabled: false },
  routes: [],
} as const;

test("provider labels survive snapshot and onboarding protocol parsing exactly", () => {
  const snapshot = parseDesktopCapabilitySnapshot({
    schemaVersion: 1,
    revision: 7,
    generation: 11,
    routeRunnable: false,
    activeRoute: null,
    providers: [protocolProvider],
    undoAvailable: false,
    appearance: { showLargeLogo: true, showHeaderMark: true },
  });
  const onboarding = parseDesktopOnboardingView({
    revision: 7,
    generation: 11,
    step: "provider",
    returnTo: "chat",
    providers: [protocolProvider],
    candidates: [],
  });

  assert.equal(snapshot.providers[0]?.providerLabel, "OpenRouter");
  assert.equal(onboarding.providers[0]?.providerLabel, "OpenRouter");
});

test("Desktop onboarding activation failures round-trip through protocol v2", () => {
  const error = {
    code: "route-activation-failed",
    label: "Modellroute konnte nicht aktiviert werden.",
    recoveryLabel: "Erneut versuchen",
  } as const;
  const parsed = parseDesktopOnboardingView({
    revision: 7,
    generation: 11,
    step: "error",
    returnTo: "chat",
    providers: [],
    candidates: [],
    error,
  });

  assert.deepEqual(parsed.error, error);
});

test("Desktop onboarding projects Settings as a canonical return surface", () => {
  const parsed = parseDesktopOnboardingView({
    revision: 7,
    generation: 11,
    step: "provider",
    returnTo: "settings",
    providers: [protocolProvider],
    candidates: [],
  });
  assert.equal(parsed.returnTo, "settings");
});

test("Desktop onboarding operation handles round-trip only on active views and Cancel", () => {
  const view = parseDesktopOnboardingView({
    revision: 7,
    generation: 11,
    operationHandle: "operation-private-to-the-process-1",
    step: "model",
    returnTo: "chat",
    providers: [],
    candidates: [],
  });
  assert.equal(view.operationHandle, "operation-private-to-the-process-1");
  assert.deepEqual(parseDesktopOnboardingIntent({
    kind: "cancel",
    revision: 7,
    generation: 11,
    operationHandle: view.operationHandle,
  }), {
    kind: "cancel",
    revision: 7,
    generation: 11,
    operationHandle: "operation-private-to-the-process-1",
  });
  assert.equal(parseDesktopOnboardingView({
    revision: 7,
    generation: 11,
    step: "model",
    returnTo: "chat",
    providers: [],
    candidates: [],
  }).operationHandle, undefined);
});

test("Desktop Settings categories require and preserve the canonical expanded state", () => {
  const category = { id: "model", label: "Modell", description: "Modelle", expanded: true, commonItems: [], advancedItems: [] };
  const parsed = parseDesktopSettingsView({
    revision: 1, categories: [category], selectedCategoryId: "model",
    search: { active: false, query: "", results: [] }, notice: null,
  });
  assert.equal(parsed.categories[0]?.expanded, true);
  assert.throws(() => parseDesktopSettingsView({
    revision: 1, categories: [{ ...category, expanded: undefined }], selectedCategoryId: "model",
    search: { active: false, query: "", results: [] }, notice: null,
  }), /boolean/i);
});

test("Desktop Settings preserves display-only focus keys on rows and restored views", () => {
  const parsed = parseDesktopSettingsView({
    revision: 4,
    categories: [{
      id: "accounts", label: "Konten", description: "Konten verwalten", expanded: false,
      commonItems: [{
        handle: "opaque-mutation", focusKey: "opaque-focus", label: "Anbieter einrichten",
        description: "Anbieter verbinden", displayValue: "Öffnen", control: "action",
      }],
      advancedItems: [],
    }],
    selectedCategoryId: "accounts",
    search: { active: false, query: "", results: [] },
    notice: null,
    initialFocusKey: "opaque-focus",
  });
  assert.equal(parsed.categories[0]?.commonItems[0]?.focusKey, "opaque-focus");
  assert.equal(parsed.initialFocusKey, "opaque-focus");
  assert.equal(parsed.categories[0]?.commonItems[0]?.handle, "opaque-mutation");
});
import {
  describeRequestFailure,
  guiConfirmAskPayload,
  GuiRequestRefused,
  installStdoutGuard,
} from "../src/gui-server.js";
import { formatUndoConfirmation } from "../src/resume.js";
import type { ChatSummary } from "../src/types.js";

test("the protocol's message inventory is pinned, so a silent addition shows up in review", () => {
  assert.equal(GUI_PROTOCOL_VERSION, 2);
  // 25 requests + 4 server frame kinds + 22 events + 8 asks.
  assert.equal(GUI_REQUEST_TYPES.length, 25);
  assert.equal(GUI_EVENT_NAMES.length, 22);
  assert.equal(GUI_ASK_KINDS.length, 8);
  assert.equal(GUI_PROTOCOL_MESSAGE_TYPES.length, 59);
  for(const request of ['official-cli.action','local-run.action','execution-policy.set','project.open'])
    assert.ok((GUI_REQUEST_TYPES as readonly string[]).includes(request));
  assert.ok(GUI_EVENT_NAMES.includes('local-run.state'));
  // Fix round 1 (m3): a turn-mutating command must be followable by an
  // append-only client, so the transcript reset is part of the protocol.
  assert.ok(GUI_EVENT_NAMES.includes("chat.reset"));
  // G1b: the hub is G2's first screen, so it must be able to open a row.
  // G3 closes the asymmetry G1b named: a window that can list and open a
  // chat it cannot remove. `chat.delete` is here now, and it is a front door
  // onto `/chat delete`'s own D4 danger question, never a second path.
  assert.ok(GUI_REQUEST_TYPES.includes("chat.open"));
  assert.ok(GUI_REQUEST_TYPES.includes("chat.new"));
  assert.ok(GUI_REQUEST_TYPES.includes("chat.delete"));
  // G2 concern 2: the pre-submit band the terminal's status line shows.
  assert.ok(GUI_REQUEST_TYPES.includes("cost.forecast"));
  assert.ok(GUI_REQUEST_TYPES.includes("desktop.snapshot.get"));
  assert.ok(GUI_REQUEST_TYPES.includes("onboarding.dispatch"));
  assert.ok(GUI_REQUEST_TYPES.includes("settings.close"));
  // G4: the live Cross panel — the half of G3's "Panel" checkbox that was
  // stated rather than shipped. Additive, so the protocol version stands.
  assert.ok(GUI_EVENT_NAMES.includes("cross"));
  assert.ok(GUI_EVENT_NAMES.includes("desktop.snapshot"));
  assert.ok(GUI_EVENT_NAMES.includes("onboarding.view"));
  assert.ok(GUI_EVENT_NAMES.includes("activity"));
  assert.ok(GUI_EVENT_NAMES.includes("native-local-action-required"));
  assert.equal(new Set(GUI_PROTOCOL_MESSAGE_TYPES).size, GUI_PROTOCOL_MESSAGE_TYPES.length);
  // The four blocking ports G0 named must each have an ask, or a run that
  // needs a human answer has no way to get one over a one-way pipe.
  for (const kind of ["confirm", "approval", "secret", "settings-editor"]) {
    assert.ok(GUI_ASK_KINDS.includes(kind as never), `missing ask: ${kind}`);
  }
});

test("D4 crosses the wire as three states, not two", () => {
  // approval.ts:53-61 — danger prints the consequence on its own line and
  // requires an explicit yes.
  assert.deepEqual(
    guiConfirmAskPayload({ title: "Really remove the API key?", consequence: "It is gone." }, { danger: true }),
    {
      title: "Really remove the API key?",
      consequence: "It is gone.",
      danger: true,
      defaultAccept: false,
    },
  );
  // Ordinary: Enter accepts.
  assert.deepEqual(
    guiConfirmAskPayload({ title: "Execute this plan with the executor model?" }),
    { title: "Execute this plan with the executor model?", danger: false, defaultAccept: true },
  );
  // The third state: ordinary in presentation, but Enter must not accept.
  // Collapsing this onto `danger` is the exact FIX-14 regression that gave
  // `/panel`'s spend confirm a destructive title.
  assert.deepEqual(
    guiConfirmAskPayload({ title: "Query 3 model(s) in parallel?" }, { defaultAccept: false }),
    { title: "Query 3 model(s) in parallel?", danger: false, defaultAccept: false },
  );
  // Danger wins over a caller that asks for a default accept: a destructive
  // question may never be the default answer.
  assert.equal(
    guiConfirmAskPayload({ title: "x" }, { danger: true, defaultAccept: true }).defaultAccept,
    false,
  );
});

test("the outbound boundary strips forbidden keys, account identities and secret shapes", () => {
  const frame = {
    t: "event",
    e: "settings.view",
    view: {
      route: {
        accountFingerprint: "acct_or_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        requestedModelId: "vendor/model",
      },
      status: { accountFingerprintSuffix: "abc123", providerSetup: { connections: [] } },
      slot: "v1:inference:11111111-2222-3333-4444-555555555555",
      note: `carrying sk-or-v1-${"0123456789".repeat(7).slice(0, 64)} inline`,
      harmless: "vendor/model",
    },
  };
  const { value, findings } = guardOutboundFrame(frame);
  const wire = JSON.stringify(value);

  assert.ok(!wire.includes("acct_or_A"), "an account fingerprint reached the wire");
  assert.ok(!wire.includes("abc123"), "a fingerprint suffix reached the wire");
  assert.ok(
    !wire.includes("v1:inference:11111111"),
    "a credential slot id reached the wire",
  );
  assert.ok(!/sk-or-v1-0123456789/.test(wire), "a raw secret reached the wire");
  assert.ok(wire.includes("vendor/model"), "the boundary ate a harmless value");
  assert.ok(wire.includes(GUI_REDACTED_FIELD));
  assert.ok(wire.includes(GUI_REDACTED_ACCOUNT));

  // The finding names a path and a reason and never the value — the same
  // discipline `SecretFinding` follows.
  const paths = findings.map((finding) => finding.path);
  assert.ok(paths.includes("view.route.accountFingerprint"));
  assert.ok(paths.includes("view.status.accountFingerprintSuffix"));
  assert.ok(paths.includes("view.status.providerSetup"));
  assert.ok(paths.includes("view.slot"));
  for (const finding of findings) {
    assert.ok(
      !JSON.stringify(finding).includes("acct_or_"),
      "a finding carried the offending value",
    );
  }
});

test("a chat row is a projection: ChatSummary.route never ships", () => {
  const summary = {
    id: "chat-1",
    title: "A chat",
    workspace: "/tmp/work",
    turnCount: 3,
    costUsd: 0.5,
    costKnowledge: "known",
    model: "vendor/model",
    route: {
      version: 1,
      backendId: "openrouter",
      accountFingerprint: "acct_or_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      billingRealm: "openrouter-payg",
      requestedModelId: "vendor/model",
      canonicalModelId: "vendor/model",
      resolutionState: "resolved",
    },
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T01:00:00.000Z",
  } as unknown as ChatSummary & { workspaceVerified: boolean };
  summary.workspaceVerified = true;

  const row = projectChatRow(summary);
  assert.equal("route" in row, false, "the projection kept the route");
  assert.equal("createdAt" in row, false);
  assert.ok(!JSON.stringify(row).includes("acct_or_"));
  assert.equal(row.title, "A chat");
  assert.equal(row.workspaceVerified, true);
});

test("streamed output is coalesced on line boundaries, never torn", () => {
  const batcher = new GuiOutputBatcher({ holdPartialLine: true });
  batcher.push("p1:stdout", "first ");
  // Nothing is ready: a reader must not see half a line.
  assert.deepEqual(batcher.drain({ flushPartial: false }), []);
  batcher.push("p1:stdout", "half\nsecond ");
  const ready = batcher.drain({ flushPartial: false });
  assert.equal(ready.length, 1);
  assert.equal(ready[0]?.text, "first half\n");
  // The held fragment survives for the next tick.
  const rest = batcher.drain({ flushPartial: true });
  assert.equal(rest[0]?.text, "second ");
});

test("a runaway tool is bounded, and the elision is said out loud", () => {
  const batcher = new GuiOutputBatcher({ ceilingChars: 100 });
  batcher.push("p1:stdout", "a".repeat(400));
  const [chunk] = batcher.drain({ flushPartial: true });
  assert.ok(chunk);
  assert.equal(chunk.text.length, 100);
  // Not a silent drop: the count is carried so the caller can say so.
  assert.equal(chunk.elided, 300);
});

test("the stdout guard keeps everything but the protocol off stdout", () => {
  const captured: string[] = [];
  const diagnostics: string[] = [];
  const fake = {
    write(chunk: string): boolean {
      captured.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;

  const guard = installStdoutGuard((chunk) => diagnostics.push(chunk), fake);
  // R1: agent.ts:1291-1293's fallback, and every `console.log` in the core.
  fake.write("the model's answer, straight to stdout\n");
  fake.write("more prose\n");
  const protocolLine = `${JSON.stringify({ v: GUI_PROTOCOL_VERSION, t: "event" })}\n`;
  guard.writeProtocol(protocolLine);
  guard.restore();
  fake.write("after restore\n");

  assert.deepEqual(captured, [protocolLine, "after restore\n"]);
  assert.deepEqual(diagnostics, [
    "the model's answer, straight to stdout\n",
    "more prose\n",
  ]);
  assert.equal(guard.strayWrites, 2);
});

test("the outbound choke point strips what can make a surface lie", () => {
  // U+202E reverses everything after it and survives HTML escaping, so a
  // model, a tool's output or a filename in a diff could render as something
  // other than what it holds. C0/C1 and ANSI are the same class of hazard.
  const hostile = "safe\u202edetupmoc\u0007 \u001b[31mred\u001b[0m \u2066iso\u2069";
  const clean = sanitizeOutboundText(hostile);
  for (const codepoint of ["\u202e", "\u0007", "\u001b", "\u2066", "\u2069"]) {
    assert.ok(!clean.includes(codepoint), `${JSON.stringify(codepoint)} survived`);
  }
  assert.equal(clean, "safedetupmoc red iso");
  // Structure survives: these carry meaning in a diff and in tool output.
  assert.equal(sanitizeOutboundText("a\nb\tc\r\nd"), "a\nb\tc\r\nd");

  // And it happens at the choke point, for every string leaf of every frame
  // — the run union included, whose SHAPE is untouched.
  const { value } = guardOutboundFrame({
    t: "event",
    e: "run",
    event: { type: "text", delta: "hi\u202ethere" },
    nested: [{ label: "x\u0007y" }],
  });
  const wire = JSON.stringify(value);
  assert.ok(!wire.includes("\u202e"));
  assert.ok(!wire.includes("\u0007"));
  assert.ok(wire.includes("hithere"));
  assert.ok(wire.includes('"type":"text"'), "the run event's shape changed");

  // Keys are content too: `tool-start.input`'s keys are the model's own JSON
  // argument names, so an override in a KEY spoofs a rendered argument list
  // exactly as one in a value would.
  const keyed = guardOutboundFrame({
    event: { type: "tool-start", input: { ["pa\u202eth"]: "notes.md" } },
  });
  const keyedWire = JSON.stringify(keyed.value);
  assert.ok(!keyedWire.includes("\u202e"), "a direction override survived in a key");
  assert.ok(keyedWire.includes('"path":"notes.md"'));
});

test("a refusal states itself; anything else is described, never quoted", () => {
  const describe = (): string => "The provider request failed.";

  // Our own copy, our own code, naming the state that blocked the request.
  const refused = describeRequestFailure(
    new GuiRequestRefused("settings-open", "Settings is open, so submit cannot start.", "close it"),
    describe,
  );
  assert.deepEqual(refused, {
    code: "settings-open",
    message: "Settings is open, so submit cannot start.",
    hint: "close it",
  });

  // Anything the core threw goes through the description path. `error.message`
  // is where provider bodies and request ids live, and it never crosses.
  const raw = new Error("429 request_id=req_abc body={\"leak\":true}");
  const described = describeRequestFailure(raw, describe);
  assert.equal(described.code, "request-failed");
  assert.equal(described.message, "The provider request failed.");
  assert.ok(!JSON.stringify(described).includes("req_abc"));
  assert.ok(!JSON.stringify(described).includes("leak"));
});

test('local conflicts have fixed actionable copy rather than a provider failure',()=>{
  const result=describeRequestFailure(new Error('original-baseline-changed'),()=> 'OpenRouter request failed.');
  assert.equal(result.code,'original-baseline-changed');
  assert.match(result.message,/Original.*geändert/);
  const untrusted=describeRequestFailure(new Error('original-baseline-changed token=PRIVATE'),()=> 'Safe fallback');
  assert.equal(untrusted.message,'Safe fallback');
});

// ---------------------------------------------------------------------------
// Round-2 re-review, open item 2: sanitizing KEYS can make two keys collide —
// a hostile `pa<U+202E>th` sanitizes to `path` and used to silently overwrite
// the honest field, re-creating the spoofing class inside its own fix. A
// collision never overwrites: the later key is disclosed under a
// disambiguated name and reported as a finding.
// ---------------------------------------------------------------------------

test("a sanitized key collision never overwrites the honest field", () => {
  const { value, findings } = guardOutboundFrame({
    v: GUI_PROTOCOL_VERSION,
    t: "event",
    e: "run",
    event: { type: "tool-start", input: { path: "notes.md", "pa‮th": "ATTACKER" } },
  } as never);
  const input = (value as { event: { input: Record<string, string> } }).event.input;
  assert.equal(input.path, "notes.md", "the honest field survives untouched");
  assert.equal(input["path#2"], "ATTACKER", "the colliding key is disclosed, not dropped");
  assert.ok(
    findings.some((finding) => finding.reason === "key-collision"),
    "the collision is reported as a finding",
  );
});

test("/undo's danger copy survives the wire unchanged, in D4's grammar", () => {
  // l8: the words themselves, composed by the core and carried by the ask.
  // `confirmInContext(context, {title, consequence: details}, {danger:true})`
  // is the one seam `/undo` uses, and `guiConfirmAskPayload` is the one
  // mapping onto the wire — so this pins the whole composition without a
  // run-log fixture.
  const { title, details } = formatUndoConfirmation(
    [
      { path: "/w/a.ts", before: "one\n", after: "one\ntwo\n", createdAt: "", runId: "r1" },
      { path: "/w/b.ts", before: null, after: "new\n", createdAt: "", runId: "r1" },
    ],
    [{ name: "run_command" }, { name: "write_file" }] as never,
    (path) => path.replace("/w/", ""),
  );
  const payload = guiConfirmAskPayload({ title, consequence: details }, { danger: true });
  assert.equal(payload.title, "Undo the last run?");
  // Every clause, in order, verbatim.
  assert.match(payload.consequence ?? "", /^2 files will be reverted:\n/);
  assert.match(payload.consequence ?? "", /- a\.ts \(\+1\/-0\)/);
  assert.match(payload.consequence ?? "", /- b\.ts \(new file, \+1\)/);
  assert.match(
    payload.consequence ?? "",
    /Not reverted: 1 command\/tool execution from this run: run_command/,
  );
  assert.match(payload.consequence ?? "", /This cannot be undone\.$/);
  // D4: destructive, so Enter can never accept it.
  assert.equal(payload.danger, true);
  assert.equal(payload.defaultAccept, false);
});
