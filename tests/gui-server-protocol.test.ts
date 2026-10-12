import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { GUI_PROTOCOL_VERSION } from "../src/gui-protocol.js";
import {
  GuiTransport,
  desktopCommandDisabled,
  emitSecretlessNativeLocalActionRequirement,
} from "../src/gui-server.js";
import { runSettingsSession, SettingsEditorOpenError } from "../src/settings-session.js";
import type { NativeLocalActionRequirement } from "../src/desktop-contracts.js";

/**
 * Protocol pins against a REAL child process.
 *
 * `tests/fixtures/gui-server-harness.mjs` is the child: a temp workspace and
 * app-home (the journey harness's own discipline), a stubbed provider runtime
 * and agent, and the real `gui-server` module driven through `runGuiServer`'s
 * own bootstrap. No PTY — the protocol is a plain pipe, which is the whole
 * point of G0's D1.
 *
 * The module under test defaults to `src/gui-server.ts` so `npm test` is
 * hermetic on a fresh clone; `ORCODE_GUI_TEST_MODULE` points the same pins at
 * `dist/gui-server.js` (see `npm run test:gui-dist`), which is what the
 * release gate runs after a build.
 */

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = join(PROJECT_ROOT, "tests/fixtures/gui-server-harness.mjs");
const GUI_MODULE_URL = process.env.ORCODE_GUI_TEST_MODULE
  ?? pathToFileURL(join(PROJECT_ROOT, "src/gui-server.ts")).href;

test("every desktop command gate has German copy and every unknown key fails closed", () => {
  const codes = ["run-active", "cross-run-active", "question-pending", "command-in-flight", "settings-open", "no-run", "terminal-only-picker", "route-stale", "provider-unavailable"];
  for (const code of codes) {
    const disabled = desktopCommandDisabled(code);
    assert.equal(disabled.code, code);
    assert.notEqual(disabled.label, code);
    assert.ok(disabled.recoveryLabel.length > 0);
  }
  for (const code of ["future-unknown-gate", "toString", "constructor", "__proto__"]) {
    assert.equal(desktopCommandDisabled(code).code, "provider-unavailable", code);
  }
});

interface Frame {
  readonly t: string;
  readonly [key: string]: unknown;
}

function assertNoShutdownSideEffects(client: GuiClient, entered: "setup" | "refresh"): void {
  const result = client.result();
  assert.equal(result?.desktopSetupCalls, entered === "setup" ? 1 : 0);
  assert.equal(result?.desktopRefreshCalls, entered === "refresh" ? 1 : 0);
  assert.equal(result?.desktopActivationCalls, 0);
  assert.equal(result?.providerCredentialCalls, 0);
  assert.deepEqual(result?.setupSecretLengths, []);
  assert.equal(result?.agentCalls, 0);
  assert.equal(result?.sessionCostUsd, 0);
  assert.equal(result?.desktopActiveOperations, 0);
  assert.equal(result?.desktopActiveDrainTimers, 0);
  assert.ok(Number(result?.desktopDrainTimersCreated) >= 1);
  assert.equal(result?.desktopDrainTimersCleared, result?.desktopDrainTimersCreated);
}

class GuiClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly frames: Frame[] = [];
  /** Every raw stdout byte, for the purity and redaction pins. */
  stdout = "";
  stderr = "";
  nonProtocolLines: string[] = [];
  #nextId = 0;
  #waiters: { match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }[] = [];
  #stderrWaiters: { match: (text: string) => boolean; resolve: () => void }[] = [];

  constructor(scenario: string) {
    this.child = spawn(process.execPath, ["--import", "tsx", HARNESS, scenario], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ORCODE_GUI_SERVER_MODULE: GUI_MODULE_URL, FORCE_COLOR: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
      for (const waiter of [...this.#stderrWaiters]) {
        if (!waiter.match(this.stderr)) continue;
        this.#stderrWaiters.splice(this.#stderrWaiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    });
    this.child.stdout.on("data", (chunk: string) => { this.stdout += chunk; });
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      if (!line.trim()) return;
      let frame: Frame;
      try {
        frame = JSON.parse(line) as Frame;
      } catch {
        this.nonProtocolLines.push(line);
        return;
      }
      this.frames.push(frame);
      for (const waiter of [...this.#waiters]) {
        if (waiter.match(frame)) {
          this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
          waiter.resolve(frame);
        }
      }
    });
  }

  send(frame: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ v: GUI_PROTOCOL_VERSION, ...frame })}\n`);
  }

  request(t: string, payload: Record<string, unknown> = {}): Promise<Frame> {
    const id = `r${(this.#nextId += 1)}`;
    const settled = this.await((frame) => frame.t === "response" && frame.id === id);
    this.send({ t, id, ...payload });
    return settled;
  }

  requestBatch(
    requests: readonly { t: string; payload?: Record<string, unknown> }[],
  ): Promise<Frame>[] {
    const pending = requests.map(({ t, payload = {} }) => {
      const id = `r${(this.#nextId += 1)}`;
      return {
        frame: { v: GUI_PROTOCOL_VERSION, t, id, ...payload },
        settled: this.await((candidate) => candidate.t === "response" && candidate.id === id),
      };
    });
    this.child.stdin.write(`${pending.map(({ frame }) => JSON.stringify(frame)).join("\n")}\n`);
    return pending.map(({ settled }) => settled);
  }

  await(match: (frame: Frame) => boolean, timeoutMs = 15_000): Promise<Frame> {
    const existing = this.frames.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(
          `timed out waiting for a frame.\nframes: ${this.frames.map((frame) => `${frame.t}:${String(frame.e ?? frame.kind ?? "")}`).join(", ")}\nstderr: ${this.stderr}`,
        ));
      }, timeoutMs);
      this.#waiters.push({
        match,
        resolve: (frame) => { clearTimeout(timer); resolve(frame); },
      });
    });
  }

  mark(): number {
    return this.frames.length;
  }

  async onboardingOperationHandleAfter(index: number): Promise<string> {
    const frame = await this.awaitAfter(index, (candidate) =>
      candidate.t === "event" && candidate.e === "onboarding.view"
      && typeof (candidate.view as { operationHandle?: unknown }).operationHandle === "string");
    return (frame.view as { operationHandle: string }).operationHandle;
  }

  awaitAfter(index: number, match: (frame: Frame) => boolean, timeoutMs = 15_000): Promise<Frame> {
    const existing = this.frames.slice(index).find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(
        `timed out waiting after frame ${index}.\nframes: ${this.frames.map((frame) => `${frame.t}:${String(frame.e ?? frame.kind ?? "")}`).join(", ")}\nstderr: ${this.stderr}`,
      )), timeoutMs);
      this.#waiters.push({
        match: (frame) => this.frames.indexOf(frame) >= index && match(frame),
        resolve: (frame) => { clearTimeout(timer); resolve(frame); },
      });
    });
  }

  awaitStderr(match: (text: string) => boolean, timeoutMs = 15_000): Promise<void> {
    if (match(this.stderr)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for stderr.\n${this.stderr}`)), timeoutMs);
      this.#stderrWaiters.push({
        match,
        resolve: () => { clearTimeout(timer); resolve(); },
      });
    });
  }

  events(name: string): Frame[] {
    return this.frames.filter((frame) => frame.t === "event" && frame.e === name);
  }

  async handshake(): Promise<Frame> {
    const hello = await this.await((frame) => frame.t === "hello");
    await this.request("hello-ack", { protocol: GUI_PROTOCOL_VERSION, client: "protocol-pin" });
    return hello;
  }

  /** The harness's self-reported result line, on stderr where it is not protocol. */
  result(): Record<string, unknown> | null {
    const line = this.stderr.split("\n").find((entry) => entry.startsWith("ORCODE_GUI_RESULT:"));
    return line ? JSON.parse(line.slice("ORCODE_GUI_RESULT:".length)) as Record<string, unknown> : null;
  }

  /** Closes our end of the pipe without a `shutdown` — the parent-death path. */
  async endInput(): Promise<number | null> {
    const exited = new Promise<number | null>((resolve) =>
      this.child.once("exit", (code) => resolve(code)));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 20_000);
    const code = await exited;
    clearTimeout(timer);
    this.#stopped = true;
    return code;
  }

  async shutdownOnly(queueAfter = false, responseDeadlineMs = 20_000): Promise<number | null> {
    const exited = new Promise<number | null>((resolve) =>
      this.child.once("exit", (code) => resolve(code)));
    const responsePending = this.request("shutdown", { reason: "explicit-test" });
    if (queueAfter) {
      this.send({ t: "submit", id: "queued-after-shutdown", text: "must never run" });
    }
    const timer = setTimeout(() => this.child.kill("SIGKILL"), responseDeadlineMs);
    try {
      const response = await Promise.race([
        responsePending,
        exited.then(() => {
          throw new Error(`GUI server exited before acknowledging shutdown.\nstderr: ${this.stderr}`);
        }),
      ]);
      assert.equal(response.ok, true);
      return await exited;
    } finally {
      clearTimeout(timer);
      this.#stopped = true;
    }
  }

  #stopped = false;

  async stop(): Promise<void> {
    if (this.#stopped) return;
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    try {
      await this.request("shutdown", { reason: "test" });
    } catch {
      // A server that already went away needs no shutdown.
    }
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(timer);
  }
}

async function withClient(
  scenario: string,
  run: (client: GuiClient) => Promise<void>,
): Promise<GuiClient> {
  const client = new GuiClient(scenario);
  try {
    await run(client);
  } finally {
    await client.stop();
  }
  return client;
}

test("native action display projection emits only the closed four-field requirement", () => {
  const lines: string[] = [];
  const diagnostics: string[] = [];
  const transport = new GuiTransport({
    input: new PassThrough(),
    writeLine: (line) => { lines.push(line); },
    diagnostic: (text) => { diagnostics.push(text); },
  });
  const hostileRequirement = {
    kind: "kimi-turn",
    revision: 7,
    generation: 11,
    purposeCode: "send-turn",
    permit: "permit-private",
    nonce: "nonce-private",
    secret: "secret-private",
    rawFd: 198,
    route: { backendId: "kimi-code", accountFingerprint: "private-account" },
    digest: "private-digest",
    diagnostic: "private-diagnostic",
  } as unknown as NativeLocalActionRequirement;

  emitSecretlessNativeLocalActionRequirement(transport, hostileRequirement);

  assert.equal(transport.pendingAskCount, 0);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), {
    v: GUI_PROTOCOL_VERSION,
    t: "event",
    e: "native-local-action-required",
    requirement: {
      kind: "kimi-turn",
      revision: 7,
      generation: 11,
      purposeCode: "send-turn",
    },
  });
  assert.deepEqual(diagnostics, []);
  assert.doesNotMatch(lines[0]!, /permit|nonce|secret|rawFd|accountFingerprint|digest|diagnostic/i);
});

interface DesktopSettingsRowProbe {
  readonly handle: string;
  readonly focusKey?: string;
  readonly label: string;
  readonly description: string;
  readonly displayValue: string;
  readonly control: string;
  readonly booleanValue?: boolean;
}

interface DesktopSettingsViewProbe {
  readonly revision: number;
  readonly initialFocusKey?: string;
  readonly categories: readonly {
    readonly id: string;
    readonly label: string;
    readonly expanded: boolean;
    readonly commonItems: readonly DesktopSettingsRowProbe[];
    readonly advancedItems: readonly DesktopSettingsRowProbe[];
  }[];
  readonly selectedCategoryId: string;
  readonly search: {
    readonly active: boolean;
    readonly query: string;
    readonly results: readonly DesktopSettingsRowProbe[];
  };
  readonly notice: null | { readonly code: string; readonly level: string; readonly label: string };
}

interface SettingsEditorProbe {
  readonly kind: "choice" | "number" | "text" | "confirm" | "invoke";
  readonly title: string;
  readonly description: string;
  readonly cancelLabel: string;
  readonly busyLabel: string;
  readonly options?: readonly { readonly handle: string; readonly label: string; readonly selected: boolean }[];
}

function settingsEditor(frame: Frame): SettingsEditorProbe {
  const editor = frame.editor as SettingsEditorProbe;
  assert.ok(editor && typeof editor === "object", `missing closed editor: ${JSON.stringify(frame)}`);
  return editor;
}

function editorChoiceHandle(frame: Frame, label: string): string {
  const option = settingsEditor(frame).options?.find((candidate) => candidate.label === label);
  assert.ok(option, `missing editor choice ${label}: ${JSON.stringify(frame)}`);
  return option.handle;
}

interface DesktopOnboardingViewProbe {
  readonly revision: number;
  readonly generation: number;
  readonly operationHandle?: string;
  readonly step: string;
  readonly returnTo: string;
  readonly candidates: readonly {
    readonly handle: string;
    readonly providerLabel: string;
    readonly accountLabel: string;
    readonly displayName: string;
    readonly canonicalModelId: string;
    readonly reasoning: string;
    readonly capabilities: readonly string[];
    readonly cost: { readonly kind: string; readonly label: string };
    readonly dataPolicy: { readonly kind: string; readonly label: string };
    readonly runnable: boolean;
  }[];
}

function desktopSettingsView(frame: Frame): DesktopSettingsViewProbe {
  return frame.view as DesktopSettingsViewProbe;
}

function desktopSettingsRows(view: DesktopSettingsViewProbe): readonly DesktopSettingsRowProbe[] {
  return view.categories.flatMap((category) => [...category.commonItems, ...category.advancedItems]);
}

function requireDesktopSettingsRow(
  view: DesktopSettingsViewProbe,
  label: string,
): DesktopSettingsRowProbe {
  const row = desktopSettingsRows(view).find((candidate) => candidate.label === label);
  assert.ok(row, `missing Desktop Settings row ${label}: ${JSON.stringify(view)}`);
  return row;
}

async function openDesktopSettings(client: GuiClient): Promise<DesktopSettingsViewProbe> {
  const mark = client.mark();
  const response = await client.request("settings.open");
  assert.equal(response.ok, true, JSON.stringify(response));
  return desktopSettingsView(await client.awaitAfter(
    mark,
    (frame) => frame.t === "event" && frame.e === "settings.view",
  ));
}

async function dispatchDesktopSettings(
  client: GuiClient,
  intent: Record<string, unknown>,
): Promise<DesktopSettingsViewProbe> {
  const mark = client.mark();
  const response = await client.request("settings.dispatch", { intent });
  assert.equal(response.ok, true, JSON.stringify(response));
  return desktopSettingsView(await client.awaitAfter(
    mark,
    (frame) => frame.t === "event" && frame.e === "settings.view",
  ));
}

async function openSharedSettingsPicker(
  client: GuiClient,
  view: DesktopSettingsViewProbe,
  rowLabel: "Hauptmodell" | "Anbieter einrichten",
): Promise<DesktopOnboardingViewProbe> {
  const row = requireDesktopSettingsRow(view, rowLabel);
  const mark = client.mark();
  const activating = client.request("settings.dispatch", {
    intent: { kind: "activate-row", handle: row.handle, revision: view.revision },
  });
  const closed = await client.awaitAfter(
    mark,
    (frame) => frame.t === "event" && frame.e === "settings.closed",
  );
  const picker = await client.awaitAfter(
    mark,
    (frame) => frame.t === "event" && frame.e === "onboarding.view"
      && (frame.view as { returnTo?: string }).returnTo === "settings",
  );
  assert.ok(client.frames.indexOf(closed) < client.frames.indexOf(picker));
  assert.equal((await activating).ok, true);
  assert.equal(client.frames.slice(mark).some((frame) => frame.t === "ask"), false);
  const settled = client.frames.slice(mark).filter((frame) =>
    frame.t === "event" && frame.e === "onboarding.view"
      && (frame.view as { returnTo?: string }).returnTo === "settings").at(-1);
  assert.ok(settled);
  return settled.view as DesktopOnboardingViewProbe;
}

async function cancelSharedSettingsPicker(
  client: GuiClient,
  picker: DesktopOnboardingViewProbe,
): Promise<DesktopSettingsViewProbe> {
  const mark = client.mark();
  const response = await client.request("onboarding.dispatch", {
    intent: {
      kind: "cancel",
      revision: picker.revision,
      generation: picker.generation,
      ...(picker.operationHandle ? { operationHandle: picker.operationHandle } : {}),
    },
  });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal((response.result as { kind: string }).kind, "cancelled");
  return desktopSettingsView(await client.awaitAfter(
    mark,
    (frame) => frame.t === "event" && frame.e === "settings.view",
  ));
}

function assertDesktopSettingsPresentationStayedMapped(
  client: GuiClient,
  since = 0,
): void {
  const frames = client.frames.slice(since);
  assert.equal(
    frames.filter((frame) => frame.t === "event" && frame.e === "transcript").length,
    0,
    "a Desktop Settings visit must not create transcript turns",
  );
  const publicSettingsFrames = frames.filter((frame) =>
    frame.t === "event"
    && (
      frame.e === "settings.view"
      || frame.e === "notice"
      || (
        frame.e === "activity"
        && (frame.activity as { kind?: string } | undefined)?.kind === "settings"
      )
    ));
  assert.doesNotMatch(
    JSON.stringify(publicSettingsFrames),
    /Show large logo|Show header mark|Current run status|More settings|Terminal glyph mode|Settings was changed|PRIVATE_CANARY/i,
  );
}

test("the handshake comes first, and nothing is served before it", async () => {
  await withClient("default", async (client) => {
    const hello = await client.await((frame) => frame.t === "hello");
    assert.equal(hello.protocol, GUI_PROTOCOL_VERSION);
    assert.equal(typeof hello.orcode, "string");
    assert.equal(hello.pid, client.child.pid);
    assert.ok(Array.isArray(hello.capabilities));

    // A request before `hello-ack` is refused rather than silently served.
    const early = await client.request("status.get");
    assert.equal(early.ok, false);
    assert.equal((early.error as { code: string }).code, "handshake-required");

    const ack = await client.request("hello-ack", { protocol: GUI_PROTOCOL_VERSION, client: "protocol-pin" });
    assert.equal(ack.ok, true);
    const status = await client.request("status.get");
    assert.equal(status.ok, true);
  });
});

test("desktop state is published only after the v2 acknowledgement", async () => {
  await withClient("default", async (client) => {
    await client.await((frame) => frame.t === "hello");
    assert.equal(client.events("desktop.snapshot").length, 0);
    assert.equal(client.events("onboarding.view").length, 0);
    assert.equal(client.events("activity").length, 0);
    const ack = await client.request("hello-ack", {
      protocol: GUI_PROTOCOL_VERSION,
      client: "desktop-order-pin",
    });
    assert.equal(ack.ok, true);
    const snapshot = await client.await((frame) => frame.t === "event" && frame.e === "desktop.snapshot");
    const view = await client.await((frame) => frame.t === "event" && frame.e === "onboarding.view");
    assert.ok(client.frames.indexOf(ack) < client.frames.indexOf(snapshot));
    assert.equal((snapshot.snapshot as { revision: number }).revision, (view.view as { revision: number }).revision);
  });
});

test("native Codex login asks for the method then returns to explicit account choice without activating a model", async () => {
  const client = await withClient("desktop-codex-login", async (client) => {
    await client.handshake();
    const snapshot = (await client.await((frame) => frame.t === "event" && frame.e === "desktop.snapshot"))
      .snapshot as { revision: number; generation: number };
    const response = client.request("onboarding.dispatch", { intent: { kind: "choose-provider", providerId: "codex",
      revision: snapshot.revision, generation: snapshot.generation } });
    const first = await Promise.race([response, client.await((frame) => frame.t === "ask" && frame.kind === "choice")]);
    assert.equal(first.t, "ask", JSON.stringify(first));
    assert.equal(first.current, "");
    client.send({ t: "answer", askId: first.askId, value: "chatgptDeviceCode" });
    const result = await response;
    assert.equal(result.ok, true, JSON.stringify(result));
    const view = client.events("onboarding.view").at(-1)?.view as { step: string; candidates: unknown[]; revision: number };
    assert.equal(view.step, "account");
    assert.equal(view.revision, snapshot.revision + 1);
    assert.deepEqual(view.candidates, []);
    const fresh = client.events("desktop.snapshot").at(-1)?.snapshot as { routeRunnable: boolean; activeRoute: unknown };
    assert.equal(fresh.routeRunnable, false);
    assert.equal(fresh.activeRoute, null);
    assert.doesNotMatch(client.stdout, /auth\.openai\.com|userCode|authUrl|private-owner|codex-sha256/);
  });
  assert.equal(client.result()?.desktopCodexLoginCalls, 1);
  assert.equal(client.result()?.desktopCodexLoginMethod, "chatgptDeviceCode");
  assert.equal(client.result()?.desktopActivationCalls, 0);
  assert.equal(client.result()?.agentCalls, 0);
});

test("cancelling the Codex login-method choice performs no native login or model activation", async () => {
  const client = await withClient("desktop-codex-login", async (client) => {
    await client.handshake();
    const snapshot = (await client.await((frame) => frame.t === "event" && frame.e === "desktop.snapshot"))
      .snapshot as { revision: number; generation: number };
    const response = client.request("onboarding.dispatch", { intent: { kind: "choose-provider", providerId: "codex",
      revision: snapshot.revision, generation: snapshot.generation } });
    const ask = await client.await((frame) => frame.t === "ask" && frame.kind === "choice");
    client.send({ t: "answer", askId: ask.askId, value: null });
    assert.equal((await response).ok, true);
    const fresh = client.events("desktop.snapshot").at(-1)?.snapshot as { revision: number; routeRunnable: boolean };
    assert.equal(fresh.revision, snapshot.revision);
    assert.equal(fresh.routeRunnable, false);
  });
  assert.equal(client.result()?.desktopCodexLoginCalls, 0);
  assert.equal(client.result()?.desktopActivationCalls, 0);
});

test("Cancel after durable Codex retention returns a fresh profile view without inventing model consent", async () => {
  const client = await withClient("desktop-codex-login-durable-cancel", async (client) => {
    await client.handshake();
    const snapshot = (await client.await((frame) => frame.t === "event" && frame.e === "desktop.snapshot"))
      .snapshot as { revision: number; generation: number };
    const mark = client.mark();
    const response = client.request("onboarding.dispatch", { intent: { kind: "choose-provider", providerId: "codex",
      revision: snapshot.revision, generation: snapshot.generation } });
    const operationHandle = await client.onboardingOperationHandleAfter(mark);
    const ask = await client.await((frame) => frame.t === "ask" && frame.kind === "choice");
    client.send({ t: "answer", askId: ask.askId, value: "chatgptDeviceCode" });
    await client.awaitStderr((text) => text.includes("ORCODE_GUI_GATE:codex-profile-retained"));
    const cancel = await client.request("onboarding.dispatch", { intent: { kind: "cancel", operationHandle,
      revision: snapshot.revision, generation: snapshot.generation } });
    assert.equal(cancel.ok, true, JSON.stringify(cancel));
    assert.equal((await response).ok, true);
    const fresh = client.events("desktop.snapshot").at(-1)?.snapshot as { revision: number; routeRunnable: boolean; activeRoute: unknown };
    assert.equal(fresh.revision, snapshot.revision + 1);
    assert.equal(fresh.routeRunnable, false);
    assert.equal(fresh.activeRoute, null);
  });
  assert.equal(client.result()?.desktopCodexLoginCalls, 1);
  assert.equal(client.result()?.desktopActivationCalls, 0);
});

test("connected Desktop onboarding continues the exact provider setup command through provider account and model", async () => {
  const client = await withClient("desktop-connected", async (client) => {
    await client.handshake();
    const initial = (await client.await((frame) => frame.t === "event" && frame.e === "desktop.snapshot"))
      .snapshot as { revision: number; generation: number };
    const common = { revision: initial.revision, generation: initial.generation };
    assert.equal((await client.request("command", { raw: "/provider setup", draft: "" })).ok, true);
    const opened = client.events("onboarding.view").at(-1)?.view as {
      revision: number; generation: number; step: string; candidates: unknown[];
    };
    assert.deepEqual(
      { revision: opened.revision, generation: opened.generation, step: opened.step, candidates: opened.candidates },
      { ...common, step: "provider", candidates: [] },
    );
    assert.equal((await client.request("onboarding.dispatch", {
      intent: { kind: "choose-provider", providerId: "openrouter", ...common },
    })).ok, true);
    assert.equal((await client.request("onboarding.dispatch", {
      intent: { kind: "choose-account", connectionId: "desktop-connection", ...common },
    })).ok, true);
    const modelView = client.events("onboarding.view").at(-1)?.view as {
      candidates: { handle: string }[];
    };
    assert.equal(modelView.candidates[0]?.handle, "route-before");
    assert.equal((await client.request("onboarding.dispatch", {
      intent: { kind: "choose-model", routeHandle: "route-before", ...common },
    })).ok, true);
    const ready = client.events("desktop.snapshot").at(-1)?.snapshot as {
      routeRunnable: boolean; activeRoute: { routeHandle: string };
    };
    assert.equal(ready.routeRunnable, true);
    assert.equal(ready.activeRoute.routeHandle, "route-after");
    const activity = client.events("activity").at(-1)?.activity as {
      message: { code: string; label: string; messageCode?: string };
    };
    assert.deepEqual(activity.message, {
      code: "setup-completed",
      label: "Einrichtung abgeschlossen",
    });
    assert.equal("messageCode" in activity.message, false);
    assert.equal(client.events("transcript").length, 0);
    const desktopBoundary = `${client.stdout}\n${client.stderr}`;
    for (const canary of [
      "SECRETCANARYFINGERPRINT", "SETUPCANARYFINGERPRINT",
      "SECRET_PROVIDER_BODY_CANARY", "SECRET_REQUESTID_CANARY",
      "outbound boundary redacted",
    ]) {
      assert.equal(desktopBoundary.includes(canary), false, `Desktop leaked ${canary}`);
    }
    const staleHandle = await client.request("onboarding.dispatch", {
      intent: {
        kind: "choose-model",
        routeHandle: "route-before",
        revision: 2,
        generation: 2,
      },
    });
    assert.equal(staleHandle.ok, false);
  });
  assert.equal(client.result()?.desktopRefreshCalls, 1);
  assert.equal(client.result()?.desktopActivationCalls, 1);
  assert.equal(client.result()?.priorChatByteStable, true, JSON.stringify(client.result()));
});

test("historical setup turns stay byte-for-byte stable across Desktop navigation and completion", async () => {
  const client = await withClient("desktop-connected", async (client) => {
    await client.handshake();
    const rows = ((await client.request("chats.list")).result as {
      chats: { id: string; title: string }[];
    }).chats;
    const prior = rows.find((chat) => chat.title === "Prior GUI Chat");
    assert.ok(prior);
    await client.request("chat.open", { chatId: prior.id });
    const initial = client.events("desktop.snapshot").at(-1)?.snapshot as {
      revision: number; generation: number;
    };
    const common = { revision: initial.revision, generation: initial.generation };
    await client.request("onboarding.dispatch", {
      intent: { kind: "choose-provider", providerId: "openrouter", ...common },
    });
    await client.request("onboarding.dispatch", {
      intent: { kind: "choose-account", connectionId: "desktop-connection", ...common },
    });
    await client.request("onboarding.dispatch", {
      intent: { kind: "choose-model", routeHandle: "route-before", ...common },
    });
  });
  assert.equal(client.result()?.priorChatTurnBytesStable, true, JSON.stringify(client.result()));
  assert.equal(client.result()?.priorChatTurnCountBefore, 4);
  assert.equal(client.result()?.priorChatTurnCountAfter, 4);
});

test("true empty Desktop setup uses the preselected OpenRouter seam and submit stays fail-closed", async () => {
  const client = await withClient("desktop-empty", async (client) => {
    await client.handshake();
    const initial = (await client.await((frame) => frame.t === "event" && frame.e === "desktop.snapshot")).snapshot as {
      revision: number; generation: number;
    };
    const early = await client.request("submit", { text: "too early" });
    assert.equal(early.ok, false);
    assert.equal(client.events("transcript").length, 0);
    const setup = client.request("onboarding.dispatch", {
      intent: {
        kind: "choose-provider",
        providerId: "openrouter",
        revision: initial.revision,
        generation: initial.generation,
      },
    });
    const secret = await client.await((frame) => frame.t === "ask" && frame.kind === "secret");
    client.send({ t: "answer", askId: secret.askId, value: "fixture-secret" });
    const model = await client.await((frame) => frame.t === "ask" && frame.kind === "choose-model");
    client.send({ t: "answer", askId: model.askId, id: "vendor/gui-main" });
    assert.equal((await setup).ok, true);
    assert.equal(client.events("transcript").length, 0);
    assert.equal((client.events("desktop.snapshot").at(-1)?.snapshot as { routeRunnable: boolean }).routeRunnable, true);
    assert.equal(client.frames.filter((frame) => frame.t === "ask" && frame.kind === "choose-hub").length, 0);
    const transcriptMark = client.mark();
    assert.equal((await client.request("submit", { text: "one real turn after setup" })).ok, true);
    await client.awaitAfter(transcriptMark, (frame) =>
      frame.t === "event" && frame.e === "run"
      && (frame.event as { type: string }).type === "run-end");
    assert.equal(client.frames.slice(transcriptMark).filter((frame) =>
      frame.t === "event" && frame.e === "transcript" && frame.role === "user").length, 1);
  });
  assert.equal(client.result()?.desktopSetupCalls, 1);
  assert.equal(client.result()?.agentCalls, 1);
});

test("exact GUI provider setup enters canonical onboarding before any provider effect", async () => {
  const client = await withClient("desktop-empty", async (client) => {
    await client.handshake();
    const initial = (await client.await((frame) => frame.t === "event" && frame.e === "desktop.snapshot"))
      .snapshot as { revision: number; generation: number };
    const mark = client.mark();
    const command = client.request("command", { raw: "/provider setup", draft: "" });
    const first = await Promise.race([
      command.then((response) => ({ kind: "response" as const, response })),
      client.awaitAfter(mark, (frame) => frame.t === "ask")
        .then((frame) => ({ kind: "legacy-ask" as const, frame })),
    ]);
    assert.equal(first.kind, "response", `legacy ask escaped: ${JSON.stringify(first)}`);
    if (first.kind !== "response") return;
    assert.equal(first.response.ok, true, JSON.stringify(first.response));
    assert.deepEqual(first.response.result, { outcome: "continue" });

    const openedViews = client.frames.slice(mark)
      .filter((frame) => frame.t === "event" && frame.e === "onboarding.view")
      .map((frame) => frame.view as {
        revision: number; generation: number; step: string; candidates: unknown[];
      });
    assert.ok(openedViews.length >= 1);
    assert.ok(openedViews.every((view) => view.step === "provider" && view.candidates.length === 0));
    assert.ok(openedViews.every((view) => view.revision === initial.revision && view.generation === initial.generation));
    assert.equal(client.frames.slice(mark).filter((frame) => frame.t === "ask").length, 0);
    assert.equal(client.frames.slice(mark).filter((frame) => frame.t === "event" && frame.e === "setup.present").length, 0);
    assert.equal(client.frames.slice(mark).filter((frame) => frame.t === "event" && frame.e === "command-output").length, 0);
    assert.equal(client.frames.slice(mark).filter((frame) => frame.t === "event" && frame.e === "transcript").length, 0);
    assert.equal(client.frames.slice(mark).filter((frame) =>
      frame.t === "event" && frame.e === "activity"
      && (frame.activity as { message?: { code?: string } }).message?.code === "setup-opened").length, 1);

    const choosingMark = client.mark();
    const choosing = client.request("onboarding.dispatch", {
      intent: { kind: "choose-provider", providerId: "openrouter", ...initial },
    });
    const secret = await client.await((frame) => frame.t === "ask" && frame.kind === "secret");
    const operationHandle = await client.onboardingOperationHandleAfter(choosingMark);
    const cancelled = await client.request("onboarding.dispatch", {
      intent: { kind: "cancel", ...initial, operationHandle },
    });
    assert.equal(cancelled.ok, true);
    assert.equal((await choosing).ok, true);
    client.send({ t: "answer", askId: secret.askId, value: "late-secret-must-be-ignored" });
    assert.equal(client.events("transcript").length, 0);
  });
  assert.equal(client.result()?.desktopSetupCalls, 1);
  assert.equal(client.result()?.desktopRefreshCalls, 0);
  assert.equal(client.result()?.desktopActivationCalls, 0);
  assert.equal(client.result()?.providerCredentialCalls, 0);
  assert.equal(client.result()?.protocolTranscriptFrames, 0);
});

test("Desktop onboarding owns one lane and concurrent cancel settles its pending secret once", async () => {
  const client = await withClient("desktop-empty", async (client) => {
    await client.handshake();
    const snapshot = (await client.await((frame) => frame.t === "event" && frame.e === "desktop.snapshot"))
      .snapshot as { revision: number; generation: number };
    const operationMark = client.mark();
    const setup = client.request("onboarding.dispatch", {
      intent: {
        kind: "choose-provider",
        providerId: "openrouter",
        revision: snapshot.revision,
        generation: snapshot.generation,
      },
    });
    await client.await((frame) => frame.t === "ask" && frame.kind === "secret");
    const operationHandle = await client.onboardingOperationHandleAfter(operationMark);
    for (const blocked of await Promise.all([
      client.request("submit", { text: "must not run" }),
      client.request("chat.new"),
      client.request("settings.open"),
      client.request("command", { raw: "/model" }),
    ])) {
      assert.equal(blocked.ok, false);
      assert.equal((blocked.error as { code: string }).code, "question-pending");
    }
    const cancelled = await client.request("onboarding.dispatch", {
      intent: {
        kind: "cancel", revision: snapshot.revision, generation: snapshot.generation, operationHandle,
      },
    });
    assert.equal(cancelled.ok, true);
    assert.equal((await setup).ok, true);
    assert.equal(client.events("transcript").length, 0);
    const cancelledActivities = client.events("activity").filter((frame) =>
      (frame.activity as { message: { code: string } }).message.code === "setup-cancelled");
    assert.equal(cancelledActivities.length, 1);
  });
  assert.equal(client.result()?.agentCalls, 0);
  assert.deepEqual(client.result()?.modelTransitions, []);
  assert.equal(client.result()?.savedShowLargeLogo, true);
  assert.equal(client.result()?.submittedSecretLength, null);
  assert.equal(client.result()?.desktopActivationCalls, 0);
  assert.equal(client.result()?.desktopRefreshCalls, 0);
});

test("desktop.snapshot.get preserves the active Empty OpenRouter operation handle", async () => {
  const client = await withClient("desktop-empty", async (client) => {
    await client.handshake();
    const snapshot = (await client.await((frame) =>
      frame.t === "event" && frame.e === "desktop.snapshot")).snapshot as {
        revision: number; generation: number;
      };
    const operationMark = client.mark();
    const setup = client.request("onboarding.dispatch", {
      intent: { kind: "choose-provider", providerId: "openrouter", ...snapshot },
    });
    await client.await((frame) => frame.t === "ask" && frame.kind === "secret");
    const activeHandle = await client.onboardingOperationHandleAfter(operationMark);

    const refreshMark = client.mark();
    assert.equal((await client.request("desktop.snapshot.get")).ok, true);
    const refreshedView = await client.awaitAfter(refreshMark, (frame) =>
      frame.t === "event" && frame.e === "onboarding.view");
    const refreshedHandle = (refreshedView.view as { operationHandle?: string }).operationHandle;
    assert.equal(refreshedHandle, activeHandle);

    const cancelled = await client.request("onboarding.dispatch", {
      intent: { kind: "cancel", ...snapshot, operationHandle: refreshedHandle },
    });
    assert.equal(cancelled.ok, true);
    assert.equal((cancelled.result as { kind: string }).kind, "cancelled");
    assert.deepEqual((await setup).result, cancelled.result);
    assert.equal((client.events("onboarding.view").at(-1)?.view as {
      operationHandle?: string;
    }).operationHandle, undefined);
  });
  assert.equal(client.result()?.desktopSetupAborted, 1);
  assert.equal(client.result()?.desktopActiveOperations, 0);
});

test("live runtime proof refuses both normal and armed Cross submit before transcript or cost", async () => {
  for (const scenario of ["desktop-proof-fails", "desktop-proof-fails-armed"]) {
    const client = await withClient(scenario, async (client) => {
      await client.handshake();
      await client.await((frame) => frame.t === "event" && frame.e === "desktop.snapshot");
      const refused = await client.request("submit", { text: "must remain local" });
      assert.equal(refused.ok, false);
      assert.equal((refused.error as { code: string }).code, "route-proof-stale");
      assert.equal(client.events("transcript").length, scenario.endsWith("armed") ? 1 : 0);
    });
    assert.equal(client.result()?.agentCalls, 0);
  }
});

test("unavailable Kimi is refused before setup or provider effects", async () => {
  const client = await withClient("desktop-empty-kimi-proof", async (client) => {
    await client.handshake();
    const snapshot = (await client.await((frame) => frame.t === "event" && frame.e === "desktop.snapshot"))
      .snapshot as { revision: number; generation: number; providers: Array<{ providerId: string; state: string; disabled?: { code: string } }> };
    const kimi = snapshot.providers.find((provider) => provider.providerId === "kimi-code");
    assert.deepEqual(kimi, {
      providerId: "kimi-code", connectionId: null, accountLabel: null, state: "disabled",
      setupMethods: ["kimi-owner-connect"], multiProfile: { enabled: false }, routes: [],
      disabled: {
        code: "native-local-action-unavailable",
        label: "Kimi Code kann nur im lokalen Eigentümer-Terminal eingerichtet werden.",
        recoveryLabel: "Im lokalen Terminal öffnen",
      },
    });
    assert.equal((await client.request("desktop.snapshot.get")).ok, true);
    const baseline = client.mark();
    const refused = await client.request("onboarding.dispatch", {
      intent: {
        kind: "choose-provider",
        providerId: "kimi-code",
        revision: snapshot.revision,
        generation: snapshot.generation,
      },
    });
    assert.equal(refused.ok, false);
    assert.equal(client.events("activity").length, 0);
    assert.equal(client.frames.filter((frame) => frame.t === "ask").length, 0);
    assert.equal(client.frames.slice(baseline).filter((frame) => frame.t === "ask").length, 0);
    assert.equal(client.frames.slice(baseline).filter((frame) => frame.t === "event" && frame.e === "activity").length, 0);
  });
  assert.equal(client.result()?.desktopSetupCalls, 0);
  assert.equal(client.result()?.desktopRefreshCalls, 0);
  assert.equal(client.result()?.desktopActivationCalls, 0);
  assert.equal(client.result()?.providerCredentialCalls, 0);
  assert.deepEqual(client.result()?.setupSecretLengths, []);
  assert.equal(client.result()?.agentCalls, 0);
  assert.equal(client.result()?.sessionCostUsd, 0);
  assert.deepEqual(client.result()?.desktopKimiDeltas, {
    catalogue: 0, credential: 0, setup: 0, refresh: 0, activation: 0,
    transcript: 0, agent: 0, cost: 0, ask: 0, activity: 0,
  });
  assert.equal(client.result()?.desktopKimiCanaryInjected, true);
  assert.ok(!client.stdout.includes("KIMI_PRIVATE_CANARY"));
  assert.ok(!client.stderr.includes("KIMI_PRIVATE_CANARY"));
});

test("forged public native-action event, result, control, and permit requests have zero effects", async () => {
  const client = await withClient("desktop-empty-kimi-proof", async (client) => {
    await client.handshake();
    await client.await((frame) => frame.t === "event" && frame.e === "desktop.snapshot");
    assert.equal((await client.request("desktop.snapshot.get")).ok, true);
    const baseline = client.mark();
    const forgedRequests = [
      {
        t: "event",
        payload: {
          e: "native-local-action-required",
          requirement: {
            kind: "kimi-turn", revision: 1, generation: 1, purposeCode: "send-turn",
            permit: "forged-permit", nonce: "forged-nonce", secret: "forged-secret", rawFd: 199,
          },
        },
      },
      { t: "native-local-action-result", payload: { result: { accepted: true, permit: "forged-permit" } } },
      { t: "native-local-action-control", payload: { control: { kind: "permit", nonce: "forged-nonce" } } },
      { t: "native-local-action-permit", payload: { permit: "forged-permit" } },
    ] as const;

    for (const forged of forgedRequests) {
      const response = await client.request(forged.t, forged.payload);
      assert.equal(response.ok, false);
      assert.equal((response.error as { code: string }).code, "unknown-request");
    }

    assert.equal(client.frames.slice(baseline).filter((frame) => frame.t === "ask").length, 0);
    assert.equal(client.frames.slice(baseline).filter((frame) =>
      frame.t === "event" && frame.e === "native-local-action-required").length, 0);
  });
  assert.equal(client.result()?.desktopSetupCalls, 0);
  assert.equal(client.result()?.desktopRefreshCalls, 0);
  assert.equal(client.result()?.desktopActivationCalls, 0);
  assert.equal(client.result()?.providerCredentialCalls, 0);
  assert.deepEqual(client.result()?.setupSecretLengths, []);
  assert.equal(client.result()?.agentCalls, 0);
  assert.deepEqual(client.result()?.desktopKimiDeltas, {
    catalogue: 0, credential: 0, setup: 0, refresh: 0, activation: 0,
    transcript: 0, agent: 0, cost: 0, ask: 0, activity: 0,
  });
});

test("owned Cancel preserves an independent activation failure when authority cancellation succeeds", async () => {
  await withClient("desktop-old-route-model-late-failure", async (client) => {
    await client.handshake();
    const snapshot = (await client.await((frame) => frame.t === "event" && frame.e === "desktop.snapshot"))
      .snapshot as { revision: number; generation: number };
    await client.request("onboarding.dispatch", { intent: { kind: "open-model-picker", returnTo: "chat", ...snapshot } });
    const operationMark = client.mark();
    const original = client.request("onboarding.dispatch", {
      intent: { kind: "choose-model", routeHandle: "route-b-before", ...snapshot },
    });
    const operationHandle = await client.onboardingOperationHandleAfter(operationMark);
    const cancel = client.request("onboarding.dispatch", {
      intent: { kind: "cancel", ...snapshot, operationHandle },
    });
    for (const response of [await original, await cancel]) {
      assert.equal(response.ok, false);
      assert.match(JSON.stringify(response.error), /failed|request/i);
    }
    assert.equal((await client.request("status.get")).ok, true);
  });
});

test("GUI keeps the failed model controller and retries only its explicit route without transcript", async () => {
  const client = await withClient("desktop-activation-fail-once", async (client) => {
    await client.handshake();
    const snapshot = (await client.await((frame) =>
      frame.t === "event" && frame.e === "desktop.snapshot")).snapshot as {
        revision: number; generation: number;
      };
    await client.request("onboarding.dispatch", {
      intent: { kind: "open-model-picker", returnTo: "chat", ...snapshot },
    });
    await client.request("onboarding.dispatch", {
      intent: { kind: "choose-provider", providerId: "openrouter", ...snapshot },
    });
    await client.request("onboarding.dispatch", {
      intent: { kind: "choose-account", connectionId: "desktop-connection", ...snapshot },
    });
    const failed = await client.request("onboarding.dispatch", {
      intent: { kind: "choose-model", routeHandle: "route-before", ...snapshot },
    });
    assert.equal(failed.ok, true);
    const failedView = (failed.result as { kind: string; view: {
      step: string; error?: { code: string; label: string; recoveryLabel?: string };
    } }).view;
    assert.equal(failedView.step, "error");
    assert.deepEqual(failedView.error, {
      code: "route-activation-failed",
      label: "Modellroute konnte nicht aktiviert werden.",
      recoveryLabel: "Erneut versuchen",
    });
    assert.doesNotMatch(JSON.stringify(client.frames), /PRIVATE_DESKTOP_ACTIVATION_FAILURE/);
    assert.equal(client.events("transcript").length, 0);

    const retried = await client.request("onboarding.dispatch", {
      intent: { kind: "retry", ...snapshot },
    });
    assert.equal(retried.ok, true);
    assert.equal((retried.result as { kind: string }).kind, "ready");
    assert.equal(client.events("transcript").length, 0);
  });
  assert.equal(client.result()?.desktopActivationCalls, 2);
});

test("a same-batch Cancel without the Retry handle is refused while Retry completes truthfully", async () => {
  await withClient("desktop-activation-fail-once", async (client) => {
    await client.handshake();
    const snapshot = (await client.await((frame) =>
      frame.t === "event" && frame.e === "desktop.snapshot")).snapshot as {
        revision: number; generation: number;
      };
    await client.request("onboarding.dispatch", {
      intent: { kind: "open-model-picker", returnTo: "chat", ...snapshot },
    });
    await client.request("onboarding.dispatch", {
      intent: { kind: "choose-provider", providerId: "openrouter", ...snapshot },
    });
    await client.request("onboarding.dispatch", {
      intent: { kind: "choose-account", connectionId: "desktop-connection", ...snapshot },
    });
    const failed = await client.request("onboarding.dispatch", {
      intent: { kind: "choose-model", routeHandle: "route-before", ...snapshot },
    });
    assert.equal((failed.result as { kind: string }).kind, "view");

    const boundary = client.mark();
    const [retryPending, cancelPending] = client.requestBatch([
      { t: "onboarding.dispatch", payload: { intent: { kind: "retry", ...snapshot } } },
      { t: "onboarding.dispatch", payload: { intent: { kind: "cancel", ...snapshot } } },
    ]);
    const [retry, cancel] = await Promise.all([retryPending, cancelPending]);
    assert.equal(retry.ok, true);
    assert.equal((retry.result as { kind: string }).kind, "ready");
    assert.equal(cancel.ok, false);
    assert.equal((cancel.error as { code: string }).code, "onboarding-stale");

    const activities = client.frames.slice(boundary).filter((frame) => frame.t === "event" && frame.e === "activity");
    assert.equal(activities.filter((frame) =>
      (frame.activity as { message: { code: string } }).message.code === "setup-completed").length, 1);
    assert.equal(activities.some((frame) =>
      (frame.activity as { message: { code: string } }).message.code === "setup-cancelled"), false);
    const finalSnapshot = client.events("desktop.snapshot").at(-1)?.snapshot as {
      revision: number; generation: number; routeRunnable: boolean;
      activeRoute: { routeHandle: string } | null;
    };
    assert.equal(finalSnapshot.revision, 2);
    assert.equal(finalSnapshot.generation, 2);
    assert.equal(finalSnapshot.routeRunnable, true);
    assert.equal(finalSnapshot.activeRoute?.routeHandle, "route-after");
  });
});

test("a Retry completion-committed proof wins Cancel even when its promise aborts", async () => {
  await withClient("desktop-activation-fail-once-durable", async (client) => {
    await client.handshake();
    const snapshot = (await client.await((frame) =>
      frame.t === "event" && frame.e === "desktop.snapshot")).snapshot as {
        revision: number; generation: number;
      };
    await client.request("onboarding.dispatch", {
      intent: { kind: "open-model-picker", returnTo: "chat", ...snapshot },
    });
    await client.request("onboarding.dispatch", {
      intent: { kind: "choose-provider", providerId: "openrouter", ...snapshot },
    });
    await client.request("onboarding.dispatch", {
      intent: { kind: "choose-account", connectionId: "desktop-connection", ...snapshot },
    });
    const failed = await client.request("onboarding.dispatch", {
      intent: { kind: "choose-model", routeHandle: "route-before", ...snapshot },
    });
    assert.equal((failed.result as { kind: string }).kind, "view");

    const operationMark = client.mark();
    const retryPending = client.request("onboarding.dispatch", {
      intent: { kind: "retry", ...snapshot },
    });
    await client.awaitStderr((text) => text.includes("ORCODE_GUI_GATE:activation-committed"));
    const operationHandle = await client.onboardingOperationHandleAfter(operationMark);
    const boundary = client.mark();
    const cancelPending = client.request("onboarding.dispatch", {
      intent: { kind: "cancel", ...snapshot, operationHandle },
    });
    const [retry, cancel] = await Promise.all([retryPending, cancelPending]);
    for (const response of [retry, cancel]) {
      assert.equal(response.ok, true);
      assert.equal((response.result as { kind: string }).kind, "ready");
    }

    const activities = client.frames.slice(boundary).filter((frame) => frame.t === "event" && frame.e === "activity");
    assert.equal(activities.filter((frame) =>
      (frame.activity as { message: { code: string } }).message.code === "setup-completed").length, 1);
    assert.equal(activities.some((frame) =>
      (frame.activity as { message: { code: string } }).message.code === "setup-cancelled"), false);
    const finalSnapshot = client.events("desktop.snapshot").at(-1)?.snapshot as {
      routeRunnable: boolean; activeRoute: { routeHandle: string } | null;
    };
    assert.equal(finalSnapshot.routeRunnable, true);
    assert.equal(finalSnapshot.activeRoute?.routeHandle, "route-after");
  });
});

test("snapshot.get live-reads an external epoch without replacing an in-flight controller", async () => {
  await withClient("desktop-refresh-external", async (client) => {
    await client.handshake();
    const initial = (await client.await((frame) => frame.t === "event" && frame.e === "desktop.snapshot"))
      .snapshot as { revision: number; generation: number };
    await client.request("onboarding.dispatch", {
      intent: { kind: "choose-provider", providerId: "openrouter", ...initial },
    });
    const operation = client.request("onboarding.dispatch", {
      intent: {
        kind: "choose-account",
        connectionId: "desktop-connection",
        revision: initial.revision,
        generation: initial.generation,
      },
    });
    const mark = client.mark();
    const live = await client.request("desktop.snapshot.get");
    assert.equal(live.ok, true);
    const inFlightSnapshot = await client.awaitAfter(mark, (frame) =>
      frame.t === "event" && frame.e === "desktop.snapshot");
    const inFlightView = await client.awaitAfter(mark, (frame) =>
      frame.t === "event" && frame.e === "onboarding.view");
    assert.equal((inFlightSnapshot.snapshot as { revision: number }).revision, 2);
    assert.equal((inFlightView.view as { revision: number }).revision, 1);
    assert.equal((await operation).ok, false);
    const settledMark = client.mark();
    await client.request("desktop.snapshot.get");
    const settledView = await client.awaitAfter(settledMark, (frame) =>
      frame.t === "event" && frame.e === "onboarding.view");
    assert.equal((settledView.view as { revision: number }).revision, 2);
  });
});

test("explicit shutdown aborts and drains deferred Desktop setup without closing stdin", async () => {
  const client = new GuiClient("desktop-empty");
  await client.handshake();
  const snapshot = (await client.await((frame) => frame.t === "event" && frame.e === "desktop.snapshot"))
    .snapshot as { revision: number; generation: number };
  client.send({ t: "onboarding.dispatch", id: "shutdown-setup",
    intent: { kind: "choose-provider", providerId: "openrouter", ...snapshot },
  });
  await client.await((frame) => frame.t === "ask" && frame.kind === "secret");
  const boundary = client.mark();
  assert.equal(await client.shutdownOnly(true), 0);
  const ackIndex = client.frames.findIndex((frame, index) => index >= boundary
    && frame.t === "response" && frame.ok === true && (frame.result as { stopping?: boolean })?.stopping === true);
  assert.ok(ackIndex >= boundary);
  assert.deepEqual(client.frames.slice(ackIndex + 1), []);
  assert.equal(client.frames.some((frame) => frame.id === "queued-after-shutdown"), false);
  assert.equal(client.result()?.desktopSetupCalls, 1);
  assert.equal(client.result()?.desktopSetupEntered, 1);
  assert.equal(client.result()?.desktopSetupSettled, 1);
  assert.equal(client.result()?.desktopSetupAborted, 1);
  assert.equal(client.result()?.desktopSetupAbortListenersRemoved, 1);
  assert.equal(client.result()?.desktopActiveDrainTimers, 0);
  assert.ok(Number(client.result()?.desktopCancelCalls) >= 1);
  assertNoShutdownSideEffects(client, "setup");
});

test("EOF aborts and drains deferred Desktop account refresh", async () => {
  const client = new GuiClient("desktop-refresh-deferred");
  await client.handshake();
  const snapshot = (await client.await((frame) => frame.t === "event" && frame.e === "desktop.snapshot"))
    .snapshot as { revision: number; generation: number };
  await client.request("onboarding.dispatch", {
    intent: { kind: "choose-provider", providerId: "openrouter", ...snapshot },
  });
  client.send({ t: "onboarding.dispatch", id: "eof-refresh",
    intent: {
      kind: "choose-account",
      connectionId: "desktop-connection",
      revision: snapshot.revision,
      generation: snapshot.generation,
    },
  });
  await client.awaitStderr((text) => text.includes("ORCODE_GUI_GATE:refresh-started"));
  const boundary = client.mark();
  assert.equal(await client.endInput(), 0);
  assert.deepEqual(client.frames.slice(boundary), []);
  assert.equal(client.result()?.desktopRefreshCalls, 1);
  assert.ok(Number(client.result()?.desktopCancelCalls) >= 1);
  assert.equal(client.result()?.desktopRefreshAborted, 1);
  assert.equal(client.result()?.desktopActiveOperations, 0);
  assert.equal(client.result()?.desktopAbortListenersRemoved, 1);
  assert.equal(client.result()?.desktopActiveDrainTimers, 0);
  assertNoShutdownSideEffects(client, "refresh");
});

test("EOF aborts and drains deferred Desktop setup", async () => {
  const client = new GuiClient("desktop-empty");
  await client.handshake();
  const snapshot = (await client.await((frame) => frame.t === "event" && frame.e === "desktop.snapshot"))
    .snapshot as { revision: number; generation: number };
  client.send({
    t: "onboarding.dispatch",
    id: "eof-setup",
    intent: { kind: "choose-provider", providerId: "openrouter", ...snapshot },
  });
  await client.await((frame) => frame.t === "ask" && frame.kind === "secret");
  const boundary = client.mark();
  assert.equal(await client.endInput(), 0);
  assert.deepEqual(client.frames.slice(boundary), []);
  assert.equal(client.result()?.desktopSetupCalls, 1);
  assert.equal(client.result()?.desktopSetupEntered, 1);
  assert.equal(client.result()?.desktopSetupSettled, 1);
  assert.equal(client.result()?.desktopSetupAborted, 1);
  assert.equal(client.result()?.desktopSetupAbortListenersRemoved, 1);
  assert.equal(client.result()?.desktopActiveDrainTimers, 0);
  assert.ok(Number(client.result()?.desktopCancelCalls) >= 1);
  assertNoShutdownSideEffects(client, "setup");
});

test("explicit shutdown aborts and drains deferred Desktop account refresh", async () => {
  const client = new GuiClient("desktop-refresh-deferred");
  await client.handshake();
  const snapshot = (await client.await((frame) => frame.t === "event" && frame.e === "desktop.snapshot"))
    .snapshot as { revision: number; generation: number };
  await client.request("onboarding.dispatch", {
    intent: { kind: "choose-provider", providerId: "openrouter", ...snapshot },
  });
  client.send({
    t: "onboarding.dispatch",
    id: "shutdown-refresh",
    intent: {
      kind: "choose-account",
      connectionId: "desktop-connection",
      revision: snapshot.revision,
      generation: snapshot.generation,
    },
  });
  await client.awaitStderr((text) => text.includes("ORCODE_GUI_GATE:refresh-started"));
  const boundary = client.mark();
  assert.equal(await client.shutdownOnly(true), 0);
  const ackIndex = client.frames.findIndex((frame, index) => index >= boundary
    && frame.t === "response" && frame.ok === true && (frame.result as { stopping?: boolean })?.stopping === true);
  assert.ok(ackIndex >= boundary);
  assert.deepEqual(client.frames.slice(ackIndex + 1), []);
  assert.equal(client.frames.some((frame) => frame.id === "queued-after-shutdown"), false);
  assert.equal(client.result()?.desktopRefreshCalls, 1);
  assert.ok(Number(client.result()?.desktopCancelCalls) >= 1);
  assert.equal(client.result()?.desktopRefreshAborted, 1);
  assert.equal(client.result()?.desktopActiveOperations, 0);
  assert.equal(client.result()?.desktopAbortListenersRemoved, 1);
  assert.equal(client.result()?.desktopActiveDrainTimers, 0);
  assertNoShutdownSideEffects(client, "refresh");
});

test("cancel at the model prompt clears the ask slot for a later setup", async () => {
  await withClient("desktop-empty", async (client) => {
    await client.handshake();
    const snapshot = (await client.await((frame) => frame.t === "event" && frame.e === "desktop.snapshot"))
      .snapshot as { revision: number; generation: number };
    const operationMark = client.mark();
    const first = client.request("onboarding.dispatch", {
      intent: { kind: "choose-provider", providerId: "openrouter", ...snapshot },
    });
    const secret = await client.await((frame) => frame.t === "ask" && frame.kind === "secret");
    client.send({ t: "answer", askId: secret.askId, value: "fixture-secret" });
    await client.await((frame) => frame.t === "ask" && frame.kind === "choose-model");
    const operationHandle = await client.onboardingOperationHandleAfter(operationMark);
    const cancelled = await client.request("onboarding.dispatch", {
      intent: { kind: "cancel", ...snapshot, operationHandle },
    });
    assert.equal(cancelled.ok, true);
    assert.equal((await first).ok, true);
    const mark = client.mark();
    const second = client.request("onboarding.dispatch", {
      intent: { kind: "choose-provider", providerId: "openrouter", ...snapshot },
    });
    const nextSecret = await client.awaitAfter(mark, (frame) => frame.t === "ask" && frame.kind === "secret");
    client.send({ t: "answer", askId: nextSecret.askId, value: null });
    assert.equal((await second).ok, true);
  });
});

test("durable route completion wins a concurrent cancel with one truthful outcome", async () => {
  await withClient("desktop-durable-cancel", async (client) => {
    await client.handshake();
    const snapshot = (await client.await((frame) => frame.t === "event" && frame.e === "desktop.snapshot"))
      .snapshot as { revision: number; generation: number };
    await client.request("onboarding.dispatch", {
      intent: { kind: "choose-provider", providerId: "openrouter", ...snapshot },
    });
    await client.request("onboarding.dispatch", {
      intent: { kind: "choose-account", connectionId: "desktop-connection", ...snapshot },
    });
    const operationMark = client.mark();
    const activation = client.request("onboarding.dispatch", {
      intent: { kind: "choose-model", routeHandle: "route-before", ...snapshot },
    });
    const operationHandle = await client.onboardingOperationHandleAfter(operationMark);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancelled = await client.request("onboarding.dispatch", {
      intent: { kind: "cancel", ...snapshot, operationHandle },
    });
    assert.equal(cancelled.ok, true);
    assert.equal((cancelled.result as { kind: string }).kind, "ready");
    assert.equal((await activation).ok, true);
    const completed = client.events("activity").filter((frame) =>
      (frame.activity as { message: { code: string } }).message.code === "setup-completed");
    assert.equal(completed.length, 1);
    assert.equal(
      ((client.events("desktop.snapshot").at(-1)?.snapshot as { activeRoute: { routeHandle: string } }).activeRoute.routeHandle),
      "route-after",
    );
  });
});

test("cancelling account refresh preserves old route A as cancellation, never completion", async () => {
  const client = await withClient("desktop-old-route-refresh", async (client) => {
    await client.handshake();
    const snapshot = (await client.await((frame) => frame.t === "event" && frame.e === "desktop.snapshot"))
      .snapshot as { revision: number; generation: number };
    await client.request("onboarding.dispatch", {
      intent: { kind: "choose-provider", providerId: "openrouter", ...snapshot },
    });
    const operationMark = client.mark();
    const refresh = client.request("onboarding.dispatch", {
      intent: { kind: "choose-account", connectionId: "desktop-connection", ...snapshot },
    });
    const operationHandle = await client.onboardingOperationHandleAfter(operationMark);
    const mark = client.mark();
    const cancelled = await client.request("onboarding.dispatch", {
      intent: { kind: "cancel", ...snapshot, operationHandle },
    });
    assert.equal(cancelled.ok, true);
    assert.equal((cancelled.result as { kind: string }).kind, "cancelled");
    const refreshFinal = await refresh;
    assert.equal(refreshFinal.ok, true);
    assert.equal((refreshFinal.result as { kind: string }).kind, "cancelled");
    const finalSnapshot = await client.awaitAfter(mark, (frame) =>
      frame.t === "event" && frame.e === "desktop.snapshot");
    assert.equal(
      ((finalSnapshot.snapshot as { activeRoute: { routeHandle: string } }).activeRoute.routeHandle),
      "route-a",
    );
    assert.equal(client.events("activity").some((frame) =>
      (frame.activity as { message: { code: string } }).message.code === "setup-completed"), false);
  });
  assert.equal(client.result()?.desktopRefreshAborted, 1);
  assert.equal(client.result()?.desktopActiveOperations, 0);
});

test("cancel without onboarding leaves an unrelated approval ask open", async () => {
  await withClient("approval", async (client) => {
    await client.handshake();
    await client.await((frame) => frame.t === "event" && frame.e === "desktop.snapshot");
    await client.request("submit", { text: "approval remains owned by the run" });
    const approval = await client.await((frame) => frame.t === "ask" && frame.kind === "approval");
    const snapshot = client.events("desktop.snapshot").at(-1)?.snapshot as {
      revision: number; generation: number;
    };
    const cancelled = await client.request("onboarding.dispatch", {
      intent: { kind: "cancel", ...snapshot },
    });
    assert.equal(cancelled.ok, false);
    assert.equal((cancelled.error as { code: string }).code, "run-active");
    client.send({ t: "answer", askId: approval.askId, accepted: true });
    await client.await((frame) =>
      frame.t === "event" && frame.e === "run"
      && (frame.event as { output?: unknown }).output === "approved");
    assert.equal(client.events("activity").some((frame) =>
      (frame.activity as { message: { code: string } }).message.code === "setup-completed"), false);
  });
});

test("cancel without onboarding leaves Settings and chat-owned asks open", async () => {
  await withClient("default", async (client) => {
    await client.handshake();
    const snapshot = (await client.await((frame) =>
      frame.t === "event" && frame.e === "desktop.snapshot")).snapshot as {
        revision: number; generation: number;
      };

    const settings = await openDesktopSettings(client);
    const glyph = requireDesktopSettingsRow(settings, "Terminalzeichen");
    const activating = client.request("settings.dispatch", {
      intent: { kind: "activate-row", handle: glyph.handle, revision: settings.revision },
    });
    const editor = await client.await((frame) => frame.t === "ask" && frame.kind === "settings-editor");
    const refusedEditorCancel = await client.request("onboarding.dispatch", {
      intent: { kind: "cancel", ...snapshot },
    });
    assert.equal(refusedEditorCancel.ok, false);
    assert.equal((refusedEditorCancel.error as { code: string }).code, "question-pending");
    client.send({
      t: "answer", askId: editor.askId, decision: { kind: "cancel" },
    });
    assert.equal((await activating).ok, true);
    await client.request("settings.close");
    assert.equal(client.events("activity").some((frame) =>
      (frame.activity as { message: { code: string } }).message.code === "setup-completed"), false);
  });

  await withClient("default", async (client) => {
    await client.handshake();
    const snapshot = (await client.await((frame) =>
      frame.t === "event" && frame.e === "desktop.snapshot")).snapshot as {
        revision: number; generation: number;
      };
    const listed = await client.request("chats.list");
    const prior = (listed.result as { chats: { id: string; title: string }[] }).chats
      .find((chat) => chat.title === "Prior GUI Chat");
    assert.ok(prior);
    await client.request("chat.open", { chatId: prior.id });
    const deleting = client.request("chat.delete", { chatId: prior.id });
    const confirm = await client.await((frame) => frame.t === "ask" && frame.kind === "confirm");
    const refusedChatCancel = await client.request("onboarding.dispatch", {
      intent: { kind: "cancel", ...snapshot },
    });
    assert.equal(refusedChatCancel.ok, false);
    assert.equal((refusedChatCancel.error as { code: string }).code, "question-pending");
    client.send({ t: "answer", askId: confirm.askId, accepted: false });
    assert.deepEqual((await deleting).result, { deleted: false, chatId: prior.id });
    assert.equal(client.events("activity").some((frame) =>
      (frame.activity as { message: { code: string } }).message.code === "setup-completed"), false);
  });
});

test("run command Settings and chat lanes refuse onboarding before provider effects", async () => {
  const client = await withClient("default", async (client) => {
    await client.handshake();
    const snapshot = (await client.await((frame) =>
      frame.t === "event" && frame.e === "desktop.snapshot")).snapshot as {
        revision: number; generation: number;
      };
    const onboarding = () => ({
      intent: { kind: "choose-provider", providerId: "openrouter", ...snapshot },
    });

    const [submitted, duringRunPending] = client.requestBatch([
      { t: "submit", payload: { text: "hold the run lane" } },
      { t: "onboarding.dispatch", payload: onboarding() },
    ]);
    assert.equal((await submitted).ok, true);
    const duringRun = await duringRunPending;
    assert.equal((duringRun.error as { code: string }).code, "run-active");
    await client.await((frame) => frame.t === "event" && frame.e === "run"
      && (frame.event as { type: string }).type === "run-end");

    const command = client.request("command", { raw: "/model" });
    const picker = await client.await((frame) => frame.t === "ask" && frame.kind === "choice");
    const duringCommand = await client.request("onboarding.dispatch", onboarding());
    assert.equal((duringCommand.error as { code: string }).code, "question-pending");
    client.send({ t: "answer", askId: picker.askId, value: null });
    await command;

    const settings = await openDesktopSettings(client);
    const glyph = requireDesktopSettingsRow(settings, "Terminalzeichen");
    const changingSetting = client.request("settings.dispatch", {
      intent: { kind: "activate-row", handle: glyph.handle, revision: settings.revision },
    });
    const settingsEditor = await client.await((frame) =>
      frame.t === "ask" && frame.kind === "settings-editor");
    const duringSettings = await client.request("onboarding.dispatch", onboarding());
    assert.equal((duringSettings.error as { code: string }).code, "question-pending");
    client.send({
      t: "answer", askId: settingsEditor.askId,
      decision: { kind: "choice", optionHandle: editorChoiceHandle(settingsEditor, "Unicode") },
    });
    assert.equal((await changingSetting).ok, true);
    await client.await((frame) => frame.t === "event" && frame.e === "settings.view"
      && (frame.view as { notice?: { code?: string } }).notice?.code === "saved");
    await client.request("settings.close");

    const rows = ((await client.request("chats.list")).result as {
      chats: { id: string; title: string }[];
    }).chats;
    const prior = rows.find((chat) => chat.title === "Prior GUI Chat");
    assert.ok(prior);
    const [opening, duringChat] = client.requestBatch([
      { t: "chat.open", payload: { chatId: prior.id } },
      { t: "onboarding.dispatch", payload: onboarding() },
    ]);
    assert.equal((await duringChat).ok, false);
    assert.equal(((await duringChat).error as { code: string }).code, "chat-mutation-active");
    assert.equal((await opening).ok, true);
  });
  assert.equal(client.result()?.desktopSetupCalls, 0);
  assert.equal(client.result()?.desktopRefreshCalls, 0);
  assert.equal(client.result()?.desktopActivationCalls, 0);
  assert.equal(client.result()?.savedShowLargeLogo, true);
  assert.equal(client.result()?.savedGlyphMode, "unicode");
});

test("a genuine cross-workspace chat switch owns its lane through reroot completion", async () => {
  const client = await withClient("desktop-deferred-chat-switch", async (client) => {
    await client.handshake();
    const snapshot = (await client.await((frame) =>
      frame.t === "event" && frame.e === "desktop.snapshot")).snapshot as {
        revision: number; generation: number;
      };
    const rows = ((await client.request("chats.list")).result as {
      chats: { id: string; title: string }[];
    }).chats;
    const foreign = rows.find((chat) => chat.title === "Chat In Another Folder");
    assert.ok(foreign);
    const opening = client.request("chat.open", { chatId: foreign.id });
    await client.awaitStderr((text) => text.includes("ORCODE_GUI_GATE:chat-mutation-held"));
    const onboarding = await client.request("onboarding.dispatch", {
      intent: { kind: "choose-provider", providerId: "openrouter", ...snapshot },
    });
    assert.equal(onboarding.ok, false);
    assert.equal((onboarding.error as { code: string }).code, "chat-mutation-active");
    const opened = await opening;
    assert.equal(opened.ok, true);
    assert.equal((opened.result as { opened: boolean; rerooted: boolean }).opened, true);
    assert.equal((opened.result as { rerooted: boolean }).rerooted, true);
  });
  assert.equal(client.result()?.desktopSetupCalls, 0);
  assert.equal(client.result()?.desktopRefreshCalls, 0);
  assert.equal(client.result()?.desktopActivationCalls, 0);
  assert.equal(client.result()?.submittedSecretLength, null);
  assert.equal(client.result()?.desktopRerootCalls, 1);
  assert.equal(client.result()?.desktopChatMutationCalls, 1);
});

test("a real alternate-model command owns its lane until its durable transition completes", async () => {
  const client = await withClient("desktop-deferred-model-command", async (client) => {
    await client.handshake();
    const snapshot = (await client.await((frame) => frame.t === "event" && frame.e === "desktop.snapshot"))
      .snapshot as { revision: number; generation: number };
    const command = client.request("command", { raw: "/model" });
    const ask = await client.await((frame) => frame.t === "ask" && frame.kind === "choice");
    const alternate = (ask.items as Array<{ value: string; label: string }>).find((item) => item.label.includes("Alternate"));
    assert.ok(alternate);
    client.send({ t: "answer", askId: ask.askId, value: alternate.value });
    await client.awaitStderr((text) => text.includes("ORCODE_GUI_GATE:model-command-held"));
    const onboarding = await client.request("onboarding.dispatch", {
      intent: { kind: "choose-provider", providerId: "openrouter", ...snapshot },
    });
    assert.equal(onboarding.ok, false);
    assert.equal((onboarding.error as { code: string }).code, "command-in-flight");
    assert.equal((await command).ok, true);
    const status = await client.request("status.get");
    assert.equal((status.result as { model: string }).model, "vendor/gui-alternate");
  });
  assert.deepEqual(client.result()?.modelTransitions, ["vendor/gui-alternate"]);
  assert.equal(client.result()?.modelDurableConfig, "vendor/gui-alternate");
  assert.equal(client.result()?.modelDurableProviderRoute, "vendor/gui-alternate");
  assert.equal(client.result()?.modelLiveRuntimeRoute, "vendor/gui-alternate");
  assert.equal(client.result()?.modelLiveSession, "vendor/gui-alternate");
  assert.equal(client.result()?.modelDurableSession, "vendor/gui-alternate");
  assert.deepEqual(client.result()?.modelTransactionJournals, []);
  assert.equal(client.result()?.legacyRouteCatalogCalls, 0);
  assert.equal(client.result()?.routePickerCaptureCalls, 2, "one Desktop authority serves the view and chosen resolve");
  assert.equal(client.result()?.terminalOwnerAuthorityCalls, 0);
  assert.equal(client.result()?.modelPreferenceAuthorityReads, 1);
  assert.equal(client.result()?.settingsPublicationPrepares, 1);
  assert.equal(client.result()?.settingsPublicationPublishes, 1);
  assert.equal(client.result()?.transitionEntries, 1);
  assert.equal(client.result()?.genericCredentialCalls, 0);
  assert.equal(client.result()?.desktopSetupCalls, 0);
});

test("explicit OpenRouter model lookup crosses the atomic query adapter and commits durably", async () => {
  const client = await withClient("desktop-deferred-model-command", async (client) => {
    await client.handshake();
    const command = client.request("command", { raw: "/model vendor/gui-alternate" });
    await client.awaitStderr((text) => text.includes("ORCODE_GUI_GATE:model-command-held"));
    await client.request("desktop.snapshot.get");
    assert.equal((await command).ok, true);
  });
  assert.deepEqual(client.result()?.modelTransitions, ["vendor/gui-alternate"]);
  assert.equal(client.result()?.modelDurableConfig, "vendor/gui-alternate");
  assert.equal(client.result()?.modelDurableProviderRoute, "vendor/gui-alternate");
  assert.equal(client.result()?.modelLiveRuntimeRoute, "vendor/gui-alternate");
  assert.equal(client.result()?.modelLiveSession, "vendor/gui-alternate");
  assert.equal(client.result()?.modelDurableSession, "vendor/gui-alternate");
  assert.equal(client.result()?.desktopAuthorityGetterCalls, 1);
  assert.equal(client.result()?.desktopRoutePickerViewCalls, 2);
  assert.equal(client.result()?.desktopRoutePickerResolveCalls, 1);
  assert.equal(client.result()?.legacyRouteCatalogCalls, 0);
  assert.equal(client.result()?.terminalOwnerAuthorityCalls, 0);
  assert.equal(client.result()?.sessionPublicationPrepares, 1);
  assert.equal(client.result()?.sessionPublicationPublishes, 1);
});

test("only the first successful hello-ack publishes Desktop bootstrap state", async () => {
  await withClient("default", async (client) => {
    await client.handshake();
    await client.await((frame) => frame.t === "event" && frame.e === "onboarding.view");
    const mark = client.mark();
    const duplicate = await client.request("hello-ack", {
      protocol: GUI_PROTOCOL_VERSION,
      client: "duplicate-ack",
    });
    assert.equal(duplicate.ok, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.frames.slice(mark).filter((frame) =>
      frame.t === "event" && (frame.e === "desktop.snapshot" || frame.e === "onboarding.view")).length, 0);
  });
});

test("cancelling deferred model replacement preserves old route A", async () => {
  const client = await withClient("desktop-old-route-model", async (client) => {
    await client.handshake();
    const snapshot = (await client.await((frame) => frame.t === "event" && frame.e === "desktop.snapshot"))
      .snapshot as { revision: number; generation: number };
    await client.request("onboarding.dispatch", {
      intent: { kind: "open-model-picker", returnTo: "chat", ...snapshot },
    });
    const operationMark = client.mark();
    const activation = client.request("onboarding.dispatch", {
      intent: { kind: "choose-model", routeHandle: "route-b-before", ...snapshot },
    });
    const operationHandle = await client.onboardingOperationHandleAfter(operationMark);
    const mark = client.mark();
    const cancelled = await client.request("onboarding.dispatch", {
      intent: { kind: "cancel", ...snapshot, operationHandle },
    });
    assert.equal((cancelled.result as { kind: string }).kind, "cancelled");
    assert.equal(((await activation).result as { kind: string }).kind, "cancelled");
    const finalSnapshot = await client.awaitAfter(mark, (frame) =>
      frame.t === "event" && frame.e === "desktop.snapshot");
    assert.equal(
      ((finalSnapshot.snapshot as { activeRoute: { routeHandle: string } }).activeRoute.routeHandle),
      "route-a",
    );
    assert.equal(client.events("activity").filter((frame) =>
      (frame.activity as { message: { code: string } }).message.code === "setup-completed").length, 0);
  });
  assert.equal(client.result()?.desktopActiveOperations, 0);
});

test("model Cancel accepts only a rebound B handle, never the selected pre-activation handle", async () => {
  for (const [scenario, expectedKind, expectedHandle] of [
    ["desktop-old-route-model-durable", "ready", "route-after"],
    ["desktop-old-route-model-reused", "cancelled", "route-b-before"],
  ] as const) {
    await withClient(scenario, async (client) => {
      await client.handshake();
      const snapshot = (await client.await((frame) =>
        frame.t === "event" && frame.e === "desktop.snapshot")).snapshot as {
          revision: number; generation: number;
        };
      await client.request("onboarding.dispatch", {
        intent: { kind: "open-model-picker", returnTo: "chat", ...snapshot },
      });
      const operationMark = client.mark();
      const activation = client.request("onboarding.dispatch", {
        intent: { kind: "choose-model", routeHandle: "route-b-before", ...snapshot },
      });
      await client.awaitStderr((text) => text.includes("ORCODE_GUI_GATE:activation-committed"));
      const operationHandle = await client.onboardingOperationHandleAfter(operationMark);
      const cancel = await client.request("onboarding.dispatch", {
        intent: { kind: "cancel", ...snapshot, operationHandle },
      });
      assert.equal((cancel.result as { kind: string }).kind, expectedKind);
      assert.deepEqual((await activation).result, cancel.result);
      assert.equal(
        (client.events("desktop.snapshot").at(-1)?.snapshot as {
          activeRoute: { routeHandle: string };
        }).activeRoute.routeHandle,
        expectedHandle,
      );
      assert.equal(client.events("activity").filter((frame) =>
        (frame.activity as { message: { code: string } }).message.code === "setup-completed").length,
      expectedKind === "ready" ? 1 : 0);
    });
  }
});

test("Cancel propagates an unrelated operation failure and releases the lane", async () => {
  await withClient("desktop-old-route-model-failure", async (client) => {
    await client.handshake();
    const snapshot = (await client.await((frame) =>
      frame.t === "event" && frame.e === "desktop.snapshot")).snapshot as {
        revision: number; generation: number;
      };
    await client.request("onboarding.dispatch", {
      intent: { kind: "open-model-picker", returnTo: "chat", ...snapshot },
    });
    const operationMark = client.mark();
    const activation = client.request("onboarding.dispatch", {
      intent: { kind: "choose-model", routeHandle: "route-b-before", ...snapshot },
    });
    const operationHandle = await client.onboardingOperationHandleAfter(operationMark);
    const [cancelA, cancelB] = client.requestBatch([
      { t: "onboarding.dispatch", payload: { intent: { kind: "cancel", ...snapshot, operationHandle } } },
      { t: "onboarding.dispatch", payload: { intent: { kind: "cancel", ...snapshot, operationHandle } } },
    ]);
    for (const response of await Promise.all([activation, cancelA, cancelB])) {
      assert.equal(response.ok, false);
    }
    const later = await client.request("onboarding.dispatch", {
      intent: { kind: "open-model-picker", returnTo: "chat", ...snapshot },
    });
    assert.equal(later.ok, true);
    assert.equal(client.events("activity").filter((frame) =>
      (frame.activity as { message: { code: string } }).message.code === "setup-cancelled").length, 0);
  });
});

test("a final snapshot failure is shared and cannot permanently retain the onboarding lane", async () => {
  await withClient("desktop-old-route-refresh-finalize-failure", async (client) => {
    await client.handshake();
    const snapshot = (await client.await((frame) =>
      frame.t === "event" && frame.e === "desktop.snapshot")).snapshot as {
        revision: number; generation: number;
      };
    await client.request("onboarding.dispatch", {
      intent: { kind: "choose-provider", providerId: "openrouter", ...snapshot },
    });
    const operationMark = client.mark();
    const refresh = client.request("onboarding.dispatch", {
      intent: { kind: "choose-account", connectionId: "desktop-connection", ...snapshot },
    });
    const operationHandle = await client.onboardingOperationHandleAfter(operationMark);
    const [cancelA, cancelB] = client.requestBatch([
      { t: "onboarding.dispatch", payload: { intent: { kind: "cancel", ...snapshot, operationHandle } } },
      { t: "onboarding.dispatch", payload: { intent: { kind: "cancel", ...snapshot, operationHandle } } },
    ]);
    const settlements = await Promise.all([refresh, cancelA, cancelB]);
    assert.equal(settlements.every((response) => response.ok === false), true, JSON.stringify(settlements));
    await new Promise((resolve) => setImmediate(resolve));
    const later = await client.request("onboarding.dispatch", {
      intent: { kind: "open-model-picker", returnTo: "chat", ...snapshot },
    });
    assert.equal(later.ok, true);
    assert.equal(client.events("activity").filter((frame) =>
      (frame.activity as { message: { code: string } }).message.code === "setup-cancelled").length, 0);
  });
});

test("a stale Cancel cannot abort or abandon the current empty setup operation", async () => {
  const client = await withClient("desktop-empty-stale-cancel", async (client) => {
    await client.handshake();
    const snapshot = (await client.await((frame) =>
      frame.t === "event" && frame.e === "desktop.snapshot")).snapshot as {
        revision: number; generation: number;
      };
    assert.equal(snapshot.revision, 4);
    assert.equal(snapshot.generation, 3);
    const operationMark = client.mark();
    const setup = client.request("onboarding.dispatch", {
      intent: { kind: "choose-provider", providerId: "openrouter", ...snapshot },
    });
    const secret = await client.await((frame) => frame.t === "ask" && frame.kind === "secret");
    const operationHandle = await client.onboardingOperationHandleAfter(operationMark);

    const stale = await client.request("onboarding.dispatch", {
      intent: { kind: "cancel", revision: 3, generation: 2, operationHandle },
    });
    assert.equal(stale.ok, false);

    client.send({ t: "answer", askId: secret.askId, value: "fixture-secret" });
    const model = await client.await((frame) => frame.t === "ask" && frame.kind === "choose-model");
    client.send({ t: "answer", askId: model.askId, id: "vendor/gui-main" });
    assert.equal((await setup).ok, true);
    assert.equal(client.events("transcript").length, 0);
  });
  assert.equal(client.result()?.desktopSetupAborted, 0);
  assert.equal(client.result()?.desktopCancelCallsBeforeSetupSettlement, 0);
  assert.equal(client.result()?.desktopSetupProofAccepted, 1);
});

test("a replayed Cancel from operation A cannot cancel operation B in the same Desktop epoch", async () => {
  const client = await withClient("desktop-old-route-model", async (client) => {
    await client.handshake();
    const snapshot = (await client.await((frame) =>
      frame.t === "event" && frame.e === "desktop.snapshot")).snapshot as {
        revision: number; generation: number;
      };

    await client.request("onboarding.dispatch", {
      intent: { kind: "open-model-picker", returnTo: "chat", ...snapshot },
    });
    const markA = client.mark();
    const activationA = client.request("onboarding.dispatch", {
      intent: { kind: "choose-model", routeHandle: "route-b-before", ...snapshot },
    });
    await client.awaitStderr((text) => text.includes("ORCODE_GUI_GATE:activation-held:1"));
    const activeViewA = client.frames.slice(markA).find((frame) =>
      frame.t === "event" && frame.e === "onboarding.view"
      && typeof (frame.view as { operationHandle?: unknown }).operationHandle === "string");
    assert.ok(activeViewA);
    const operationA = (activeViewA.view as { operationHandle: string }).operationHandle;
    const cancelA = await client.request("onboarding.dispatch", {
      intent: { kind: "cancel", ...snapshot, operationHandle: operationA },
    });
    assert.equal(cancelA.ok, true);
    assert.equal((cancelA.result as { kind: string }).kind, "cancelled");
    assert.deepEqual((await activationA).result, cancelA.result);
    await new Promise((resolve) => setImmediate(resolve));

    await client.request("onboarding.dispatch", {
      intent: { kind: "open-model-picker", returnTo: "chat", ...snapshot },
    });
    const markB = client.mark();
    const activationB = client.request("onboarding.dispatch", {
      intent: { kind: "choose-model", routeHandle: "route-b-before", ...snapshot },
    });
    await client.awaitStderr((text) => text.includes("ORCODE_GUI_GATE:activation-held:2"));
    const activeViewB = client.frames.slice(markB).find((frame) =>
      frame.t === "event" && frame.e === "onboarding.view"
      && typeof (frame.view as { operationHandle?: unknown }).operationHandle === "string");
    assert.ok(activeViewB);
    const operationB = (activeViewB.view as { operationHandle: string }).operationHandle;
    assert.notEqual(operationB, operationA);

    const replayedA = await client.request("onboarding.dispatch", {
      intent: { kind: "cancel", ...snapshot, operationHandle: operationA },
    });
    assert.equal(replayedA.ok, false);
    assert.equal((replayedA.error as { code: string }).code, "onboarding-stale");
    const stillActive = await client.request("onboarding.dispatch", {
      intent: { kind: "open-model-picker", returnTo: "chat", ...snapshot },
    });
    assert.equal(stillActive.ok, false);
    assert.equal((stillActive.error as { code: string }).code, "onboarding-active");

    const cancelB = await client.request("onboarding.dispatch", {
      intent: { kind: "cancel", ...snapshot, operationHandle: operationB },
    });
    assert.equal(cancelB.ok, true);
    assert.equal((cancelB.result as { kind: string }).kind, "cancelled");
    assert.deepEqual((await activationB).result, cancelB.result);
    assert.equal(client.events("activity").filter((frame) =>
      (frame.activity as { message: { code: string } }).message.code === "setup-cancelled").length, 2);
  });
  // Two exact operation cancels plus the server's unconditional shutdown drain.
  assert.equal(client.result()?.desktopCancelCalls, 3);
  assert.equal(client.result()?.desktopActiveOperations, 0);
});

test("a foreign higher-epoch OpenRouter route cannot reconcile a held empty setup rejection", async () => {
  const client = await withClient("desktop-empty-foreign-route", async (client) => {
    await client.handshake();
    const snapshot = (await client.await((frame) =>
      frame.t === "event" && frame.e === "desktop.snapshot")).snapshot as {
        revision: number; generation: number;
      };
    const setup = client.request("onboarding.dispatch", {
      intent: { kind: "choose-provider", providerId: "openrouter", ...snapshot },
    });
    const secret = await client.await((frame) => frame.t === "ask" && frame.kind === "secret");
    client.send({ t: "answer", askId: secret.askId, value: "fixture-secret" });
    const model = await client.await((frame) => frame.t === "ask" && frame.kind === "choose-model");
    client.send({ t: "answer", askId: model.askId, id: "vendor/gui-main" });
    await client.awaitStderr((text) => text.includes("ORCODE_GUI_GATE:empty-setup-held"));

    assert.equal((await client.request("desktop.snapshot.get")).ok, true);
    const response = await setup;
    assert.equal(response.ok, false);
    assert.equal(client.events("activity").filter((frame) =>
      (frame.activity as { message: { code: string } }).message.code === "setup-completed").length, 0);
    assert.equal(client.events("transcript").length, 0);
  });
  assert.equal(client.result()?.desktopSetupProofAccepted, 0);
  assert.equal(client.result()?.agentCalls, 0);
});

test("empty setup authority commit wins legacy cancelled and throwing outer settlement", async () => {
  for (const scenario of ["desktop-empty-durable-cancelled", "desktop-empty-durable-throw"]) {
    const client = await withClient(scenario, async (client) => {
      await client.handshake();
      const snapshot = (await client.await((frame) => frame.t === "event" && frame.e === "desktop.snapshot"))
        .snapshot as { revision: number; generation: number };
      const setup = client.request("onboarding.dispatch", {
        intent: { kind: "choose-provider", providerId: "openrouter", ...snapshot },
      });
      const secret = await client.await((frame) => frame.t === "ask" && frame.kind === "secret");
      client.send({ t: "answer", askId: secret.askId, value: "fixture-secret" });
      const model = await client.await((frame) => frame.t === "ask" && frame.kind === "choose-model");
      client.send({ t: "answer", askId: model.askId, id: "vendor/gui-main" });
      const response = await setup;
      assert.equal(response.ok, true);
      assert.equal((response.result as { kind: string }).kind, "ready");
      assert.equal(client.events("activity").filter((frame) =>
        (frame.activity as { message: { code: string } }).message.code === "setup-completed").length, 1);
      assert.equal(client.events("transcript").length, 0);
    });
    assert.equal(client.result()?.desktopSetupCalls, 1);
    assert.equal(client.result()?.desktopSetupProofReconciliations, 1);
    assert.equal(client.result()?.desktopSetupProofAccepted, 1);
  }
});

test("Desktop setup failures redact secret account fingerprint provider body and request id everywhere", async () => {
  const client = await withClient("desktop-empty-private-failure", async (client) => {
    await client.handshake();
    const snapshot = (await client.await((frame) =>
      frame.t === "event" && frame.e === "desktop.snapshot")).snapshot as {
        revision: number; generation: number;
      };
    const setup = client.request("onboarding.dispatch", {
      intent: { kind: "choose-provider", providerId: "openrouter", ...snapshot },
    });
    const secret = await client.await((frame) => frame.t === "ask" && frame.kind === "secret");
    client.send({ t: "answer", askId: secret.askId, value: "DESKTOP_SECRET_CANARY" });
    const model = await client.await((frame) => frame.t === "ask" && frame.kind === "choose-model");
    client.send({ t: "answer", askId: model.askId, id: "vendor/gui-main" });
    assert.equal((await setup).ok, false);
    const boundary = `${client.stdout}\n${client.stderr}`;
    for (const canary of [
      "DESKTOP_SECRET_CANARY", "DESKTOP_ACCOUNT_CANARY",
      "DESKTOP_PROVIDER_BODY_CANARY", "DESKTOP_REQUEST_CANARY",
      "outbound boundary redacted",
    ]) assert.equal(boundary.includes(canary), false, `leaked ${canary}`);
  });
  assert.equal(client.result()?.desktopSetupCalls, 1);
  assert.equal(client.result()?.desktopActivationCalls, 0);
  assert.equal(client.result()?.agentCalls, 0);
});

test("concurrent Cancels share one exact operation settlement and block operation C", async () => {
  const client = await withClient("desktop-empty", async (client) => {
    await client.handshake();
    const snapshot = (await client.await((frame) => frame.t === "event" && frame.e === "desktop.snapshot"))
      .snapshot as { revision: number; generation: number };
    const operationMark = client.mark();
    const setup = client.request("onboarding.dispatch", {
      intent: { kind: "choose-provider", providerId: "openrouter", ...snapshot },
    });
    await client.await((frame) => frame.t === "ask" && frame.kind === "secret");
    const operationHandle = await client.onboardingOperationHandleAfter(operationMark);
    const mark = client.mark();
    const [cancelA, cancelB, operationCPending] = client.requestBatch([
      { t: "onboarding.dispatch", payload: { intent: { kind: "cancel", ...snapshot, operationHandle } } },
      { t: "onboarding.dispatch", payload: { intent: { kind: "cancel", ...snapshot, operationHandle } } },
      {
        t: "onboarding.dispatch",
        payload: { intent: { kind: "choose-provider", providerId: "openrouter", ...snapshot } },
      },
    ]);
    const operationC = await operationCPending;
    assert.equal(operationC.ok, false);
    assert.equal((operationC.error as { code: string }).code, "onboarding-active");
    const [a, b, original] = await Promise.all([cancelA, cancelB, setup]);
    assert.deepEqual(a.result, b.result);
    assert.deepEqual(a.result, original.result);
    assert.equal(client.frames.slice(mark).filter((frame) =>
      frame.t === "event" && frame.e === "activity"
      && (frame.activity as { message: { code: string } }).message.code === "setup-cancelled").length, 1);
    assert.equal(client.frames.slice(mark).filter((frame) =>
      frame.t === "event" && frame.e === "desktop.snapshot").length, 1);
  });
  assert.equal(client.result()?.desktopActiveOperations, 0);
});

test("a version mismatch is an honest refusal, never a degraded mode", async () => {
  await withClient("default", async (client) => {
    await client.await((frame) => frame.t === "hello");
    const ack = await client.request("hello-ack", { protocol: 99, client: "from-the-future" });
    assert.equal(ack.ok, false);
    assert.equal((ack.error as { code: string }).code, "protocol-mismatch");
    const fatal = await client.await((frame) => frame.t === "event" && frame.e === "fatal");
    assert.equal(fatal.code, "protocol-mismatch");
    assert.equal(client.events("desktop.snapshot").length, 0);
    assert.equal(client.events("onboarding.view").length, 0);
    // Still unauthenticated: the mismatch did not open the door.
    const after = await client.request("status.get");
    assert.equal(after.ok, false);
  });
});

test("a v1 client is refused honestly instead of receiving a compatibility mode", async () => {
  await withClient("default", async (client) => {
    await client.await((frame) => frame.t === "hello");
    const id = "legacy-v1";
    const settled = client.await((frame) => frame.t === "response" && frame.id === id);
    client.send({ v: 1, t: "hello-ack", id, protocol: 1, client: "legacy-client" });
    const refusal = await settled;
    assert.equal(refusal.ok, false);
    assert.equal((refusal.error as { code: string }).code, "protocol-mismatch");
    const fatal = await client.await((frame) => frame.t === "event" && frame.e === "fatal");
    assert.equal(fatal.code, "protocol-mismatch");
  });
});

test("a scripted run streams the whole event union, coalesced and in order", async () => {
  const client = await withClient("default", async (client) => {
    await client.handshake();
    const started = await client.request("submit", { text: "write the notes" });
    assert.deepEqual(started.result, { started: true });
    await client.await((frame) =>
      frame.t === "event" && frame.e === "run"
      && (frame.event as { type: string }).type === "run-end");
    // Let the trailing frames (assistant end, footer) land.
    await client.await((frame) =>
      frame.t === "event" && frame.e === "suggestions");
  });

  const runTypes = client.events("run").map((frame) => (frame.event as { type: string }).type);
  assert.deepEqual(runTypes, [
    "run-start",
    "model-start",
    "reasoning",
    "tool-start",
    "process-start",
    "process-output",
    "file-change",
    "tool-end",
    "text",
    "run-end",
  ], "the run-event union did not cross 1:1");

  // The two torn `process-output` writes arrive as one whole-line chunk.
  const output = client.events("run")
    .map((frame) => frame.event as { type: string; text?: string })
    .filter((event) => event.type === "process-output");
  assert.equal(output.length, 1);
  assert.equal(output[0]?.text, "first half\nsecond line\n");

  // P15's split: reasoning is its own event, the answer is its own stream.
  const reasoning = client.events("run")
    .map((frame) => frame.event as { type: string; delta?: string })
    .find((event) => event.type === "reasoning");
  assert.equal(reasoning?.delta, "Weighing the options.");
  const deltas = client.events("assistant")
    .filter((frame) => frame.phase === "delta")
    .map((frame) => frame.delta as string)
    .join("");
  assert.equal(deltas, "Hello world.");

  // A file change carries its diff, which is what a GUI renders.
  const fileChange = client.events("run")
    .map((frame) => frame.event as { type: string; diff?: string })
    .find((event) => event.type === "file-change");
  assert.equal(fileChange?.diff, "+ hello");

  // The transcript carries the same run-complete line the TUI composes.
  const footer = client.events("transcript")
    .map((frame) => String(frame.content))
    .find((content) => content.startsWith("Run complete"));
  assert.ok(footer?.includes("$0.00200"), `footer was: ${footer}`);
  assert.equal(client.result()?.agentCalls, 1);

  // --- what a client must reduce, stated as the contract it is -----------
  //
  // The owner's duplicate-answer report was a client that treated the two
  // shapes below as two answers. They are not, and this is the wire order
  // that makes the difference load-bearing: the run has ALREADY ended by the
  // time `assistant/end` arrives, so a reducer that closes its live block at
  // `run-end` must not open a new one for the end frame.
  const answerShape = client.frames
    .filter((frame) =>
      frame.t === "event"
      && (frame.e === "assistant"
        || (frame.e === "run" && (frame.event as { type: string }).type === "run-end")
        || (frame.e === "transcript" && String(frame.content).startsWith("Run complete"))))
    .map((frame) =>
      frame.e === "assistant"
        ? `assistant/${String(frame.phase)}`
        : frame.e === "run"
          ? "run-end"
          : "footer");
  assert.deepEqual(answerShape, [
    "assistant/begin",
    "assistant/delta",
    "run-end",
    "assistant/end",
    "footer",
  ], "the answer's frames did not cross in the order a client reduces them in");

  // The answer crosses as the assistant stream and NOWHERE else: the `end`
  // frame's `text` is a fallback for a run that streamed nothing, never a
  // second copy of what the deltas already said.
  assert.equal(
    client.events("transcript").filter((frame) => frame.role === "assistant").length,
    0,
    "the answer must not also cross as a transcript turn",
  );
  // And exactly one completion line, from one composer.
  assert.equal(
    client.events("transcript")
      .filter((frame) => /^Run (complete|cancelled|failed)/.test(String(frame.content)))
      .length,
    1,
  );
});

test("cancel is requested, never reported as a success", async () => {
  await withClient("default", async (client) => {
    await client.handshake();
    // Nothing is running: the refusal is honest rather than a silent no-op.
    const idle = await client.request("cancel");
    assert.equal(idle.ok, false);
    assert.match(String((idle.error as { message: string }).message), /Nothing is running/);
  });
});

test("a tool approval is a typed danger ask, and the answer decides the tool", async () => {
  const client = await withClient("approval", async (client) => {
    await client.handshake();
    await client.request("submit", { text: "write the notes" });
    const ask = await client.await((frame) => frame.t === "ask" && frame.kind === "approval");
    // A consent point is never a default-accepted control.
    assert.equal(ask.danger, true);
    assert.equal(ask.rememberAvailable, true);
    assert.equal(ask.reasonAvailable, true);
    const preview = ask.preview as { name: string; summary: string; risk: string };
    assert.equal(preview.name, "write_file");
    assert.equal(preview.summary, "Write notes.md");
    client.send({ t: "answer", askId: ask.askId, accepted: true, remember: "allow" });
    await client.await((frame) =>
      frame.t === "event" && frame.e === "run"
      && (frame.event as { type: string; output?: unknown }).output === "approved");
  });
  assert.ok(client.frames.some((frame) => frame.t === "ask" && frame.kind === "approval"));
});

test("a danger confirm crosses with the command's own copy and its own grammar", async () => {
  await withClient("default", async (client) => {
    await client.handshake();
    const dispatched = client.request("command", { raw: "/clear" });
    const ask = await client.await((frame) => frame.t === "ask" && frame.kind === "confirm");
    // The exact D4 danger grading from `commands.ts`, unchanged by the wire.
    assert.equal(ask.danger, true);
    assert.equal(ask.defaultAccept, false);
    assert.match(String(ask.title), /Reset this chat/);
    assert.ok(String(ask.consequence).length > 0, "the consequence was dropped");
    client.send({ t: "answer", askId: ask.askId, accepted: false });
    const response = await dispatched;
    assert.equal(response.ok, true);
    // A declined danger confirm did nothing, and says nothing: silence is
    // the honest report for "no change was made".
    assert.deepEqual(client.events("command-output"), []);

    // Accepting the same question runs it, and the surface hears about it.
    const second = client.request("command", { raw: "/clear" });
    const again = await client.await((frame) =>
      frame.t === "ask" && frame.kind === "confirm" && frame.askId !== ask.askId);
    assert.equal(again.danger, true);
    assert.equal(again.defaultAccept, false);
    client.send({ t: "answer", askId: again.askId, accepted: true });
    assert.equal((await second).ok, true);
    assert.ok(
      client.events("command-output").length > 0,
      "an accepted /clear reported nothing",
    );
  });
});

test("Settings opens on the projected snapshot and one save reaches the file", async () => {
  const client = await withClient("default", async (client) => {
    await client.handshake();
    const view = await openDesktopSettings(client);
    assert.deepEqual(
      view.categories.map((category) => category.id),
      ["model", "accounts", "security", "more"],
    );
    // F1/F1b: the snapshot is fingerprint-free by construction — this is the
    // pin the brief asks for, made on the frame the client actually receives.
    assert.ok(!JSON.stringify(view).includes("accountFingerprint"));
    assert.ok(!JSON.stringify(view).includes("acct_or_"));
    assert.equal(view.notice, null);

    const glyph = requireDesktopSettingsRow(view, "Terminalzeichen");
    const activated = client.request("settings.dispatch", {
      intent: { kind: "activate-row", handle: glyph.handle, revision: view.revision },
    });
    const editor = await client.await((frame) =>
      frame.t === "ask" && frame.kind === "settings-editor");
    assert.equal(settingsEditor(editor).kind, "choice");
    assert.equal(settingsEditor(editor).title, "Terminalzeichen");
    assert.doesNotMatch(JSON.stringify(editor), /appearance-glyph-mode|actionId|categoryId|itemId|validationMessage|generation/);
    client.send({
      t: "answer",
      askId: editor.askId,
      decision: { kind: "choice", optionHandle: editorChoiceHandle(editor, "Unicode") },
    });
    assert.equal((await activated).ok, true);
    const saved = desktopSettingsView(client.events("settings.view").at(-1)!);
    assert.deepEqual(saved.notice, { code: "saved", level: "info", label: "Gespeichert" });
    assert.equal(requireDesktopSettingsRow(saved, "Terminalzeichen").displayValue, "Unicode");
    await client.request("settings.close");
  });
  // Read back off the real file the save wrote, not off in-memory state.
  assert.equal(client.result()?.savedGlyphMode, "unicode");
});

test("Desktop Settings serves Choice Number Text Confirm and Invoke through one closed German editor DTO", async () => {
  await withClient("default", async (client) => {
    await client.handshake();
    let view = await openDesktopSettings(client);
    const settingsFramesMark = client.mark();
    const activate = async (label: string): Promise<{ readonly ask: Frame; readonly response: Promise<Frame>; readonly mark: number }> => {
      const row = requireDesktopSettingsRow(view, label);
      const mark = client.mark();
      const response = client.request("settings.dispatch", {
        intent: { kind: "activate-row", handle: row.handle, revision: view.revision },
      });
      const ask = await client.awaitAfter(mark, (frame) => frame.t === "ask" && frame.kind === "settings-editor");
      const wire = JSON.stringify(ask);
      assert.doesNotMatch(wire, /actionId|categoryId|itemId|validationMessage|generation|PRIVATE/);
      assert.equal(settingsEditor(ask).cancelLabel, "Abbrechen");
      assert.equal(settingsEditor(ask).busyLabel, "Änderung wird angewendet …");
      return { ask, response, mark };
    };
    const finish = async (active: { readonly response: Promise<Frame>; readonly mark: number }): Promise<void> => {
      assert.equal((await active.response).ok, true);
      view = desktopSettingsView(await client.awaitAfter(
        active.mark,
        (frame) => frame.t === "event" && frame.e === "settings.view",
      ));
    };

    const approval = await activate("Freigabemodus");
    assert.equal(settingsEditor(approval.ask).kind, "choice");
    assert.deepEqual(settingsEditor(approval.ask).options?.map(({ label }) => label), [
      "Nur lesen", "Nachfragen", "Automatisch bearbeiten", "Alles erlauben",
    ]);
    const confirmMark = client.mark();
    client.send({
      t: "answer",
      askId: approval.ask.askId,
      decision: { kind: "choice", optionHandle: editorChoiceHandle(approval.ask, "Alles erlauben") },
    });
    const confirm = await client.awaitAfter(confirmMark, (frame) =>
      frame.t === "ask" && frame.kind === "settings-editor");
    assert.equal(settingsEditor(confirm).kind, "confirm");
    assert.equal(settingsEditor(confirm).title, "Alles erlauben aktivieren?");
    assert.doesNotMatch(JSON.stringify(confirm), /allow-all|Really enable|actionId|categoryId|itemId/);
    client.send({ t: "answer", askId: confirm.askId, decision: { kind: "confirm", accepted: true } });
    await finish(approval);

    const number = await activate("Aktionen pro Lauf");
    assert.equal(settingsEditor(number.ask).kind, "number");
    client.send({ t: "answer", askId: number.ask.askId, decision: { kind: "number", value: "9" } });
    await finish(number);

    const text = await activate("Browserpfad");
    assert.equal(settingsEditor(text.ask).kind, "text");
    client.send({
      t: "answer", askId: text.ask.askId,
      decision: { kind: "text", value: "/Applications/Test Browser.app" },
    });
    await finish(text);

    const invoke = await activate("Prüf-Befehle vorschlagen");
    assert.equal(settingsEditor(invoke.ask).kind, "invoke");
    const invokeFollowupMark = client.mark();
    client.send({ t: "answer", askId: invoke.ask.askId, decision: { kind: "invoke" } });
    const invokeFollowup = await client.awaitAfter(
      invokeFollowupMark,
      (frame) => frame.t === "ask" && frame.kind === "confirm",
    );
    client.send({ t: "answer", askId: invokeFollowup.askId, accepted: false });
    await finish(invoke);

    assert.equal(client.events("transcript").length, 0);
    assert.equal(client.frames.some((frame) => frame.t === "ask" && frame.kind === "choice"), false);
    assert.doesNotMatch(
      JSON.stringify(client.frames.slice(settingsFramesMark)),
      /Applying the change|"text":"Ready"/,
    );
    await client.request("settings.close");
  });
});

test("opening a foreign-folder chat re-roots the runtime and says so", async () => {
  const client = await withClient("default", async (client) => {
    await client.handshake();
    const listed = await client.request("chats.list");
    const chats = (listed.result as { chats: { id: string; title: string; workspace: string }[] }).chats;
    const foreign = chats.find((chat) => chat.title === "Chat In Another Folder");
    assert.ok(foreign, `the foreign chat was not listed: ${JSON.stringify(chats)}`);

    const opened = await client.request("chat.open", { chatId: foreign.id });
    assert.equal(opened.ok, true);
    const result = opened.result as {
      opened: boolean; chatId: string; workspace: string; rerooted: boolean;
      turnCount: number; untouched: boolean;
    };
    assert.equal(result.opened, true);
    assert.equal(result.chatId, foreign.id);
    assert.equal(result.rerooted, true, "the runtime did not follow the chat's folder");
    assert.equal(result.workspace, foreign.workspace);
    assert.equal(result.turnCount, 2);
    assert.equal(result.untouched, false);

    // The transcript reaches the client with the chat, not as a second fetch.
    const event = client.events("chat.opened").pop();
    assert.ok(event);
    const turns = event.turns as { role: string; content: string }[];
    assert.deepEqual(turns.map((turn) => turn.role), ["user", "assistant"]);
    assert.equal(turns[1]?.content, "The other one.");

    // FIX-20 finding 9: a re-root is the biggest thing a pick can do, and the
    // destination is named outright rather than left to a changing basename.
    const status = client.events("status").map((frame) => String(frame.text));
    const notice = status.find((text) => text.startsWith("Folder switched:"));
    assert.ok(notice, `no re-root notice among: ${JSON.stringify(status)}`);
    assert.ok(notice.includes("Chat In Another Folder"));

    // The status request agrees — the whole runtime moved, not just a label.
    const after = await client.request("status.get");
    assert.equal((after.result as { workspace: string }).workspace, foreign.workspace);
    assert.equal((after.result as { chatId: string }).chatId, foreign.id);
  });
  const outcome = client.result() as { foreignWorkspace: string; foreignChatId: string };
  assert.ok(outcome.foreignWorkspace.endsWith("elsewhere"));
});

test("opening the chat that is already open moves nothing, and says so", async () => {
  await withClient("default", async (client) => {
    await client.handshake();
    const status = await client.request("status.get");
    const current = (status.result as { chatId: string }).chatId;
    const again = await client.request("chat.open", { chatId: current });
    assert.equal(again.ok, true);
    assert.deepEqual(again.result, { opened: false, reason: "already-open", chatId: current });
    assert.deepEqual(client.events("chat.opened"), []);
    // An unknown id is refused rather than silently ignored.
    const missing = await client.request("chat.open", { chatId: "not-a-chat" });
    assert.equal(missing.ok, false);
    assert.match(String((missing.error as { message: string }).message), /No chat with id/);
  });
});

test("the ghost-file guard holds on the sidecar path too", async () => {
  const client = await withClient("default", async (client) => {
    await client.handshake();
    const listed = await client.request("chats.list");
    const before = (listed.result as { chats: { id: string; title: string }[] }).chats;
    assert.equal(before.length, 2, "the fixture's two saved chats are the baseline");

    // chat.new with no title, then quit: `SessionStore.create` never writes on
    // its own and every save path skips an untouched session (D8c / FIX-20
    // finding 7), so this must leave no file behind.
    const created = await client.request("chat.new");
    const result = created.result as { opened: boolean; chatId: string; untouched: boolean };
    assert.equal(result.opened, true);
    assert.equal(result.untouched, true, "a fresh unnamed chat claimed it was written");

    // Opening an existing chat and saying nothing must not mint a file either.
    const target = before.find((chat) => chat.title === "Prior GUI Chat");
    assert.ok(target);
    const reopened = await client.request("chat.open", { chatId: target.id });
    assert.equal((reopened.result as { opened: boolean }).opened, true);

    const relisted = await client.request("chats.list");
    assert.deepEqual(
      (relisted.result as { chats: { id: string }[] }).chats.map((chat) => chat.id).sort(),
      before.map((chat) => chat.id).sort(),
      "an unwritten chat leaked into the listing",
    );
  });

  const outcome = client.result() as {
    chatFileIds: string[]; priorChatId: string; foreignChatId: string;
  };
  // Read off the real files this process wrote, after shutdown.
  assert.deepEqual(
    outcome.chatFileIds,
    [outcome.priorChatId, outcome.foreignChatId].sort(),
    "a ghost chat file was written",
  );
});

test("stdin EOF cancels the run, kills its tool child, and saves exactly once", async () => {
  const client = new GuiClient("cancel-on-eof");
  await client.handshake();
  // A chat with real turns, so the teardown save is not skipped by the
  // untouched guard and "exactly once" is actually measurable.
  const listed = await client.request("chats.list");
  const prior = (listed.result as { chats: { id: string; title: string }[] }).chats
    .find((chat) => chat.title === "Prior GUI Chat");
  assert.ok(prior);
  await client.request("chat.open", { chatId: prior.id });

  await client.request("submit", { text: "start something long" });
  await client.await((frame) =>
    frame.t === "event" && frame.e === "run"
    && (frame.event as { type: string }).type === "run-start");

  // The parent goes away. On macOS this is the ONLY reliable parent-death
  // signal (no PR_SET_PDEATHSIG), and it is why D1 chose stdio.
  const exitCode = await client.endInput();
  assert.equal(exitCode, 0, "the sidecar did not exit cleanly after EOF");

  const outcome = client.result() as {
    runOutcome: string | null;
    toolChildPid: number | null;
    saveCalls: number;
    saveCallsAtRunStart: number | null;
  };
  // The core was cancelled through the run's own cancel path, so the outcome
  // is `cancelled` — never `complete` (agent.ts:1666-1668).
  assert.equal(outcome.runOutcome, "cancelled");
  // Exactly one save from the instant the run began through teardown.
  assert.equal(
    outcome.saveCalls - (outcome.saveCallsAtRunStart ?? 0),
    1,
    "the session was not saved exactly once during shutdown",
  );

  // The proof the review asked for, read off the OS rather than off the
  // fixture: orcode spawns tool children into their own process groups
  // (workspace.ts), so a sidecar that is SIGKILLed mid-run orphans them.
  assert.ok(outcome.toolChildPid);
  assert.throws(
    () => process.kill(outcome.toolChildPid as number, 0),
    (error: NodeJS.ErrnoException) => error.code === "ESRCH",
    "the run's detached tool child outlived the sidecar",
  );
});

test("a hanging provider read cannot hold the exit", async () => {
  const client = new GuiClient("hanging-balance");
  await client.handshake();
  await client.request("submit", { text: "start something long" });
  await client.await((frame) =>
    frame.t === "event" && frame.e === "run"
    && (frame.event as { type: string }).type === "run-start");

  // The startup balance read never resolves. Fix round 1 awaited it in
  // teardown, ahead of the final save and with no bound — so exit took as
  // long as the provider client's own retries, defeating the drain bound six
  // lines above it.
  const started = Date.now();
  const exitCode = await client.endInput();
  const elapsed = Date.now() - started;

  assert.equal(exitCode, 0);
  assert.ok(
    elapsed < 12_000,
    `exit took ${elapsed}ms with a hanging balance read; the drain bound is ${5_000}ms`,
  );
  // …and it still did the work: cancelled, and the child is gone.
  const outcome = client.result() as { runOutcome: string | null; toolChildPid: number | null };
  assert.equal(outcome.runOutcome, "cancelled");
  assert.throws(
    () => process.kill(outcome.toolChildPid as number, 0),
    (error: NodeJS.ErrnoException) => error.code === "ESRCH",
  );
});

test("every exit trigger ends the process, not just EOF", async () => {
  // `shutdown` and `/quit` used to tear the session down and leave the
  // sidecar alive: the readline interface kept `process.stdin` referenced, so
  // the loop never drained and only the client closing the pipe ended it.
  for (const trigger of ["shutdown", "quit"] as const) {
    const client = new GuiClient("default");
    await client.handshake();
    const exited = new Promise<number | null>((resolve) =>
      client.child.once("exit", (code) => resolve(code)));
    const acknowledged = trigger === "shutdown"
      ? await client.request("shutdown", { reason: "test" })
      : await client.request("command", { raw: "/quit" });
    assert.equal(acknowledged.ok, true, `${trigger} was not acknowledged`);
    if (trigger === "quit") {
      assert.equal((acknowledged.result as { outcome: string }).outcome, "exit");
    }
    // Our end of the pipe is still open: whatever ends the process next, it
    // is not the client closing it.
    assert.equal(client.child.stdin.writableEnded, false);

    const timer = setTimeout(() => client.child.kill("SIGKILL"), 10_000);
    const code = await exited;
    clearTimeout(timer);
    assert.equal(code, 0, `${trigger} did not end the process on its own`);
  }
});

test("a run failure crosses as its classification too", async () => {
  const client = await withClient("run-error", async (client) => {
    await client.handshake();
    await client.request("submit", { text: "make it fail" });
    await client.await((frame) =>
      frame.t === "event" && frame.e === "transcript" && frame.role === "error");
  });

  const failure = client.events("transcript").find((frame) => frame.role === "error");
  assert.ok(failure, "the run failure never reached the transcript");
  assert.match(String(failure.content), /throttling|rate limit/i);

  // Controller ruling (fix round 2): a run failure is an ordinary outbound
  // frame, so the wire's rule outranks TUI parity for it. The TUI keeps
  // `safeMessage` for its own rendering; the wire gets the same
  // detail-dropping renderer every other outbound failure uses.
  for (const canary of ["SECRET_REQUESTID_CANARY", "SECRET_PROVIDER_BODY_CANARY", "req_", "Details:"]) {
    assert.ok(!client.stdout.includes(canary), `"${canary}" reached the wire on the run path`);
  }
  // Diagnostics are an owner-visible surface too: classification is useful,
  // raw provider/request data is not.
  assert.match(client.stderr, /orcode-gui: run failed:/);
  assert.ok(!client.stderr.includes("SECRET_REQUESTID_CANARY"));
  assert.ok(!client.stderr.includes("SECRET_PROVIDER_BODY_CANARY"));
});

test("a provider failure crosses as its classification, not as its body", async () => {
  const client = await withClient("error-body", async (client) => {
    await client.handshake();
    const failed = await client.request("command", { raw: "/balance" });
    assert.equal(failed.ok, false);
    const error = failed.error as { code: string; message: string };
    assert.equal(error.code, "request-failed");
    // The same `explain()` classification the TUI renders — the sentence a
    // reader can act on, not the transport's own `error.message`.
    assert.match(error.message, /throttling|rate limit/i);
  });

  // The privacy contract's own list (commands.ts:5305-5307): no request ids,
  // no provider bodies. `safeMessage` keeps them in its `· Details:` clause
  // for the terminal; `safePanelMessage` — the repo's second renderer over
  // the same classification — drops that clause, which is why it is the one
  // this surface uses.
  for (const canary of ["SECRET_REQUESTID_CANARY", "SECRET_PROVIDER_BODY_CANARY", "req_"]) {
    assert.ok(!client.stdout.includes(canary), `"${canary}" reached the wire`);
  }
  assert.ok(!client.stdout.includes("Details:"), "the technical tail reached the wire");
});

test("one thing at a time: every collision is refused by name", async () => {
  await withClient("cancel-on-eof", async (client) => {
    await client.handshake();

    // 1. submit while a run is in flight.
    await client.request("submit", { text: "start something long" });
    await client.await((frame) =>
      frame.t === "event" && frame.e === "run"
      && (frame.event as { type: string }).type === "run-start");
    const duringRun = await client.request("submit", { text: "and another" });
    assert.equal(duringRun.ok, false);
    assert.equal((duringRun.error as { code: string }).code, "run-active");
    const commandDuringRun = await client.request("command", { raw: "/help" });
    assert.equal(commandDuringRun.ok, false);
    assert.equal((commandDuringRun.error as { code: string }).code, "run-active");
    await client.request("cancel");
    await client.await((frame) =>
      frame.t === "event" && frame.e === "run"
      && (frame.event as { type: string }).type === "run-end");

    // 2. submit while Settings is open. The dashboard cannot reach this
    // state at all — Settings owns the screen — and the registry's
    // `runActive` locking assumes it is entered before a run.
    await openDesktopSettings(client);
    const duringSettings = await client.request("submit", { text: "hello" });
    assert.equal(duringSettings.ok, false);
    assert.equal((duringSettings.error as { code: string }).code, "settings-open");
    assert.match(String((duringSettings.error as { message: string }).message), /Settings is open/);
    await client.request("settings.close");
    await client.await((frame) => frame.t === "event" && frame.e === "settings.closed");

    // 3. submit while a question from a previous command is unanswered.
    const clearing = client.request("command", { raw: "/clear" });
    const ask = await client.await((frame) => frame.t === "ask" && frame.kind === "confirm");
    const duringAsk = await client.request("submit", { text: "hello" });
    assert.equal(duringAsk.ok, false);
    assert.equal((duringAsk.error as { code: string }).code, "question-pending");
    // …and a second command cannot interleave with the first one's guiOut.
    // Both blockers are true here (a command holds the lane AND a question is
    // open); the refusal names the more specific one, because only it tells
    // the owner what to do about it.
    const secondCommand = await client.request("command", { raw: "/help" });
    assert.equal(secondCommand.ok, false);
    assert.equal((secondCommand.error as { code: string }).code, "question-pending");
    client.send({ t: "answer", askId: ask.askId, accepted: false });
    assert.equal((await clearing).ok, true);
  });
});

test("the exclusions run both ways: Settings and commands guard each other", async () => {
  await withClient("cancel-on-eof", async (client) => {
    await client.handshake();

    // 1. Settings during a run — the mirror of round 1's "submit during
    // Settings", and the state the registry's runActive locking is never
    // entered for.
    await client.request("submit", { text: "start something long" });
    await client.await((frame) =>
      frame.t === "event" && frame.e === "run"
      && (frame.event as { type: string }).type === "run-start");
    const settingsDuringRun = await client.request("settings.open");
    assert.equal(settingsDuringRun.ok, false);
    assert.equal((settingsDuringRun.error as { code: string }).code, "run-active");
    await client.request("cancel");
    await client.await((frame) =>
      frame.t === "event" && frame.e === "run"
      && (frame.event as { type: string }).type === "run-end");

    // 2. A command while Settings owns the session.
    const settings = await openDesktopSettings(client);
    const commandDuringSettings = await client.request("command", { raw: "/help" });
    assert.equal(commandDuringSettings.ok, false);
    assert.equal((commandDuringSettings.error as { code: string }).code, "settings-open");

    // 3. `settings.open` racing itself: the flag is claimed synchronously by
    // the handler, not in `begin()` after an await, so the second request
    // cannot start a second controller on one context.
    const second = await client.request("settings.open");
    assert.equal(second.ok, false);
    assert.equal((second.error as { code: string }).code, "settings-open");

    // 4. A command while an editor ask is unanswered.
    const glyph = requireDesktopSettingsRow(settings, "Terminalzeichen");
    const activated = client.request("settings.dispatch", {
      intent: { kind: "activate-row", handle: glyph.handle, revision: settings.revision },
    });
    const editor = await client.await((frame) =>
      frame.t === "ask" && frame.kind === "settings-editor");
    const duringEditor = await client.request("command", { raw: "/help" });
    assert.equal(duringEditor.ok, false);
    assert.equal((duringEditor.error as { code: string }).code, "question-pending");
    client.send({ t: "answer", askId: editor.askId, decision: { kind: "cancel" } });
    assert.equal((await activated).ok, true);
    await client.request("settings.close");
  });
});

test("a turn-mutating command tells the client to resync", async () => {
  await withClient("default", async (client) => {
    await client.handshake();
    // A chat with turns, so a clear has something to remove.
    const listed = await client.request("chats.list");
    const prior = (listed.result as { chats: { id: string; title: string }[] }).chats
      .find((chat) => chat.title === "Prior GUI Chat");
    assert.ok(prior);
    await client.request("chat.open", { chatId: prior.id });
    assert.equal(
      (await client.request("status.get")).ok,
      true,
    );

    const clearing = client.request("command", { raw: "/clear" });
    const ask = await client.await((frame) => frame.t === "ask" && frame.kind === "confirm");
    client.send({ t: "answer", askId: ask.askId, accepted: true });
    assert.equal((await clearing).ok, true);

    // The dashboard answers `/clear` with `ui.loadTurns([])`; this is that
    // answer, derived from what the session holds rather than from the
    // command's name.
    const reset = await client.await((frame) => frame.t === "event" && frame.e === "chat.reset");
    assert.equal(reset.reason, "cleared");
    assert.equal(reset.turnCount, 0);
    assert.deepEqual(reset.turns, []);
    assert.equal(reset.chatId, prior.id);
  });
});

test("the palette is served from the catalog, with the terminal's own verbs", async () => {
  await withClient("default", async (client) => {
    await client.handshake();

    const root = await client.request("catalog.level", { path: [] });
    const level = root.result as {
      crumb: string[];
      total: number;
      rows: { name: string; verb: string; command?: string }[];
    };
    assert.deepEqual(level.crumb, ["Commands"]);
    assert.equal(level.rows.length, level.total);
    // The six root groups browse; none of them is a command.
    assert.ok(level.rows.every((row) => row.verb === "open" && row.command === undefined));

    const workspace = await client.request("catalog.level", { path: ["Workspace"] });
    const inside = workspace.result as {
      crumb: string[];
      rows: { command?: string; verb: string; usage?: string }[];
    };
    assert.deepEqual(inside.crumb, ["Commands", "Workspace"]);
    const undo = inside.rows.find((row) => row.command === "/undo");
    // FIX-11's rule, over the wire: `/undo [--dry-run]` takes arguments, so
    // Enter fills the composer instead of running it and eating the flag.
    assert.equal(undo?.verb, "insert");
    assert.equal(undo?.usage, "/undo [--dry-run]");
    assert.equal(inside.rows.find((row) => row.command === "/diff")?.verb, "run");

    const search = await client.request("catalog.search", { query: "swap" });
    const found = search.result as { crumb: string[]; rows: { command?: string; verb: string }[] };
    // A search reaches every leaf, so it states no location.
    assert.deepEqual(found.crumb, ["Commands"]);
    assert.equal(found.rows.find((row) => row.command === "/cross swap")?.verb, "run");

    const co = await client.request("catalog.search", { query: "co" });
    const coRows = (co.result as { rows: Array<{ usage?: string; command?: string; presentation: { description: string; actionLabel: string } }> }).rows;
    assert.deepEqual(coRows.map((row) => row.command), ["/compress", "/context", "/cost", "/cross"]);
    assert.ok(coRows.every((row) => !/\b(run|insert|open)\b/i.test(`${row.presentation.description} ${row.presentation.actionLabel}`)));
  });
});

test("/undo reaches the real command, and answers with the core's own words", async () => {
  await withClient("default", async (client) => {
    await client.handshake();
    // The window sends a leading-slash line as a `command`, exactly as the
    // dashboard dispatches one. Nothing was run in this fixture chat, so the
    // honest answer is the core's own sentence — never a model prompt, and
    // never a fabricated success.
    const answered = await client.request("command", { raw: "/undo" });
    assert.equal(answered.ok, true);
    assert.deepEqual(answered.result, { outcome: "continue" });
    const output = client.events("command-output").at(-1);
    assert.equal(output?.raw, "/undo");
    assert.deepEqual(output?.lines, ["No completed run to undo in this chat."]);
    // And no confirmation was ever asked, because there was nothing to confirm.
    assert.equal(client.frames.some((frame) => frame.t === "ask"), false);
  });
});

test("a slash line is never a paid message, whatever the client does", async () => {
  const client = await withClient("default", async (client) => {
    await client.handshake();
    // The reviewer's own probe: the shipped server used to answer
    // `{started:true}` here and run a model. In the terminal an idle slash
    // line can never become a message, and the wire — not one window's `if`
    // — is where that guarantee has to live.
    const refused = await client.request("submit", { text: "/undo" });
    assert.equal(refused.ok, false);
    const error = refused.error as { code: string; message: string; hint?: string };
    assert.equal(error.code, "slash-as-message");
    assert.match(error.message, /is a command, not a message/);
    assert.match(String(error.hint), /command request/);
    // Nothing was started, nothing streamed, nothing was spent.
    assert.equal(client.events("run").length, 0);
    assert.equal(client.events("assistant").length, 0);
    const status = (await client.request("status.get")).result as {
      runActive: boolean;
      sessionUsd: number;
    };
    assert.equal(status.runActive, false);
    assert.equal(status.sessionUsd, 0);

    // Mid-run, the terminal feeds every line — slash included — to the
    // running task as an interjection (`!runOwnsTheLine &&`). So `interject`
    // stays permissive: this is parity, not a hole.
    const interjected = await client.request("interject", { text: "/undo" });
    assert.equal(interjected.ok, false);
    assert.equal((interjected.error as { code: string }).code, "no-run");
  });
  // And the model was never reached.
  assert.equal(client.result()?.agentCalls, 0);
});

test("a slash line on an ARMED chat cannot launch the two-model run", async () => {
  const client = await withClient("cross-armed", async (client) => {
    await client.handshake();
    // The worst variant the review named: the armed branch precedes any
    // slash check, so `submit({text:"/cross off"})` from a buggy client
    // would have started a paid Cross run with the command as the task.
    const refused = await client.request("submit", { text: "/cross off" });
    assert.equal(refused.ok, false);
    assert.equal((refused.error as { code: string }).code, "slash-as-message");
    // No echo, no run, and the chat is still armed — nothing was spent. (The
    // one transcript line that IS there is the startup "this chat is armed"
    // notice, which the plain loop prints for the same reason.)
    assert.equal(
      client.events("transcript").filter((frame) => frame.role === "user").length,
      0,
    );
    assert.equal(client.events("run").length, 0);
  });
  assert.equal(client.result()?.agentCalls, 0);
  assert.deepEqual(client.result()?.crossModeAfter, { oneShot: false });
});

test("an armed chat routes a plain message through the Cross pair, echoed once", async () => {
  const client = new GuiClient("cross-armed");
  try {
    await client.handshake();
    const started = await client.request("submit", { text: "make the parser strict" });
    assert.equal(started.ok, true);
    // The armed branch answers with its own shape, so a client can tell a
    // Cross dispatch from a single-model run.
    assert.deepEqual(started.result, { started: true, cross: true });

    const crossCatalog = await client.request("catalog.search", { query: "cross" });
    const crossRows = (crossCatalog.result as {
      rows: Array<{ command?: string; presentation: { disabled?: { code: string } } }>;
    }).rows;
    const disabledCode = (command: string): string | undefined =>
      crossRows.find((row) => row.command === command)?.presentation.disabled?.code;
    for (const command of ["/cross status", "/cross stop", "/cross off"]) {
      assert.equal(disabledCode(command), undefined, `${command} must remain available`);
    }
    for (const command of ["/cross run", "/cross models", "/cross swap"]) {
      assert.equal(disabledCode(command), "cross-run-active", `${command} must stay blocked`);
    }
    const quitCatalog = await client.request("catalog.search", { query: "quit" });
    const quitRow = (quitCatalog.result as {
      rows: Array<{ command?: string; presentation: { disabled?: { code: string } } }>;
    }).rows.find((row) => row.command === "/quit");
    assert.equal(quitRow?.presentation.disabled, undefined, "/quit must remain available");

    // FIX-19 finding 6: the message is echoed on the SUBMIT, once — a
    // multi-model run the owner is paying for must not be invisible until it
    // lands, and a blocked run publishes a notice rather than a turn.
    const echoes = client.events("transcript")
      .filter((frame) => frame.role === "user" && frame.content === "make the parser strict");
    assert.equal(echoes.length, 1);

    // While it runs, the lane is held: the same exclusion a single-model run
    // gets, named for what actually blocks it.
    const blocked = await client.request("submit", { text: "and again" });
    assert.equal(blocked.ok, false);
    assert.equal((blocked.error as { code: string }).code, "cross-run-active");
    const wrongCommand = await client.request("command", { raw: "/diff", draft: "" });
    assert.equal(wrongCommand.ok, false);
    assert.equal((wrongCommand.error as { code: string }).code, "cross-run-active");
    assert.match(
      (wrongCommand.error as { message: string }).message,
      /^Cross is already running\. Only \/cross status, \/cross stop, \/cross off, and \/quit are available while it runs\.$/,
    );
    // And the four that survive are reachable rather than refused generically.
    const survivor = await client.request("command", { raw: "/cross status", draft: "" });
    assert.equal(survivor.ok, true);

    // Fix round 1: the shell goes away mid-Cross. A Cross run is not
    // `state.runActive`, so teardown used to walk straight past it and the
    // two workers kept spending into a pipe nobody reads. EOF must stop it
    // and the process must end inside the drain bound — measured, because
    // this exact case hung the first draft of this pin.
    const began = Date.now();
    const code = await client.endInput();
    const elapsed = Date.now() - began;
    assert.equal(code, 0, `exit code ${code} after ${elapsed}ms`);
    assert.ok(elapsed < 15_000, `EOF took ${elapsed}ms to end a Cross run`);
  } finally {
    await client.stop();
  }
});

test("an armed GUI Kimi pair denied before its private claim restores its draft without an echo", async () => {
  const client = new GuiClient("cross-kimi-missing-claim");
  try {
    await client.handshake();
    const task = "keep this exact Kimi draft";

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const mark = client.mark();
      const started = await client.request("submit", { text: task });
      assert.deepEqual(started.result, { started: true, cross: true });
      const restored = await client.awaitAfter(mark, (frame) =>
        frame.t === "event" && frame.e === "draft" && frame.text === task);
      assert.deepEqual(
        { text: restored.text, reason: restored.reason },
        { text: task, reason: "fallback" },
      );
      await client.awaitAfter(mark, (frame) =>
        frame.t === "event" && frame.e === "transcript" && frame.role === "error");
      assert.equal(
        client.frames.slice(mark).filter((frame) =>
          frame.t === "event" && frame.e === "transcript"
          && frame.role === "user" && frame.content === task).length,
        0,
        `attempt ${attempt} must not retain or consume a stale echo marker`,
      );
    }

    assert.equal(client.events("draft").filter((frame) => frame.text === task).length, 2);
    assert.equal(client.events("native-local-action-required").length, 0);
    assert.equal(client.frames.filter((frame) => frame.t === "ask").length, 0);
    await client.endInput();
  } finally {
    await client.stop();
  }

  assert.equal(client.result()?.agentCalls, 0);
  assert.equal(client.result()?.crossWorkersStarted, 0);
  assert.equal(client.result()?.providerCredentialCalls, 0);
  assert.equal(client.result()?.genericCredentialCalls, 0);
  assert.equal(client.result()?.sessionCostUsd, 0);
});

test("a bare /cross never presents the last message as the task", async () => {
  await withClient("cross", async (client) => {
    await client.handshake();
    // A plain message, answered. In the terminal this writes NO draft: the
    // draft slot is one-shot and only the palette fills it.
    await client.request("submit", { text: "message A" });
    await client.await((frame) =>
      frame.t === "event" && frame.e === "run"
      && (frame.event as { type?: string }).type === "run-end");

    // Now a bare `/cross`, typed — the composer held the command itself, so
    // there is no separate draft.
    const opening = client.request("command", { raw: "/cross", draft: "" });
    const gate = await client.await((frame) => frame.t === "ask" && frame.kind === "choice");
    const items = gate.items as { value: string; description: string }[];
    const everything = items.map((item) => item.description).join(" | ");
    // The defect this pins: the gate priced and offered to re-run the
    // message the model had already answered.
    assert.equal(everything.includes("message A"), false, everything);
    // What the terminal shows instead: an EMPTY draft, treated as one — the
    // continuation task where there is history, the pending one-shot preview
    // where there is not. Either is the honest reading; the message text is
    // not.
    assert.match(String(gate.task), /continue the current chat|waiting for your first message/);

    client.send({ t: "answer", askId: gate.askId, value: null });
    assert.equal((await opening).ok, true);
    // Nothing to put back — there was nothing captured and nothing typed.
    assert.equal(client.events("draft").length, 0);
  });
});

test("a captured draft is consumed once and handed back when the gate is abandoned", async () => {
  await withClient("cross", async (client) => {
    await client.handshake();
    // What the palette does: it replaces the composer with `/cross` and
    // carries the bytes that were there. One capture, one read.
    const opening = client.request("command", { raw: "/cross", draft: "rewrite the parser" });
    const gate = await client.await((frame) => frame.t === "ask" && frame.kind === "choice");
    // With a real task there is no continuation preview — the owner can see
    // what they typed.
    assert.equal(gate.task, "rewrite the parser");

    client.send({ t: "answer", askId: gate.askId, value: null });
    assert.equal((await opening).ok, true);
    // Abandoned: the captured text comes back, exactly as
    // `restoreCrossCommandDraft` puts it back in the terminal.
    const restored = client.events("draft").at(-1);
    assert.equal(restored?.text, "rewrite the parser");
    assert.equal(restored?.reason, "restore");

    // ONE-SHOT: a second bare `/cross` must not see it again.
    const again = client.request("command", { raw: "/cross", draft: "" });
    const second = await client.await(
      (frame) => frame.t === "ask" && frame.kind === "choice" && frame.askId !== gate.askId,
    );
    assert.equal(String(second.task).includes("rewrite the parser"), false);
    client.send({ t: "answer", askId: second.askId, value: null });
    assert.equal((await again).ok, true);
  });
});

test("a refused command leaves the draft slot exactly as it found it", async () => {
  await withClient("cross", async (client) => {
    await client.handshake();
    // A multi-line slash line is refused — and the refusal must not have
    // armed the slot on its way out (the guard runs first).
    const refused = await client.request("command", {
      raw: "/cross\nand more",
      draft: "keep me",
    });
    assert.equal(refused.ok, false);
    assert.equal((refused.error as { code: string }).code, "multiline-command");

    const opening = client.request("command", { raw: "/cross", draft: "" });
    const gate = await client.await((frame) => frame.t === "ask" && frame.kind === "choice");
    assert.equal(String(gate.task).includes("keep me"), false, String(gate.task));
    client.send({ t: "answer", askId: gate.askId, value: null });
    assert.equal((await opening).ok, true);
  });
});

test("the Desktop Cross preflight starts with no implicit route, duration or price claim", async () => {
  const client = await withClient("cross", async (client) => {
    await client.handshake();
    // G1 left `/cross` refused because no Cross runtime was wired. It is the
    // dashboard's own runtime now, through the dashboard's own gate surface.
    const opening = client.request("command", { raw: "/cross", draft: "rewrite the parser" });
    const gate = await client.await((frame) => frame.t === "ask" && frame.kind === "choice");
    assert.equal(gate.title, "Cross einrichten");
    assert.equal(gate.presentation, "cross-preflight");
    const items = gate.items as {
      value: string;
      label: string;
      description: string;
      descriptionParts?: string[];
    }[];
    assert.deepEqual(items.map((item) => item.value), [
      "coding",
      "review",
      "swap",
      "duration-one-task",
      "duration-chat",
      "start",
    ]);
    // Task 5B: even valid saved preferences do not become an implicit choice.
    assert.equal(items[0]?.label, "Lead auswählen");
    assert.equal(items[0]?.description, "Nicht ausgewählt");
    assert.equal(items[1]?.label, "Challenger auswählen");
    assert.equal(items[1]?.description, "Nicht ausgewählt");
    const projected = await client.await((frame) => frame.t === "event" && frame.e === "cross"
      && (frame.preflight as { duration?: unknown } | null)?.duration === null);
    assert.deepEqual(projected.preflight, {
      lead: null,
      challenger: null,
      duration: null,
      estimatedCalls: { min: 4, max: 6 },
      cost: { kind: "unknown", label: "Kosten unbekannt" },
      startDisabled: {
        code: "cross-selection-incomplete",
        label: "Lead, Challenger und Dauer auswählen",
        recoveryLabel: "Beide Modelle und Dauer wählen",
      },
    });

    // Cancelling the gate hands the task text back rather than eating it
    // (FIX-20 finding 6) — and nothing was started.
    client.send({ t: "answer", askId: gate.askId, value: null });
    assert.equal((await opening).ok, true);
    const restored = client.events("draft").at(-1);
    assert.equal(restored?.text, "rewrite the parser");
  });
  // The gate rendered model names; no fingerprint reached the wire.
  assert.equal(client.stdout.includes("acct_or_SECRETCROSS"), false);
});

test("Desktop Cross keeps duration explicit, confirms both roles, then starts the exact pair", async () => {
  const client = await withClient("cross-preflight", async (client) => {
    await client.handshake();
    const runEventsBefore = client.events("run").length;
    const opening = client.request("command", { raw: "/cross", draft: "rewrite the parser" });
    let gate = await client.await((frame) => frame.t === "ask" && frame.kind === "choice"
      && frame.presentation === "cross-preflight");

    let mark = client.mark();
    client.send({ t: "answer", askId: gate.askId, value: "duration-one-task" });
    gate = await client.awaitAfter(mark, (frame) => frame.t === "ask" && frame.kind === "choice"
      && frame.presentation === "cross-preflight");
    const durationOnly = await client.awaitAfter(mark, (frame) => frame.t === "event"
      && frame.e === "cross"
      && (frame.preflight as { duration?: unknown } | null)?.duration === "one-task");
    assert.equal((durationOnly.preflight as { startDisabled: { code: string } }).startDisabled.code, "cross-selection-incomplete");

    mark = client.mark();
    client.send({ t: "answer", askId: gate.askId, value: "coding" });
    const leadPicker = await client.awaitAfter(mark, (frame) => frame.t === "ask"
      && frame.kind === "choice" && frame.presentation !== "cross-preflight");
    const leadItem = (leadPicker.items as Array<{ value: string; label: string; description: string }>)[0]!;
    const leadHandle = leadItem.value;
    mark = client.mark();
    client.send({ t: "answer", askId: leadPicker.askId, value: leadHandle });
    gate = await client.awaitAfter(mark, (frame) => frame.t === "ask" && frame.kind === "choice"
      && frame.presentation === "cross-preflight");

    mark = client.mark();
    client.send({ t: "answer", askId: gate.askId, value: "review" });
    const challengerPicker = await client.awaitAfter(mark, (frame) => frame.t === "ask"
      && frame.kind === "choice" && frame.presentation !== "cross-preflight");
    const challengerItem = (challengerPicker.items as Array<{ value: string; label: string; description: string }>)
      .find((item) => item.label !== leadItem.label);
    assert.ok(challengerItem, "the challenger must be an explicit different route");
    const challengerHandle = challengerItem.value;
    mark = client.mark();
    client.send({ t: "answer", askId: challengerPicker.askId, value: challengerHandle });
    gate = await client.awaitAfter(mark, (frame) => frame.t === "ask" && frame.kind === "choice"
      && frame.presentation === "cross-preflight");
    const ready = await client.awaitAfter(mark, (frame) => frame.t === "event" && frame.e === "cross"
      && frame.preflight !== null);
    const preflight = ready.preflight as {
      lead: {
        providerLabel: string;
        displayName: string;
        accountLabel: string;
        canonicalModelId: string;
        reasoning: string;
        capabilities: string[];
      };
      challenger: {
        providerLabel: string;
        displayName: string;
        accountLabel: string;
        canonicalModelId: string;
        reasoning: string;
        capabilities: string[];
      };
      duration: string;
      startDisabled: unknown;
    };
    assert.equal(preflight.startDisabled, null);
    assert.equal(preflight.duration, "one-task");
    assert.equal(
      preflight.lead.displayName,
      preflight.challenger.displayName,
      "display copy alone is deliberately ambiguous in this fixture",
    );
    assert.notEqual(
      preflight.lead.canonicalModelId,
      preflight.challenger.canonicalModelId,
      "the exact chosen models still differ",
    );
    const leadPresentation = `${preflight.lead.providerLabel} · ${preflight.lead.accountLabel} · ${preflight.lead.displayName} · ${preflight.lead.canonicalModelId}`;
    const challengerPresentation = `${preflight.challenger.providerLabel} · ${preflight.challenger.accountLabel} · ${preflight.challenger.displayName} · ${preflight.challenger.canonicalModelId}`;
    assert.equal(leadItem.label, leadPresentation);
    assert.equal(challengerItem.label, challengerPresentation);
    assert.match(String(leadItem.description), /Denkmodus: unterstützt/);
    assert.match(String(leadItem.description), /Fähigkeiten: Text · Werkzeuge/);

    mark = client.mark();
    client.send({ t: "answer", askId: gate.askId, value: "start" });
    const confirm = await client.awaitAfter(mark, (frame) => frame.t === "ask" && frame.kind === "confirm");
    assert.equal(confirm.title, "Cross starten?");
    assert.match(String(confirm.consequence), new RegExp(`Lead: ${leadPresentation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(String(confirm.consequence), new RegExp(`Challenger: ${challengerPresentation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(String(confirm.consequence), /Denkmodus: unterstützt/);
    assert.match(String(confirm.consequence), /Fähigkeiten: Text · Werkzeuge/);
    assert.match(String(confirm.consequence), /Dauer: Nur diese Aufgabe/);
    assert.match(String(confirm.consequence), /4–6 Modellaufrufe je Aufgabe/);
    assert.match(String(confirm.consequence), /Kosten unbekannt|Mindestens \$/);
    assert.equal(confirm.defaultAccept, false);

    mark = client.mark();
    client.send({ t: "answer", askId: confirm.askId, accepted: true });
    assert.equal((await opening).ok, true);
    const active = await client.awaitAfter(mark, (frame) => frame.t === "event" && frame.e === "cross"
      && (frame.state as { active?: boolean } | null)?.active === true);
    const activeState = active.state as {
      active: boolean;
      lead: typeof preflight.lead;
      challenger: typeof preflight.challenger;
      phase: string;
    };
    assert.equal(activeState.active, true);
    assert.deepEqual(activeState.lead, {
      providerLabel: preflight.lead.providerLabel,
      accountLabel: preflight.lead.accountLabel,
      displayName: preflight.lead.displayName,
      canonicalModelId: preflight.lead.canonicalModelId,
      reasoning: preflight.lead.reasoning,
      capabilities: preflight.lead.capabilities,
    });
    assert.deepEqual(activeState.challenger, {
      providerLabel: preflight.challenger.providerLabel,
      accountLabel: preflight.challenger.accountLabel,
      displayName: preflight.challenger.displayName,
      canonicalModelId: preflight.challenger.canonicalModelId,
      reasoning: preflight.challenger.reasoning,
      capabilities: preflight.challenger.capabilities,
    });
    assert.notEqual(activeState.phase, "", "the live panel carries the coordinator's current phase");
    const activeJson = JSON.stringify(activeState);
    for (const privateField of ["providerId", "connectionId", "accountFingerprint", "backendId", "billingRealm"]) {
      assert.equal(activeJson.includes(`\"${privateField}\"`), false, `${privateField} must not cross the wire`);
    }
    assert.equal(client.events("run").length, runEventsBefore, "Cross uses its coordinator lane, not a single-model run");
  });
  assert.equal(client.result()?.crossPreferencePublishes, 1);
  assert.equal(client.result()?.crossWorkersStarted, 2, "both confirmed routes reached the coordinator");
});

test("declining the final Desktop Cross confirmation restores the draft with zero effects", async () => {
  const client = await withClient("cross-preflight", async (client) => {
    await client.handshake();
    const draft = "keep this exact draft";
    const opening = client.request("command", { raw: "/cross", draft });
    let gate = await client.await((frame) => frame.t === "ask" && frame.kind === "choice"
      && frame.presentation === "cross-preflight");

    let mark = client.mark();
    client.send({ t: "answer", askId: gate.askId, value: "duration-chat" });
    gate = await client.awaitAfter(mark, (frame) => frame.t === "ask" && frame.kind === "choice"
      && frame.presentation === "cross-preflight");

    let leadLabel: string | null = null;
    for (const role of ["coding", "review"] as const) {
      mark = client.mark();
      client.send({ t: "answer", askId: gate.askId, value: role });
      const picker = await client.awaitAfter(mark, (frame) => frame.t === "ask"
        && frame.kind === "choice" && frame.presentation !== "cross-preflight");
      const selected = (picker.items as Array<{ value: string; label: string }>).find((item) =>
        role === "coding" || item.label !== leadLabel);
      assert.ok(selected);
      if (role === "coding") leadLabel = selected.label;
      mark = client.mark();
      client.send({ t: "answer", askId: picker.askId, value: selected.value });
      gate = await client.awaitAfter(mark, (frame) => frame.t === "ask" && frame.kind === "choice"
        && frame.presentation === "cross-preflight");
    }

    mark = client.mark();
    client.send({ t: "answer", askId: gate.askId, value: "start" });
    const confirm = await client.awaitAfter(mark, (frame) => frame.t === "ask" && frame.kind === "confirm");
    mark = client.mark();
    client.send({ t: "answer", askId: confirm.askId, accepted: false });
    assert.equal((await opening).ok, true);
    const restored = await client.awaitAfter(mark, (frame) => frame.t === "event"
      && frame.e === "draft" && frame.text === draft);
    assert.equal(restored.reason, "restore");
  });
  assert.equal(client.result()?.crossPreferencePublishes, 0);
  assert.equal(client.result()?.sessionArmCalls, 0);
  assert.equal(client.result()?.crossWorkersStarted, 0);
});

test("chat.delete asks the command's own danger question, and a decline keeps the chat", async () => {
  await withClient("default", async (client) => {
    await client.handshake();
    const listed = await client.request("chats.list");
    const rows = (listed.result as { chats: { id: string; title: string }[] }).chats;
    const prior = rows.find((chat) => chat.title === "Prior GUI Chat");
    const foreign = rows.find((chat) => chat.title === "Chat In Another Folder");
    assert.ok(prior);
    assert.ok(foreign);

    // Deletion happens in the chat's own folder — the same lookup the
    // command performs decides that, so a row this folder cannot reach is
    // refused by name instead of being deleted from afar.
    const refused = await client.request("chat.delete", { chatId: foreign.id });
    assert.equal(refused.ok, false);
    assert.equal((refused.error as { code: string }).code, "foreign-chat");
    assert.match(String((refused.error as { hint: string }).hint), /open it first/);

    // Open the one this folder owns, then delete it — the path the refusal
    // above points at.
    await client.request("chat.open", { chatId: prior.id });

    // Declined first: cancel-never-success, and the chat is still there.
    const declining = client.request("chat.delete", { chatId: prior.id });
    const question = await client.await((frame) => frame.t === "ask" && frame.kind === "confirm");
    // The command's own copy, word for word — this request is a front door
    // onto `/chat delete`, not a second deletion path with its own wording.
    assert.equal(question.title, `Permanently delete chat "${prior.title}"?`);
    assert.match(String(question.consequence), /^Chat ID: /);
    assert.match(
      String(question.consequence),
      /Transcript, SDK state, run logs, checkpoints, journals, and task sidecars will be deleted\./,
    );
    // D4: destructive, so Enter must not accept.
    assert.equal(question.danger, true);
    assert.equal(question.defaultAccept, false);
    client.send({ t: "answer", askId: question.askId, accepted: false });
    const declined = await declining;
    assert.equal(declined.ok, true);
    assert.deepEqual(declined.result, { deleted: false, chatId: prior.id });
    const stillThere = await client.request("chats.list");
    assert.equal(
      (stillThere.result as { chats: { id: string }[] }).chats.some((chat) => chat.id === prior.id),
      true,
    );

    // Accepted: gone, and reported as gone because the store says so — never
    // because the answer was yes.
    const deleting = client.request("chat.delete", { chatId: prior.id });
    const again = await client.await(
      (frame) => frame.t === "ask" && frame.kind === "confirm" && frame.askId !== question.askId,
    );
    client.send({ t: "answer", askId: again.askId, accepted: true });
    const deleted = await deleting;
    assert.deepEqual(deleted.result, { deleted: true, chatId: prior.id });
    const after = await client.request("chats.list");
    assert.equal(
      (after.result as { chats: { id: string }[] }).chats.some((chat) => chat.id === prior.id),
      false,
    );
  });
});

test("the cost forecast is silence, a hedge or a band — never a guess", async () => {
  await withClient("default", async (client) => {
    await client.handshake();
    // No resolved model info yet, and nothing typed: no segment at all.
    const empty = await client.request("cost.forecast", { draftChars: 0 });
    assert.deepEqual(empty.result, { kind: "none" });
    const beforeAnyRun = await client.request("cost.forecast", { draftChars: 400 });
    assert.deepEqual(beforeAnyRun.result, { kind: "none" });

    // One run resolves the model info the dashboard's own status line reads.
    await client.request("submit", { text: "write the notes" });
    await client.await((frame) =>
      frame.t === "event" && frame.e === "run"
      && (frame.event as { type?: string }).type === "run-end");

    const band = await client.request("cost.forecast", { draftChars: 400 });
    const forecast = band.result as { kind: string; text?: string; minUsd?: number; maxUsd?: number };
    assert.equal(forecast.kind, "band", JSON.stringify(band));
    // `formatCostForecastBand`'s own wording, whatever it is — the window
    // renders the string it was given rather than formatting money itself.
    assert.equal(
      typeof forecast.text === "string" && forecast.text.startsWith("~"),
      true,
      `text: ${JSON.stringify(forecast)}`,
    );
    assert.equal((forecast.minUsd ?? 0) > 0, true, `min: ${JSON.stringify(forecast)}`);
    assert.equal(
      (forecast.maxUsd ?? 0) >= (forecast.minUsd ?? 0),
      true,
      `max: ${JSON.stringify(forecast)}`,
    );
    // Longer draft, larger floor — it is priced, not a constant.
    const longer = await client.request("cost.forecast", { draftChars: 40_000 });
    assert.equal(
      (longer.result as { minUsd: number }).minUsd > (forecast.minUsd ?? 0),
      true,
      `longer: ${JSON.stringify(longer.result)} vs ${JSON.stringify(forecast)}`,
    );
  });
});

test("the launcher's claim about the execution mode changes nothing", async () => {
  const client = await withClient("claimed-owner", async (client) => {
    await client.handshake();
    const status = (await client.request("status.get")).result as {
      executionMode: string;
      ownerPathsAllowed: boolean;
    };
    // The harness spawns over pipes, so the engine derives `piped` — and the
    // env var the shell sets is corroborating, never load-bearing.
    assert.equal(status.executionMode, "piped");
    assert.equal(status.ownerPathsAllowed, false);
    // Owner-only terminal policy is diagnostic state, not chat content.
    const notices = client.events("notice").map((frame) => String(frame.message));
    assert.deepEqual(notices, []);
  });
  assert.equal(client.stderr.includes("corroborating, not load-bearing"), true);
  assert.doesNotMatch(client.stderr, /Setting up Kimi Code|Recovering a non-OpenRouter credential/);
});

test("Desktop setup and Settings stay usable while startup inspection is pending", async () => {
  const client = await withClient("desktop-empty-startup-held", async (client) => {
    await client.handshake();
    await client.awaitStderr((text) => text.includes("ORCODE_GUI_GATE:startup-inspection-held"));
    const heldStatuses = client.events("status").map((frame) => String(frame.text));
    assert.equal(heldStatuses.at(-1), "Checking provider …", JSON.stringify(heldStatuses));
    assert.equal(heldStatuses.includes("Ready"), false, JSON.stringify(heldStatuses));
    let releaseMark = 0;
    try {
      const snapshotResponse = await client.request("desktop.snapshot.get");
      assert.equal(snapshotResponse.ok, true, JSON.stringify(snapshotResponse));
      const snapshot = (snapshotResponse.result as {
        snapshot: {
          revision: number;
          generation: number;
          routeRunnable: boolean;
          providers: Array<{
            providerId: string;
            disabled?: { code: string; label: string; recoveryLabel: string };
          }>;
        };
      }).snapshot;
      assert.equal(snapshot.routeRunnable, false);
      assert.deepEqual(snapshot.providers.find(({ providerId }) => providerId === "kimi-code")?.disabled, {
        code: "native-local-action-unavailable",
        label: "Kimi Code kann nur im lokalen Eigentümer-Terminal eingerichtet werden.",
        recoveryLabel: "Im lokalen Terminal öffnen",
      });

      const settingsMark = client.mark();
      const settings = await client.request("settings.open");
      assert.equal(settings.ok, true, JSON.stringify(settings));
      await client.awaitAfter(settingsMark, (frame) =>
        frame.t === "event" && frame.e === "settings.view");
      const closeMark = client.mark();
      assert.equal((await client.request("settings.close")).ok, true);
      await client.awaitAfter(closeMark, (frame) =>
        frame.t === "event" && frame.e === "settings.closed");

      const setup = await client.request("onboarding.dispatch", {
        intent: {
          kind: "open-model-picker",
          returnTo: "chat",
          revision: snapshot.revision,
          generation: snapshot.generation,
        },
      });
      assert.equal(setup.ok, true, JSON.stringify(setup));
      const view = (setup.result as {
        kind: string;
        view: { step: string; providers: readonly { providerId: string }[] };
      }).view;
      assert.equal(view.step, "provider");
      assert.deepEqual(view.providers.map(({ providerId }) => providerId), ["openrouter", "kimi-code"]);
      assert.equal(client.events("transcript").length, 0);
      assert.equal(client.events("notice").some((frame) =>
        /Setting up Kimi Code|Recovering a non-OpenRouter credential/.test(String(frame.message))), false);
    } finally {
      releaseMark = client.mark();
      client.child.kill("SIGUSR1");
    }
    const ready = await client.awaitAfter(releaseMark, (frame) =>
      frame.t === "event" && frame.e === "status" && frame.text === "Ready");
    assert.equal(ready.busy, false);
  });
  assert.equal(client.result()?.startupInspectionStarted, 1);
  assert.equal(client.result()?.startupInspectionReleased, 1);
  assert.equal(client.result()?.desktopSetupCalls, 0);
  assert.equal(client.result()?.desktopRefreshCalls, 0);
  assert.equal(client.result()?.desktopActivationCalls, 0);
  assert.equal(client.result()?.providerCredentialCalls, 0);
  assert.equal(client.result()?.agentCalls, 0);
});

test("model text cannot smuggle a direction override or a control code", async () => {
  const client = await withClient("default", async (client) => {
    await client.handshake();
    await client.request("submit", { text: "write the notes" });
    await client.await((frame) =>
      frame.t === "event" && frame.e === "run"
      && (frame.event as { type: string }).type === "run-end");
    await client.await((frame) => frame.t === "event" && frame.e === "suggestions");
  });

  // U+202E survives HTML escaping and reverses everything after it, so a
  // model — or a tool's output, or a filename in a diff — could display one
  // thing and mean another. The outbound choke point strips it, together
  // with C0/C1 and any ANSI the core let through.
  for (const hazard of ["\u202e", "\u0007", "\u001b["]) {
    assert.ok(
      !client.stdout.includes(hazard),
      `a control codepoint reached the wire: ${JSON.stringify(hazard)}`,
    );
  }
  // …and the surrounding text survived intact, in both the streamed answer
  // and the run union's own `text` event.
  const answer = client.events("assistant")
    .filter((frame) => frame.phase === "delta")
    .map((frame) => frame.delta as string)
    .join("");
  assert.equal(answer, "Hello world.");
  const textEvent = client.events("run")
    .map((frame) => frame.event as { type: string; delta?: string })
    .find((event) => event.type === "text");
  assert.equal(textEvent?.delta, "Hello world.");
});

test("the model picker mints its candidates core-side and answers by handle", async () => {
  const client = await withClient("default", async (client) => {
    await client.handshake();
    const before = (await client.request("status.get")).result as { model: string };

    const picking = client.request("command", { raw: "/model" });
    const ask = await client.await((frame) => frame.t === "ask" && frame.kind === "choice");
    const items = ask.items as { value: string; label: string; description: string }[];
    // The Desktop authority mints opaque handles; the GUI never re-indexes
    // them or receives a private route.
    assert.ok(items.length >= 1, `the picker offered nothing to choose: ${JSON.stringify(items)}`);
    for (const item of items) {
      assert.doesNotMatch(item.value, /^model-route:\d+$/);
      assert.equal("route" in item, false);
    }
    const serialized = JSON.stringify(ask);
    assert.ok(!serialized.includes("accountFingerprint"));
    assert.ok(!serialized.includes("acct_or_"));

    // Cancelling round-trips through the picker's own return path.
    client.send({ t: "answer", askId: ask.askId, value: null });
    assert.equal((await picking).ok, true);
    assert.equal(
      ((await client.request("status.get")).result as { model: string }).model,
      before.model,
    );

    // A handle the server never issued resolves to nothing: the candidate
    // table is the server's, and a client cannot name a route it was not
    // given one for.
    const forging = client.request("command", { raw: "/model" });
    const second = await client.await((frame) =>
      frame.t === "ask" && frame.kind === "choice" && frame.askId !== ask.askId);
    client.send({ t: "answer", askId: second.askId, value: "forged-authority-handle" });
    assert.equal((await forging).ok, true);
    assert.equal(
      ((await client.request("status.get")).result as { model: string }).model,
      before.model,
      "an unissued handle changed the active model",
    );
  });
  assert.equal(client.result()?.legacyRouteCatalogCalls, 0, "GUI /model reached the owner provider catalogue");
});

test("explicit GUI /model cannot discover a Desktop-disabled Kimi route through the owner catalogue", async () => {
  const client = await withClient("route-picker-kimi-trap", async (client) => {
    await client.handshake();
    assert.equal((await client.request("desktop.snapshot.get")).ok, true);
    const response = await client.request("command", { raw: "/model moonshotai/kimi-k3" });
    assert.equal(response.ok, false);
  });
  assert.equal(client.result()?.legacyRouteCatalogCalls, 0);
  assert.equal(client.result()?.terminalOwnerViewCalls, 0);
  assert.equal(client.result()?.terminalOwnerResolveCalls, 0);
  assert.equal(client.result()?.terminalOwnerAuthorityCalls, 0);
  assert.equal(client.result()?.desktopRoutePickerResolveCalls, 0);
  assert.equal(client.result()?.desktopAuthorityGetterCalls, 1);
  assert.deepEqual(client.result()?.modelTransitions, []);
  assert.equal(client.result()?.providerCredentialCalls, 0);
  assert.equal(client.result()?.crossPreferenceReads, 0);
  assert.equal(client.result()?.crossPreferencePublishes, 0);
  assert.equal(client.result()?.sessionArmCalls, 0);
  assert.deepEqual(client.result()?.desktopKimiDeltas, {
    catalogue: 0, credential: 0, setup: 0, refresh: 0, activation: 0,
    transcript: 0, agent: 0, cost: 0, ask: 0, activity: 0,
  });
  assert.equal(client.result()?.modelPreferenceAuthorityReads, 0);
  assert.equal(client.result()?.settingsPublicationPrepares, 0);
  assert.equal(client.result()?.ownerKimiRunnableBaseline, true);
  assert.equal(client.result()?.desktopDisabledKimiBindingProven, true);
  assert.doesNotMatch(JSON.stringify(client.frames), /KIMI_DESKTOP_PRIVATE_CANARY|KIMI_OWNER_PRIVATE_CANARY/);
  assert.doesNotMatch(client.stdout, /KIMI_DESKTOP_PRIVATE_CANARY|KIMI_OWNER_PRIVATE_CANARY/);
  assert.doesNotMatch(client.stderr, /KIMI_DESKTOP_PRIVATE_CANARY|KIMI_OWNER_PRIVATE_CANARY/);
  assert.equal(client.result()?.settingsPublicationPublishes, 0);
  assert.equal(client.result()?.sessionPublicationPrepares, 0);
  assert.equal(client.result()?.sessionPublicationPublishes, 0);
  assert.equal(client.result()?.crossPreferencePublishes, 0);
  assert.equal(client.result()?.transitionEntries, 0);
  assert.equal(client.result()?.adoptSessionCalls, 0);
  assert.equal(client.result()?.configMutationCalls, 0);
  assert.equal(client.result()?.genericCredentialCalls, 0);
  assert.deepEqual(client.result()?.credentialMethodCalls, { has: 0, get: 0, set: 0, delete: 0, reserveSlot: 0, readSlot: 0, writeSlot: 0, deleteSlot: 0, hmac: 0 });
  assert.equal(client.result()?.commandConfigBytesStable, true);
  assert.equal(client.result()?.commandSessionBytesStable, true);
  assert.equal(client.result()?.commandLiveConfigStable, true);
  assert.equal(client.result()?.commandLiveSessionStable, true);
});

test("explicit GUI model lookup never returns a partial account set across an authority epoch change", async () => {
  const client = await withClient("route-picker-atomic-ambiguity", async (client) => {
    await client.handshake();
    const response = await client.request("command", { raw: "/model vendor/gui-main" });
    assert.equal(response.ok, false);
  });
  assert.deepEqual(client.result()?.modelTransitions, []);
  assert.equal(client.result()?.atomicRaceInitialMatchingRows, 2);
  assert.equal(client.result()?.atomicRaceEpochChanges, 1);
  assert.equal(client.result()?.routePickerCaptureCalls, 3);
  assert.equal(client.result()?.desktopRoutePickerViewCalls, 1);
  assert.equal(client.result()?.desktopRoutePickerResolveCalls, 2);
  assert.equal(client.result()?.legacyRouteCatalogCalls, 0);
  assert.equal(client.result()?.modelPreferenceAuthorityReads, 0);
  assert.equal(client.result()?.settingsPublicationPrepares, 0);
  assert.equal(client.result()?.settingsPublicationPublishes, 0);
  assert.equal(client.result()?.sessionPublicationPrepares, 0);
  assert.equal(client.result()?.sessionPublicationPublishes, 0);
  assert.equal(client.result()?.crossPreferencePublishes, 0);
  assert.equal(client.result()?.transitionEntries, 0);
  assert.equal(client.result()?.configMutationCalls, 0);
  assert.equal(client.result()?.genericCredentialCalls, 0);
  assert.equal(client.result()?.providerCredentialCalls, 0);
  assert.deepEqual(client.result()?.credentialMethodCalls, { has: 0, get: 0, set: 0, delete: 0, reserveSlot: 0, readSlot: 0, writeSlot: 0, deleteSlot: 0, hmac: 0 });
  assert.equal(client.result()?.adoptSessionCalls, 0);
  assert.equal(client.result()?.commandConfigBytesStable, true);
  assert.equal(client.result()?.commandSessionBytesStable, true);
  assert.equal(client.result()?.commandLiveConfigStable, true);
  assert.equal(client.result()?.commandLiveSessionStable, true);
});

test("explicit GUI model lookup fails closed when only the final revalidation view drifts", async () => {
  const client = await withClient("route-picker-final-view-drift", async (client) => {
    await client.handshake();
    const response = await client.request("command", { raw: "/model vendor/gui-main" });
    assert.equal(response.ok, false);
  });
  assert.equal(client.result()?.desktopRoutePickerViewCalls, 2);
  assert.equal(client.result()?.desktopRoutePickerResolveCalls, 1);
  assert.equal(client.result()?.transitionEntries, 0);
  assert.equal(client.result()?.settingsPublicationPrepares, 0);
});

test("bare GUI /model shows but cannot resolve the Desktop-disabled Kimi row", async () => {
  const client = await withClient("route-picker-kimi-trap", async (client) => {
    await client.handshake();
    assert.equal((await client.request("desktop.snapshot.get")).ok, true);
    const command = client.request("command", { raw: "/model" });
    const ask = await client.await((frame) => frame.t === "ask" && frame.kind === "choice");
    const kimi = (ask.items as Array<Record<string, unknown>>).find((item) => String(item.label).includes("Kimi K3"));
    assert.ok(kimi);
    assert.deepEqual(Object.keys(kimi).sort(), ["description", "disabled", "label", "value"]);
    assert.equal(kimi.disabled, "Kimi Code kann nur im lokalen Eigentümer-Terminal eingerichtet werden.");
    client.send({ t: "answer", askId: ask.askId, value: kimi.value });
    assert.equal((await command).ok, true);
  });
  assert.equal(client.result()?.legacyRouteCatalogCalls, 0);
  assert.equal(client.result()?.terminalOwnerViewCalls, 0);
  assert.equal(client.result()?.terminalOwnerResolveCalls, 0);
  assert.equal(client.result()?.terminalOwnerAuthorityCalls, 0);
  assert.equal(client.result()?.desktopRoutePickerResolveCalls, 0);
  assert.equal(client.result()?.desktopAuthorityGetterCalls, 1);
  assert.deepEqual(client.result()?.modelTransitions, []);
  assert.equal(client.result()?.providerCredentialCalls, 0);
  assert.equal(client.result()?.ownerKimiRunnableBaseline, true);
  assert.equal(client.result()?.desktopKimiCanaryInjected, true);
  assert.equal(client.result()?.desktopDisabledKimiBindingProven, true);
  assert.deepEqual(client.result()?.desktopKimiDeltas, {
    catalogue: 0, credential: 0, setup: 0, refresh: 0, activation: 0,
    transcript: 0, agent: 0, cost: 0, ask: 1, activity: 0,
  });
  assert.equal(client.result()?.desktopSetupCalls, 0);
  assert.equal(client.result()?.desktopRefreshCalls, 0);
  assert.equal(client.result()?.desktopActivationCalls, 0);
  assert.equal(client.result()?.crossModeAfter, null);
  assert.equal(client.result()?.crossPreferenceReads, 0);
  assert.equal(client.result()?.crossPreferencePublishes, 0);
  assert.equal(client.result()?.sessionArmCalls, 0);
  assert.equal(client.result()?.modelPreferenceAuthorityReads, 0);
  assert.equal(client.result()?.settingsPublicationPrepares, 0);
  assert.equal(client.result()?.settingsPublicationPublishes, 0);
  assert.equal(client.result()?.transitionEntries, 0);
  assert.equal(client.result()?.adoptSessionCalls, 0);
  assert.equal(client.result()?.configMutationCalls, 0);
  assert.equal(client.result()?.genericCredentialCalls, 0);
  assert.deepEqual(client.result()?.credentialMethodCalls, { has: 0, get: 0, set: 0, delete: 0, reserveSlot: 0, readSlot: 0, writeSlot: 0, deleteSlot: 0, hmac: 0 });
  assert.equal(client.result()?.sessionPublicationPrepares, 0);
  assert.equal(client.result()?.sessionPublicationPublishes, 0);
  assert.equal(client.result()?.commandConfigBytesStable, true);
  assert.equal(client.result()?.commandSessionBytesStable, true);
  assert.equal(client.result()?.commandLiveConfigStable, true);
  assert.equal(client.result()?.commandLiveSessionStable, true);
  assert.doesNotMatch(JSON.stringify(client.frames), /KIMI_DESKTOP_PRIVATE_CANARY|KIMI_OWNER_PRIVATE_CANARY/);
  assert.doesNotMatch(client.stdout, /KIMI_DESKTOP_PRIVATE_CANARY|KIMI_OWNER_PRIVATE_CANARY/);
  assert.doesNotMatch(client.stderr, /KIMI_DESKTOP_PRIVATE_CANARY|KIMI_OWNER_PRIVATE_CANARY/);
});

test("both GUI model command forms fail closed when Desktop authority is absent despite runnable owner Kimi", async () => {
  for (const raw of ["/model", "/model moonshotai/kimi-k3"] as const) {
    const client = await withClient("route-picker-missing-desktop", async (client) => {
      await client.handshake();
      const mark = client.frames.length;
      await client.request("command", { raw });
      assert.equal(client.frames.slice(mark).some((frame) => frame.t === "ask"), false, raw);
    });
    assert.equal(client.result()?.ownerKimiRunnableBaseline, true, raw);
    assert.equal(client.result()?.terminalOwnerAuthorityCalls, 0, raw);
    assert.equal(client.result()?.terminalOwnerViewCalls, 0, raw);
    assert.equal(client.result()?.terminalOwnerResolveCalls, 0, raw);
    assert.equal(client.result()?.desktopRoutePickerViewCalls, 0, raw);
    assert.equal(client.result()?.desktopRoutePickerResolveCalls, 0, raw);
    assert.equal(client.result()?.desktopAuthorityGetterCalls, 1, raw);
    assert.equal(client.result()?.routePickerCaptureCalls, 0, raw);
    assert.equal(client.result()?.legacyRouteCatalogCalls, 0, raw);
    assert.deepEqual(client.result()?.modelTransitions, [], raw);
    assert.equal(client.result()?.modelPreferenceAuthorityReads, 0, raw);
    assert.equal(client.result()?.settingsPublicationPrepares, 0, raw);
    assert.equal(client.result()?.settingsPublicationPublishes, 0, raw);
    assert.equal(client.result()?.transitionEntries, 0, raw);
    assert.equal(client.result()?.adoptSessionCalls, 0, raw);
    assert.equal(client.result()?.configMutationCalls, 0, raw);
    assert.equal(client.result()?.providerCredentialCalls, 0, raw);
    assert.equal(client.result()?.desktopSetupCalls, 0, raw);
    assert.equal(client.result()?.desktopRefreshCalls, 0, raw);
    assert.equal(client.result()?.desktopActivationCalls, 0, raw);
    assert.equal(client.result()?.crossPreferenceReads, 0, raw);
    assert.equal(client.result()?.crossPreferencePublishes, 0, raw);
    assert.equal(client.result()?.sessionArmCalls, 0, raw);
    assert.equal(client.result()?.agentCalls, 0, raw);
    assert.equal(client.result()?.sessionCostUsd, 0, raw);
    assert.equal(client.result()?.crossModeAfter, null, raw);
    assert.equal(client.result()?.protocolAskFrames, 0, raw);
    assert.equal(client.result()?.protocolTranscriptFrames, 0, raw);
    assert.equal(client.result()?.protocolActivityFrames, 0, raw);
    assert.equal(client.result()?.genericCredentialCalls, 0, raw);
    assert.deepEqual(client.result()?.credentialMethodCalls, { has: 0, get: 0, set: 0, delete: 0, reserveSlot: 0, readSlot: 0, writeSlot: 0, deleteSlot: 0, hmac: 0 }, raw);
    assert.equal(client.result()?.sessionPublicationPrepares, 0, raw);
    assert.equal(client.result()?.sessionPublicationPublishes, 0, raw);
    assert.equal(client.result()?.commandConfigBytesStable, true, raw);
    assert.equal(client.result()?.commandSessionBytesStable, true, raw);
    assert.equal(client.result()?.commandLiveConfigStable, true, raw);
    assert.equal(client.result()?.commandLiveSessionStable, true, raw);
    assert.doesNotMatch(JSON.stringify(client.frames), /KIMI_DESKTOP_PRIVATE_CANARY|KIMI_OWNER_PRIVATE_CANARY/, raw);
    assert.doesNotMatch(client.stdout, /KIMI_DESKTOP_PRIVATE_CANARY|KIMI_OWNER_PRIVATE_CANARY/, raw);
    assert.doesNotMatch(client.stderr, /KIMI_DESKTOP_PRIVATE_CANARY|KIMI_OWNER_PRIVATE_CANARY/, raw);
  }
});

test("Settings GUI picker exposes authority handles and only public unknown policy labels", async () => {
  const client = await withClient("default", async (client) => {
    await client.handshake();
    const view = await openDesktopSettings(client);
    const picker = await openSharedSettingsPicker(client, view, "Hauptmodell");
    assert.equal(picker.step, "model");
    assert.ok(picker.candidates.length > 0);
    assert.ok(picker.candidates.every(({ handle }) => !/^model-route:\d+$/.test(handle)), "an index alias crossed the GUI boundary");
    assert.ok(picker.candidates.some(({ cost, dataPolicy }) =>
      cost.label === "Kosten unbekannt" || dataPolicy.label === "Datenrichtlinie unbekannt"));
    const serialized = JSON.stringify(picker);
    assert.doesNotMatch(serialized, /accountFingerprint|billingRealm|credential|PRIVATE_CANARY|routeIdentity/i);
    const restored = await cancelSharedSettingsPicker(client, picker);
    assert.equal(restored.selectedCategoryId, "model");
    await client.request("settings.close");
  });
  assert.equal(client.result()?.legacyRouteCatalogCalls, 0, "passive GUI picker called the legacy provider catalog");
  assert.equal(client.result()?.providerCredentialCalls, 0);
});

test("Settings GUI picker preserves the exact canonical mixed known and unknown policy presentations", async () => {
  await withClient("route-picker-known-policy", async (client) => {
    await client.handshake();
    const view = await openDesktopSettings(client);
    const picker = await openSharedSettingsPicker(client, view, "Hauptmodell");
    const candidates = picker.candidates;
    await cancelSharedSettingsPicker(client, picker);
    await client.request("settings.close");
    assert.ok(candidates.length > 0);
    assert.ok(candidates.every(({ cost }) => cost.kind === "known" && cost.label === "OpenRouter-Tarif"), JSON.stringify(candidates));
    assert.ok(candidates.every(({ dataPolicy }) =>
      dataPolicy.kind === "unknown" && dataPolicy.label === "Datenrichtlinie unbekannt"), JSON.stringify(candidates));
  });
});

test("Settings GUI rejects a stale canonical picker epoch without mutation", async () => {
  const client = await withClient("route-picker-reorder", async (client) => {
    await client.handshake();
    const view = await openDesktopSettings(client);
    const picker = await openSharedSettingsPicker(client, view, "Hauptmodell");
    const selected = picker.candidates[0]!.handle;
    assert.doesNotMatch(selected, /^model-route:\d+$/);
    const attemptedMark = client.mark();
    const attempted = await client.request("onboarding.dispatch", {
      intent: {
        kind: "choose-model",
        routeHandle: selected,
        revision: picker.revision + 1,
        generation: picker.generation,
        ...(picker.operationHandle ? { operationHandle: picker.operationHandle } : {}),
      },
    });
    const restored = desktopSettingsView(await client.awaitAfter(
      attemptedMark,
      (frame) => frame.t === "event" && frame.e === "settings.view",
    ));
    await client.request("settings.close");
    assert.equal(attempted.ok, false, JSON.stringify(attempted));
    assert.equal((attempted.error as { code: string }).code, "request-failed");
    assert.equal(restored.selectedCategoryId, "model");
  });
  assert.deepEqual(client.result()?.modelTransitions, []);
  assert.equal(client.result()?.providerCredentialCalls, 0);
  assert.equal(client.result()?.legacyRouteCatalogCalls, 0);
});

test("GUI Cross is bound to the Desktop authority and opening then cancelling is passive", async () => {
  const client = await withClient("cross", async (client) => {
    await client.handshake();
    const command = client.request("command", { raw: "/cross" });
    const gate = await client.await((frame) => frame.t === "ask" && frame.kind === "choice");
    client.send({ t: "answer", askId: gate.askId, value: null });
    assert.equal((await command).ok, true);
  });
  assert.ok(Number(client.result()?.routePickerCaptureCalls) >= 2);
  assert.equal(client.result()?.legacyRouteCatalogCalls, 0);
  assert.equal(client.result()?.providerCredentialCalls, 0);
});

test("Settings keeps the onboarding authority while Cross fails closed without its route-picker authority", async () => {
  const client = await withClient("route-picker-missing-desktop", async (client) => {
    await client.handshake();
    const view = await openDesktopSettings(client);
    const picker = await openSharedSettingsPicker(client, view, "Hauptmodell");
    assert.equal(picker.step, "model");
    assert.ok(picker.candidates.length > 0);
    const restored = await cancelSharedSettingsPicker(client, picker);
    assert.equal(restored.selectedCategoryId, "model");
    await client.request("settings.close");
    await client.request("command", { raw: "/cross absent desktop" });
  });
  assert.equal(client.result()?.terminalOwnerAuthorityCalls, 0);
  assert.equal(client.result()?.terminalOwnerViewCalls, 0);
  assert.equal(client.result()?.terminalOwnerResolveCalls, 0);
  assert.equal(client.result()?.providerCredentialCalls, 0);
  assert.equal(client.result()?.legacyRouteCatalogCalls, 0);
  assert.deepEqual(client.result()?.modelTransitions, []);
});

test("GUI Cross refuses a malicious disabled Kimi answer without consulting owner policy or effects", async () => {
  const client = await withClient("cross-kimi-desktop", async (client) => {
    await client.handshake();
    const command = client.request("command", { raw: "/cross" });
    const gate = await client.await((frame) => frame.t === "ask" && frame.kind === "choice");
    const afterGate = client.mark();
    client.send({ t: "answer", askId: gate.askId, value: "coding" });
    const models = await client.awaitAfter(afterGate, (frame) => frame.t === "ask" && frame.kind === "choice");
    const kimi = (models.items as Array<{ value: string; label: string; disabled?: string }>)
      .find((item) => item.label.includes("Kimi K3"))!;
    assert.ok(kimi, `Desktop authority must expose the disabled Kimi row: ${JSON.stringify(models.items)}`);
    const afterModels = client.mark();
    client.send({ t: "answer", askId: models.askId, value: kimi.value });
    const returnedGate = await client.awaitAfter(afterModels, (frame) => frame.t === "ask" && frame.kind === "choice");
    client.send({ t: "answer", askId: returnedGate.askId, value: null });
    assert.equal((await command).ok, true);
  });
  assert.equal(client.result()?.ownerKimiRunnableBaseline, true);
  assert.equal(client.result()?.terminalOwnerAuthorityCalls, 0);
  assert.equal(client.result()?.terminalOwnerViewCalls, 0);
  assert.equal(client.result()?.terminalOwnerResolveCalls, 0);
  assert.equal(client.result()?.providerCredentialCalls, 0);
  assert.equal(client.result()?.legacyRouteCatalogCalls, 0);
  assert.deepEqual(client.result()?.modelTransitions, []);
  assert.doesNotMatch(client.stdout + client.stderr, /accountFingerprint|billingRealm|credentialSlot|credentialBinding|pointer|homeId|codexHome|KIMI_OWNER_PRIVATE_CANARY/i);
});

test("GUI main uses canonical picker capabilities while compressor rechecks its current owner", async () => {
  const main = await withClient("route-picker-main-no-tools", async (client) => {
    await client.handshake();
    const view = await openDesktopSettings(client);
    const picker = await openSharedSettingsPicker(client, view, "Hauptmodell");
    assert.ok(picker.candidates.every(({ capabilities }) => capabilities.includes("tools")));
    assert.equal(client.frames.some((frame) => frame.t === "ask"), false);
    await cancelSharedSettingsPicker(client, picker);
    await client.request("settings.close");
  });
  assert.deepEqual(main.result()?.modelTransitions, []);
  assert.equal(main.result()?.providerCredentialCalls, 0);

  const drive = async (scenario: string, pick: (items: Array<{ value: string; label: string }>) => string) =>
    withClient(scenario, async (client) => {
      await client.handshake();
      const view = await openDesktopSettings(client);
      const row = requireDesktopSettingsRow(view, "Zusammenfassungsmodell");
      const activating = client.request("settings.dispatch", {
        intent: { kind: "activate-row", handle: row.handle, revision: view.revision },
      });
      const ask = await client.await((frame) => frame.t === "ask" && frame.kind === "choice");
      client.send({ t: "answer", askId: ask.askId, value: pick(ask.items as Array<{ value: string; label: string }>) });
      assert.equal((await activating).ok, true);
      await client.request("settings.close");
    });
  const compressorNoTools = await drive("route-picker-compressor-no-tools", (items) =>
    items.find((item) => item.label.includes("GUI Alternate"))!.value);
  assert.notEqual(compressorNoTools.result()?.durableCompressorModel, "vendor/gui-alternate");
  assert.equal(compressorNoTools.result()?.providerCredentialCalls, 0);
  assert.equal(compressorNoTools.result()?.legacyRouteCatalogCalls, 0);
  const compressor = await drive("route-picker-compressor-foreign", (items) =>
    items.find((item) => item.label.includes("Foreign compressor"))!.value);
  assert.notEqual(compressor.result()?.durableCompressorModel, "vendor/gui-alternate");
  assert.equal(compressor.result()?.providerCredentialCalls, 0);
  assert.equal(compressor.result()?.legacyRouteCatalogCalls, 0);
});

test("a secret travels inward only", async () => {
  const SECRET = `sk-or-v1-${"S".repeat(56)}`;
  const client = await withClient("default", async (client) => {
    await client.handshake();
    const dispatched = client.request("command", { raw: "/key set" });
    const ask = await client.await((frame) => frame.t === "ask" && frame.kind === "secret");
    assert.equal(ask.label, "OpenRouter API key");
    // The ask itself carries no value — it asks for one.
    assert.equal("value" in ask, false);
    client.send({ t: "answer", askId: ask.askId, value: SECRET });
    const response = await dispatched;
    assert.equal(response.ok, true);
  });
  // R-SEC-4: never echoed in any event, response or ask.
  assert.ok(!client.stdout.includes(SECRET), "the submitted secret came back out");
  assert.ok(!client.stdout.includes("S".repeat(20)), "a fragment of the secret came back out");
  assert.ok(!client.stderr.includes(SECRET), "the secret reached the diagnostic stream");
  // It nonetheless reached the consumer seam: `withCredentialSecret` handed
  // the raw value to `use`, which is the only place it may exist.
  assert.equal(client.result()?.submittedSecretLength, SECRET.length);
});

test("no frame the server emits carries a fingerprint, a slot or an account id", async () => {
  const client = await withClient("approval", async (client) => {
    await client.handshake();
    // Drive every emitting path the server has against a fixture whose route
    // carries an `acct_or_` fingerprint and whose balance key carries a
    // `creatorUserId`.
    await client.request("status.get");
    await client.request("chats.list");
    await client.request("catalog.level", { path: [] });
    await client.request("catalog.search", { query: "model" });
    // `/model` is the choice-ask emitting path; it is driven and then
    // CANCELLED, so the sweep sees the ask's payload without leaving a
    // question open behind it.
    const picking = client.request("command", { raw: "/model" });
    const choice = await client.await((frame) => frame.t === "ask" && frame.kind === "choice");
    client.send({ t: "answer", askId: choice.askId, value: null });
    await picking.catch(() => undefined);
    let settings = await openDesktopSettings(client);
    settings = await dispatchDesktopSettings(client, {
      kind: "select-category", categoryId: "accounts", revision: settings.revision,
    });
    settings = await dispatchDesktopSettings(client, {
      kind: "select-category", categoryId: "model", revision: settings.revision,
    });
    // Settings owns the session while it is open (M3), so it closes before
    // the run half of the sweep.
    await client.request("settings.close");
    await client.await((frame) => frame.t === "event" && frame.e === "settings.closed");
    await client.request("submit", { text: "write the notes" });
    const ask = await client.await((frame) => frame.t === "ask" && frame.kind === "approval");
    client.send({ t: "answer", askId: ask.askId, accepted: true });
    await client.await((frame) =>
      frame.t === "event" && frame.e === "run"
      && (frame.event as { type: string }).type === "run-end");
  });

  const wire = client.stdout;
  assert.ok(wire.length > 2_000, "the pin did not actually drive the server");
  for (const canary of [
    "SECRETCANARYFINGERPRINT",
    "SECRET_CREATOR_CANARY",
    "acct_or_",
    "accountFingerprint",
    "accountFingerprintSuffix",
    "credentialSlot",
    "credentialBinding",
    "pointer",
    "homeId",
    "codexHome",
    "orcode-keychain",
    "provider-runtime",
    "codex-0123456789abcdef0123456789abcdef",
    "keychain-pointer-canary",
    "/private/provider-home-canary",
    "providerSetup",
    "creatorUserId",
  ]) {
    assert.ok(!wire.includes(canary), `"${canary}" reached the wire`);
  }
});

test("nothing but protocol lines ever reaches stdout", async () => {
  const client = await withClient("default", async (client) => {
    await client.handshake();
    await client.request("submit", { text: "write the notes" });
    await client.await((frame) =>
      frame.t === "event" && frame.e === "run"
      && (frame.event as { type: string }).type === "run-end");
    // A command whose output `commands.ts` builds with `console.log` in the
    // plain sink — it must arrive as a `command-output` event, not as bytes.
    await client.request("command", { raw: "/help" });
  });

  assert.deepEqual(client.nonProtocolLines, [], "stdout carried something that was not a frame");
  for (const line of client.stdout.split("\n")) {
    if (!line.trim()) continue;
    const frame = JSON.parse(line) as Frame;
    assert.equal(frame.v, GUI_PROTOCOL_VERSION, `a frame was missing the envelope version: ${line}`);
    assert.ok(
      ["hello", "response", "event", "ask"].includes(frame.t),
      `unknown frame type on the wire: ${frame.t}`,
    );
  }
  assert.ok(
    client.events("command-output").some((frame) =>
      (frame.lines as string[]).join("\n").length > 0),
    "the command's output never arrived as a frame",
  );
});

// ---------------------------------------------------------------------------
// Round-2 re-review, pin gap: the double-`settings.open` RACE — both requests
// in ONE stdin write, same tick, before any response is read. The sequential
// variant above stays green even if the flag claim moves back behind
// `begin()`'s await; this one does not (verified by that exact mutation).
// ---------------------------------------------------------------------------

test("two settings.open in one write, one tick: one controller, one refusal", async () => {
  await withClient("default", async (client) => {
    await client.handshake();
    client.child.stdin.write(
      `${JSON.stringify({ v: GUI_PROTOCOL_VERSION, t: "settings.open", id: "race-a" })}\n`
      + `${JSON.stringify({ v: GUI_PROTOCOL_VERSION, t: "settings.open", id: "race-b" })}\n`,
    );
    const first = await client.await((frame) => frame.t === "response" && frame.id === "race-a");
    const second = await client.await((frame) => frame.t === "response" && frame.id === "race-b");
    assert.equal(first.ok, true, "the first open wins");
    assert.equal(second.ok, false, "the same-tick twin is refused, never a second controller");
    assert.equal((second.error as { code: string }).code, "settings-open");
    await client.await((frame) => frame.t === "event" && frame.e === "settings.view");
    assert.equal(
      client.events("settings.view").length,
      1,
      "exactly one settings view for one surviving controller",
    );
  });
});

test("Settings session classifies a synchronous surface editor throw and tears down once", async () => {
  const canary = new Error("SYNC_EDITOR_PRIVATE_CANARY");
  const request = Object.freeze({
    generation: 1,
    category: "appearance",
    itemId: "appearance-glyph-mode",
    label: "Terminalzeichen",
    description: "",
    initialValue: "auto",
    editor: Object.freeze({ kind: "choice", actionId: "appearance-glyph-mode", options: [] }),
  });
  let endCalls = 0;
  let completeCalls = 0;
  const controller = {
    view: Object.freeze({}),
    async dispatch() { return { kind: "edit", request }; },
    async completeEditor() { completeCalls += 1; return { kind: "render" }; },
  };
  const surface = {
    begin() {},
    async nextIntent() { return { kind: "activate", itemId: request.itemId }; },
    edit() { throw canary; },
    end() { endCalls += 1; },
  };

  await assert.rejects(
    runSettingsSession(controller as never, surface as never),
    (error: unknown) => {
      assert.ok(error instanceof SettingsEditorOpenError);
      assert.equal(error.itemId, request.itemId);
      assert.equal(
        error.message,
        'Settings closed — the editor for "Terminalzeichen" could not be opened.',
      );
      assert.equal(error.cause, canary);
      assert.doesNotMatch(error.message, /SYNC_EDITOR_PRIVATE_CANARY/);
      return true;
    },
  );
  assert.equal(completeCalls, 0);
  assert.equal(endCalls, 1);
});

test("Desktop Settings closes on the first dedicated request during search and stays out of transcript", async () => {
  await withClient("default", async (client) => {
    await client.handshake();
    const settingsMark = client.mark();
    const initial = await openDesktopSettings(client);
    assert.deepEqual(initial.categories.map(({ id, label }) => ({ id, label })), [
      { id: "model", label: "Modell" },
      { id: "accounts", label: "Konten" },
      { id: "security", label: "Sicherheit" },
      { id: "more", label: "Mehr" },
    ]);

    const disclosed = await dispatchDesktopSettings(client, {
      kind: "toggle-advanced",
      categoryId: "more",
      revision: initial.revision,
    });
    assert.equal(disclosed.categories.find(({ id }) => id === "more")?.expanded, true);
    const searched = await dispatchDesktopSettings(client, {
      kind: "search-change",
      query: "logo",
      revision: disclosed.revision,
    });
    assert.deepEqual(
      searched.search.results.map(({ label }) => label),
      ["Großes ORCODE-Logo"],
    );
    assert.equal(searched.search.active, true);

    const closeMark = client.mark();
    assert.equal((await client.request("settings.close")).ok, true);
    await client.awaitAfter(closeMark, (frame) => frame.t === "event" && frame.e === "settings.closed");
    assert.equal((await client.request("settings.close")).ok, true, "a repeated close is harmless");
    assert.equal(client.events("settings.closed").length, 1);
    assert.equal(client.events("transcript").length, 0);

    const settingsActivities = client.events("activity")
      .map((frame) => frame.activity as {
        kind: string; revision: number; message: { code: string; label: string; messageCode?: string };
      })
      .filter(({ kind }) => kind === "settings");
    assert.deepEqual(settingsActivities.map(({ message }) => message), [
      { code: "settings-opened", label: "Einstellungen geöffnet" },
      { code: "settings-closed", label: "Einstellungen geschlossen" },
    ]);
    assert.deepEqual(
      settingsActivities.map(({ revision }) => revision),
      [initial.revision, searched.revision],
      "open and close activities carry the exact resulting Desktop view revisions",
    );
    assert.ok(settingsActivities.every(({ message }) => !("messageCode" in message)));
    assertDesktopSettingsPresentationStayedMapped(client, settingsMark);
  });
});

test("both Desktop Settings route rows close before the shared picker and Back restores their category", async () => {
  for (const entry of [
    { categoryId: "model", label: "Hauptmodell", step: "model" },
    { categoryId: "accounts", label: "Anbieter einrichten", step: "provider" },
  ] as const) {
    await withClient("default", async (client) => {
      await client.handshake();
      const settingsMark = client.mark();
      let settings = await openDesktopSettings(client);
      if (entry.categoryId !== settings.selectedCategoryId) {
        settings = await dispatchDesktopSettings(client, {
          kind: "select-category",
          categoryId: entry.categoryId,
          revision: settings.revision,
        });
      }
      const target = requireDesktopSettingsRow(settings, entry.label);
      const bridgeMark = client.mark();
      const launched = client.request("settings.dispatch", {
        intent: { kind: "activate-row", handle: target.handle, revision: settings.revision },
      });
      const closed = await client.awaitAfter(
        bridgeMark,
        (frame) => frame.t === "event" && frame.e === "settings.closed",
      );
      const picker = await client.awaitAfter(
        bridgeMark,
        (frame) => frame.t === "event" && frame.e === "onboarding.view"
          && (frame.view as { returnTo?: string; step?: string }).returnTo === "settings"
          && (frame.view as { step?: string }).step === entry.step,
      );
      assert.ok(client.frames.indexOf(closed) < client.frames.indexOf(picker));
      assert.equal((await launched).ok, true);
      assert.equal(
        client.frames.slice(bridgeMark).some((frame) => frame.t === "ask"),
        false,
        "Settings navigation must not open a legacy choice or setup ask",
      );

      const pickerView = picker.view as {
        revision: number; generation: number; operationHandle?: string;
      };
      const returnMark = client.mark();
      const returned = await client.request("onboarding.dispatch", {
        intent: {
          kind: "back",
          revision: pickerView.revision,
          generation: pickerView.generation,
        },
      });
      assert.equal(returned.ok, true, JSON.stringify(returned));
      assert.equal((returned.result as { kind: string }).kind, "cancelled");
      const restored = desktopSettingsView(await client.awaitAfter(
        returnMark,
        (frame) => frame.t === "event" && frame.e === "settings.view",
      ));
      assert.equal(restored.selectedCategoryId, entry.categoryId);
      const restoredTarget = requireDesktopSettingsRow(restored, entry.label);
      assert.equal(restored.initialFocusKey, restoredTarget.focusKey);
      assert.notEqual(restored.initialFocusKey, restoredTarget.handle);
      assert.equal(
        client.frames.slice(returnMark).filter((frame) => frame.t === "event" && frame.e === "settings.view").length,
        1,
        "return publishes one fresh Settings projection",
      );
      assert.equal(client.events("transcript").length, 0);
      assertDesktopSettingsPresentationStayedMapped(client, settingsMark);
      await client.request("settings.close");
    });
  }
});

test("direct OpenRouter connect leaves Settings before canonical setup and cancellation restores its exact row", async () => {
  const client = await withClient("desktop-empty-settings-provider-guidance", async (client) => {
    await client.handshake();
    let settings = await openDesktopSettings(client);
    settings = await dispatchDesktopSettings(client, {
      kind: "select-category",
      categoryId: "accounts",
      revision: settings.revision,
    });
    const target = requireDesktopSettingsRow(settings, "OpenRouter · Verbinden");
    const bridgeMark = client.mark();
    const dispatched = client.request("settings.dispatch", {
      intent: { kind: "activate-row", handle: target.handle, revision: settings.revision },
    });
    const first = await client.awaitAfter(
      bridgeMark,
      (frame) => (frame.t === "event" && frame.e === "settings.closed")
        || (frame.t === "ask" && frame.kind === "settings-editor"),
    );
    if (first.t === "ask") {
      client.send({ t: "answer", askId: first.askId, decision: { kind: "cancel" } });
      await dispatched;
    }
    assert.equal(first.e, "settings.closed", `provider action reached Settings Core: ${JSON.stringify(first)}`);

    const secret = await client.awaitAfter(
      bridgeMark,
      (frame) => frame.t === "ask" && frame.kind === "secret",
    );
    const closed = client.frames.slice(bridgeMark).find((frame) =>
      frame.t === "event" && frame.e === "settings.closed");
    assert.ok(closed);
    assert.ok(client.frames.indexOf(closed) < client.frames.indexOf(secret));
    assert.equal(
      client.frames.slice(bridgeMark, client.frames.indexOf(secret))
        .filter((frame) => frame.t === "event" && frame.e === "onboarding.view").length,
      0,
      "a Settings-owned secret prompt must not arm a provider overlay behind itself",
    );
    const refreshMark = client.mark();
    assert.equal((await client.request("desktop.snapshot.get")).ok, true);
    const refreshed = await client.awaitAfter(
      refreshMark,
      (frame) => frame.t === "event" && frame.e === "onboarding.view",
    );
    assert.equal((refreshed.view as { returnTo?: string }).returnTo, "settings");
    assert.equal((refreshed.view as { step?: string }).step, "provider");
    assert.equal(
      (refreshed.view as { operationHandle?: string }).operationHandle,
      undefined,
      "snapshot refresh must not arm a hidden provider overlay behind the secret prompt",
    );
    client.send({ t: "answer", askId: secret.askId, value: null });
    assert.equal((await dispatched).ok, true);

    const restored = desktopSettingsView(await client.awaitAfter(
      bridgeMark,
      (frame) => frame.t === "event" && frame.e === "settings.view"
        && (frame.view as { initialFocusKey?: string }).initialFocusKey !== undefined,
    ));
    assert.equal(restored.selectedCategoryId, "accounts");
    const restoredTarget = requireDesktopSettingsRow(restored, "OpenRouter · Verbinden");
    assert.equal(restored.initialFocusKey, restoredTarget.focusKey);
    assert.notEqual(restored.initialFocusKey, restoredTarget.handle);
    assert.equal(
      client.frames.slice(bridgeMark).filter((frame) => frame.t === "ask" && frame.kind === "choose-hub").length,
      0,
    );
    for (const event of ["setup.present", "notice", "command-output", "transcript"]) {
      assert.equal(
        client.frames.slice(bridgeMark).filter((frame) => frame.t === "event" && frame.e === event).length,
        0,
        event,
      );
    }

    assert.equal((await client.request("settings.close")).ok, true);
    const snapshot = client.events("desktop.snapshot").at(-1)!.snapshot as {
      revision: number; generation: number;
    };
    const headerMark = client.mark();
    const header = await client.request("onboarding.dispatch", {
      intent: {
        kind: "open-model-picker",
        returnTo: "model-picker",
        revision: snapshot.revision,
        generation: snapshot.generation,
      },
    });
    assert.equal(header.ok, true, JSON.stringify(header));
    assert.equal((header.result as { view: { step: string; returnTo: string } }).view.step, "provider");
    assert.equal((header.result as { view: { returnTo: string } }).view.returnTo, "model-picker");
    assert.equal(client.frames.slice(headerMark).filter((frame) => frame.t === "ask").length, 0);
    assert.equal(client.frames.slice(headerMark).filter((frame) =>
      frame.t === "event" && ["setup.present", "notice", "command-output", "transcript"].includes(String(frame.e))).length, 0);
  });
  assert.equal(client.result()?.settingsDesktopBeginCalls, 0);
  assert.equal(client.result()?.settingsDesktopAdvanceCalls, 0);
  assert.equal(client.result()?.settingsDesktopAbortCalls, 0);
  assert.equal(client.result()?.desktopSetupCalls, 1);
  assert.equal(client.result()?.desktopSetupSettled, 1);
  assert.equal(client.result()?.desktopRefreshCalls, 0);
  assert.equal(client.result()?.desktopActivationCalls, 0);
  assert.equal(client.result()?.providerCredentialCalls, 0);
  assert.equal(client.result()?.protocolTranscriptFrames, 0);
});

test("connected provider refresh rows deep-link one exact account and Back restores the activating row", async () => {
  for (const label of ["OpenRouter · Neu verbinden", "OpenRouter · Modelle aktualisieren"]) {
    const client = await withClient("desktop-connected-settings-provider-guidance", async (client) => {
      await client.handshake();
      let settings = await openDesktopSettings(client);
      settings = await dispatchDesktopSettings(client, {
        kind: "select-category",
        categoryId: "accounts",
        revision: settings.revision,
      });
      const target = requireDesktopSettingsRow(settings, label);
      const bridgeMark = client.mark();
      const dispatched = client.request("settings.dispatch", {
        intent: { kind: "activate-row", handle: target.handle, revision: settings.revision },
      });
      const first = await client.awaitAfter(
        bridgeMark,
        (frame) => (frame.t === "event" && frame.e === "settings.closed")
          || (frame.t === "ask" && frame.kind === "settings-editor"),
      );
      if (first.t === "ask") {
        client.send({ t: "answer", askId: first.askId, decision: { kind: "cancel" } });
        await dispatched;
      }
      assert.equal(first.e, "settings.closed", `${label} reached Settings Core: ${JSON.stringify(first)}`);
      assert.equal((await dispatched).ok, true);

      const accountFrame = await client.awaitAfter(
        bridgeMark,
        (frame) => frame.t === "event" && frame.e === "onboarding.view"
          && (frame.view as { returnTo?: string; step?: string }).returnTo === "settings"
          && (frame.view as { step?: string }).step === "account",
      );
      const account = accountFrame.view as DesktopOnboardingViewProbe & { providerId?: string };
      assert.equal(account.providerId, "openrouter");
      assert.equal(client.frames.slice(bridgeMark).filter((frame) => frame.t === "ask").length, 0);

      const returnMark = client.mark();
      const returned = await client.request("onboarding.dispatch", {
        intent: { kind: "back", revision: account.revision, generation: account.generation },
      });
      assert.equal(returned.ok, true, JSON.stringify(returned));
      assert.equal((returned.result as { kind: string }).kind, "cancelled");
      const restored = desktopSettingsView(await client.awaitAfter(
        returnMark,
        (frame) => frame.t === "event" && frame.e === "settings.view",
      ));
      assert.equal(restored.selectedCategoryId, "accounts");
      const restoredTarget = requireDesktopSettingsRow(restored, label);
      assert.equal(restored.initialFocusKey, restoredTarget.focusKey);
      assert.notEqual(restored.initialFocusKey, restoredTarget.handle);
      for (const event of ["setup.present", "notice", "command-output", "transcript"]) {
        assert.equal(
          client.frames.slice(bridgeMark).filter((frame) => frame.t === "event" && frame.e === event).length,
          0,
          `${label}: ${event}`,
        );
      }
      await client.request("settings.close");
    });
    assert.equal(client.result()?.settingsDesktopBeginCalls, 0, label);
    assert.equal(client.result()?.settingsDesktopAdvanceCalls, 0, label);
    assert.equal(client.result()?.settingsDesktopAbortCalls, 0, label);
    assert.equal(client.result()?.desktopSetupCalls, 0, label);
    assert.equal(client.result()?.desktopRefreshCalls, 0, label);
    assert.equal(client.result()?.desktopActivationCalls, 0, label);
    assert.equal(client.result()?.providerCredentialCalls, 0, label);
    assert.equal(client.result()?.protocolTranscriptFrames, 0, label);
  }
});

test("an unavailable direct Kimi row opens the disabled canonical provider view with zero effects", async () => {
  const client = await withClient("desktop-empty-settings-provider-guidance", async (client) => {
    await client.handshake();
    assert.equal((await client.request("desktop.snapshot.get")).ok, true);
    let settings = await openDesktopSettings(client);
    settings = await dispatchDesktopSettings(client, {
      kind: "select-category",
      categoryId: "accounts",
      revision: settings.revision,
    });
    const target = requireDesktopSettingsRow(settings, "Kimi Code · Verbinden");
    const bridgeMark = client.mark();
    const dispatched = client.request("settings.dispatch", {
      intent: { kind: "activate-row", handle: target.handle, revision: settings.revision },
    });
    const first = await client.awaitAfter(
      bridgeMark,
      (frame) => (frame.t === "event" && frame.e === "settings.closed")
        || (frame.t === "ask" && frame.kind === "settings-editor"),
    );
    if (first.t === "ask") {
      client.send({ t: "answer", askId: first.askId, decision: { kind: "cancel" } });
      await dispatched;
    }
    assert.equal(first.e, "settings.closed", `unavailable provider action reached Settings Core: ${JSON.stringify(first)}`);
    assert.equal((await dispatched).ok, true);

    const pickerFrame = await client.awaitAfter(
      bridgeMark,
      (frame) => frame.t === "event" && frame.e === "onboarding.view"
        && (frame.view as { returnTo?: string; step?: string }).returnTo === "settings"
        && (frame.view as { step?: string }).step === "provider",
    );
    const picker = pickerFrame.view as DesktopOnboardingViewProbe & {
      providers: Array<{ providerId: string; state: string; disabled?: { code: string } }>;
    };
    const kimi = picker.providers.find(({ providerId }) => providerId === "kimi-code");
    assert.equal(kimi?.state, "disabled");
    assert.equal(kimi?.disabled?.code, "native-local-action-unavailable");
    const codex = picker.providers.find(({ providerId }) => providerId === "codex");
    assert.equal(codex?.state, "disabled");
    assert.equal(codex?.disabled?.code, "setup-method-unavailable");
    assert.equal(client.frames.slice(bridgeMark).filter((frame) => frame.t === "ask").length, 0);

    const returnMark = client.mark();
    const returned = await client.request("onboarding.dispatch", {
      intent: { kind: "back", revision: picker.revision, generation: picker.generation },
    });
    assert.equal(returned.ok, true, JSON.stringify(returned));
    assert.equal((returned.result as { kind: string }).kind, "cancelled");
    const restored = desktopSettingsView(await client.awaitAfter(
      returnMark,
      (frame) => frame.t === "event" && frame.e === "settings.view",
    ));
    assert.equal(restored.selectedCategoryId, "accounts");
    const restoredTarget = requireDesktopSettingsRow(restored, "Kimi Code · Verbinden");
    assert.equal(restored.initialFocusKey, restoredTarget.focusKey);
    assert.notEqual(restored.initialFocusKey, restoredTarget.handle);
    for (const event of ["setup.present", "notice", "command-output", "transcript"]) {
      assert.equal(
        client.frames.slice(bridgeMark).filter((frame) => frame.t === "event" && frame.e === event).length,
        0,
        event,
      );
    }
    await client.request("settings.close");
  });
  assert.equal(client.result()?.settingsDesktopBeginCalls, 0);
  assert.equal(client.result()?.settingsDesktopAdvanceCalls, 0);
  assert.equal(client.result()?.settingsDesktopAbortCalls, 0);
  assert.equal(client.result()?.desktopSetupCalls, 0);
  assert.equal(client.result()?.desktopRefreshCalls, 0);
  assert.equal(client.result()?.desktopActivationCalls, 0);
  assert.equal(client.result()?.providerCredentialCalls, 0);
  assert.equal(client.result()?.protocolTranscriptFrames, 0);
  const deltas = client.result()?.desktopKimiDeltas as Record<string, number> | null;
  assert.ok(deltas);
  for (const effect of ["catalogue", "credential", "setup", "refresh", "activation", "transcript", "agent", "cost", "ask"]) {
    assert.equal(deltas[effect], 0, effect);
  }
  assert.equal(client.result()?.desktopKimiCanaryInjected, true);
  assert.ok(!client.stdout.includes("KIMI_PRIVATE_CANARY"));
  assert.ok(!client.stderr.includes("KIMI_PRIVATE_CANARY"));
});

test("Settings provider setup keeps canonical error recovery and returns once after readiness", async () => {
  await withClient("desktop-activation-fail-once", async (client) => {
    await client.handshake();
    let settings = await openDesktopSettings(client);
    settings = await dispatchDesktopSettings(client, {
      kind: "select-category",
      categoryId: "accounts",
      revision: settings.revision,
    });
    const target = requireDesktopSettingsRow(settings, "Anbieter einrichten");
    const bridgeMark = client.mark();
    assert.equal((await client.request("settings.dispatch", {
      intent: { kind: "activate-row", handle: target.handle, revision: settings.revision },
    })).ok, true);
    const opened = client.events("onboarding.view").at(-1)!.view as {
      revision: number; generation: number; step: string; returnTo: string;
    };
    assert.equal(opened.step, "provider");
    assert.equal(opened.returnTo, "settings");

    const provider = await client.request("onboarding.dispatch", {
      intent: { kind: "choose-provider", providerId: "openrouter", revision: opened.revision, generation: opened.generation },
    });
    assert.equal((provider.result as { view: { step: string; returnTo: string } }).view.step, "account");
    assert.equal((provider.result as { view: { returnTo: string } }).view.returnTo, "settings");
    const account = await client.request("onboarding.dispatch", {
      intent: { kind: "choose-account", connectionId: "desktop-connection", revision: opened.revision, generation: opened.generation },
    });
    assert.equal((account.result as { view: { step: string; returnTo: string } }).view.step, "model");
    assert.equal((account.result as { view: { returnTo: string } }).view.returnTo, "settings");
    const modelView = (account.result as { view: { candidates: Array<{ handle: string }> } }).view;
    const failed = await client.request("onboarding.dispatch", {
      intent: { kind: "choose-model", routeHandle: modelView.candidates[0]!.handle, revision: opened.revision, generation: opened.generation },
    });
    assert.equal((failed.result as { view: { step: string; returnTo: string } }).view.step, "error");
    assert.equal((failed.result as { view: { returnTo: string } }).view.returnTo, "settings");
    assert.equal(
      client.frames.slice(bridgeMark).filter((frame) => frame.t === "event" && frame.e === "settings.view").length,
      0,
      "a recoverable canonical error remains in the shared picker",
    );

    const returnMark = client.mark();
    const retried = await client.request("onboarding.dispatch", {
      intent: { kind: "retry", revision: opened.revision, generation: opened.generation },
    });
    assert.equal((retried.result as { kind: string }).kind, "ready");
    const restored = desktopSettingsView(await client.awaitAfter(
      returnMark,
      (frame) => frame.t === "event" && frame.e === "settings.view",
    ));
    assert.equal(restored.selectedCategoryId, "accounts");
    assert.equal(restored.initialFocusKey, requireDesktopSettingsRow(restored, "Anbieter einrichten").focusKey);
    assert.equal(
      client.frames.slice(returnMark).filter((frame) => frame.t === "event" && frame.e === "settings.view").length,
      1,
    );
    assert.equal(client.frames.slice(bridgeMark).some((frame) => frame.t === "ask"), false);
    assert.equal(client.events("transcript").length, 0);
    await client.request("settings.close");
  });
});

test("Settings provider setup cancel from a canonical error returns once to the same account category", async () => {
  await withClient("desktop-activation-fail-once", async (client) => {
    await client.handshake();
    let settings = await openDesktopSettings(client);
    settings = await dispatchDesktopSettings(client, {
      kind: "select-category",
      categoryId: "accounts",
      revision: settings.revision,
    });
    const opened = await openSharedSettingsPicker(client, settings, "Anbieter einrichten");
    const provider = await client.request("onboarding.dispatch", {
      intent: {
        kind: "choose-provider",
        providerId: "openrouter",
        revision: opened.revision,
        generation: opened.generation,
      },
    });
    const account = await client.request("onboarding.dispatch", {
      intent: {
        kind: "choose-account",
        connectionId: "desktop-connection",
        revision: opened.revision,
        generation: opened.generation,
      },
    });
    assert.equal((provider.result as { view: { step: string } }).view.step, "account");
    const model = (account.result as { view: DesktopOnboardingViewProbe }).view;
    assert.equal(model.step, "model");
    const failed = await client.request("onboarding.dispatch", {
      intent: {
        kind: "choose-model",
        routeHandle: model.candidates[0]!.handle,
        revision: opened.revision,
        generation: opened.generation,
      },
    });
    const error = (failed.result as { view: DesktopOnboardingViewProbe }).view;
    assert.equal(error.step, "error");
    assert.equal(error.returnTo, "settings");

    const returnMark = client.mark();
    const restored = await cancelSharedSettingsPicker(client, error);
    assert.equal(restored.selectedCategoryId, "accounts");
    assert.equal(restored.initialFocusKey, requireDesktopSettingsRow(restored, "Anbieter einrichten").focusKey);
    assert.equal(
      client.frames.slice(returnMark).filter((frame) => frame.t === "event" && frame.e === "settings.view").length,
      1,
    );
    assert.equal(client.frames.some((frame) => frame.t === "ask"), false);
    assert.equal(client.events("transcript").length, 0);
    await client.request("settings.close");
  });
});

test("Desktop Settings plain open and close publishes one exact close and no transcript", async () => {
  const client = await withClient("default", async (client) => {
    await client.handshake();
    const settingsMark = client.mark();
    const initial = await openDesktopSettings(client);
    const response = await client.request("settings.close");
    assert.equal(response.ok, true);
    assert.deepEqual(response.result, { closed: true });
    await client.awaitAfter(
      settingsMark,
      (frame) => frame.t === "event" && frame.e === "settings.closed",
    );
    assert.equal(client.events("settings.closed").length, 1);
    const activities = client.events("activity")
      .map((frame) => frame.activity as { kind: string; revision: number; message: { code: string } })
      .filter(({ kind }) => kind === "settings");
    assert.deepEqual(activities.map(({ message }) => message.code), ["settings-opened", "settings-closed"]);
    assert.deepEqual(activities.map(({ revision }) => revision), [initial.revision, initial.revision]);
    assertDesktopSettingsPresentationStayedMapped(client, settingsMark);
  });
  assert.equal(client.result()?.protocolSettingsClosedFrames, 1);
  assert.equal(client.result()?.protocolTranscriptFrames, 0);
  assert.equal(client.result()?.settingsDesktopBeginCalls, 0);
  assert.equal(client.result()?.settingsDesktopAdvanceCalls, 0);
  assert.equal(client.result()?.settingsDesktopAbortCalls, 0);
  assert.equal(client.result()?.configMutationCalls, 0);
});

test("Desktop Settings close and reopen retires every old handle before Core", async () => {
  const client = await withClient("default", async (client) => {
    await client.handshake();
    const settingsMark = client.mark();
    const first = await openDesktopSettings(client);
    const oldLogo = requireDesktopSettingsRow(first, "Großes ORCODE-Logo");
    assert.equal((await client.request("settings.close")).ok, true);
    const reopened = await openDesktopSettings(client);
    const freshLogo = requireDesktopSettingsRow(reopened, "Großes ORCODE-Logo");
    assert.notEqual(freshLogo.handle, oldLogo.handle, "the reopened visit minted a disjoint handle");

    const refused = await client.request("settings.dispatch", {
      intent: {
        kind: "set-boolean",
        handle: oldLogo.handle,
        value: !freshLogo.booleanValue,
        revision: reopened.revision,
      },
    });
    assert.equal(refused.ok, false, "an old handle is invalid even with the live reopened revision");
    assert.equal((await client.request("settings.close")).ok, true);
    assert.equal(client.events("settings.closed").length, 2);
    assertDesktopSettingsPresentationStayedMapped(client, settingsMark);
  });
  assert.equal(client.result()?.settingsDesktopBeginCalls, 0);
  assert.equal(client.result()?.settingsDesktopAdvanceCalls, 0);
  assert.equal(client.result()?.settingsDesktopAbortCalls, 0);
  assert.equal(client.result()?.configMutationCalls, 0);
  assert.equal(client.result()?.savedShowLargeLogo, true);
  assert.equal(client.result()?.protocolSettingsClosedFrames, 2);
  assert.equal(client.result()?.protocolTranscriptFrames, 0);
});

test("Desktop Settings close cancels one exact editor, ignores a late answer and is idempotent", async () => {
  const client = await withClient("default", async (client) => {
    await client.handshake();
    const settingsMark = client.mark();
    const initial = await openDesktopSettings(client);
    const glyph = requireDesktopSettingsRow(initial, "Terminalzeichen");
    const activating = client.request("settings.dispatch", {
      intent: { kind: "activate-row", handle: glyph.handle, revision: initial.revision },
    });
    const editor = await client.await((frame) => frame.t === "ask" && frame.kind === "settings-editor");

    const [firstClose, repeatedClose] = client.requestBatch([
      { t: "settings.close" },
      { t: "settings.close" },
    ]);
    assert.equal((await firstClose).ok, true);
    assert.equal((await repeatedClose).ok, true);
    assert.equal((await activating).ok, true);
    assert.equal(client.events("settings.closed").length, 1);
    assert.equal(client.events("transcript").length, 0);

    client.send({
      t: "answer",
      askId: editor.askId,
      decision: { kind: "choice", optionHandle: editorChoiceHandle(editor, "Unicode") },
    });
    assert.equal((await client.request("status.get")).ok, true, "the late answer was drained before teardown");
    assertDesktopSettingsPresentationStayedMapped(client, settingsMark);
  });
  assert.equal(client.result()?.settingsDesktopBeginCalls, 1);
  assert.equal(client.result()?.settingsDesktopAdvanceCalls, 1);
  assert.equal(client.result()?.settingsDesktopCancelAdvances, 1);
  assert.equal(client.result()?.settingsDesktopAbortCalls, 0);
  assert.equal(client.result()?.configMutationCalls, 0);
  assert.equal(client.result()?.savedGlyphMode, "auto");
  assert.equal(client.result()?.protocolSettingsClosedFrames, 1);
});

test("the shared model picker owns the lane after Settings closes and dedicated close stays idempotent", async () => {
  const client = await withClient("default", async (client) => {
    await client.handshake();
    const settingsMark = client.mark();
    const initial = await openDesktopSettings(client);
    const picker = await openSharedSettingsPicker(client, initial, "Hauptmodell");
    assert.equal(picker.step, "model");
    assert.equal(client.events("settings.closed").length, 1);

    const [firstClose, repeatedClose] = client.requestBatch([
      { t: "settings.close" },
      { t: "settings.close" },
    ]);
    assert.deepEqual((await firstClose).result, { closed: false });
    assert.deepEqual((await repeatedClose).result, { closed: false });
    assert.equal(client.events("settings.closed").length, 1);

    const restored = await cancelSharedSettingsPicker(client, picker);
    assert.equal(restored.selectedCategoryId, "model");
    assert.equal((await client.request("settings.close")).ok, true);
    assert.equal(client.events("settings.closed").length, 2);
    assertDesktopSettingsPresentationStayedMapped(client, settingsMark);
  });
  assert.equal(client.result()?.settingsDesktopBeginCalls, 0);
  assert.equal(client.result()?.settingsDesktopAdvanceCalls, 0);
  assert.equal(client.result()?.settingsDesktopCancelAdvances, 0);
  assert.equal(client.result()?.settingsDesktopAbortCalls, 0);
  assert.deepEqual(client.result()?.modelTransitions, []);
  assert.equal(client.result()?.transitionEntries, 0);
  assert.equal(client.result()?.settingsPublicationPrepares, 0);
  assert.equal(client.result()?.settingsPublicationPublishes, 0);
  assert.equal(client.result()?.configMutationCalls, 0);
  assert.equal(client.result()?.providerCredentialCalls, 0);
  assert.equal(client.result()?.protocolSettingsClosedFrames, 2);
  assert.equal(client.result()?.protocolTranscriptFrames, 0);
});

test("Desktop Settings close prevents a stale queued shared-picker entry after one-shot ask abandonment", async () => {
  const client = await withClient("default", async (client) => {
    await client.handshake();
    const settingsMark = client.mark();
    const initial = await openDesktopSettings(client);
    const glyph = requireDesktopSettingsRow(initial, "Terminalzeichen");
    const main = requireDesktopSettingsRow(initial, "Hauptmodell");
    const firstDispatch = client.request("settings.dispatch", {
      intent: { kind: "activate-row", handle: glyph.handle, revision: initial.revision },
    });
    await client.await((frame) => frame.t === "ask" && frame.kind === "settings-editor");
    const asksBeforeClose = client.frames.filter((frame) => frame.t === "ask").length;
    const batchMark = client.mark();

    const [queuedDispatch, close] = client.requestBatch([
      {
        t: "settings.dispatch",
        payload: {
          intent: {
            kind: "activate-row",
            handle: main.handle,
            revision: initial.revision + 1,
          },
        },
      },
      { t: "settings.close" },
    ]);
    assert.equal((await firstDispatch).ok, true);
    const refused = await queuedDispatch;
    assert.equal(refused.ok, false);
    assert.equal((refused.error as { code: string }).code, "request-failed");
    assert.equal((await close).ok, true);
    assert.equal(
      client.frames.filter((frame) => frame.t === "ask").length,
      asksBeforeClose,
      "no owned prompt registered after the one-shot close abandonment",
    );
    assert.equal(
      client.frames.slice(batchMark).some((frame) => frame.t === "event" && frame.e === "onboarding.view"),
      false,
      "the stale queued row never opens the shared picker",
    );
    assert.equal(client.events("settings.closed").length, 1);
    assertDesktopSettingsPresentationStayedMapped(client, settingsMark);
  });
  assert.equal(client.result()?.settingsDesktopBeginCalls, 1);
  assert.equal(client.result()?.settingsDesktopAdvanceCalls, 1);
  assert.equal(client.result()?.settingsDesktopCancelAdvances, 1);
  assert.equal(client.result()?.settingsDesktopAbortCalls, 0);
  assert.equal(client.result()?.configMutationCalls, 0);
  assert.equal(client.result()?.protocolSettingsClosedFrames, 1);
  assert.equal(client.result()?.protocolTranscriptFrames, 0);
});

test("Desktop Settings serializes a real editor mutation before the next predicted revision", async () => {
  const client = await withClient("default", async (client) => {
    await client.handshake();
    const settingsMark = client.mark();
    const initial = await openDesktopSettings(client);
    const glyph = requireDesktopSettingsRow(initial, "Terminalzeichen");
    const responseCount = client.frames.filter(({ t }) => t === "response").length;
    const mark = client.mark();
    const [mutating, searching] = client.requestBatch([
      {
        t: "settings.dispatch",
        payload: {
          intent: { kind: "activate-row", handle: glyph.handle, revision: initial.revision },
        },
      },
      {
        t: "settings.dispatch",
        payload: {
          intent: { kind: "search-change", query: "logo", revision: initial.revision + 1 },
        },
      },
    ]);
    const editor = await client.awaitAfter(mark, (frame) => frame.t === "ask" && frame.kind === "settings-editor");
    assert.equal(
      client.frames.filter(({ t }) => t === "response").length,
      responseCount,
      "neither queued dispatch responds while the first editor is pending",
    );
    client.send({
      t: "answer",
      askId: editor.askId,
      decision: { kind: "choice", optionHandle: editorChoiceHandle(editor, "Unicode") },
    });
    const first = await mutating;
    const second = await searching;
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.ok(client.frames.indexOf(first) < client.frames.indexOf(second));

    const views = client.frames.slice(mark)
      .filter((frame) => frame.t === "event" && frame.e === "settings.view")
      .map(desktopSettingsView);
    assert.deepEqual(views.map(({ revision }) => revision), [initial.revision + 1, initial.revision + 2]);
    assert.deepEqual(views[0]?.notice, { code: "saved", level: "info", label: "Gespeichert" });
    assert.deepEqual(views[1]?.search, {
      active: true,
      query: "logo",
      results: views[1]!.search.results,
    });
    assert.equal(views[1]?.search.results.some(({ label }) => label === "Großes ORCODE-Logo"), true);
    assert.equal((await client.request("settings.close")).ok, true);
    assertDesktopSettingsPresentationStayedMapped(client, settingsMark);
  });
  assert.equal(client.result()?.settingsDesktopBeginCalls, 1);
  assert.equal(client.result()?.settingsDesktopAdvanceCalls, 1);
  assert.equal(client.result()?.settingsDesktopCancelAdvances, 0);
  assert.equal(client.result()?.settingsDesktopAbortCalls, 0);
  assert.equal(client.result()?.configMutationCalls, 1);
  assert.equal(client.result()?.savedGlyphMode, "unicode");
});

test("Desktop Settings rejects stale, retired and forged handles before Core effects", async () => {
  const client = await withClient("default", async (client) => {
    await client.handshake();
    const settingsMark = client.mark();
    const initial = await openDesktopSettings(client);
    const logo = requireDesktopSettingsRow(initial, "Großes ORCODE-Logo");
    const staleRevision = await client.request("settings.dispatch", {
      intent: {
        kind: "set-boolean",
        handle: logo.handle,
        value: !logo.booleanValue,
        revision: initial.revision - 1,
      },
    });
    assert.equal(staleRevision.ok, false);

    const refreshed = await dispatchDesktopSettings(client, {
      kind: "search-change",
      query: "logo",
      revision: initial.revision,
    });
    for (const handle of [logo.handle, "ds_forged-current-revision-handle"]) {
      const refused = await client.request("settings.dispatch", {
        intent: {
          kind: "set-boolean",
          handle,
          value: !logo.booleanValue,
          revision: refreshed.revision,
        },
      });
      assert.equal(refused.ok, false, handle);
    }
    assert.equal((await client.request("settings.close")).ok, true);
    assertDesktopSettingsPresentationStayedMapped(client, settingsMark);
  });
  assert.equal(client.result()?.settingsDesktopBeginCalls, 0);
  assert.equal(client.result()?.settingsDesktopAdvanceCalls, 0);
  assert.equal(client.result()?.settingsDesktopAbortCalls, 0);
  assert.equal(client.result()?.configMutationCalls, 0);
  assert.equal(client.result()?.savedShowLargeLogo, true);
});

test("Desktop Settings shutdown shares the close settlement and drains a pending editor", async () => {
  const client = await withClient("default", async (client) => {
    await client.handshake();
    const settingsMark = client.mark();
    const initial = await openDesktopSettings(client);
    const glyph = requireDesktopSettingsRow(initial, "Terminalzeichen");
    client.send({
      t: "settings.dispatch",
      intent: { kind: "activate-row", handle: glyph.handle, revision: initial.revision },
    });
    await client.await((frame) => frame.t === "ask" && frame.kind === "settings-editor");
    assert.equal(await client.endInput(), 0);
    assertDesktopSettingsPresentationStayedMapped(client, settingsMark);
  });
  assert.equal(client.result()?.settingsDesktopBeginCalls, 1);
  assert.equal(client.result()?.settingsDesktopAdvanceCalls, 1);
  assert.equal(client.result()?.settingsDesktopCancelAdvances, 1);
  assert.equal(client.result()?.settingsDesktopAbortCalls, 0);
  assert.equal(client.result()?.configMutationCalls, 0);
  assert.equal(client.result()?.savedGlyphMode, "auto");
  assert.ok(Number(client.result()?.protocolSettingsClosedFrames) <= 1);
  assert.equal(client.result()?.protocolTranscriptFrames, 0);
});

test("explicit shutdown races a started Settings close without suppressing either response", async () => {
  const client = await withClient("default", async (client) => {
    await client.handshake();
    const settingsMark = client.mark();
    const initial = await openDesktopSettings(client);
    const glyph = requireDesktopSettingsRow(initial, "Terminalzeichen");
    const activating = client.request("settings.dispatch", {
      intent: { kind: "activate-row", handle: glyph.handle, revision: initial.revision },
    });
    await client.await((frame) => frame.t === "ask" && frame.kind === "settings-editor");

    const closing = client.request("settings.close");
    const shuttingDown = client.shutdownOnly();
    const [closeResponse, exitCode, dispatchResponse] = await Promise.all([
      closing,
      shuttingDown,
      activating,
    ]);
    assert.equal(closeResponse.ok, true, "the started close response stayed writable");
    assert.deepEqual(closeResponse.result, { closed: true });
    assert.equal(dispatchResponse.ok, true, "the cancelled dispatch response stayed writable");
    assert.equal(exitCode, 0);
    assert.equal(client.events("settings.closed").length, 1);
    assertDesktopSettingsPresentationStayedMapped(client, settingsMark);
  });
  assert.equal(client.result()?.settingsDesktopBeginCalls, 1);
  assert.equal(client.result()?.settingsDesktopAdvanceCalls, 1);
  assert.equal(client.result()?.settingsDesktopCancelAdvances, 1);
  assert.equal(client.result()?.settingsDesktopAbortCalls, 0);
  assert.equal(client.result()?.configMutationCalls, 0);
  assert.equal(client.result()?.savedGlyphMode, "auto");
  assert.equal(client.result()?.protocolSettingsClosedFrames, 1);
  assert.equal(client.result()?.protocolTranscriptFrames, 0);
});

test("explicit shutdown bounds a wedged real Settings mutation and retires its publications", async () => {
  const client = await withClient("settings-wedged-mutation", async (client) => {
    await client.handshake();
    const settingsMark = client.mark();
    const initial = await openDesktopSettings(client);
    const logo = requireDesktopSettingsRow(initial, "Großes ORCODE-Logo");
    assert.equal(logo.booleanValue, true);

    const mutationMark = client.mark();
    client.send({
      t: "settings.dispatch",
      id: "wedged-settings-mutation",
      intent: {
        kind: "set-boolean",
        handle: logo.handle,
        value: false,
        revision: initial.revision,
      },
    });
    await client.awaitStderr((text) => text.includes("ORCODE_GUI_GATE:settings-mutation-held"));

    const startedAt = Date.now();
    assert.equal(await client.shutdownOnly(false, 7_500), 0);
    assert.ok(
      Date.now() - startedAt < 7_500,
      "the existing five-second shutdown policy plus process-exit overhead was exceeded",
    );
    assert.equal(
      client.frames.some((frame) => frame.t === "response" && frame.id === "wedged-settings-mutation"),
      false,
      "a retired wedged dispatch must not publish a late response",
    );
    assert.equal(
      client.frames.slice(mutationMark).filter((frame) => frame.t === "event" && frame.e === "settings.view").length,
      0,
      "the retired operation must not publish a late view",
    );
    assert.equal(client.events("settings.closed").length, 1);
    assert.equal(client.events("transcript").length, 0);
    assertDesktopSettingsPresentationStayedMapped(client, settingsMark);
  });

  assert.equal(client.result()?.settingsMutationHeld, 1);
  assert.equal(client.result()?.settingsMutationTaskCalls, 0);
  assert.equal(client.result()?.configMutationCalls, 1);
  assert.equal(client.result()?.savedShowLargeLogo, true);
  assert.equal(client.result()?.liveShowLargeLogo, true);
  assert.equal(client.result()?.settingsDesktopBeginCalls, 1);
  assert.equal(client.result()?.settingsDesktopAdvanceCalls, 1);
  assert.equal(client.result()?.settingsDesktopCancelAdvances, 0);
  assert.equal(client.result()?.settingsDesktopAbortCalls, 0);
  assert.equal(client.result()?.protocolSettingsClosedFrames, 1);
  assert.equal(client.result()?.protocolTranscriptFrames, 0);
});

for (const [scenario, outcome] of [
  ["settings-timeout-release", "success"],
  ["settings-timeout-release-error", "failure"],
] as const) {
  test(`timeout-retired Settings ${outcome} emits only the shutdown response`, async () => {
    const dispatchId = `timeout-retired-dispatch-${outcome}`;
    const closeId = `timeout-retired-close-${outcome}`;
    const client = await withClient(scenario, async (client) => {
      await client.handshake();
      const settingsMark = client.mark();
      const initial = await openDesktopSettings(client);
      const logo = requireDesktopSettingsRow(initial, "Großes ORCODE-Logo");
      assert.equal(logo.booleanValue, true);

      client.send({
        t: "settings.dispatch",
        id: dispatchId,
        intent: {
          kind: "set-boolean",
          handle: logo.handle,
          value: false,
          revision: initial.revision,
        },
      });
      await client.awaitStderr((text) => text.includes("ORCODE_GUI_GATE:settings-timeout-mutation-held"));
      client.send({ t: "settings.close", id: closeId });
      await client.awaitStderr((text) => text.includes("ORCODE_GUI_GATE:settings-close-accepted"));

      const shutdownMark = client.mark();
      const startedAt = Date.now();
      assert.equal(await client.shutdownOnly(false, 7_500), 0);
      assert.ok(
        Date.now() - startedAt < 7_500,
        "the releasable timeout race exceeded the existing shutdown policy",
      );

      const retirementIndex = client.frames.findIndex((frame, index) =>
        index >= shutdownMark && frame.t === "event" && frame.e === "settings.closed");
      assert.ok(retirementIndex >= shutdownMark, "the timeout did not retire the Settings operation");
      const retiredSuffix = client.frames.slice(retirementIndex + 1);
      const responses = client.frames.slice(shutdownMark).filter((frame) => frame.t === "response");
      assert.equal(
        responses.length,
        1,
        `only shutdown may respond after timeout retirement: ${JSON.stringify(responses)}`,
      );
      assert.deepEqual(responses[0]?.result, { stopping: true });
      assert.equal(
        client.frames.some((frame) => frame.t === "response" && frame.id === dispatchId),
        false,
        "the retired dispatch response crossed the transport boundary",
      );
      assert.equal(
        client.frames.some((frame) => frame.t === "response" && frame.id === closeId),
        false,
        "the retired close response crossed the transport boundary",
      );
      for (const event of ["settings.view", "notice", "status", "transcript", "settings.closed"]) {
        assert.equal(
          retiredSuffix.some((frame) => frame.t === "event" && frame.e === event),
          false,
          `retired Settings published a late ${event} event`,
        );
      }
      assert.equal(client.events("settings.closed").length, 1);
      assertDesktopSettingsPresentationStayedMapped(client, settingsMark);
    });

    const stderrLines = client.stderr.split(/\r?\n/).filter(Boolean);
    const engineDiagnostics = stderrLines.filter((line) => line.startsWith("orcode-gui:"));
    assert.deepEqual(engineDiagnostics, [
      "orcode-gui: Desktop Settings did not stop within 5000ms of shutdown.",
    ]);
    assert.equal(
      stderrLines.filter((line) =>
        /^orcode-gui: request "settings\.(?:dispatch|close)" failed:/.test(line),
      ).length,
      0,
      "retired Settings requests must not publish request-failed diagnostics",
    );
    assert.doesNotMatch(client.stderr, /fixture post-settlement Settings failure/);
    assert.doesNotMatch(client.stderr, /GuiResponseRetired|The request response was retired\./);

    assert.equal(client.result()?.settingsMutationHeld, 1);
    assert.equal(client.result()?.settingsMutationTaskCalls, 1);
    assert.equal(client.result()?.settingsTimeoutMutationReleased, 1);
    assert.equal(client.result()?.settingsTimeoutReleaseFrames, 1);
    assert.equal(client.result()?.settingsTimeoutCloseAccepted, 1);
    assert.equal(client.result()?.settingsTimeoutTransportDeferrals, 1);
    assert.equal(client.result()?.settingsTimeoutControllerSettlements, 1);
    assert.equal(client.result()?.configMutationCalls, 1);
    assert.equal(client.result()?.savedShowLargeLogo, false);
    assert.equal(client.result()?.liveShowLargeLogo, false);
    assert.equal(client.result()?.settingsDesktopAdvanceCalls, 1);
    assert.equal(client.result()?.settingsDesktopCancelAdvances, 0);
    assert.equal(client.result()?.settingsDesktopAbortCalls, 0);
    assert.equal(client.result()?.protocolSettingsClosedFrames, 1);
    assert.equal(client.result()?.protocolTranscriptFrames, 0);
  });
}

test("Settings main model exposes only canonical onboarding routes and never promotes a route-picker-only Kimi fixture", async () => {
  const client = await withClient("settings-kimi-switch", async (client) => {
    await client.handshake();
    const settingsMark = client.mark();
    const initial = await openDesktopSettings(client);
    const transcriptBefore = client.events("transcript").length;
    const picker = await openSharedSettingsPicker(client, initial, "Hauptmodell");
    assert.equal(picker.step, "model");
    assert.equal(picker.candidates.some(({ providerLabel }) => providerLabel === "Kimi Code"), false);
    assert.doesNotMatch(JSON.stringify(picker), /Kimi for Coding Highspeed|kimi-for-coding-highspeed/);
    const restored = await cancelSharedSettingsPicker(client, picker);
    assert.equal(restored.selectedCategoryId, "model");
    assert.equal(
      client.events("transcript").length - transcriptBefore,
      0,
      "the shared Settings route visit must not create a transcript row",
    );
    assert.equal((await client.request("settings.close")).ok, true);
    assertDesktopSettingsPresentationStayedMapped(client, settingsMark);
  });

  assert.deepEqual(client.result()?.crossModeAfter, { oneShot: false });
  assert.equal(client.result()?.settingsKimiAdapterActivations, 0);
  assert.equal(client.result()?.settingsPublicationPrepares, 0);
  assert.equal(client.result()?.settingsPublicationPublishes, 0);
  assert.equal(client.result()?.sessionPublicationPrepares, 0);
  assert.equal(client.result()?.sessionPublicationPublishes, 0);
  assert.equal(client.result()?.transitionEntries, 0);
  assert.equal(client.result()?.desktopRoutePickerViewCalls, 0);
  assert.equal(client.result()?.desktopRoutePickerResolveCalls, 0);
  assert.deepEqual(client.result()?.modelTransactionJournals, []);
  assert.equal(client.result()?.protocolTranscriptFrames, 1);
});

// ---------------------------------------------------------------------------
// Round-2 re-review, pin gap: the TUI half of the wire-redaction ruling. The
// wire half is pinned end-to-end above; this holds the OTHER side still — the
// dashboard's run-failure text stays `safeMessage` (TUI parity), while the
// sidecar's deps replace exactly that one member with `safePanelMessage`.
// Source-level on purpose, like the keymap tripwire: the seam is a deps
// literal, and this is the cheapest guard that notices it silently flipping.
// ---------------------------------------------------------------------------

test("describeRunFailure: the dashboard keeps safeMessage, the sidecar replaces exactly that member", async () => {
  const { readFile } = await import("node:fs/promises");
  const cli = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  const gui = await readFile(new URL("../src/gui-server.ts", import.meta.url), "utf8");
  assert.match(
    cli,
    /describeRunFailure: \(openRouter, error\) => openRouter\.safeMessage\(error\)/,
    "the dashboard's run-failure renderer is the TUI's documented safeMessage contract",
  );
  // The override routes through `describeError`, the sidecar's one wire
  // describer, which IS safePanelMessage — assert the chain, not one line.
  assert.match(
    gui,
    /describeRunFailure: \(_openRouter/,
    "the sidecar's deps replace the run-failure member",
  );
  assert.match(
    gui,
    /return describeError\(error\);/,
    "the replaced member returns the wire describer",
  );
  assert.match(
    gui,
    /const describeError = \(error: unknown\): string =>\s*\n?\s*context\.openRouter\.safePanelMessage\(error\);/,
    "the wire describer is the detail-dropping renderer",
  );
});

test("non-exact GUI provider commands stay on the legacy command dispatcher", async () => {
  const client = await withClient("setup", async (client) => {
    await client.handshake();
    const assertNoCanonicalSetupSince = (mark: number, raw: string): void => {
      const frames = client.frames.slice(mark);
      assert.equal(frames.some((frame) =>
        frame.t === "event" && frame.e === "activity"
        && (frame.activity as { message?: { code?: string } }).message?.code === "setup-opened"), false, raw);
    };

    const bareMark = client.mark();
    const bare = await client.request("command", { raw: "/provider", draft: "" });
    assert.equal(bare.ok, true, "/provider must remain a legacy command");
    assert.deepEqual(bare.result, { outcome: "continue" });
    assert.equal(client.frames.slice(bareMark).filter((frame) =>
      frame.t === "event" && frame.e === "command-output" && frame.raw === "/provider").length, 1);
    assertNoCanonicalSetupSince(bareMark, "/provider");

    const statusMark = client.mark();
    const status = await client.request("command", { raw: "/provider status", draft: "" });
    assert.equal(status.ok, false, "/provider status must remain legacy provider action validation");
    assert.deepEqual(status.error, { code: "request-failed", message: "OpenRouter request failed." });
    assert.equal(client.frames.slice(statusMark).some((frame) =>
      frame.t === "event" && frame.e === "command-output" && frame.raw === "/provider status"), false);
    assertNoCanonicalSetupSince(statusMark, "/provider status");

    const extraMark = client.mark();
    const extra = await client.request("command", { raw: "/provider setup extra", draft: "" });
    assert.equal(extra.ok, false, "non-canonical setup arguments stay with legacy validation");
    assert.deepEqual(extra.error, { code: "request-failed", message: "OpenRouter request failed." });
    assert.equal(client.frames.slice(extraMark).some((frame) =>
      frame.t === "event" && frame.e === "command-output" && frame.raw === "/provider setup extra"), false);
    assertNoCanonicalSetupSince(extraMark, "/provider setup extra");
  });
});

// ---------------------------------------------------------------------------
// G4: the Cross teardown, substantiated.
//
// The G3 re-review proved the `cross-armed` teardown assertion could not
// discriminate: the fixture pair is refused at `readModelRuntimeIdentity`, so
// the whole Cross run is over in 2-45 ms and a teardown that never stops Cross
// passes anyway. `cross-slow` gives the worker adapter the binding it asks for
// and a worker that settles ONLY on abort, so the two states the stop path
// exists to tell apart are actually different states.
// ---------------------------------------------------------------------------

test("EOF stops a Cross run that is still running, and its workers die with it", async () => {
  const client = new GuiClient("cross-slow");
  try {
    await client.handshake();
    const started = await client.request("submit", { text: "make the parser strict" });
    assert.deepEqual(started.result, { started: true, cross: true });
    assert.equal(
      client.events("transcript").filter((frame) =>
        frame.role === "user" && frame.content === "make the parser strict").length,
      1,
      "the committed armed task is echoed exactly once before its live workers",
    );

    // Both workers are alive and holding a detached child each — the
    // "two model workers spending into a pipe nobody reads" state itself.
    await client.await(
      (frame) => frame.t === "event"
        && frame.e === "status"
        && /cross/i.test(String(frame.text ?? "")),
      10_000,
    ).catch(() => undefined);
    const held = await client.request("command", { raw: "/cross status", draft: "" });
    assert.equal(held.ok, true);
    // The lane is held, which is only true while the run really is in flight.
    assert.equal((await client.request("submit", { text: "again" })).ok, false);

    const began = Date.now();
    const code = await client.endInput();
    const elapsed = Date.now() - began;
    assert.equal(code, 0, `exit code ${code} after ${elapsed}ms`);
    assert.ok(elapsed < 15_000, `EOF took ${elapsed}ms to end a live Cross run`);
  } finally {
    await client.stop();
  }

  const summary = client.result();
  // The discriminating facts: the workers really ran, and the stop path is
  // what ended them. Without `stopAndDrainCrossRun` neither is true — the
  // process does not reach this line at all, because nothing aborts them.
  assert.equal(summary?.crossWorkersStarted, 2, "both roles reached a worker");
  assert.equal(summary?.crossWorkersAborted, 2, "both were aborted, not abandoned");
  // And the OS agrees: a worker's own detached child is gone, so a SIGKILLed
  // sidecar's orphan story never starts.
  for (const pid of summary?.crossWorkerPids as number[]) {
    assert.throws(
      () => process.kill(pid, 0),
      /ESRCH/,
      `a Cross worker's tool child (${pid}) outlived the engine`,
    );
  }
});

test("an already-armed Cross run keeps exact safe route facts and exposes settled catalog actions", async () => {
  const client = new GuiClient("cross-slow");
  try {
    await client.handshake();
    await client.request("submit", { text: "make the parser strict" });
    const frame = await client.await(
      (candidate) => candidate.t === "event"
        && candidate.e === "cross"
        && (candidate.state as { active?: boolean } | null)?.active === true,
      10_000,
    );
    const state = frame.state as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(state).sort(),
      ["active", "challenger", "lead", "phase", "reason", "sequence", "updatedAt", "verification"],
    );
    assert.ok((state.sequence as number) > 0);
    assert.equal(typeof state.phase, "string");
    assert.notEqual(state.phase, "", "the live Cross journey exposes its current phase");
    assert.deepEqual(state.lead, {
      providerLabel: "OpenRouter",
      accountLabel: "Persönliches OpenRouter",
      displayName: "GUI Main",
      canonicalModelId: "vendor/gui-main",
      reasoning: "supported",
      capabilities: ["text", "tools"],
    });
    assert.deepEqual(state.challenger, {
      providerLabel: "OpenRouter",
      accountLabel: "Persönliches OpenRouter",
      displayName: "GUI Main",
      canonicalModelId: "vendor/gui-alternate",
      reasoning: "supported",
      capabilities: ["text", "tools"],
    });
    const liveJson = JSON.stringify(state);
    for (const privateField of ["providerId", "connectionId", "accountFingerprint", "backendId", "billingRealm"]) {
      assert.equal(liveJson.includes(`\"${privateField}\"`), false, `${privateField} must not cross the wire`);
    }

    // While active the real catalog still locks route mutation and leaves
    // Stop/Status available. This is the same availability the panel uses.
    const activeCatalog = await client.request("catalog.search", { query: "cross" });
    const activeRows = (activeCatalog.result as {
      rows: Array<{ command?: string; presentation: { disabled?: { code: string } } }>;
    }).rows;
    const activeCode = (raw: string): string | undefined =>
      activeRows.find((row) => row.command === raw)?.presentation.disabled?.code;
    assert.equal(activeCode("/cross models"), "cross-run-active");
    assert.equal(activeCode("/cross swap"), "cross-run-active");
    assert.equal(activeCode("/cross status"), undefined);
    assert.equal(activeCode("/cross stop"), undefined);
    assert.equal(
      activeRows.filter((row) => row.command === "/cross stop").length,
      1,
      "the active panel exposes exactly one canonical Stop action",
    );

    let mark = client.mark();
    const stopped = await client.request("command", { raw: "/cross stop", draft: "" });
    assert.equal(stopped.ok, true);
    assert.equal(client.frames.slice(mark).filter((candidate) => candidate.t === "response").length, 1);
    const settled = await client.awaitAfter(mark, (candidate) => candidate.t === "event"
      && candidate.e === "cross"
      && (candidate.state as { active?: boolean } | null)?.active === false);
    const settledState = settled.state as Record<string, unknown>;
    assert.deepEqual(settledState.lead, state.lead);
    assert.deepEqual(settledState.challenger, state.challenger);
    assert.deepEqual(settledState.selection, {
      lead: state.lead,
      challenger: state.challenger,
    });
    assert.ok((settledState.sequence as number) >= (state.sequence as number));

    const settledCatalog = await client.request("catalog.search", { query: "cross" });
    const settledRows = (settledCatalog.result as {
      rows: Array<{ command?: string; presentation: { disabled?: { code: string } } }>;
    }).rows;
    for (const raw of ["/cross models", "/cross swap", "/cross status"]) {
      assert.equal(
        settledRows.find((row) => row.command === raw)?.presentation.disabled,
        undefined,
        `${raw} must be actionable from the settled panel`,
      );
    }

    // Each direct panel action enters the existing command catalog exactly
    // once. `/cross models` is cancelled at its first real gate, proving the
    // command reached the shared preflight without arming or starting again.
    mark = client.mark();
    const models = client.request("command", { raw: "/cross models", draft: "" });
    const modelsGate = await client.awaitAfter(mark, (candidate) => candidate.t === "ask"
      && candidate.kind === "choice" && candidate.presentation === "cross-preflight");
    assert.equal(client.frames.slice(mark).filter((candidate) => candidate.t === "ask"
      && candidate.kind === "choice" && candidate.presentation === "cross-preflight").length, 1);
    client.send({ t: "answer", askId: modelsGate.askId, value: null });
    assert.equal((await models).ok, true);
    assert.equal(client.frames.slice(mark).filter((candidate) => candidate.t === "response").length, 1);

    mark = client.mark();
    const swapped = await client.request("command", { raw: "/cross swap", draft: "" });
    assert.equal(swapped.ok, true);
    assert.equal(client.frames.slice(mark).filter((candidate) => candidate.t === "response").length, 1);
    const swappedPanel = await client.awaitAfter(mark, (candidate) => candidate.t === "event"
      && candidate.e === "cross"
      && (candidate.state as { selection?: { lead?: { canonicalModelId?: string } } } | null)
        ?.selection?.lead?.canonicalModelId === "vendor/gui-alternate");
    const swappedState = swappedPanel.state as {
      lead: unknown;
      challenger: unknown;
      selection: { lead: unknown; challenger: unknown };
    };
    assert.deepEqual(swappedState.lead, state.lead, "the last run must not be relabelled by a later swap");
    assert.deepEqual(swappedState.challenger, state.challenger, "the last run must not be relabelled by a later swap");
    assert.deepEqual(swappedState.selection, {
      lead: state.challenger,
      challenger: state.lead,
    }, "the current selection must make the swap visible");

    mark = client.mark();
    const status = await client.request("command", { raw: "/cross status", draft: "" });
    assert.equal(status.ok, true);
    assert.equal(client.frames.slice(mark).filter((candidate) => candidate.t === "response").length, 1);
    assert.equal(client.frames.slice(mark).filter((candidate) => candidate.t === "event"
      && candidate.e === "transcript" && candidate.role === "system" && candidate.meta === "Cross").length, 1);
  } finally {
    await client.stop();
  }
  assert.equal(client.result()?.crossWorkersStarted, 2);
  assert.equal(client.result()?.crossWorkersAborted, 2);
  assert.equal(client.result()?.crossPreferencePublishes, 1, "the one swap command publishes once");
  // No private route identity reached the wire in either live or settled state.
  assert.ok(!client.stdout.includes("SECRETCROSSLEADCANARY"));
  assert.ok(!client.stdout.includes("SECRETCROSSCHALLENGERCANARY"));
});
