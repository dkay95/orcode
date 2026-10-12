import assert from "node:assert/strict";
import { terminalHeld } from "../src/ui/terminal-lease.js";
import { pickFromListPlain } from "../src/ui/list-plain.js";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ReadStream, WriteStream } from "node:tty";
import { ApprovalManager } from "../src/approval.js";
import { COMMAND_CATALOG, searchCommands } from "../src/command-catalog.js";
import { createRunId, RunLog } from "../src/runlog.js";
import { SessionStore } from "../src/session.js";
import {
  ChangeJournal,
  WorkspaceGuard,
  createCodingTools,
  type CodingToolOptions,
} from "../src/workspace.js";
import {
  TerminalUi,
  buildDashboardFrame,
  createTerminalModelRoutePicker,
  runOutcomeLabel,
  sanitizeTerminalText,
  type ChoicePickerItem,
  type DashboardFrameInput,
  type DashboardState,
} from "../src/tui.js";
import type { SelectableModelRoute } from "../src/model-route-catalog.js";
import type { ChatBlock } from "../src/ui/blocks.js";
import {
  buildListEmptyLine,
  withListSections,
  type ListSection,
} from "../src/ui/list-core.js";
import { listActionChips } from "../src/ui/keymap.js";
import { actionBarLine } from "../src/ui/zones.js";
import { lineWidth, plainText, type Line } from "../src/ui/spans.js";
import { createTheme } from "../src/ui/theme.js";
import { routeCoreCompact, routeCoreLarge } from "../src/branding.js";
import { RunViewModel } from "../src/ui/view-model.js";
import type { AgentRunEvent, ModelInfo } from "../src/types.js";
import { handleSlashCommand, type CommandContext } from "../src/commands.js";
import * as credentialsModule from "../src/credentials.js";
import { createTuiSetupSurface, type TuiSetupPromptUi } from "../src/setup-surface/index.js";

const theme = createTheme({ level: 0 });
const NOW = 1_700_000_000_000;

const state: DashboardState = {
  workspace: "/Users/demo/projects/robopet",
  projectStatus: "robopet · Git main*3 · 12 Chat-Nachrichten",
  model: "openrouter/auto",
  resolvedModel: "moonshotai/kimi-k3",
  approval: "ask",
  reasoning: "auto",
  maxCost: "$1.000",
  budget: "Day $2.000 · Total $50.000",
  maxSteps: 12,
};

function text(lines: readonly Line[]): string {
  return lines.map((line) => plainText(line)).join("\n");
}

function input(overrides: Partial<DashboardFrameInput> = {}): DashboardFrameInput {
  return {
    width: 100,
    height: 28,
    theme,
    state,
    blocks: [],
    mode: "input",
    input: "",
    cursor: 0,
    status: "Ready",
    now: NOW,
    ...overrides,
  };
}

test("empty dashboard and normal header consume the canonical Route Core branding", () => {
  const branded = buildDashboardFrame(input({
    brand: {
      showLargeLogo: true,
      showHeaderMark: true,
      largeLines: routeCoreLarge("ascii"),
      compactMark: routeCoreCompact("ascii"),
      version: "9.9.9",
    },
  }));
  const brandedText = text(branded.lines);
  assert.match(brandedText, /---------\*/);
  assert.match(brandedText, /ORCODE/);

  const unbranded = buildDashboardFrame(input({
    brand: {
      showLargeLogo: false,
      showHeaderMark: false,
      largeLines: routeCoreLarge("ascii"),
      compactMark: routeCoreCompact("ascii"),
      version: "9.9.9",
    },
  }));
  // D8d appearance pin update, with justification: the wordmark text itself
  // (`ORCODE <version>`, one source — `ROUTE_CORE_WORDMARK` + the threaded
  // `readPackageVersion()`) is now an unconditional part of the hub's
  // identity row; `showHeaderMark` only ever gated the compact mark GLYPH
  // ahead of it (unchanged from before this ruling — the pre-D8d wordmark
  // text, lowercase "orcode", was in fact always there too, just never
  // caught by this case-sensitive regex). Only the glyph vanishes here.
  const unbrandedText = text(unbranded.lines);
  assert.doesNotMatch(unbrandedText, /---------\*|>-\*/);
  assert.match(unbrandedText, /ORCODE 9\.9\.9/);

  const populated = buildDashboardFrame(input({
    blocks: chat(1),
    brand: {
      showLargeLogo: true,
      showHeaderMark: true,
      largeLines: routeCoreLarge("ascii"),
      compactMark: routeCoreCompact("ascii"),
      version: "9.9.9",
    },
  }));
  assert.match(plainText(populated.lines[0]!), />-\*/);
});

test("empty Route Core degrades from complete large art to compact wordmark then welcome", () => {
  const brand = {
    showLargeLogo: true,
    showHeaderMark: true,
    largeLines: routeCoreLarge("ascii"),
    compactMark: routeCoreCompact("ascii"),
    version: "9.9.9",
  };
  // Heights re-measured for D8d, with justification: the hub no longer
  // reserves MIN_STREAM (5) blank filler rows it will never use
  // (render-frame.ts's `isHub` floor, D8d) and no longer duplicates the
  // folder path in a plain header above the box (the box absorbs it) — both
  // used to cost real rows the candidate ladder had to budget for, so every
  // tier now fits at a shorter height than before D8d.
  const tall = text(buildDashboardFrame(input({ height: 26, brand })).lines);
  assert.match(tall, /---------\*/);
  assert.match(tall, /^Recent$/m);

  const short = text(buildDashboardFrame(input({ height: 16, brand })).lines);
  assert.doesNotMatch(short, /---------\*/);
  // `Route     ` (five trailing spaces) is the box's own row label, present
  // here and in `tall` above but not in the compact-mark-only tier below —
  // the specific discriminator between "the box itself" and just the
  // wordmark text (which the compact tier's own one-liner also carries).
  assert.match(short, /Route {5}/);
  assert.match(short, /^Recent$/m);

  // This fixture's `input()` never sets `quickGroups` and starts with no
  // `recentChats`, so the hub's own smallest real content — the compact
  // mark plus an empty "Recent" section — is already only 3 lines: the
  // bare "What would you like to do?" invitation below it is genuinely
  // unreachable through height alone with this minimal fixture (there is
  // nothing left to shed). `ui-workbench.test.ts`'s dedicated degrade-ladder
  // and rock-bottom tests own that tier, with a fixture built to reach it.
  const minimum = text(buildDashboardFrame(input({ height: 8, brand })).lines);
  assert.doesNotMatch(minimum, /---------\*|Route {5}/);
  assert.match(minimum, />-\* ORCODE 9\.9\.9/);
  assert.match(minimum, /^Recent$/m);
});

test("empty Route Core accounts for multiline input and chrome before selecting an expansion tier", () => {
  const frame = buildDashboardFrame(input({
    height: 20,
    input: "one\ntwo\nthree\nfour\nfive\nsix",
    cursor: 27,
    status: "sichtbarer Status",
    statusFresh: true,
    helpRequested: true,
    brand: {
      showLargeLogo: true,
      showHeaderMark: true,
      largeLines: routeCoreLarge("ascii"),
      compactMark: routeCoreCompact("ascii"),
      version: "9.9.9",
    },
  }));
  const rendered = text(frame.lines);
  assert.doesNotMatch(rendered, /---------\*/);
  assert.match(rendered, />-\* ORCODE/);
  assert.match(rendered, /^Recent$/m);
  assert.equal(frame.lines.length <= 20, true);
});

// D8e: `/new` (and any chat-switch landing on an empty chat) used to publish
// its "Chat: <title> · N message(s) · <uuid>" confirmation as a transcript
// block, which flips `blocks.length` away from zero and — per `isHub` in
// `ui/dashboard-frame.ts` — replaces the clean hub with the old bare
// transcript layout for a chat that has nothing in it. The fix (`cli.ts`'s
// `applyDashboardCommandOutput`) routes that confirmation through the
// transient status channel instead: `blocks` stays empty, so the frame is
// still the hub, and the confirmation still reaches the user via the status
// line (`dashboard-frame.ts`'s `statusInfo`: a fresh, non-"Ready" status
// renders as the status line's own text).
test("D8e: an empty chat with the /new status confirmation still renders as the hub, never the bare transcript layout", () => {
  const brand = {
    showLargeLogo: true,
    showHeaderMark: true,
    largeLines: routeCoreLarge("ascii"),
    compactMark: routeCoreCompact("ascii"),
    version: "9.9.9",
  };
  const frame = buildDashboardFrame(input({
    blocks: [],
    status: "New chat started.",
    statusFresh: true,
    brand,
  }));
  const rendered = text(frame.lines);
  assert.match(rendered, /---------\*/);
  assert.match(rendered, /^Recent$/m);
  assert.match(rendered, /New chat started\./);
  assert.doesNotMatch(rendered, /message\(s\)/);
  assert.doesNotMatch(rendered, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);

  // A chat WITH content (a real transcript block) keeps today's ordinary
  // presentation — the hub's brand block never shows once there is
  // something to actually show instead.
  const populatedFrame = buildDashboardFrame(input({
    blocks: chat(1),
    status: "Chat opened: Old chat",
    statusFresh: true,
    brand,
  }));
  const populatedRendered = text(populatedFrame.lines);
  assert.doesNotMatch(populatedRendered, /---------\*/);
  assert.doesNotMatch(populatedRendered, /^Recent$/m);
});

/**
 * J2 finding 1 (render-scheduler race). The D8e test directly above proves
 * the FRAME renders the confirmation once it is handed one. Getting it into
 * the frame is where it was actually lost: `applyDashboardCommandOutput`
 * (`cli.ts`) put "New chat started." on the status channel exactly as
 * designed, and the dashboard loop's `landedOnEmptyChat` guard already
 * skipped its own generic "Ready" reset to protect it — but the next thing
 * that loop does is `await ui.readInput()`, whose mode entry overwrote
 * `#status` with its own "Ready" and painted IMMEDIATELY
 * (`scheduleRender(true)`), while `setStatus`'s paint was still only the
 * ordinary 30ms debounce, cleared before it ever fired. Nothing yields
 * between the two, so the confirmation was computed, dispatched, and never
 * shown for even one frame.
 *
 * "Ready" is the composer's DEFAULT, not an instruction to erase what was
 * just said, so it now loses to a fresh transient notice the terminal has
 * not had its chance to show yet. Every sibling that sets a status right
 * before returning to the composer wins the same way — `/chats`' "Chat
 * opened: <title>", `pickDashboardChat`'s "Folder switched: …", the
 * "Cross is already running" notice.
 */
test("a transient status set right before readInput survives the composer's own mode entry and is really painted", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    terminal.setStatus("New chat started.", false);
    const pending = terminal.readInput();
    assert.match(
      text(terminal.frame().lines),
      /New chat started\./,
      "readInput's generic \"Ready\" default must not overwrite a fresh transient notice",
    );
    assert.match(
      stdout.output,
      /New chat started\./,
      "the notice must reach the real terminal, not merely the frame the test asks for",
    );
    press(stdin, "return");
    assert.equal(await pending, "");
  } finally {
    terminal.stop();
  }
});

/**
 * The precedence rule above is deliberately narrow: only a transient notice
 * the status channel itself wrote (`setStatus(…, busy=false)`), still fresh,
 * and still the current status, carries into the composer. A run's own phase
 * text, a status already consumed by an earlier composer entry, and a plain
 * "Ready" all fall back to "Ready" exactly as before — so a stale busy phase
 * can never sit above an idle composer pretending work is still happening.
 */
test("readInput keeps falling back to Ready for a run phase, a consumed notice, and Ready itself", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    // A busy run phase is not a notice: it belongs to the run, not the composer.
    terminal.setStatus("Streaming …");
    let pending = terminal.readInput();
    assert.doesNotMatch(text(terminal.frame().lines), /Streaming …/);
    press(stdin, "return");
    await pending;

    // A notice is carried exactly once — the composer entry that showed it
    // consumes it, so simply pressing Enter again does not resurrect it.
    terminal.setStatus("Chat opened: River Facts", false);
    pending = terminal.readInput();
    assert.match(text(terminal.frame().lines), /Chat opened: River Facts/);
    press(stdin, "return");
    await pending;
    pending = terminal.readInput();
    assert.doesNotMatch(text(terminal.frame().lines), /Chat opened: River Facts/);
    press(stdin, "return");
    await pending;

    // "Ready" itself is never treated as something worth protecting.
    terminal.setStatus("Ready", false);
    pending = terminal.readInput();
    assert.doesNotMatch(text(terminal.frame().lines), /Chat opened/);
    press(stdin, "return");
    await pending;
  } finally {
    terminal.stop();
  }
});

function chat(count: number): ChatBlock[] {
  const model = new RunViewModel();
  for (let index = 0; index < count; index += 1) {
    model.pushUser(`Frage ${index}`, 0, NOW + index);
    model.appendAssistant(
      `Antwort ${index}: ${"ausführlicher Text ".repeat(4)}`,
      NOW + index,
    );
    model.finishAssistant();
  }
  return [...model.blocks];
}

function modelInfo(id: string, name = id): ModelInfo {
  return {
    id,
    name,
    description: `${name} ist ein tool-fähiges Coding-Modell.`,
    contextLength: 131_072,
    promptPrice: 0.000_000_2,
    completionPrice: 0.000_000_8,
    supportedParameters: ["tools", "reasoning"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    reasoning: {
      defaultEffort: "low",
      defaultEnabled: true,
      mandatory: false,
      supportedEfforts: ["low", "high"],
      supportsMaxTokens: true,
    },
  };
}

function awsCaptureLabels(): Array<{ name: string; label: string }> {
  return [
    { name: "bare-equals", label: "aws_secret_access_key=" },
    { name: "spaced-double-value", label: 'aws_secret_access_key =  "' },
    { name: "double-quoted-json", label: 'aws_secret_access_key" : "' },
    { name: "single-quoted-tabbed", label: "AWS-SECRET-ACCESS-KEY'\t=\t'" },
  ];
}

class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;

  setRawMode(value: boolean): this {
    this.isRaw = value;
    return this;
  }

  resume(): this {
    return this;
  }

  pause(): this {
    return this;
  }
}

class FakeOutput extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 28;
  output = "";

  write(value: string | Uint8Array): boolean {
    this.output += value.toString();
    return true;
  }
}

function ui(stdin: FakeInput, stdout: FakeOutput): TerminalUi {
  return new TerminalUi(
    () => state,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
    theme,
  );
}

function press(stdin: FakeInput, name: string, character = "", extra: Record<string, unknown> = {}): void {
  stdin.emit("keypress", character, { name, ctrl: false, meta: false, ...extra });
}

function emitTerminalData(stdin: FakeInput, value: string): void {
  const listener = stdin.listeners("data")[0];
  assert.ok(listener, "TerminalUi raw-data listener must be installed first");
  listener(Buffer.from(value));
}

function pressReadlineEscape(stdin: FakeInput): void {
  emitTerminalData(stdin, "\u001b");
  press(stdin, "escape", "", { sequence: "\u001b" });
}

function type(stdin: FakeInput, value: string): void {
  for (const character of value) {
    press(stdin, character.toLowerCase(), character);
  }
}

// F7 (ruling 2): the `chooseAuthenticationMethod` picker is gone entirely
// (Kimi's one real auth method needs no picker of its own anymore, and no
// other provider ever had one) — renamed from "...and OAuth explanations
// out of picker values" and the removed picker's assertions dropped; the
// remaining unavailable-provider-explanation coverage is unchanged.
test("setup TUI surface keeps unavailable provider explanations out of picker values", async () => {
  const calls: string[] = [];
  const promptUi: TuiSetupPromptUi = {
    async pickChoice(_title, items) {
      calls.push(`choice:${items[0]?.value}`);
      return items[0] ?? null;
    },
    async readSecret() { calls.push("secret"); return "candidate"; },
    async pickModel(search) { calls.push(`model:${search("")[0]?.id}`); return search("")[0] ?? null; },
    async confirmAction() { calls.push("confirm"); return { accepted: true }; },
    addMessage(_role, message) { calls.push(`notice:${message}`); },
    setStatus(status) { calls.push(`status:${status}`); },
  };
  const surface = createTuiSetupSurface(promptUi);

  const providerEntries = [
    { id: "anthropic", label: "Anthropic / Claude", description: "Coming soon is not selectable", disabled: true, current: false, generation: 3 },
    { id: "openrouter", label: "OpenRouter", description: "API key · Pay as you go", disabled: false, current: false, generation: 3 },
  ];
  surface.present({ version: 1, type: "provider-state", entries: providerEntries });
  assert.equal(await surface.chooseHub(providerEntries), "openrouter");
  assert.equal(await surface.readSecret({ backendId: "openrouter", message: "Key" }), "candidate");
  assert.equal(await surface.chooseModel({ backendId: "openrouter", models: [{ backendId: "openrouter", requestedModelId: "vendor/a", canonicalModelId: "vendor/a", displayName: "A", capabilities: { textInput: true, textOutput: true, tools: true, reasoning: false } }] }), "vendor/a");
  assert.equal(await surface.confirm({ id: "save", message: "Save?", defaultValue: true }), true);
  surface.present({ version: 1, type: "notice", message: "Coming soon" });
  assert.deepEqual(calls, [
    "notice:Anthropic / Claude · Coming soon is not selectable",
    "choice:openrouter",
    "secret",
    "model:vendor/a",
    "confirm",
    "status:Coming soon",
  ]);
});

test("choice picker parses real SGR mouse bytes into the same Anthropic selection as keyboard", async () => {
  async function select(method: "keyboard" | "mouse"): Promise<string | null> {
    const stdin = new FakeInput();
    const stdout = new FakeOutput();
    const terminal = ui(stdin, stdout);
    terminal.start();
    try {
      const picked = terminal.pickChoice("Provider", [
        { value: "openrouter", label: "OpenRouter", description: "Ready" },
        { value: "anthropic", label: "Anthropic · Coming soon", description: "Coming soon" },
      ], "openrouter");
      if (method === "keyboard") {
        press(stdin, "down");
        press(stdin, "return");
      } else {
        const row = terminal.frame().lines.findIndex((line) => plainText(line).includes("Anthropic")) + 1;
        assert.ok(row > 0, "Anthropic must occupy a visible picker row");
        stdin.emit("data", Buffer.from(`\u001b[<0;1;${row}M`));
      }
      const selected = await picked;
      assert.match(stdout.output, /\u001b\[\?1000h\u001b\[\?1006h/);
      return selected?.value ?? null;
    } finally {
      terminal.stop();
      assert.match(stdout.output, /\u001b\[\?1000l\u001b\[\?1006l/);
    }
  }

  assert.equal(await select("keyboard"), "anthropic");
  assert.equal(await select("mouse"), "anthropic");
});

/**
 * Phase F3 (information-dense pickers), ruling 1: the fullscreen /model
 * picker (`createTerminalModelRoutePicker`) is the picker the binding
 * mockup depicts, so its row composes the exact `<provider> · <price> ·
 * <ctx>` shape — a real per-token price for an OpenRouter route, and
 * "subscription" (never a fabricated number) for a provider-managed one
 * (Kimi & friends) — via the shared `formatModelRouteDetail` (`utils.ts`).
 */
test("the fullscreen /model route picker's rows carry real pricing and never fabricate a price for provider-managed routes", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const priced: SelectableModelRoute = {
      route: {
        version: 1,
        backendId: "openrouter",
        accountFingerprint: "acct-priced",
        billingRealm: "openrouter-payg",
        requestedModelId: "anthropic/claude-sonnet-4-6",
        canonicalModelId: "anthropic/claude-sonnet-4-6",
        resolutionState: "resolved",
      },
      providerLabel: "Anthropic",
      model: {
        id: "anthropic/claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        contextLength: 200_000,
        reasoning: undefined,
        price: { kind: "known", promptUsdPerToken: 0.000003, completionUsdPerToken: 0.000015 },
      },
      supportsTools: true,
      supportsReasoning: true,
      selected: true,
    };
    const subscription: SelectableModelRoute = {
      route: {
        version: 1,
        backendId: "kimi-code",
        accountFingerprint: "acct-kimi",
        billingRealm: "kimi-code-membership-provider-managed-overage",
        requestedModelId: "k3",
        canonicalModelId: "k3",
        resolutionState: "resolved",
      },
      providerLabel: "Kimi Code",
      model: {
        id: "k3",
        name: "Kimi K3",
        contextLength: 256_000,
        reasoning: undefined,
        price: { kind: "unknown" },
      },
      supportsTools: true,
      supportsReasoning: true,
      selected: false,
    };
    const picker = createTerminalModelRoutePicker(terminal, {
      listSelectableModelRoutes: async () => [priced, subscription],
    });
    const picked = picker.pickModelRoute({
      title: "the main model",
      role: "main",
      current: priced.route,
      preserveDraft: true,
    });
    // `pickModelRoute` awaits the (async) catalog fetch before it enters
    // "choice-picker" mode — flush that microtask before reading the frame
    // or pressing a key, exactly like this file's other async-setup pickers.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const rendered = text(terminal.frame().lines);
    assert.match(rendered, /Anthropic · \$3\/M in · \$15\/M out · 200K/);
    assert.match(rendered, /Kimi Code · Kosten unbekannt · 256\.000 ctx/);
    press(stdin, "escape");
    assert.equal(await picked, null);
  } finally {
    terminal.stop();
  }
});

/**
 * Real-TTY-shaped smoke of the workspace switch (Phase F1b): the controller's
 * dispatch prompt for this task asked for a PTY smoke of the switch "using
 * the existing scripts/check-pty patterns if a PTY script fits, else a
 * real-TTY-shaped integration test" (the brief itself only says "PTY smoke of
 * the switch", no fallback clause). The Python/PTY harness in
 * `scripts/check-pty.mjs` is hard-wired to a specific Settings suspend/resume
 * scenario (its own markers, a `dist/` build, a real subprocess) and does not
 * fit a chat-picker scenario; this drives the exact same sectioned items
 * `pickDashboardChat` builds (`src/cli.ts`, via `withListSections`) through a
 * real `TerminalUi` over a TTY-shaped (but in-process) stdin/stdout — real
 * render, real raw-mode keypresses, real key-intent classification — the
 * same surface a genuine PTY session drives, without the external
 * Python/build dependency.
 */
test("real-TTY smoke: the sectioned /chats picker shows both folders and keyboard navigation skips the heading to reach a foreign chat", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const sections: ListSection[] = [
      {
        heading: "Current folder",
        entries: [
          {
            name: "Local chat",
            value: "local-chat-id",
            label: "Local chat",
            description: "1 message · $0.00 · just now",
          } as unknown as ListSection["entries"][number],
        ],
      },
      {
        heading: "Other folders",
        entries: [
          {
            name: "Foreign chat",
            value: "foreign-chat-id",
            label: "Foreign chat",
            description: "2 messages · $0.01 · 1h ago · ~/projects/other",
          } as unknown as ListSection["entries"][number],
        ],
      },
    ];
    // Mirrors `pickDashboardChat`'s own `toDashboardChoice` (src/cli.ts):
    // `withListSections` only guarantees a heading row's `name` (list-core's
    // `ListEntry` shape); a real `ChoicePickerItem` renders through `label`.
    const items: ChoicePickerItem[] = withListSections(sections).map((entry) =>
      entry.sectionHeading
        ? { value: `__section__${entry.name}`, label: entry.name, description: "", sectionHeading: true }
        : (entry as unknown as ChoicePickerItem));
    const picker = terminal.pickChoice("Chats · project-a", items, "local-chat-id");

    const initial = text(terminal.frame().lines);
    assert.match(initial, /Current folder/);
    assert.match(initial, /Other folders/);
    assert.match(initial, /Local chat/);
    assert.match(initial, /Foreign chat/);
    assert.match(initial, /~\/projects\/other/);

    // From the current chat's row, one Down must skip clean over the
    // non-selectable "Other folders" heading (stepSelectableListIndex) and
    // land directly on the foreign chat — never a dead stop on the divider.
    press(stdin, "down");
    const afterDown = text(terminal.frame().lines);
    assert.match(afterDown, /❯.*Foreign chat/u);

    press(stdin, "return");
    const picked = await picker;
    assert.equal(picked?.value, "foreign-chat-id", "Enter must resolve the foreign chat, not the section heading");
  } finally {
    terminal.stop();
  }
});

test("FIX-11: pickChoice renders the caller's own title verbatim — no fabricated 'Choose ' prefix", async () => {
  for (const title of ["Provider setup", "Cross · Start", "Chats · robopet", "Approval mode"]) {
    const stdin = new FakeInput();
    const stdout = new FakeOutput();
    const terminal = ui(stdin, stdout);
    terminal.start();
    try {
      const picker = terminal.pickChoice(title, [
        { value: "a", label: "First", description: "" },
        { value: "b", label: "Second", description: "" },
      ], "a");
      const lines = terminal.frame().lines.map((line) => plainText(line));
      // V4-A: the heading is the title bar now, so at colour level 0 it wears
      // the divider rule the bar degrades to. The TEXT is still the caller's
      // own, verbatim — which is all this test was ever about.
      assert.ok(
        lines.includes(`${theme.glyph("divider")} ${title}`),
        `the picker title bar must carry exactly ${JSON.stringify(title)}: ${JSON.stringify(lines)}`,
      );
      assert.equal(
        lines.some((line) => line.includes(`Choose ${title}`)),
        false,
        `no line may read "Choose ${title}"`,
      );
      press(stdin, "escape");
      assert.equal(await picker, null);
    } finally {
      terminal.stop();
    }
  }
});

// FIX-11 addendum: the picker used to print its own name twice, one line
// apart — once as the heading above the rows, once again on the status line
// directly above the filter row. The heading is the single place it renders.
test("FIX-11: a choice picker prints its title exactly once, and the filter row keeps only its prompt", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const picker = terminal.pickChoice("Provider setup", [
      { value: "openrouter", label: "OpenRouter", description: "Stable" },
      { value: "kimi", label: "Kimi Code", description: "Preview" },
    ], "openrouter");
    const lines = terminal.frame().lines.map((line) => plainText(line));
    assert.equal(
      lines.filter((line) => line.includes("Provider setup")).length,
      1,
      `the title must render on exactly one line: ${JSON.stringify(lines)}`,
    );
    // The status line right above the composer is the one that used to
    // repeat it; it now carries the always-on identity chrome instead.
    assert.doesNotMatch(lines.at(-3)!, /Provider setup/);
    press(stdin, "escape");
    assert.equal(await picker, null);
  } finally {
    terminal.stop();
  }
});

test("Readline standalone Escape cancels a choice picker and disables mouse reporting", async () => {
  const enable = "\u001b[?1000h\u001b[?1006h";
  const disable = "\u001b[?1000l\u001b[?1006l";
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  let settled = false;
  let picker: Promise<{ value: string } | null> | null = null;
  try {
    picker = terminal.pickChoice("Provider", [
      { value: "openrouter", label: "OpenRouter", description: "Ready" },
    ], "openrouter");
    void picker.then(() => {
      settled = true;
    });

    pressReadlineEscape(stdin);
    await Promise.resolve();

    assert.equal(settled, true, "completed Escape keypress must settle the picker");
    assert.equal(await picker, null);
    assert.equal(stdout.output.split(enable).length - 1, 1, stdout.output);
    assert.equal(stdout.output.split(disable).length - 1, 1, stdout.output);
    assert.match(text(terminal.frame().lines), /Selection cancelled/);
  } finally {
    if (!settled) {
      press(stdin, "c", "\u0003", { ctrl: true });
      await picker;
    }
    terminal.stop();
  }
});

test("Readline standalone Escape cancels a model picker and disables mouse reporting", async () => {
  const enable = "\u001b[?1000h\u001b[?1006h";
  const disable = "\u001b[?1000l\u001b[?1006l";
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  let settled = false;
  let picker: Promise<ModelInfo | null> | null = null;
  try {
    picker = terminal.pickModel(() => [modelInfo("vendor/a")], "vendor/a");
    void picker.then(() => {
      settled = true;
    });

    pressReadlineEscape(stdin);
    await Promise.resolve();

    assert.equal(settled, true, "completed Escape keypress must settle the picker");
    assert.equal(await picker, null);
    assert.equal(stdout.output.split(enable).length - 1, 1, stdout.output);
    assert.equal(stdout.output.split(disable).length - 1, 1, stdout.output);
    assert.match(text(terminal.frame().lines), /Selection cancelled/);
  } finally {
    if (!settled) {
      press(stdin, "c", "\u0003", { ctrl: true });
      await picker;
    }
    terminal.stop();
  }
});

test("Readline standalone Escape cancels secret entry and clears its input", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  let settled = false;
  let secret: Promise<string | null> | null = null;
  try {
    secret = terminal.readSecret("OpenRouter API-Key");
    void secret.then(() => {
      settled = true;
    });
    type(stdin, "stale-secret");

    pressReadlineEscape(stdin);
    await Promise.resolve();

    assert.equal(settled, true, "completed Escape keypress must settle secret entry");
    assert.equal(await secret, null);
    assert.match(text(terminal.frame().lines), /Input cancelled/);
    const next = terminal.readInput();
    type(stdin, "clean");
    press(stdin, "return");
    assert.equal(await next, "clean");
  } finally {
    if (!settled) {
      press(stdin, "c", "\u0003", { ctrl: true });
      await secret;
    }
    terminal.stop();
  }
});

test("SGR mouse parsing accepts every split escape prefix without leaking into the picker", async () => {
  for (const prefixLength of [1, 2, 3]) {
    const stdin = new FakeInput();
    const stdout = new FakeOutput();
    const terminal = ui(stdin, stdout);
    terminal.start();
    let picked: Promise<{ value: string } | null> | null = null;
    try {
      picked = terminal.pickChoice("Provider", [
        { value: "openrouter", label: "OpenRouter", description: "Ready" },
        { value: "anthropic", label: "Anthropic · Coming soon", description: "Coming soon" },
      ], "openrouter");
      const row = terminal.frame().lines.findIndex((line) => plainText(line).includes("Anthropic")) + 1;
      const packet = `\u001b[<0;1;${row}M`;
      stdin.emit("data", Buffer.from(packet.slice(0, prefixLength)));
      stdin.emit("data", Buffer.from(packet.slice(prefixLength)));

      const selected = await Promise.race([
        picked.then((item) => item?.value ?? null),
        new Promise<null>((resolve) => setImmediate(() => resolve(null))),
      ]);
      assert.equal(selected, "anthropic", `split ${prefixLength}`);
    } finally {
      press(stdin, "escape");
      await picked;
      terminal.stop();
    }
  }
});

test("ESC [ followed by a divergent non-mouse escape resets before the next chat key", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const input = terminal.readInput();
    stdin.emit("data", Buffer.from("\u001b["));
    stdin.emit("data", Buffer.from("\u001b"));
    stdin.emit("data", Buffer.from("a"));
    stdin.emit("data", Buffer.from("\u001b[<0;1;1M"));
    press(stdin, "return");

    assert.equal(await input, "a");
  } finally {
    terminal.stop();
  }
});

test("ESC [ < followed by a divergent non-mouse escape resets before the next secret key", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const secret = terminal.readSecret("OpenRouter API-Key");
    stdin.emit("data", Buffer.from("\u001b[<"));
    stdin.emit("data", Buffer.from("\u001b"));
    stdin.emit("data", Buffer.from("a"));
    press(stdin, "return");

    assert.equal(await secret, "a");
  } finally {
    terminal.stop();
  }
});

test("a malformed SGR prefix resets before the next ordinary input key", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const input = terminal.readInput();
    stdin.emit("data", Buffer.from("\u001b[<x"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    type(stdin, "a");
    press(stdin, "return");
    assert.equal(await input, "a");
  } finally {
    terminal.stop();
  }
});

test("mouse reporting belongs only to a pending picker and ends at settlement", async () => {
  const enable = "\u001b[?1000h\u001b[?1006h";
  const disable = "\u001b[?1000l\u001b[?1006l";
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    assert.doesNotMatch(stdout.output, /\u001b\[\?1000h\u001b\[\?1006h/);
    const picker = terminal.pickChoice("Provider", [
      { value: "openrouter", label: "OpenRouter", description: "Ready" },
    ], "openrouter");
    assert.equal(stdout.output.split(enable).length - 1, 1, stdout.output);
    press(stdin, "return");
    assert.equal((await picker)?.value, "openrouter");
    assert.equal(stdout.output.split(disable).length - 1, 1, stdout.output);
    assert.ok(stdout.output.lastIndexOf(disable) > stdout.output.lastIndexOf(enable), stdout.output);
  } finally {
    terminal.stop();
  }
});

test("a pending picker re-enables SGR mouse only after suspend resumes it", async () => {
  const enable = "\u001b[?1000h\u001b[?1006h";
  const disable = "\u001b[?1000l\u001b[?1006l";
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const picker = terminal.pickChoice("Provider", [
      { value: "openrouter", label: "OpenRouter", description: "Ready" },
    ], "openrouter");
    await terminal.suspend(async () => undefined);
    assert.equal(stdout.output.split(enable).length - 1, 2, stdout.output);
    assert.equal(stdout.output.split(disable).length - 1, 1, stdout.output);
    press(stdin, "escape");
    assert.equal(await picker, null);
    assert.equal(stdout.output.split(disable).length - 1, 2, stdout.output);
  } finally {
    terminal.stop();
  }
});

test("mouse protocol rejects malformed, non-left, release, and out-of-range bytes without leaking into chat", async () => {
  const ignored = [
    "\u001b[<x;1;1M",
    "\u001b[<2;1;1M",
    "\u001b[<0;1;1m",
    "\u001b[<0;1;999M",
  ];
  for (const sequence of ignored) {
    const stdin = new FakeInput();
    const stdout = new FakeOutput();
    const terminal = ui(stdin, stdout);
    terminal.start();
    try {
      const picked = terminal.pickChoice("Provider", [
        { value: "openrouter", label: "OpenRouter", description: "Ready" },
        { value: "anthropic", label: "Anthropic · Coming soon", description: "Coming soon" },
      ], "openrouter");
      stdin.emit("data", Buffer.from(sequence));
      await new Promise<void>((resolve) => setImmediate(resolve));
      press(stdin, "escape");
      assert.equal(await picked, null, sequence);
    } finally {
      terminal.stop();
    }
  }

  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const input = terminal.readInput();
    stdin.emit("data", Buffer.from("\u001b[<0;1;1M"));
    type(stdin, "a");
    press(stdin, "return");
    assert.equal(await input, "a");
  } finally {
    terminal.stop();
  }
});

test("mouse reporting stays disabled after picker cancel across suspend and terminal stop", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const picker = terminal.pickChoice("Provider", [
      { value: "openrouter", label: "OpenRouter", description: "Ready" },
      { value: "anthropic", label: "Anthropic · Coming soon", description: "Coming soon" },
    ], "openrouter");
    press(stdin, "escape");
    assert.equal(await picker, null);
    await terminal.suspend(async () => undefined);
  } finally {
    terminal.stop();
  }
  const enable = "\u001b[?1000h\u001b[?1006h";
  const disable = "\u001b[?1000l\u001b[?1006l";
  assert.equal(stdout.output.split(enable).length - 1, 1, stdout.output);
  assert.equal(stdout.output.split(disable).length - 1, 1, stdout.output);
  assert.ok(stdout.output.lastIndexOf(disable) > stdout.output.lastIndexOf(enable), stdout.output);
});

test("partial SGR bytes are cleared before a restarted terminal accepts ordinary input", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  stdin.emit("data", Buffer.from("\u001b[<0;1"));
  terminal.stop();
  terminal.start();
  try {
    const input = terminal.readInput();
    stdin.emit("data", Buffer.from("a"));
    press(stdin, "return");
    assert.equal(await input, "a");
  } finally {
    terminal.stop();
  }
});

test("raw terminal data ownership is inert before start and balanced across stop suspend and restart", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  assert.equal(stdin.listenerCount("data"), 0, "construction must not own a live raw listener");

  terminal.start();
  const firstActive = stdin.listenerCount("data");
  assert.ok(firstActive > 0);
  terminal.stop();
  const stopped = stdin.listenerCount("data");
  assert.equal(firstActive, stopped + 1, "stop must detach exactly the UI-owned raw listener");

  terminal.start();
  assert.equal(stdin.listenerCount("data"), firstActive, "restart must not accumulate listeners");
  await terminal.suspend(async () => {
    assert.equal(
      stdin.listenerCount("data"),
      stopped,
      "suspend must detach the UI-owned raw listener while the terminal is released",
    );
  });
  assert.equal(stdin.listenerCount("data"), firstActive, "resume must restore exactly one listener");

  terminal.stop();
  assert.equal(stdin.listenerCount("data"), stopped);
});

test("dispose permanently releases terminal input ownership", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  const active = stdin.listenerCount("data");
  terminal.dispose();
  assert.equal(terminal.active, false);
  assert.equal(stdin.listenerCount("data"), active - 1);
  terminal.dispose();
  terminal.start();
  assert.equal(terminal.active, false, "a disposed terminal must not reacquire raw input");
  assert.equal(stdin.listenerCount("data"), active - 1);
});

test("stop settles a pasted secret once and clears it before fallible terminal cleanup and restart", async () => {
  class FallibleOutput extends FakeOutput {
    failCleanup = false;

    override write(value: string | Uint8Array): boolean {
      if (this.failCleanup) throw new Error("fixed terminal cleanup failure");
      return super.write(value);
    }
  }

  const stdin = new FakeInput();
  const stdout = new FallibleOutput();
  const terminal = ui(stdin, stdout);
  let settlements = 0;

  terminal.start();
  const pending = terminal.readSecret("OpenRouter API-Key");
  void pending.then(() => {
    settlements += 1;
  });
  press(stdin, "paste-start");
  type(stdin, "stale-secret-bytes");
  press(stdin, "paste-end");
  emitTerminalData(stdin, "\u001b[<0;1");
  stdout.failCleanup = true;

  terminal.stop();
  const stoppedValue = await Promise.race([
    pending,
    new Promise<"still-pending">((resolve) => setImmediate(() => resolve("still-pending"))),
  ]);
  assert.equal(stoppedValue, null);
  assert.equal(settlements, 1);

  stdout.failCleanup = false;
  terminal.start();
  const restarted = terminal.readSecret("OpenRouter API-Key");
  press(stdin, "return");
  assert.equal(await restarted, "", "restart must not resubmit bytes from the stopped secret");
  assert.equal(settlements, 1, "the stopped resolver must remain settled exactly once");

  const cleanInput = terminal.readInput();
  type(stdin, "clean-after-stop");
  press(stdin, "return");
  assert.equal(await cleanInput, "clean-after-stop");
  terminal.stop();
});

test("stop and restart preserve an ordinary chat draft", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  const input = terminal.readInput();
  type(stdin, "draft survives");
  terminal.stop();
  terminal.start();
  try {
    press(stdin, "return");
    assert.equal(await input, "draft survives");
  } finally {
    terminal.stop();
  }
});

test("suspend and resume preserve a pending secret until explicit submission", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const secret = terminal.readSecret("OpenRouter API-Key");
    type(stdin, "before-");
    await terminal.suspend(async () => undefined);
    type(stdin, "after");
    press(stdin, "return");
    assert.equal(await secret, "before-after");
  } finally {
    terminal.stop();
  }
});

test("stop and EOF settle picker, confirmation, and recording exactly once", async () => {
  const cases = ["stop", "eof"] as const;
  for (const exit of cases) {
    const stdin = new FakeInput();
    const stdout = new FakeOutput();
    const terminal = ui(stdin, stdout);
    terminal.start();
    let choiceSettlements = 0;
    const choice = terminal.pickChoice("Provider", [
      { value: "openrouter", label: "OpenRouter", description: "Ready" },
    ], "openrouter").then((value) => {
      choiceSettlements += 1;
      return value;
    });
    if (exit === "stop") terminal.stop();
    else stdin.emit("end");
    assert.equal(await Promise.race([
      choice,
      new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
    ]), null, exit);
    assert.equal(choiceSettlements, 1, exit);

    terminal.start();
    let confirmSettlements = 0;
    const confirmation = terminal.confirmAction("Löschen", "lokal").then((value) => {
      confirmSettlements += 1;
      return value;
    });
    if (exit === "stop") terminal.stop();
    else stdin.emit("end");
    assert.deepEqual(await confirmation, { accepted: false });
    assert.equal(confirmSettlements, 1, exit);

    terminal.start();
    let recordingSettlements = 0;
    const recording = terminal.awaitRecordingControl("Aufnahme").then((value) => {
      recordingSettlements += 1;
      return value;
    });
    if (exit === "stop") terminal.stop();
    else stdin.emit("end");
    assert.equal(await recording, "cancel");
    assert.equal(recordingSettlements, 1, exit);
    assert.equal(terminal.active, false);
  }
});

test("suspend stoppt nur den Timer und lässt einen aktiven Lauf weiter running", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  terminal.handleRunEvent({
    type: "run-start",
    model: "openrouter/auto",
    maxSteps: 12,
    timestamp: Date.now(),
  });
  await terminal.suspend(async () => undefined);
  assert.match(text(terminal.frame().lines), /[✻✽✶✳✢·]/u);
  terminal.stop();
});

test("setup TUI retry shows one latest current revision card at narrow and wide widths and replaces status", async () => {
  for (const columns of [58, 120]) {
    const stdin = new FakeInput();
    const stdout = new FakeOutput();
    stdout.columns = columns;
    const terminal = ui(stdin, stdout);
    const surface = createTuiSetupSurface(terminal);
    terminal.start();
    try {
      const initialEntries = [
        { id: "openrouter", label: "OpenRouter", description: "Not connected", disabled: false, current: true, generation: 6 },
        { id: "anthropic", label: "Anthropic", description: "Coming soon is not selectable", disabled: true, current: false, generation: 6 },
      ];
      surface.present({ version: 1, type: "provider-state", entries: initialEntries });
      const initial = surface.chooseHub(initialEntries);
      press(stdin, "escape");
      await initial;
      surface.present({ version: 1, type: "notice", message: "Previous error" });
      const currentEntries = [
        { id: "openrouter", label: "OpenRouter", description: "Connected", disabled: false, current: true, generation: 7 },
        { id: "anthropic", label: "Anthropic", description: "Coming soon is not selectable", disabled: true, current: false, generation: 7 },
      ];
      surface.present({ version: 1, type: "provider-state", entries: currentEntries });
      const choice = surface.chooseHub(currentEntries);
      surface.present({ version: 1, type: "notice", message: "Reconnected successfully" });
      const screen = terminal.frame().lines.map(plainText).join("\n");
      press(stdin, "escape");
      await choice;
      // The internal `generation` counter (V3 audit principle 4) no longer
      // appears in the label itself, and since the FIX-12 merge the current
      // marking comes from the picker row (`list-core`'s `· active`), never
      // from the label — one marking, one word, rendered exactly once (the
      // stale round never duplicates). The stale "Not connected" description
      // from generation 6 must not survive the generation-7 refresh.
      assert.equal((screen.match(/Connected · active/g) ?? []).length, 1, `width ${columns}\n${screen}`);
      assert.match(screen, /OpenRouter\s+Connected · active/);
      assert.doesNotMatch(screen, /· Current/, "the label no longer carries its own current suffix");
      assert.doesNotMatch(screen, /Not connected/);
      assert.match(screen, /Anthropic · Coming soon/);
      assert.match(screen, /Reconnected successfully/);
      assert.doesNotMatch(screen, /Previous error/);
    } finally {
      terminal.stop();
    }
  }
});

// F7 fix round 1, Critical C1: before this fix, `readSecret`'s own mode
// switch (`#enterMode("secret", ...)`) clobbered `setStatus`'s pending text
// in the same tick, and the "secret" mode status line is hardcoded to
// "<label> · input stays hidden" regardless of `status` — so a pending
// pre-secret notice (cost disclosure, or the Kimi replace consequence)
// never actually reached the fullscreen screen, even though it was
// genuinely presented at the event level. This is the real-surface,
// frame-level proof the plain-surface tests could never catch: the notice
// must be VISIBLE on screen before the secret line appears, and the raw
// secret itself must never appear anywhere in the terminal's rendered
// output once it does.
test("setup TUI surface shows a pending pre-secret notice on screen before the secret prompt, and never leaks the secret itself", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  const surface = createTuiSetupSurface(terminal);
  const secretBody = `fixture-kimi-membership-key-${"z".repeat(24)}`;
  const consequence = "An existing Kimi Code membership key is connected (account …abc123). "
    + "Submitting a new key replaces it; press Esc to keep the current one and cancel. "
    + "The membership key uses a third-party integration with provider-managed limits; "
    + "paid Extra Usage may apply, and the USD amount is not known here.";
  terminal.start();
  try {
    surface.present({ version: 1, type: "notice", message: consequence });
    const pending = surface.readSecret({ backendId: "kimi-code", message: "Kimi Code membership key" });

    const screenBeforeInput = text(terminal.frame().lines);
    assert.match(
      screenBeforeInput,
      /existing Kimi Code membership key is connected \(account …abc123\)/,
      "the replace consequence must be visible before the secret prompt, not just presented at the event level",
    );
    assert.match(
      screenBeforeInput,
      /paid Extra Usage may apply/,
      "the cost disclosure (M1) must be visible on the same fullscreen surface",
    );
    assert.doesNotMatch(stdout.output, new RegExp(secretBody), "the secret has not been typed yet");

    type(stdin, secretBody);
    assert.doesNotMatch(stdout.output, new RegExp(secretBody), "typed secret characters must render masked, never raw");
    press(stdin, "return");

    assert.equal(await pending, secretBody);
    assert.doesNotMatch(stdout.output, new RegExp(secretBody), "the resolved secret must never appear in any rendered output");
  } finally {
    terminal.stop();
  }
});

test("frame fills the screen and keeps chrome, divider and input in place", () => {
  const frame = buildDashboardFrame(input({ blocks: chat(6), input: "Bitte prüfe die Tests", cursor: 21 }));

  assert.equal(frame.lines.length, 28);
  // Controller decision B: identity chrome (model/approval/branch/cost) now
  // lives on the always-on bottom status line, not the header — the header
  // carries only the workspace path.
  const status = plainText(frame.lines[frame.lines.length - 2]!);
  assert.match(status, /kimi-k3/);
  assert.match(status, /ask/);
  const divider = frame.lines.findIndex((line) => /^─{10,}$/.test(plainText(line)));
  assert.ok(divider > 0);
  assert.match(plainText(frame.lines.at(-1)!), /^> Bitte prüfe die Tests/);
  assert.deepEqual(frame.cursor, { row: 28, col: 24 });
});

test("a 10-line prompt shows 6 rows and 6/10 (Bauplan A6)", () => {
  const prompt = Array.from({ length: 10 }, (_, index) => `Zeile ${index}`).join("\n");
  const frame = buildDashboardFrame(input({ input: prompt, cursor: prompt.length }));
  const inputArea = frame.lines.slice(-6).map(plainText);

  assert.equal(inputArea.length, 6);
  assert.match(inputArea.join("\n"), /6\/10/);
  assert.match(inputArea.at(-1)!, /Zeile 9/);
});

test("Kontextfüllstand wird ab 80% in Rolle warn angezeigt (Bauplan A7)", () => {
  const below = buildDashboardFrame(input({ contextPercent: 79 }));
  const atThreshold = buildDashboardFrame(input({ contextPercent: 80 }));
  const belowSpan = below.lines[0]!.spans.find((item) => item.text.includes("79%"));
  const atSpan = atThreshold.lines[0]!.spans.find((item) => item.text.includes("80%"));

  assert.equal(belowSpan?.role, "muted");
  assert.equal(atSpan?.role, "warn");
});

test("secret label stays visible at 200 characters (Bauplan A6)", () => {
  const secret = "x".repeat(200);
  const frame = buildDashboardFrame(
    input({ mode: "secret", input: secret, cursor: secret.length, secretLabel: "OpenRouter API-Key" }),
  );
  const maskedRows = frame.lines.filter((item) => plainText(item).includes(theme.glyph("mask")));

  assert.ok(maskedRows.length > 0);
  for (const row of maskedRows) {
    assert.match(plainText(row), /OpenRouter API-Key/);
  }
  assert.doesNotMatch(text(frame.lines), /xxxxx/);
});

test("at rest only the hub invitation, divider, the identity status line and prompt are on screen — no orphan header", () => {
  const frame = buildDashboardFrame(input({ mode: "idle", status: "" }));
  const lines = frame.lines.map((line) => plainText(line));
  const divider = lines.findIndex((line) => /^─{10,}$/.test(line));

  assert.equal(lines.length, 28);
  // D8d appearance pin update, with justification: this fixture's `input()`
  // never sets `brand`, so the hub's rock-bottom "What would you like to
  // do?" invitation is the whole brand block — and it now renders top-
  // anchored (line 0), with the empty space growing below it toward the
  // divider, instead of bottom-glued directly above the divider under a
  // void (the exact layout bug D8d fixes). The plain workspace-path header
  // this test used to also count is gone too — the hub's brand block
  // absorbs it (Controller ruling), so there is nothing left to duplicate
  // it; a real transcript (blocks.length > 0) still gets the header.
  assert.match(lines[0]!, /What would you like to do\?/);
  assert.equal(lines[divider - 1], "", "blank filler grows below the top-anchored content, not above it");
  // Controller decision B: the status line is always-on now, right below
  // the divider — the identity chrome the header used to carry.
  assert.match(lines[divider + 1]!, /ask/);
  assert.equal(lines.at(-1), "> ");
  assert.equal(lines.filter((line) => line.trim().length > 0).length, 4);
});

test("no rendered line is wider than the usable width", () => {
  for (const width of [40, 60, 100, 170]) {
    const frame = buildDashboardFrame(
      input({ width, blocks: chat(4), input: "x".repeat(300), cursor: 300 }),
    );
    for (const line of frame.lines) {
      assert.ok(lineWidth(line) <= width - 1, `width ${width}: ${plainText(line)}`);
    }
  }
});

test("a scrolled viewport adds an indicator line without eating a chat line", () => {
  const blocks = chat(12);
  const tail = buildDashboardFrame(input({ height: 24, blocks }));
  const anchor = { anchor: { blockId: blocks[0]!.id, lineOffset: 0 } };
  const scrolled = buildDashboardFrame(
    input({ height: 24, blocks, viewport: anchor, newLinesBelow: 12 }),
  );

  assert.equal(tail.lines.length, scrolled.lines.length);
  assert.deepEqual(plainText(tail.lines[0]!), plainText(scrolled.lines[0]!));
  assert.match(plainText(scrolled.lines[1]!), /↑ .*lines above.*End jumps to the end/);
  // The first chat line is still visible: the indicator is an extra row.
  assert.match(plainText(scrolled.lines[2]!), /Frage 0/);
  assert.match(text(scrolled.lines), /↓ 12 new lines/);
});

// D4: the confirm footer now speaks one grammar per class — danger is
// `y confirm · Enter/Esc cancel`, with the pre-existing remember-allow/deny
// and reason-key hints appended after it — instead of the old
// `j yes · n no · Enter = no · …` wording (`j`, the German "ja" synonym, is
// gone from the danger class entirely; see the keyboard tests below).
test("an approval keeps its details once on screen and offers y and n", () => {
  const model = new RunViewModel();
  model.pushApproval({
    risk: "shell",
    summary: "SHELL · Tests ausführen",
    details: ["npm test", "in ~/projekt/routercode"],
    rememberHint: "keine gemerkte Regel für „npm“",
  });
  const frame = buildDashboardFrame(input({
    mode: "confirm",
    confirmDanger: true,
    // The approval mechanism (`confirmAction`'s `#confirmResolve`) is the
    // only one that ever binds `g` (reason) — set explicitly here since
    // this test models a real tool-call approval, not a settings confirm.
    confirmReasonAvailable: true,
    blocks: [...model.blocks],
    waitingSince: NOW - 14_000,
    rememberAvailable: true,
  }));
  const screen = text(frame.lines);

  assert.match(screen, /⚠ Approval · SHELL · Tests ausführen/);
  assert.equal(screen.match(/npm test/g)?.length, 1);
  // FIX-20, finding 5: a confirm with no run behind it has no repaint
  // cadence — the line says "waiting" and never claims a frozen number.
  assert.match(screen, /waiting/);
  assert.doesNotMatch(screen, /waiting since \d/);
  assert.equal(
    plainText(frame.lines.at(-1)!).trim(),
    "y confirm · Enter/Esc cancel · a always allow · d never allow · g reason",
  );
});

// Audit FIX-1 (2026-08-28): the danger-confirm explanation used to render as
// one raw, unfitted line — at 40 columns it was hard-cut mid-word with no
// ellipsis ("allow-all runs file changes and shell co"), unreadable exactly
// when the consequence text matters most. Confirm bodies now word-wrap;
// the key/footer lines stay single-line.
test("a danger confirm explanation wraps whole words at 40 columns", () => {
  const description =
    "allow-all runs file changes and shell commands without asking. Really enable it?";
  const frame = buildDashboardFrame(input({
    width: 40,
    height: 20,
    mode: "confirm",
    confirmDanger: true,
    waitingSince: NOW - 3_000,
    editorPrompt: { label: "Enable allow-all?", description },
  }));
  const lines = frame.lines.map((line) => plainText(line));
  const rendered = lines.join("\n");

  // Nothing overflows the terminal width.
  for (const line of frame.lines) {
    assert.ok(lineWidth(line) <= 40, `line wider than 40: "${plainText(line)}"`);
  }
  // Every word of the explanation survives intact — no mid-word cut.
  for (const word of description.split(" ")) {
    assert.ok(rendered.includes(word), `word lost or cut: "${word}"`);
  }
  // It genuinely wrapped: the 81-char explanation spans multiple lines.
  assert.ok(
    lines.filter((line) => /allow-all|asking|enable/.test(line)).length >= 2,
    "the explanation must occupy more than one line at 40 columns",
  );
  // The keys line stays single-line (D4 danger grammar, untouched).
  assert.match(rendered, /y confirm · Enter\/Esc cancel/);
});

test("the confirm footer hides remember actions when no safe subject exists", () => {
  const frame = buildDashboardFrame(input({
    mode: "confirm",
    confirmDanger: true,
    confirmReasonAvailable: true,
    waitingSince: NOW - 2_000,
    rememberAvailable: false,
  }));
  const footer = plainText(frame.lines.at(-1)!).trim();

  assert.equal(footer, "y confirm · Enter/Esc cancel · g reason");
});

// Fix round 1, IMPORTANT: the settings-editor mechanism never binds `g`
// (reason capture) even for a danger-class settings confirm — the footer
// must not claim it does. Direct `buildDashboardFrame` unit coverage,
// alongside the full-TerminalUi-integration equality check in
// settings-tui.test.ts.
test("the danger confirm footer omits g reason when the settings-editor mechanism is live", () => {
  const frame = buildDashboardFrame(input({
    mode: "confirm",
    confirmDanger: true,
    confirmReasonAvailable: false,
    waitingSince: NOW - 2_000,
  }));
  const footer = plainText(frame.lines.at(-1)!).trim();

  assert.equal(footer, "y confirm · Enter/Esc cancel");
});

test("the confirm footer uses the ordinary grammar when the confirm is not danger-graded", () => {
  const frame = buildDashboardFrame(input({
    mode: "confirm",
    confirmDanger: false,
    waitingSince: NOW - 2_000,
  }));
  const footer = plainText(frame.lines.at(-1)!).trim();

  assert.equal(footer, "Enter confirm · Esc cancel");
  assert.doesNotMatch(footer, /\by\b|always allow|never allow|reason/);
});

/**
 * FIX-14 fix round 1 (review M2, controller ruling). D4 has a third state
 * that `confirmDanger` alone cannot express: an ORDINARY action that still
 * needs an explicit yes (`confirmPlain`'s `defaultAccept: false` — /panel's
 * spend confirm, the process-only credential confirm). The first pass
 * graded those as danger outright, which gave them a destructive title and
 * advertised a `g reason` that command confirms discard.
 */
test("an ordinary confirm that must not accept on Enter says so — with no danger-only controls", () => {
  const frame = buildDashboardFrame(input({
    mode: "confirm",
    // Ordinary in CLASS …
    confirmDanger: false,
    // … but Enter must not accept.
    confirmEnterDeclines: true,
    waitingSince: NOW - 2_000,
  }));
  const footer = plainText(frame.lines.at(-1)!).trim();

  // The key grammar is stated, because that is what the reader must act on.
  assert.equal(footer, "y confirm · Enter/Esc cancel");
  // And nothing danger-only rides along: `a`/`d` need an exact subject and
  // `g` needs a caller that can use the reason — neither holds here.
  assert.doesNotMatch(footer, /always allow|never allow|reason/);
});

test("the ordinary+explicit-yes confirm keeps ordinary presentation — the danger title treatment is class-only", () => {
  const danger = buildDashboardFrame(input({
    mode: "confirm",
    confirmDanger: true,
    editorPrompt: { label: "Enable allow-all?", description: "" },
    waitingSince: NOW - 2_000,
  }));
  const explicitYes = buildDashboardFrame(input({
    mode: "confirm",
    confirmDanger: false,
    confirmEnterDeclines: true,
    editorPrompt: { label: "Enable allow-all?", description: "" },
    waitingSince: NOW - 2_000,
  }));
  const roleOf = (frame: ReturnType<typeof buildDashboardFrame>): string | undefined =>
    frame.lines.map((line) => line.spans.find((part) => part.text.includes("Enable allow-all?")))
      .find(Boolean)?.role;

  assert.equal(roleOf(danger), "warn", "the danger class keeps its warn title");
  assert.notEqual(
    roleOf(explicitYes),
    "warn",
    "an ordinary action must not be dressed as destructive just to ask for an explicit yes",
  );
});

test("assistant Markdown is translated instead of stripped", () => {
  const model = new RunViewModel();
  model.appendAssistant(
    "## Ergebnis\n- **Tests** laufen mit `npm test` erfolgreich.",
    NOW,
  );
  const frame = buildDashboardFrame(input({ blocks: [...model.blocks] }));
  const screen = text(frame.lines);

  assert.match(screen, /Ergebnis/);
  assert.match(screen, /– Tests laufen mit npm test/);
  assert.doesNotMatch(screen, /\*\*|## /);
});

test("the expansion area lists commands aligned on the longest visible name", () => {
  const frame = buildDashboardFrame(
    input({
      input: "/m",
      cursor: 2,
      list: {
        entries: [
          { name: "/model", description: "Main-Modell auswählen" },
          { name: "/max-cost", description: "Kostenlimit setzen" },
        ],
        selectedIndex: 1,
      },
    }),
  );
  const lines = frame.lines.map((line) => plainText(line));
  const first = lines.find((line) => line.includes("/model"))!;
  const second = lines.find((line) => line.includes("/max-cost"))!;

  assert.equal(first.indexOf("Main-Modell"), second.indexOf("Kostenlimit"));
  assert.match(second, /^❯ \/max-cost/);
  // FIX-14 ticket 10: this is FIX-9's reported "1 of 2 pager" verbatim — two
  // rows on screen, two rows in the list, and a corner label counting them
  // for a reader who can see both. The corner is drawn only when rows are
  // genuinely off screen now.
  assert.doesNotMatch(second, /\d+ of \d+/);
  // V4-A: the generic list consumers' hint is the action bar now — same four
  // keys, same four words, chips instead of a `·` chain, and in the mockup's
  // order (move, take, insert, leave).
  assert.match(lines.at(-1)!, /\[↑↓\] select {2}\[Enter\] choose {2}\[Tab\] open {2}\[Esc\] back\/close/);
});

test("pending image attachments are reported in the status line", () => {
  const frame = buildDashboardFrame(input({ blocks: chat(2), attachmentCount: 2 }));
  assert.match(text(frame.lines), /2 images ready/);
});

test("live reasoning collapses to the spec's English Thinking line and expands on Ctrl+O", () => {
  const model = new RunViewModel();
  model.apply({
    type: "reasoning",
    model: "moonshotai/kimi-k3",
    step: 1,
    delta: "Ich prüfe zuerst die Projektstruktur. Danach die Tests.",
    timestamp: NOW,
  });
  const collapsed = buildDashboardFrame(input({ blocks: [...model.blocks] }));
  // Phase 3b, Part C: the born-new English steering copy for LIVE thinking —
  // elapsed seconds (0s: `now` and `block.at` are both the fixed NOW here),
  // the Ctrl+O toggle hint, and the Esc-ends-thinking hint.
  assert.match(text(collapsed.lines), /Thinking … \(0s · Ctrl\+O show thinking · Esc end thinking\)/);
  // The token estimate is still tracked in the data model (no fake thoughts,
  // see the sibling test below) even though the new collapsed line no longer
  // surfaces it.
  const reasoningBlock = model.blocks[0]!;
  assert.equal(reasoningBlock.kind, "reasoning");
  assert.ok(reasoningBlock.kind === "reasoning" && reasoningBlock.tokens > 0);

  model.toggle(model.blocks[0]!.id);
  const expanded = buildDashboardFrame(input({ blocks: [...model.blocks] }));
  assert.match(text(expanded.lines), /Ctrl\+O hide thinking/);
  assert.match(text(expanded.lines), /Ich prüfe zuerst die Projektstruktur/);
});

test("reasoning tokens without provider text never fake thoughts", () => {
  const model = new RunViewModel();
  model.apply({ type: "reasoning", model: "p/m", step: 1, delta: "   ", timestamp: NOW });
  const reasoningBlock = model.blocks[0]!;
  assert.equal(reasoningBlock.kind, "reasoning");
  // Whitespace-only deltas are not thoughts (view-model.ts's estimateTokens);
  // this is the invariant the collapsed line used to display directly. The
  // new Thinking line (Phase 3b, Part C) no longer shows a token count, so
  // the guarantee is asserted on the data model instead of the rendered text.
  assert.equal(reasoningBlock.kind === "reasoning" && reasoningBlock.tokens, 0);
  const frame = buildDashboardFrame(input({ blocks: [...model.blocks] }));
  assert.match(text(frame.lines), /Thinking … \(0s/);
});

test("small terminals drop chrome instead of the stream, tiny ones refuse", () => {
  const small = buildDashboardFrame(input({ width: 60, height: 12, blocks: chat(4) }));
  assert.equal(small.lines.length, 12);
  assert.ok(small.chatHeight >= 5);

  const short = buildDashboardFrame(input({ width: 60, height: 8, blocks: chat(4) }));
  assert.ok(short.chatHeight >= 5);
  assert.doesNotMatch(plainText(short.lines[0]!), /openrouter/);

  const tiny = buildDashboardFrame(input({ width: 39, height: 8 }));
  assert.equal(tiny.lines.length, 1);
  assert.match(plainText(tiny.lines[0]!), /Terminal too small \(at least 40×8/);
});

test("a running tool shows exactly one spinner, phase, step and cost", () => {
  const model = new RunViewModel();
  model.apply({ type: "run-start", model: "m", maxSteps: 12, timestamp: NOW });
  model.apply({
    type: "tool-start",
    id: "t1",
    number: 1,
    name: "run_command",
    input: { command: "npm run check" },
    timestamp: NOW,
  });
  const frame = buildDashboardFrame(
    input({
      mode: "busy",
      blocks: [...model.blocks],
      now: NOW + 7_000,
      run: {
        phase: "Tool running",
        startedAt: NOW,
        lastEventAt: NOW + 5_000,
        step: 4,
        maxSteps: 12,
        costUsd: 0.043,
        running: true,
      },
    }),
  );
  const screen = text(frame.lines);

  assert.match(screen, /Tool running/);
  assert.match(screen, /00:07/);
  assert.match(screen, /Step 4\/12/);
  assert.match(screen, /\$0\.043/);
  assert.match(screen, /npm run check/);
});

test("a running Kimi task renders provider-managed cost instead of a zero-dollar value", () => {
  const frame = buildDashboardFrame(
    input({
      mode: "busy",
      now: NOW + 1_000,
      state,
      run: {
        phase: "Model working",
        startedAt: NOW,
        lastEventAt: NOW,
        step: 1,
        maxSteps: 12,
        costUsd: 0,
        costKnowledge: "unknown",
        running: true,
      },
    }),
  );
  const screen = text(frame.lines);
  assert.match(screen, /provider-managed|unknown/i);
  assert.doesNotMatch(screen, /kostenlos|\$0(?:\.0+)?\b|0(?:,0+)?\s*\$/i);
});

test("an idle Kimi session keeps provider-managed cost out of the compact dashboard header", () => {
  const frame = buildDashboardFrame(input({
    width: 160,
    state,
  }));
  const header = plainText(frame.lines[0]!);
  assert.doesNotMatch(header, /provider-managed|unknown|free|\$0(?:\.0+)?\b|0(?:,0+)?\s*\$/i);
});

test("Kimi run-start marks live TUI cost unknown before the first model-end", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    terminal.handleRunEvent({
      type: "run-start",
      model: "k3",
      maxSteps: 12,
      prompt: "hello",
      costKnowledge: "unknown",
      timestamp: NOW,
    });
    const statusLine = plainText(terminal.frame().lines.at(-2)!);
    assert.match(statusLine, /provider-managed|unknown/i);
    assert.doesNotMatch(statusLine, /kostenlos|\$0(?:\.0+)?\b|0(?:,0+)?\s*\$/i);
  } finally {
    terminal.stop();
  }
});

test("secret entry never renders the actual API key", () => {
  const secret = `${["sk", "or", "v1"].join("-")}-this-must-never-be-rendered`;
  const frame = buildDashboardFrame(
    input({
      mode: "secret",
      input: secret,
      cursor: secret.length,
      secretLabel: "OpenRouter API-Key",
    }),
  );
  const screen = text(frame.lines);

  assert.doesNotMatch(screen, /this-must-never-be-rendered/);
  assert.match(screen, /> •+/);
  assert.match(screen, /input stays hidden/);
});

test("terminal sanitizer removes CSI, OSC, DCS, and unsafe controls", () => {
  const unsafe = [
    "vor",
    "\u001b[31mrot\u001b[0m",
    "\u001b]0;Fenstertitel\u0007",
    "\u001b]52;c;Y2xpcGJvYXJk\u001b\\",
    "\u001bP1;2|payload\u001b\\",
    "\u0001",
    "nach",
  ].join("");

  assert.equal(sanitizeTerminalText(unsafe), "vorrotnach");
});

test("interactive picker filters typed text and selects with arrow keys", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  const models = [modelInfo("alpha/default"), modelInfo("moonshotai/kimi-k3"), modelInfo("kilo/code")];

  terminal.start();
  try {
    const selection = terminal.pickModel(
      (query) => models.filter((item) => item.id.includes(query.toLowerCase())),
      "alpha/default",
      "Kompressor-Modell auswählen",
    );
    press(stdin, "k", "k");
    press(stdin, "down");
    press(stdin, "return");

    assert.equal((await selection)?.id, "kilo/code");
    assert.match(stdout.output, /kilo\/code/);
    assert.match(stdout.output, /> k/);
  } finally {
    terminal.stop();
  }
  assert.equal(stdin.isRaw, false);
});

test("ordinary f, F and T keys are accepted as text input", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const value = terminal.readInput();
    press(stdin, "f", "f");
    press(stdin, "f", "F", { shift: true });
    press(stdin, "t", "T", { shift: true });
    press(stdin, "return");
    assert.equal(await value, "fFT");
  } finally {
    terminal.stop();
  }
});

test("editor inserts text at the logical cursor position", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "Hllo");
    for (let index = 0; index < 3; index += 1) press(stdin, "left");
    press(stdin, "a", "a");
    press(stdin, "return");
    assert.equal(await value, "Hallo");
  } finally {
    terminal.stop();
  }
});

test("Ctrl+A/E, Ctrl+U/K and Ctrl+W edit the current line only (Bauplan A6)", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "erste Zeile");
    press(stdin, "return", "", { shift: true });
    type(stdin, "zweite Zeile");
    // Ctrl+A must land at the start of the *current* (second) line.
    press(stdin, "a", "a", { ctrl: true });
    press(stdin, "x", "x");
    terminal.refresh();
    assert.match(stdout.output, /xzweite Zeile/);

    // Ctrl+K clears from the cursor to the end of the current line.
    press(stdin, "k", "k", { ctrl: true });
    terminal.refresh();
    assert.ok(
      stdout.output.lastIndexOf("> x[K") > stdout.output.lastIndexOf("zweite"),
      "the line should be cleared after the cursor",
    );

    // Ctrl+E jumps to line end, then Ctrl+W deletes the previous word.
    press(stdin, "e", "e", { ctrl: true });
    press(stdin, "w", "w", { ctrl: true });
    press(stdin, "return");
    assert.equal(await value, "erste Zeile");
  } finally {
    terminal.stop();
  }
});

test("submitted input clears immediately and busy typing is queued FIFO", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const first = terminal.readInput();
    type(stdin, "Erste Aufgabe");
    await new Promise((resolve) => setTimeout(resolve, 40));
    const beforeSubmit = stdout.output.length;
    press(stdin, "return");
    assert.equal(await first, "Erste Aufgabe");
    assert.doesNotMatch(stdout.output.slice(beforeSubmit), /Erste Aufgabe/);

    type(stdin, "Zweite Aufgabe");
    press(stdin, "return");
    // FIX-19 finding 5: with no run owning the line, the queue notice no
    // longer invents one — it says nothing is running yet.
    assert.match(stdout.output, /1 message queued · nothing is running yet/);
    assert.equal(await terminal.readInput(), "Zweite Aufgabe");
  } finally {
    terminal.stop();
  }
});

// Phase 3b, Part B: while a run is active (mode "busy") AND an interject
// handler is registered, submitted text feeds the RUNNING task instead of
// becoming the next run's prompt — today's `#queuedInputs` fallback (proven
// above) only applies when nothing has claimed the line.
test("busy typing reaches a registered interject handler instead of surfacing as the next prompt", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const first = terminal.readInput();
    type(stdin, "Erste Aufgabe");
    press(stdin, "return");
    assert.equal(await first, "Erste Aufgabe");

    const interjections: string[] = [];
    terminal.setInterjectHandler((text) => {
      interjections.push(text);
    });

    type(stdin, "Zwischenruf eins");
    press(stdin, "return");
    type(stdin, "Zwischenruf zwei");
    press(stdin, "return");

    assert.deepEqual(interjections, ["Zwischenruf eins", "Zwischenruf zwei"], "two interjections queue in order");
    assert.doesNotMatch(stdout.output, /queued for the next run/, "the old next-run queue wording must not appear once a handler owns the line");

    // The interjections must not resurface as a queued prompt for the next run.
    terminal.setInterjectHandler();
    const afterRun = terminal.readInput();
    type(stdin, "Dritte Aufgabe");
    press(stdin, "return");
    assert.equal(await afterRun, "Dritte Aufgabe");
  } finally {
    terminal.stop();
  }
});

test("an accepted interjection renders with the interject glyph and its confirmation line", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const first = terminal.readInput();
    type(stdin, "Erste Aufgabe");
    press(stdin, "return");
    await first;

    terminal.setInterjectHandler(() => {});
    type(stdin, "Bitte auch die Tests prüfen");
    press(stdin, "return");
    terminal.refresh();

    assert.match(stdout.output, /> ↪ Bitte auch die Tests prüfen/);
    assert.match(stdout.output, /⎿ Interjection accepted — feeds into the next step/);
  } finally {
    terminal.stop();
  }
});

test("the input hint during a run invites an interjection and still allows esc to cancel", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const first = terminal.readInput();
    type(stdin, "Erste Aufgabe");
    press(stdin, "return");
    await first;
    terminal.setInterjectHandler(() => {});
    terminal.refresh();
    assert.match(
      stdout.output,
      /Type an interjection … \(Enter queues it · Esc cancels the run\)/,
    );
  } finally {
    terminal.stop();
  }
});

// Audit FIX-1 (2026-08-28): while reasoning streams live, esc ends ONLY the
// thinking (the escape handler already branched on `reasoningLive`) — the
// hint used to keep claiming `esc cancels the run` the whole time. Both
// states of the hint are pinned; the esc behavior itself is unchanged.
test("the interjection hint tells the truth about esc while thinking streams", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  // Wide enough that the run status line keeps its priority-50 cancel-hint
  // segment alongside phase/step/cost — the hint text is what is under test.
  stdout.columns = 200;
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const first = terminal.readInput();
    type(stdin, "Aufgabe");
    press(stdin, "return");
    await first;
    terminal.setInterjectHandler(() => {});
    terminal.handleRunEvent({ type: "run-start", model: "m", maxSteps: 12, timestamp: NOW });
    terminal.handleRunEvent({
      type: "reasoning",
      model: "m",
      step: 1,
      delta: "Ich denke noch.",
      timestamp: NOW + 10,
    });
    const thinking = text(terminal.frame().lines);
    assert.match(thinking, /Type an interjection … \(Enter queues it · Esc ends thinking\)/);
    assert.doesNotMatch(thinking, /Esc cancels the run/);

    terminal.handleRunEvent({
      type: "model-end",
      model: "m",
      step: 1,
      durationMs: 10,
      inputTokens: 4,
      outputTokens: 5,
      reasoningTokens: 3,
      cachedTokens: 0,
      costUsd: 0,
      timestamp: NOW + 20,
    });
    const streaming = text(terminal.frame().lines);
    assert.match(streaming, /Type an interjection … \(Enter queues it · Esc cancels the run\)/);
    assert.doesNotMatch(streaming, /Esc ends thinking\)/);
  } finally {
    terminal.stop();
  }
});

test("bracketed multiline paste is inserted once and only submits on a later Enter", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const value = terminal.readInput();
    let settled = false;
    void value.then(() => {
      settled = true;
    });
    press(stdin, "paste-start");
    type(stdin, "Erste Zeile");
    press(stdin, "enter", "\n");
    type(stdin, "Zweite Zeile");
    press(stdin, "paste-end");
    await Promise.resolve();

    assert.equal(settled, false);
    assert.match(stdout.output, /2 lines pasted/);
    assert.match(stdout.output, /Erste Zeile/);
    assert.match(stdout.output, /\u001b\[\?2004h/);

    press(stdin, "return");
    assert.equal(await value, "Erste Zeile\nZweite Zeile");
  } finally {
    terminal.stop();
  }
  assert.match(stdout.output, /\u001b\[\?2004l/);
});

test("secret bracketed paste preserves raw CRLF until common normalization, masks it, and waits for later Enter", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  const body = `${["sk", "or", "v1"].join("-")}-${"r".repeat(48)}`;
  const raw = `\r\n${body}\r\n`;

  terminal.start();
  try {
    const value = terminal.readSecret("OpenRouter API-Key");
    let settled = false;
    void value.then(() => {
      settled = true;
    });
    press(stdin, "paste-start");
    press(stdin, "enter", "\r\n");
    type(stdin, body);
    press(stdin, "enter", "\r\n");
    press(stdin, "paste-end");
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(settled, false, "paste-end must not submit a secret");
    assert.doesNotMatch(stdout.output, new RegExp(body));
    assert.match(stdout.output, /•{8,}/);

    press(stdin, "return");
    const received = await value;
    assert.equal(received, raw);
    assert.equal(
      (credentialsModule as typeof credentialsModule & {
        normalizeProviderSecret(value: string): string;
      }).normalizeProviderSecret(received ?? ""),
      body,
    );
  } finally {
    terminal.stop();
  }
});

test("secret paste preserves non-framing readline key.sequence bytes for rejection and clears the next input", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  const body = `candidate-${"q".repeat(32)}`;
  const raw = `${body}\u001b[31m\0\r\n`;
  const normalize = (credentialsModule as typeof credentialsModule & {
    normalizeProviderSecret(value: string): string;
  }).normalizeProviderSecret;

  terminal.start();
  try {
    const value = terminal.readSecret("OpenRouter API-Key");
    let settled = false;
    void value.then(() => {
      settled = true;
    });
    press(stdin, "paste-start", "", { sequence: "\u001b[200~" });
    type(stdin, body);
    press(stdin, "unknown", "", { sequence: "\u001b[31m" });
    press(stdin, "unknown", "", { sequence: "\0" });
    press(stdin, "enter", "", { sequence: "\r\n" });
    press(stdin, "paste-end", "", { sequence: "\u001b[201~" });
    await Promise.resolve();

    assert.equal(settled, false, "paste-end must not submit a secret");
    assert.doesNotMatch(stdout.output, new RegExp(body));
    assert.match(stdout.output, /•{8,}/);

    press(stdin, "return");
    const received = await value;
    assert.equal(received, raw);
    assert.throws(() => normalize(received ?? ""), /invalid|control|whitespace/i);

    const next = terminal.readInput();
    type(stdin, "clean-next-input");
    press(stdin, "return");
    assert.equal(await next, "clean-next-input");
  } finally {
    terminal.stop();
  }
});

test("secret success, validation error, and cancellation leave the next input buffer clean", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  const normalize = (credentialsModule as typeof credentialsModule & {
    normalizeProviderSecret(value: string): string;
  }).normalizeProviderSecret;

  terminal.start();
  try {
    const invalid = terminal.readSecret("OpenRouter API-Key");
    press(stdin, "paste-start");
    type(stdin, "bad key");
    press(stdin, "paste-end");
    press(stdin, "return");
    const invalidValue = await invalid;
    assert.throws(() => normalize(invalidValue ?? ""), /invalid|whitespace/i);

    const afterError = terminal.readInput();
    type(stdin, "nach-fehler");
    press(stdin, "return");
    assert.equal(await afterError, "nach-fehler");

    const cancelled = terminal.readSecret("OpenRouter API-Key");
    press(stdin, "paste-start");
    type(stdin, "stale-secret-bytes");
    press(stdin, "c", "\u0003", { ctrl: true });
    assert.equal(await cancelled, null);

    const afterCancel = terminal.readInput();
    type(stdin, "nach-abbruch");
    press(stdin, "return");
    assert.equal(await afterCancel, "nach-abbruch");
  } finally {
    terminal.stop();
  }
});

test("a paste without its end marker still lets Ctrl+C through", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  let cancellations = 0;

  terminal.start();
  try {
    terminal.setStatus("Modell arbeitet");
    terminal.setCancelHandler(() => {
      cancellations += 1;
    });
    press(stdin, "paste-start");
    type(stdin, "halb eingefügt");
    press(stdin, "c", "", { ctrl: true });

    assert.equal(cancellations, 1);
    assert.match(stdout.output, /Cancel requested/);
  } finally {
    terminal.stop();
  }
});

// Audit FIX-1 (2026-08-28): the idle prompt follows the same two-press
// Ctrl+C convention runs already use — a single press must never close
// orcode (it used to quit instantly, discarding any typed draft).
test("the raw Ctrl+C byte closes an idle dashboard input only on the second press", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const pending = terminal.readInput();
    let settled = false;
    pending.catch(() => { settled = true; });
    press(stdin, "\u0003", "\u0003");
    await Promise.resolve();
    assert.equal(settled, false, "a single Ctrl+C must not close orcode");
    assert.match(text(terminal.frame().lines), /Ctrl\+C again closes orcode/);
    press(stdin, "\u0003", "\u0003");
    await assert.rejects(pending, /orcode was closed/i);
  } finally {
    terminal.stop();
  }
});

test("Ctrl+C with a typed draft clears the draft and never quits on that press", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const pending = terminal.readInput();
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    type(stdin, "wichtiger entwurf");
    press(stdin, "c", "", { ctrl: true });
    await Promise.resolve();
    assert.equal(settled, false, "Ctrl+C over a draft must only clear it");
    const rendered = text(terminal.frame().lines);
    assert.doesNotMatch(rendered, /wichtiger entwurf/);
    assert.match(rendered, /Ctrl\+C again closes orcode/);
    // A fresh draft typed inside the armed window keeps the guarantee: the
    // next press clears again instead of quitting.
    type(stdin, "zweiter entwurf");
    press(stdin, "c", "", { ctrl: true });
    await Promise.resolve();
    assert.equal(settled, false, "Ctrl+C while a draft exists must never quit");
    assert.doesNotMatch(text(terminal.frame().lines), /zweiter entwurf/);
    // Draft gone, window armed — the next press closes orcode.
    press(stdin, "c", "", { ctrl: true });
    await assert.rejects(pending, /orcode was closed/i);
  } finally {
    terminal.stop();
  }
});

test("any other key disarms the idle two-press quit window", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const pending = terminal.readInput();
    let settled = false;
    pending.catch(() => { settled = true; });
    press(stdin, "c", "", { ctrl: true });
    type(stdin, "x");
    press(stdin, "backspace");
    press(stdin, "c", "", { ctrl: true });
    await Promise.resolve();
    assert.equal(settled, false, "typing between presses must disarm the quit window");
    press(stdin, "c", "", { ctrl: true });
    await assert.rejects(pending, /orcode was closed/i);
  } finally {
    terminal.stop();
  }
});

test("the idle two-press quit window expires with the hint", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const pending = terminal.readInput();
    let settled = false;
    pending.catch(() => { settled = true; });
    press(stdin, "c", "", { ctrl: true });
    // 6s is STATUS_FRESH_MS — the quit window is exactly the hint's own
    // visibility: once "Ctrl+C again closes orcode" has gone stale, a
    // press re-arms instead of quitting.
    t.mock.timers.setTime(NOW + 6_001);
    press(stdin, "c", "", { ctrl: true });
    await Promise.resolve();
    assert.equal(settled, false, "a press after the window expired must re-arm, not quit");
    press(stdin, "c", "", { ctrl: true });
    await assert.rejects(pending, /orcode was closed/i);
  } finally {
    terminal.stop();
  }
});

test("resize redraws without a full clear and repositions the real cursor", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const beforeResize = stdout.output.length;
    stdout.columns = 175;
    stdout.rows = 55;
    process.emit("SIGWINCH");
    const redraw = stdout.output.slice(beforeResize);

    assert.doesNotMatch(redraw, /\u001b\[2J/);
    assert.match(redraw, /^\u001b\[\?25l\u001b\[H/);
    assert.match(redraw, /\u001b\[K\r\n/);
    assert.match(redraw, /\u001b\[J\u001b\[\d+;\d+H\u001b\[\?25h$/);
  } finally {
    terminal.stop();
  }
});

test("assistant text after a tool is rendered after the completed tool card", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 40;
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    terminal.beginAssistant("moonshotai/kimi-k3");
    terminal.handleRunEvent({ type: "run-start", model: "m", maxSteps: 12, timestamp: NOW });
    terminal.appendAssistant("Text vor dem Tool.");
    terminal.handleRunEvent({
      type: "tool-start",
      id: "tool-1",
      number: 1,
      name: "run_command",
      input: { command: "python -m pytest" },
      timestamp: NOW + 100,
    });
    terminal.handleRunEvent({
      type: "tool-end",
      id: "tool-1",
      number: 1,
      name: "run_command",
      input: { command: "python -m pytest" },
      output: { exitCode: 0, stdout: "116 passed in 0.47s\n", stderr: "", truncated: false },
      durationMs: 470,
      timestamp: NOW + 570,
    });
    terminal.appendAssistant("Text nach dem Tool.");

    const screen = text(terminal.frame().lines);
    const before = screen.indexOf("Text vor dem Tool.");
    const tool = screen.indexOf("python -m pytest");
    const after = screen.indexOf("Text nach dem Tool.");

    assert.ok(before >= 0);
    assert.ok(tool > before);
    assert.ok(after > tool);
    // Controller decision C: the head bullet is constant now; exit 0's
    // verified glyph (vs. `~` for anything else) shows up on the outcome
    // result line instead.
    assert.match(screen, /● Shell\(python -m pytest/);
    assert.match(screen, /⎿ ✓ 116 passed/);
  } finally {
    terminal.stop();
  }
});

test("volatile process events render live and one terminal event does not duplicate the tail", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 36;
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    terminal.handleRunEvent({
      type: "process-start",
      id: "direct-diff-1",
      name: "git_diff",
      input: { staged: false },
      timestamp: NOW,
    } as AgentRunEvent);
    terminal.handleRunEvent({
      type: "process-output",
      id: "direct-diff-1",
      name: "git_diff",
      stream: "stdout",
      text: "+live-line\n",
      timestamp: NOW + 1,
    } as AgentRunEvent);
    assert.match(text(terminal.frame().lines), /live-line/);

    const terminalEvent = {
      type: "process-end",
      id: "direct-diff-1",
      name: "git_diff",
      input: { staged: false },
      exitCode: 0,
      durationMs: 20,
      truncated: false,
      timedOut: false,
      aborted: false,
      timestamp: NOW + 20,
    } as AgentRunEvent;
    terminal.handleRunEvent(terminalEvent);
    terminal.handleRunEvent(terminalEvent);
    const screen = text(terminal.frame().lines);
    assert.ok((screen.match(/live-line/g)?.length ?? 0) <= 1);
    assert.equal(screen.match(/working tree/g)?.length, 1);
  } finally {
    terminal.stop();
  }
});

test("automatic verification uses one process card and renders the root unverified terminal once", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 36;
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    terminal.handleRunEvent({
      type: "run-start",
      model: "vendor/model",
      maxSteps: 6,
      prompt: "edit",
      timestamp: NOW,
    });
    terminal.handleRunEvent({
      type: "process-start",
      id: "task9-verify",
      name: "verify",
      input: { command: "task9-check" },
      timestamp: NOW + 1,
    });
    terminal.handleRunEvent({
      type: "process-output",
      id: "task9-verify",
      name: "verify",
      stream: "stderr",
      text: "ERROR task9-only-tail\n",
      timestamp: NOW + 2,
    });
    terminal.handleRunEvent({
      type: "process-end",
      id: "task9-verify",
      name: "verify",
      input: { command: "task9-check" },
      exitCode: 1,
      durationMs: 20,
      truncated: false,
      timedOut: false,
      aborted: false,
      timestamp: NOW + 3,
    });
    terminal.handleRunEvent({
      type: "run-end",
      outcome: "unverified",
      durationMs: 30,
      toolCount: 0,
      timestamp: NOW + 4,
    });

    const screen = text(terminal.frame().lines);
    assert.equal(screen.match(/task9-check/g)?.length, 1);
    assert.equal(screen.match(/task9-only-tail/g)?.length, 1);
    assert.equal(screen.match(/Run complete · unverified/g)?.length, 1);
    assert.doesNotMatch(screen, /Verification run.*Round/);
  } finally {
    terminal.stop();
  }
});

test("invalid verification shell shows one redacted process-card reason and one root terminal", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 36;
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    terminal.handleRunEvent({
      type: "run-start",
      model: "vendor/model",
      maxSteps: 6,
      prompt: "edit",
      timestamp: NOW,
    });
    terminal.handleRunEvent({
      type: "process-start",
      id: "task9-invalid-shell",
      name: "verify",
      input: { command: "task9-shell-check" },
      timestamp: NOW + 1,
    });
    terminal.handleRunEvent({
      type: "process-end",
      id: "task9-invalid-shell",
      name: "verify",
      input: { command: "task9-shell-check" },
      exitCode: null,
      durationMs: 2,
      truncated: false,
      timedOut: false,
      aborted: false,
      error: "ENOENT: missing shell [REDACTED]",
      timestamp: NOW + 2,
    });
    terminal.handleRunEvent({
      type: "run-end",
      outcome: "unverified",
      durationMs: 3,
      toolCount: 0,
      timestamp: NOW + 3,
    });

    const screen = text(terminal.frame().lines);
    assert.equal(screen.match(/task9-shell-check/g)?.length, 1);
    assert.equal(screen.match(/missing shell \[REDACTED\]/g)?.length, 1, screen);
    assert.equal(screen.match(/Run complete · unverified/g)?.length, 1);
    assert.doesNotMatch(screen, /Verification run.*Round/);
  } finally {
    terminal.stop();
  }
});

test("a tool-bound null-exit launch failure renders one cause and one terminal tool card", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 36;
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    terminal.handleRunEvent({
      type: "run-start",
      model: "vendor/model",
      maxSteps: 6,
      prompt: "run",
      timestamp: NOW,
    });
    terminal.handleRunEvent({
      type: "tool-start",
      id: "tool-launch",
      invocationId: "invocation-launch",
      number: 1,
      name: "run_command",
      input: { command: "task9-bound-command" },
      timestamp: NOW + 1,
    });
    terminal.handleRunEvent({
      type: "process-start",
      id: "process-launch",
      invocationId: "invocation-launch",
      name: "run_command",
      input: { command: "task9-bound-command" },
      toolId: "tool-launch",
      toolNumber: 1,
      timestamp: NOW + 2,
    });
    terminal.handleRunEvent({
      type: "process-end",
      id: "process-launch",
      invocationId: "invocation-launch",
      name: "run_command",
      input: { command: "task9-bound-command" },
      toolId: "tool-launch",
      toolNumber: 1,
      exitCode: null,
      durationMs: 2,
      truncated: false,
      timedOut: false,
      aborted: false,
      error: "spawn shell ENOENT [REDACTED]",
      timestamp: NOW + 3,
    });
    terminal.handleRunEvent({
      type: "tool-error",
      id: "tool-launch",
      invocationId: "invocation-launch",
      number: 1,
      name: "run_command",
      input: { command: "task9-bound-command" },
      error: "spawn shell ENOENT [REDACTED]",
      durationMs: 3,
      timestamp: NOW + 4,
    });
    terminal.handleRunEvent({
      type: "run-end",
      outcome: "error",
      durationMs: 4,
      toolCount: 1,
      timestamp: NOW + 5,
    });

    const screen = text(terminal.frame().lines);
    assert.equal(screen.match(/task9-bound-command/g)?.length, 1, screen);
    assert.equal(screen.match(/spawn shell ENOENT \[REDACTED\]/g)?.length, 1, screen);
    assert.equal(screen.match(/Run failed/g)?.length, 1, screen);
  } finally {
    terminal.stop();
  }
});

test("fullscreen /diff terminal frames distinguish dirty, clean, and failed repositories without duplicate tails", async (t) => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("git ist nicht installiert");
    return;
  }
  const renderDiff = async (workspace: string): Promise<string> => {
    const stdin = new FakeInput();
    const stdout = new FakeOutput();
    stdout.rows = 40;
    const terminal = ui(stdin, stdout);
    terminal.start();
    try {
      const context = {
        workspace,
        onRunEvent: (event: AgentRunEvent) => terminal.handleRunEvent(event),
        out: { text: () => undefined, error: () => undefined },
      } as unknown as CommandContext;
      await handleSlashCommand("/diff", context);
      return text(terminal.frame().lines);
    } finally {
      terminal.stop();
    }
  };
  const repository = mkdtempSync(join(tmpdir(), "routercode-tui-diff-"));
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "RouterCode Test"], { cwd: repository });
  writeFileSync(join(repository, "tracked.txt"), "before\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: repository });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repository });
  const failed = mkdtempSync(join(tmpdir(), "routercode-tui-diff-failed-"));
  try {
    const clean = await renderDiff(repository);
    assert.match(clean, /0 diff line/);

    writeFileSync(join(repository, "tracked.txt"), "after\n");
    const dirty = await renderDiff(repository);
    assert.match(dirty, /[1-9]\d* diff line/);
    assert.ok((dirty.match(/after/g)?.length ?? 0) <= 1, "the streamed tail was duplicated at terminal completion");

    const failure = await renderDiff(failed);
    assert.match(failure, /(?:Git fehlgeschlagen|exit 1(?:28|29))/i);
    assert.doesNotMatch(failure, /0 diff line/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
    rmSync(failed, { recursive: true, force: true });
  }
});

test("process chunks are redacted and partial lines are reassembled before TUI rendering", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 36;
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    terminal.handleRunEvent({ type: "process-start", id: "p-secret", name: "verify", input: { command: "check" }, timestamp: NOW } as AgentRunEvent);
    terminal.handleRunEvent({ type: "process-output", id: "p-secret", name: "verify", stream: "stdout", text: "partial", timestamp: NOW + 1 } as AgentRunEvent);
    terminal.handleRunEvent({ type: "process-output", id: "p-secret", name: "verify", stream: "stdout", text: "-line\n", timestamp: NOW + 2 } as AgentRunEvent);
    terminal.handleRunEvent({ type: "process-output", id: "p-secret", name: "verify", stream: "stderr", text: `${["sk", "or", "v1"].join("-")}-`, timestamp: NOW + 3 } as AgentRunEvent);
    terminal.handleRunEvent({ type: "process-output", id: "p-secret", name: "verify", stream: "stderr", text: `${"q".repeat(40)}\n`, timestamp: NOW + 4 } as AgentRunEvent);
    const screen = text(terminal.frame().lines);
    assert.match(screen, /partial-line/);
    assert.doesNotMatch(screen, /^partial$/m);
    assert.doesNotMatch(screen, new RegExp(`${["sk", "or", "v1"].join("-")}-${"q".repeat(40)}`));
  } finally {
    terminal.stop();
  }
});

test("TUI hides every registered credential family at every process chunk split and flushes benign suffixes", () => {
  const awsSecret = "A".repeat(40);
  const bearer = `token9${"b".repeat(24)}`;
  const privateBody = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=";
  const privateLabel = ["PRIVATE", "KEY"].join(" ");
  const fixtures = [
    { name: "openrouter", secret: `${["sk", "or", "v1"].join("-")}-${"o".repeat(24)}`, sensitive: "o".repeat(24) },
    { name: "anthropic", secret: `${["sk", "ant"].join("-")}-${"a".repeat(24)}`, sensitive: "a".repeat(24) },
    { name: "generic-sk", secret: `${["sk", "generic"].join("-")}-${"g".repeat(24)}`, sensitive: "g".repeat(24) },
    { name: "aws-access", secret: `${["AK", "IA"].join("")}${"C".repeat(16)}`, sensitive: "C".repeat(16) },
    { name: "aws-secret", secret: `aws_secret_access_key=${awsSecret}`, sensitive: awsSecret },
    { name: "github", secret: `${["gh", "p_"].join("")}${"H".repeat(24)}`, sensitive: "H".repeat(24) },
    { name: "gitlab", secret: `${["glpat", ""].join("-")}${"L".repeat(24)}`, sensitive: "L".repeat(24) },
    { name: "slack", secret: `${["xox", "b-"].join("")}${"1".repeat(16)}`, sensitive: "1".repeat(16) },
    { name: "google", secret: `${["AI", "za"].join("")}${"Q".repeat(35)}`, sensitive: "Q".repeat(35) },
    { name: "npm", secret: `${["npm", "_"].join("")}${"N".repeat(36)}`, sensitive: "N".repeat(36) },
    { name: "bearer", secret: `Bearer ${bearer}`, sensitive: bearer },
    { name: "jwt", secret: `eyJ${"j".repeat(10)}.${"k".repeat(10)}.${"m".repeat(10)}`, sensitive: `${"j".repeat(10)}.${"k".repeat(10)}.${"m".repeat(10)}` },
    { name: "private-key", secret: `-----BEGIN ${privateLabel}-----\n${privateBody}\n-----END ${privateLabel}-----`, sensitive: privateBody },
  ];
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 40;
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    let timestamp = NOW;
    for (const fixture of fixtures) {
      for (let split = 1; split < fixture.secret.length; split += 1) {
        const id = `${fixture.name}-${split}`;
        terminal.handleRunEvent({ type: "process-start", id, name: "verify", input: {}, timestamp: timestamp++ } as AgentRunEvent);
        terminal.handleRunEvent({ type: "process-output", id, name: "verify", stream: "stdout", text: fixture.secret.slice(0, split), timestamp: timestamp++ } as AgentRunEvent);
        terminal.handleRunEvent({ type: "process-output", id, name: "verify", stream: "stdout", text: `${fixture.secret.slice(split)}\n`, timestamp: timestamp++ } as AgentRunEvent);
        assert.equal(
          text(terminal.frame().lines).includes(fixture.sensitive),
          false,
          `${fixture.name} leaked at split ${split}`,
        );
        terminal.handleRunEvent({
          type: "process-end",
          id,
          name: "verify",
          input: {},
          exitCode: 0,
          durationMs: 1,
          truncated: false,
          timedOut: false,
          aborted: false,
          timestamp: timestamp++,
        } as AgentRunEvent);
      }
    }
    terminal.handleRunEvent({ type: "process-start", id: "benign-suffix", name: "verify", input: {}, timestamp: timestamp++ } as AgentRunEvent);
    terminal.handleRunEvent({ type: "process-output", id: "benign-suffix", name: "verify", stream: "stdout", text: "ordinary trailing s", timestamp: timestamp++ } as AgentRunEvent);
    terminal.handleRunEvent({
      type: "process-end",
      id: "benign-suffix",
      name: "verify",
      input: {},
      exitCode: 1,
      durationMs: 1,
      truncated: false,
      timedOut: false,
      aborted: false,
      timestamp: timestamp++,
    } as AgentRunEvent);
    assert.match(text(terminal.frame().lines), /ordinary trailing s/);
  } finally {
    terminal.stop();
  }
});

test("TUI keeps later stderr behind an earlier ambiguous stdout prefix", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 36;
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const id = "cross-stream-order";
    terminal.handleRunEvent({ type: "process-start", id, name: "run_command", input: { command: "order" }, timestamp: NOW } as AgentRunEvent);
    terminal.handleRunEvent({ type: "process-output", id, name: "run_command", stream: "stdout", text: "eyJ", timestamp: NOW + 1 } as AgentRunEvent);
    terminal.handleRunEvent({ type: "process-output", id, name: "run_command", stream: "stderr", text: "ERR-LATER\n", timestamp: NOW + 2 } as AgentRunEvent);
    assert.doesNotMatch(
      text(terminal.frame().lines),
      /ERR-LATER/,
      "later stderr escaped while the earlier stdout overlap was unresolved",
    );
    terminal.handleRunEvent({
      type: "process-end",
      id,
      name: "run_command",
      input: { command: "order" },
      exitCode: 1,
      durationMs: 3,
      truncated: false,
      timedOut: false,
      aborted: false,
      timestamp: NOW + 3,
    } as AgentRunEvent);

    const screen = text(terminal.frame().lines);
    const earlier = screen.indexOf("eyJ");
    const later = screen.indexOf("ERR-LATER");
    assert.ok(earlier >= 0 && later >= 0, screen);
    assert.ok(earlier < later, screen);
  } finally {
    terminal.stop();
  }
});

test("TUI preserves retained stdout provenance when a same-stream chunk resolves mid-process", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 36;
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const id = "cross-stream-provenance";
    terminal.handleRunEvent({ type: "process-start", id, name: "run_command", input: { command: "order" }, timestamp: NOW } as AgentRunEvent);
    terminal.handleRunEvent({ type: "process-output", id, name: "run_command", stream: "stdout", text: "eyJ", timestamp: NOW + 1 } as AgentRunEvent);
    terminal.handleRunEvent({ type: "process-output", id, name: "run_command", stream: "stderr", text: "ERR-LATER\n", timestamp: NOW + 2 } as AgentRunEvent);
    assert.doesNotMatch(text(terminal.frame().lines), /ERR-LATER/);
    terminal.handleRunEvent({ type: "process-output", id, name: "run_command", stream: "stdout", text: " benign\n", timestamp: NOW + 3 } as AgentRunEvent);

    const screen = text(terminal.frame().lines);
    const oldStdout = screen.indexOf("eyJ");
    const interveningStderr = screen.indexOf("ERR-LATER");
    const currentStdout = screen.indexOf("benign");
    assert.ok(oldStdout >= 0 && interveningStderr >= 0 && currentStdout >= 0, screen);
    assert.ok(oldStdout < interveningStderr, screen);
    assert.ok(interveningStderr < currentStdout, screen);

    terminal.handleRunEvent({
      type: "process-end",
      id,
      name: "run_command",
      input: { command: "order" },
      exitCode: 1,
      durationMs: 4,
      truncated: false,
      timedOut: false,
      aborted: false,
      timestamp: NOW + 4,
    } as AgentRunEvent);
  } finally {
    terminal.stop();
  }
});

test("TUI emits exactly one AWS marker in original output order across every capture split", () => {
  const sensitive = "S".repeat(40);
  const marker = "[REDACTED_AWS_SECRET]";
  for (const variant of awsCaptureLabels()) {
    for (let split = 1; split <= variant.label.length; split += 1) {
      const stdin = new FakeInput();
      const stdout = new FakeOutput();
      stdout.columns = 180;
      stdout.rows = 50;
      const terminal = ui(stdin, stdout);
      terminal.start();
      try {
        const id = `aws-${variant.name}-${split}`;
        const oldTag = `OLD-${variant.name}-${split}|`;
        const errorTag = `ERR-${variant.name}-${split}`;
        const currentTag = `|CURRENT-${variant.name}-${split}`;
        terminal.handleRunEvent({
          type: "process-start",
          id,
          name: "verify",
          input: {},
          timestamp: NOW,
        } as AgentRunEvent);
        terminal.handleRunEvent({
          type: "process-output",
          id,
          name: "verify",
          stream: "stdout",
          text: `${oldTag}${variant.label.slice(0, split)}`,
          timestamp: NOW + 1,
        } as AgentRunEvent);
        terminal.handleRunEvent({
          type: "process-output",
          id,
          name: "verify",
          stream: "stderr",
          text: `${errorTag}\n`,
          timestamp: NOW + 2,
        } as AgentRunEvent);
        assert.doesNotMatch(
          text(terminal.frame().lines),
          new RegExp(errorTag),
          `${id} let stderr pass an unresolved stdout capture`,
        );
        terminal.handleRunEvent({
          type: "process-output",
          id,
          name: "verify",
          stream: "stdout",
          text: `${variant.label.slice(split)}${sensitive}${currentTag}\n`,
          timestamp: NOW + 3,
        } as AgentRunEvent);
        terminal.handleRunEvent({
          type: "process-end",
          id,
          name: "verify",
          input: {},
          exitCode: 1,
          durationMs: 4,
          truncated: false,
          timedOut: false,
          aborted: false,
          timestamp: NOW + 4,
        } as AgentRunEvent);

        const screen = text(terminal.frame().lines);
        const markerIsOld = split === variant.label.length;
        const oldText = `${oldTag}${variant.label.slice(0, split)}${markerIsOld ? marker : ""}`.trim();
        const currentText = `${variant.label.slice(split)}${markerIsOld ? "" : marker}${currentTag}`.trim();
        assert.equal(
          screen.split(marker).length - 1,
          1,
          `${id} emitted more than one marker:\n${screen}`,
        );
        assert.doesNotMatch(screen, new RegExp(sensitive), `${id} leaked secret bytes`);
        const oldIndex = screen.indexOf(oldText);
        const errorIndex = screen.indexOf(errorTag);
        const currentIndex = screen.indexOf(currentText);
        assert.ok(oldIndex >= 0, `${id} lost old-frame text:\n${screen}`);
        assert.ok(errorIndex >= 0, `${id} lost stderr text:\n${screen}`);
        assert.ok(currentIndex >= 0, `${id} lost current-frame text:\n${screen}`);
        assert.ok(oldIndex < errorIndex, `${id} reordered old stdout behind stderr:\n${screen}`);
        assert.ok(errorIndex < currentIndex, `${id} reordered current stdout before stderr:\n${screen}`);
      } finally {
        terminal.stop();
      }
    }
  }
});

test("terminal process deduplication is bounded and eventually releases old operation IDs", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 36;
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    for (let index = 0; index < 513; index += 1) {
      const id = `bounded-${index}`;
      terminal.handleRunEvent({
        type: "process-start",
        id,
        name: "verify",
        input: { command: String(index) },
        timestamp: NOW + index,
      } as AgentRunEvent);
      terminal.handleRunEvent({
        type: "process-end",
        id,
        name: "verify",
        input: { command: String(index) },
        exitCode: 0,
        durationMs: 1,
        truncated: false,
        timedOut: false,
        aborted: false,
        timestamp: NOW + index,
      } as AgentRunEvent);
    }
    terminal.handleRunEvent({
      type: "process-start",
      id: "bounded-0",
      name: "verify",
      input: { command: "reused" },
      timestamp: NOW + 600,
    } as AgentRunEvent);
    terminal.handleRunEvent({
      type: "process-output",
      id: "bounded-0",
      name: "verify",
      stream: "stdout",
      text: "reused-live\n",
      timestamp: NOW + 601,
    } as AgentRunEvent);
    assert.match(text(terminal.frame().lines), /reused-live/);
  } finally {
    terminal.stop();
  }
});

test("Ctrl+T toggles the reasoning block, a bare T does not", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 34;
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    terminal.handleRunEvent({ type: "run-start", model: "m", maxSteps: 12, timestamp: NOW });
    terminal.handleRunEvent({
      type: "reasoning",
      model: "m",
      step: 1,
      delta: "Ich untersuche zunächst die betroffenen Dateien.",
      timestamp: NOW + 10,
    });
    assert.match(text(terminal.frame().lines), /Ctrl\+O show thinking/);

    press(stdin, "t", "", { ctrl: true });
    const expanded = text(terminal.frame().lines);
    assert.match(expanded, /Ctrl\+O hide thinking/);
    assert.match(expanded, /Ich untersuche zunächst/);

    terminal.finishAssistant("Fertig.");
    const value = terminal.readInput();
    press(stdin, "t", "T", { shift: true });
    press(stdin, "return");
    assert.equal(await value, "T");
  } finally {
    terminal.stop();
  }
});

test("FIX-3 addendum: Ctrl+O reaches the tool block that advertises it, and reveals real lines", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 40;
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    terminal.handleRunEvent({ type: "run-start", model: "m", maxSteps: 12, timestamp: NOW });
    terminal.handleRunEvent({
      type: "tool-start",
      id: "t1",
      number: 1,
      name: "run_command",
      input: { command: "npm test" },
      timestamp: NOW,
    });
    for (let index = 0; index < 20; index += 1) {
      terminal.handleRunEvent({
        type: "tool-output",
        id: "t1",
        number: 1,
        stream: "stdout",
        text: `error TS1000: Zeile ${index}\n`,
        timestamp: NOW + index,
      });
    }
    terminal.handleRunEvent({
      type: "tool-end",
      id: "t1",
      number: 1,
      name: "run_command",
      input: { command: "npm test" },
      output: { exitCode: 1, stdout: "", stderr: "", truncated: false },
      durationMs: 20,
      timestamp: NOW + 20,
    });

    const collapsed = text(terminal.frame().lines);
    assert.match(collapsed, /more lines/);
    assert.match(collapsed, /Ctrl\+O expand/);
    assert.doesNotMatch(collapsed, /Zeile 8/, "the tail beyond the collapsed limit stays hidden");

    press(stdin, "o", "", { ctrl: true });
    const expanded = text(terminal.frame().lines);
    assert.match(expanded, /Ctrl\+O collapse/);
    // The advertised key does what it says: lines that were not on screen are.
    assert.match(expanded, /Zeile 8/);
  } finally {
    terminal.stop();
  }
});

// Audit FIX-1 (2026-08-28): Shift+Tab (CSI Z; node's keypress decoder
// reports `{ name: "tab", shift: true }`) cycles the approval mode
// ask → auto-edit → read-only → ask through the registered /allow
// persistence sink. allow-all is NEVER entered by the cycle — it stays
// exclusively behind /allow's explicit danger confirm.
test("Shift+Tab cycles the approval mode and never enters allow-all", async () => {
  const shiftTabState: DashboardState = { ...state };
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = new TerminalUi(
    () => shiftTabState,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
    theme,
  );
  const persisted: string[] = [];
  terminal.setApprovalModeHandler((mode) => {
    persisted.push(mode);
    shiftTabState.approval = mode;
  });
  terminal.start();
  try {
    const pending = terminal.readInput();
    type(stdin, "draft stays");

    press(stdin, "tab", "", { shift: true });
    assert.deepEqual(persisted, ["auto-edit"]);
    let rendered = text(terminal.frame().lines);
    assert.match(rendered, /Approvals: auto-edit/);
    assert.match(rendered, /draft stays/, "cycling the mode must not touch the draft");

    press(stdin, "tab", "", { shift: true });
    assert.deepEqual(persisted, ["auto-edit", "read-only"]);

    press(stdin, "tab", "", { shift: true });
    assert.deepEqual(persisted, ["auto-edit", "read-only", "ask"], "the cycle wraps back to ask");

    // From allow-all (reachable only via /allow's danger confirm) the key
    // leaves toward ask — the safe direction — and never re-enters it.
    shiftTabState.approval = "allow-all";
    press(stdin, "tab", "", { shift: true });
    assert.deepEqual(persisted.at(-1), "ask");
    assert.equal(persisted.includes("allow-all"), false, "Shift+Tab must never hand over allow-all");

    // A plain Tab is not the cycle key.
    press(stdin, "tab", "\t");
    assert.equal(persisted.length, 4);

    press(stdin, "return");
    assert.equal(await pending, "draft stays");
  } finally {
    terminal.stop();
  }
});

// Audit FIX-1 (2026-08-28): confirm mode used to swallow Ctrl+O, so the
// truncated approval's "Ctrl+O shows all" hint was false 100% of the time
// it rendered — a large write had to be approved blind. Ctrl+O now expands
// the pending approval's full detail inside confirm mode, and every
// decision key keeps working while it is expanded.
test("Ctrl+O inside confirm mode expands the truncated approval and y still decides", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 40;
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const details = Array.from({ length: 15 }, (_, i) => `detail-${i + 1}`).join("\n");
    const decision = terminal.confirmAction("Datei schreiben: index.html", details);

    const collapsed = text(terminal.frame().lines);
    assert.match(collapsed, /Ctrl\+O shows all/);
    assert.match(collapsed, /5 more lines/);
    assert.doesNotMatch(collapsed, /detail-15/);

    press(stdin, "o", "", { ctrl: true });
    const expanded = text(terminal.frame().lines);
    assert.match(expanded, /detail-15/);
    assert.match(expanded, /Ctrl\+O collapse/);
    assert.doesNotMatch(expanded, /more lines/);

    // Ctrl+T is the established synonym of the toggle pair — it collapses
    // again, and the hint flips back.
    press(stdin, "t", "", { ctrl: true });
    const recollapsed = text(terminal.frame().lines);
    assert.match(recollapsed, /Ctrl\+O shows all/);
    assert.doesNotMatch(recollapsed, /detail-15/);

    // Decision keys keep working while expanded.
    press(stdin, "o", "", { ctrl: true });
    press(stdin, "y", "y");
    assert.deepEqual(await decision, { accepted: true });
  } finally {
    terminal.stop();
  }
});

test("Shift+Tab stays inert without a registered approval-mode sink", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const pending = terminal.readInput();
    press(stdin, "tab", "", { shift: true });
    assert.doesNotMatch(
      text(terminal.frame().lines),
      /Approvals:/,
      "without a persistence sink the key must not announce a change nothing stored",
    );
    press(stdin, "return");
    assert.equal(await pending, "");
  } finally {
    terminal.stop();
  }
});

// Phase 3b, Part C: `esc`'s meaning during a run is state-dependent —
// deterministic on `RunViewModel.reasoningLive`, never a timing heuristic.
// These three tests pin the split at the key-routing level; the PTY harness
// (tests/pty-lifecycle.test.ts) covers the same split end-to-end.
test("esc while reasoning streams live ends only the thinking, never the run", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    let cancelled = 0;
    let endedThinking = 0;
    terminal.setCancelHandler(() => {
      cancelled += 1;
    });
    terminal.setEndThinkingHandler(() => {
      endedThinking += 1;
    });
    terminal.handleRunEvent({ type: "run-start", model: "m", maxSteps: 12, timestamp: NOW });
    terminal.handleRunEvent({
      type: "reasoning",
      model: "m",
      step: 1,
      delta: "Ich prüfe die betroffenen Module.",
      timestamp: NOW + 5,
    });

    press(stdin, "escape");

    assert.equal(endedThinking, 1, "esc during live reasoning must end the thinking step");
    assert.equal(cancelled, 0, "esc during live reasoning must NOT abort the run");
  } finally {
    terminal.stop();
  }
});

test("esc while no reasoning streams aborts the run (the existing meaning, now also reachable via esc)", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    let cancelled = 0;
    let endedThinking = 0;
    terminal.setCancelHandler(() => {
      cancelled += 1;
    });
    terminal.setEndThinkingHandler(() => {
      endedThinking += 1;
    });
    terminal.handleRunEvent({ type: "run-start", model: "m", maxSteps: 12, timestamp: NOW });
    // A tool call is running, not reasoning: `reasoningLive` is false.
    terminal.handleRunEvent({
      type: "tool-start",
      id: "t1",
      number: 1,
      name: "run_command",
      input: { command: "npm test" },
      timestamp: NOW + 5,
    });

    press(stdin, "escape");

    assert.equal(cancelled, 1, "esc must abort the run once reasoning is not the live stream");
    assert.equal(endedThinking, 0);
  } finally {
    terminal.stop();
  }
});

test("esc still does nothing while idle with no run active (unchanged invariant)", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    let cancelled = 0;
    let endedThinking = 0;
    terminal.setCancelHandler(() => {
      cancelled += 1;
    });
    terminal.setEndThinkingHandler(() => {
      endedThinking += 1;
    });
    const value = terminal.readInput();
    type(stdin, "etwas Text");
    press(stdin, "escape");
    assert.equal(cancelled, 0);
    assert.equal(endedThinking, 0);
    press(stdin, "return");
    assert.equal(await value, "etwas Text", "escape must not have wiped the buffer");
  } finally {
    terminal.stop();
  }
});

// Fix round 1, Critical 2: `reasoningLive` (src/ui/view-model.ts) was
// previously cleared only by "model-end" — a phase aborted mid-stream (esc
// ending its thinking) never gets one, so the flag stayed stuck true. A
// second esc during the continuation would then wrongly re-arm end-thinking
// (aborting the continuation too, booking another "unknown" cost, looping)
// instead of routing to run-abort, and the "Thinking … Ns" header would keep
// ticking through a continuation that is not even streaming reasoning.
test("a second esc during the end-thinking continuation routes to run-abort, and the thinking header stops ticking after the first esc", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    let cancelled = 0;
    let endedThinking = 0;
    terminal.setCancelHandler(() => {
      cancelled += 1;
    });
    terminal.setEndThinkingHandler(() => {
      endedThinking += 1;
    });
    terminal.handleRunEvent({ type: "run-start", model: "m", maxSteps: 12, timestamp: NOW });
    terminal.handleRunEvent({
      type: "reasoning",
      model: "m",
      step: 1,
      delta: "Ich prüfe die betroffenen Module.",
      timestamp: NOW + 5,
    });
    assert.match(
      text(terminal.frame().lines),
      /Thinking … \(\d+s/,
      "the live thinking header shows before the first esc",
    );

    press(stdin, "escape");
    assert.equal(endedThinking, 1, "the first Esc ends the thinking");
    assert.equal(cancelled, 0);

    // The continuation is a fresh model phase — agent.ts always emits
    // model-start for it (announceModelStep at the top of every
    // executeModelPhase call, including the end-thinking continuation);
    // this must supersede the aborted phase's orphaned "live" reasoning
    // block, since that phase's own model-end never fires (the request was
    // aborted, not completed).
    terminal.handleRunEvent({ type: "model-start", model: "m", step: 2, timestamp: NOW + 10 });
    assert.doesNotMatch(
      text(terminal.frame().lines),
      /Thinking … \(\d+s/,
      "the thinking header must stop ticking once the continuation starts",
    );

    press(stdin, "escape");
    assert.equal(endedThinking, 1, "the second esc, during the continuation, must NOT re-trigger end-thinking");
    assert.equal(cancelled, 1, "the second esc must route to run-abort instead");
  } finally {
    terminal.stop();
  }
});

test("Enter in the command list completes first and executes only afterwards", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "/");
    let settled = false;
    void value.then(() => {
      settled = true;
    });
    press(stdin, "return");
    await Promise.resolve();
    assert.equal(settled, false);
    assert.match(stdout.output, /\/model/);

    press(stdin, "return");
    await Promise.resolve();
    assert.equal(settled, false);
    press(stdin, "return");
    assert.equal(await value, "/model");
  } finally {
    terminal.stop();
  }
});

test("slash and Ctrl+P open the same hierarchical root menu without changing the Ctrl+P draft", async () => {
  const slashIn = new FakeInput();
  const slashOut = new FakeOutput();
  const slash = ui(slashIn, slashOut);
  const paletteIn = new FakeInput();
  const paletteOut = new FakeOutput();
  const palette = ui(paletteIn, paletteOut);
  slash.start();
  palette.start();
  try {
    const slashValue = slash.readInput();
    const paletteValue = palette.readInput();
    type(paletteIn, "unchanged input");
    press(slashIn, "/", "/");
    press(paletteIn, "p", "\u0010", { ctrl: true });
    // V3 reskin (F2): the palette's own dedicated footer line now shares the
    // same fixed row budget as the rows themselves, so one fewer root item
    // fits at this terminal height than before the reskin — trimmed from
    // "…Accounts · Safety" to "…Work · Accounts", still proving both trigger
    // paths render the identical, correctly ordered root tree.
    const root = /Model[\s\S]*Chat[\s\S]*Work[\s\S]*Accounts/;
    assert.match(slashOut.output, root);
    assert.match(paletteOut.output, root);
    press(paletteIn, "escape");
    press(paletteIn, "return");
    assert.equal(await paletteValue, "unchanged input");
    press(slashIn, "escape");
    press(slashIn, "return");
    assert.equal(await slashValue, "/");
  } finally {
    slash.stop();
    palette.stop();
  }
});

test("direct slash commands keep every typed argument in the composer", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "/imagX");
    press(stdin, "backspace");
    type(stdin, "e /tmp/fixture.png");
    press(stdin, "return");
    assert.equal(await value, "/image /tmp/fixture.png");
  } finally {
    terminal.stop();
  }
});

test("a complete direct slash command submits on the first real Enter", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const pending = terminal.readInput();
    let submitted: string | undefined;
    void pending.then((value) => {
      submitted = value;
    });
    type(stdin, "/model");
    press(stdin, "return", "\r");
    await Promise.resolve();
    assert.equal(submitted, "/model");
  } finally {
    terminal.stop();
  }
});

test("Ctrl+P treats real terminal control bytes as navigation instead of search text", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "unchanged");
    press(stdin, "p", "\u0010", { ctrl: true });
    type(stdin, "mX");
    press(stdin, "backspace", "\u007f");
    // A correctly recognized backspace BYTE erases "X", leaving the exact
    // query "m" — which now searches every executable leaf globally and
    // top-matches /model (the old root-level-only filter would instead
    // have coincidentally matched the "Models" *branch* label, not any
    // command). A wrongly-printable backspace byte would instead append
    // itself to the query, leaving "mX\u007f" and no match at all.
    assert.match(text(terminal.frame().lines), /\/model\b/);
    // A correctly recognized escape BYTE cancels the palette outright
    // (the query never drilled into a path) and restores the exact
    // pre-palette draft, rather than becoming literal query text — a
    // wrongly-printable escape byte would instead leave the menu open,
    // so the following real Enter would complete a match instead of
    // submitting the restored draft untouched.
    press(stdin, "escape", "\u001b");
    press(stdin, "return", "\r");
    assert.equal(await value, "unchanged");
  } finally {
    terminal.stop();
  }
});

test("Ctrl+P searches the whole tree from any drilled-in level while preserving exact draft bytes and cursor", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 20;
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    terminal.setImageAttachments([
      { path: "/tmp/one.png", name: "one.png", mimeType: "image/png", sizeBytes: 1 },
      { path: "/tmp/two.png", name: "two.png", mimeType: "image/png", sizeBytes: 1 },
    ]);
    for (const turn of chat(8)) {
      if (turn.kind === "user") terminal.addMessage("user", turn.text);
      else if (turn.kind === "assistant") terminal.addMessage("assistant", turn.text);
    }
    press(stdin, "pageup");
    const routeBefore = plainText(terminal.frame().lines[0]!);
    const scrollBefore = plainText(terminal.frame().lines[2]!);
    const value = terminal.readInput();
    type(stdin, "A🙂B");
    press(stdin, "left");
    press(stdin, "p", "\u0010", { ctrl: true });
    press(stdin, "return");
    const childStart = stdout.output.length;
    type(stdin, "th");
    assert.match(stdout.output.slice(childStart), /\/think/);
    assert.doesNotMatch(stdout.output.slice(childStart), /Model      Models and thinking/);
    // Being drilled into "Models" must not scope the search to that group's
    // own children: clearing the query and typing one that only matches a
    // leaf under a *different* root group ("/settings" lives under
    // "System") proves the search reaches the whole tree, not just the
    // level last browsed to.
    press(stdin, "backspace");
    press(stdin, "backspace");
    const globalStart = stdout.output.length;
    type(stdin, "se");
    assert.match(stdout.output.slice(globalStart), /\/settings/);
    assert.doesNotMatch(stdout.output.slice(globalStart), /\/think/);
    press(stdin, "escape");
    press(stdin, "escape");
    const restored = text(terminal.frame().lines);
    assert.match(restored, /2 images ready/);
    assert.equal(plainText(terminal.frame().lines[0]!), routeBefore);
    assert.equal(plainText(terminal.frame().lines[2]!), scrollBefore);
    type(stdin, "X");
    press(stdin, "return");
    assert.equal(await value, "A🙂XB");
  } finally { terminal.stop(); }
});

test("Cross palette selection exposes the exact composer draft once and restores its cursor on cancel", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "A🙂B");
    press(stdin, "return", "", { shift: true });
    type(stdin, "C");
    press(stdin, "left");
    press(stdin, "p", "\u0010", { ctrl: true });

    // Cross is the fifth item in Models (after FIX-15's /fallback). The palette
    // replaces the composer with /cross, but its original bytes/cursor
    // remain runtime-owned.
    press(stdin, "return");
    assert.match(text(terminal.frame().lines), /Commands › Models/);
    for (let index = 0; index < 4; index += 1) press(stdin, "down");
    press(stdin, "return");
    assert.match(text(terminal.frame().lines), /\/cross/);
    press(stdin, "return");

    assert.equal(await value, "/cross");
    assert.equal(terminal.consumeCrossCommandDraft(), "A🙂B\nC");
    assert.equal(terminal.consumeCrossCommandDraft(), "");

    terminal.restoreCrossCommandDraft();
    const restored = terminal.readInput();
    type(stdin, "X");
    press(stdin, "return");
    assert.equal(await restored, "A🙂B\nXC");
  } finally {
    terminal.stop();
  }
});

test("Architect palette selection exposes the exact composer draft, through the same one-shot bridge Cross uses", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "refactor the parser");
    press(stdin, "p", "", { ctrl: true });
    type(stdin, "architect");
    press(stdin, "return");
    assert.match(text(terminal.frame().lines), /\/architect/);
    press(stdin, "return");

    assert.equal(await value, "/architect");
    // The production path bare `/architect` actually reads (cli.ts wires
    // `composerDraft.read()` to exactly this) — not a test-only fake.
    assert.equal(terminal.consumeCrossCommandDraft(), "refactor the parser");
    assert.equal(terminal.consumeCrossCommandDraft(), "", "the bridge is one-shot");

    // Controller addendum: an `/architect` refusal calls exactly this seam
    // (wired as `composerDraft.restore`, cli.ts), so the owner's text lands
    // back in the composer instead of being silently eaten.
    terminal.restoreCrossCommandDraft();
    const retry = terminal.readInput();
    type(stdin, "!");
    press(stdin, "return");
    assert.equal(await retry, "refactor the parser!");
  } finally {
    terminal.stop();
  }
});

test("Architect palette selection on Tab captures no draft — the owner finishes typing an inline task instead", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "refactor the parser");
    press(stdin, "p", "", { ctrl: true });
    type(stdin, "architect");
    press(stdin, "tab");
    type(stdin, "fix the bug");
    press(stdin, "return");

    assert.equal(await value, "/architect fix the bug");
    assert.equal(
      terminal.consumeCrossCommandDraft(),
      "",
      "an inline task must never leave a stale draft behind for the next command to inherit",
    );
  } finally {
    terminal.stop();
  }
});

// FIX-11 (sanctioned behavior change, controller ruling): this is the
// ARGUMENT-TAKING half of the new Enter contract, and it keeps its double
// Return deliberately. `/cross run [task]` takes a task, so Enter
// fills the composer and hands the line back to the user — the palette
// footer says `Enter insert` for exactly this row (the state-2 footer test
// below pins it). Running it on the first Return would silently discard
// the task the palette was opened to type. The argument-less counterpart,
// which now runs on a single Return, is the test directly below.
test("nested Cross palette leaf submits its canonical command path instead of a bare leaf", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const value = terminal.readInput();
    press(stdin, "p", "\u0010", { ctrl: true });
    press(stdin, "return");
    for (let index = 0; index < 4; index += 1) press(stdin, "down");
    press(stdin, "tab");
    press(stdin, "return");
    assert.match(text(terminal.frame().lines), /\/cross run/);
    press(stdin, "return");
    assert.equal(await value, "/cross run");
  } finally {
    terminal.stop();
  }
});
test("FIX-11: Enter on an argument-less palette leaf runs it outright — the single Return the footer promises", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const value = terminal.readInput();
    press(stdin, "p", "", { ctrl: true });
    press(stdin, "down"); // Model -> Chat
    press(stdin, "return"); // drill into Chat (FIX-15 added compact, image, whisper)
    // `/clear` is the one Chat leaf that takes no arguments at all, and it is
    // the group's last row.
    for (let index = 0; index < 11; index += 1) press(stdin, "down");
    press(stdin, "return");
    // One Return, no second one: `readInput` resolves right here.
    assert.equal(await value, "/clear");
  } finally {
    terminal.stop();
  }
});

test("FIX-11: Tab keeps its insert-only semantics on an argument-less leaf — it never runs it", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const value = terminal.readInput();
    press(stdin, "p", "", { ctrl: true });
    press(stdin, "down");
    press(stdin, "return");
    for (let index = 0; index < 11; index += 1) press(stdin, "down");
    press(stdin, "tab");
    // Still sitting in the composer, unsent — and with no trailing space,
    // since `/clear` takes no arguments.
    assert.match(text(terminal.frame().lines), /\/clear/);
    press(stdin, "return");
    assert.equal(await value, "/clear");
  } finally {
    terminal.stop();
  }
});

// FIX-11 addendum, controller ruling B: one frame per verb. `Enter run` on
// a row that only opens a sublevel was the same footer lie the argument-less
// leaf case was, so every row class now names its own behavior.
test("FIX-11: the palette footer's Enter verb follows the selected row — 'open' on a browse branch, 'insert' on an argument-taking leaf, 'run' on an argument-less one", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    terminal.readInput();
    press(stdin, "p", "", { ctrl: true });
    // Root: "Models" is a browse group — Enter descends into it.
    const branch = text(terminal.frame().lines);
    assert.match(branch, /\[Enter\] open/);
    assert.doesNotMatch(branch, /\[Enter\] run/);
    assert.doesNotMatch(branch, /\[Enter\] insert/);

    press(stdin, "down"); // Model -> Chat
    press(stdin, "return"); // new, fork, chat, history, context, compact, goal, checkpoint, image, whisper, export, clear
    // `/new [title]` takes an optional title: Enter fills the composer.
    const argful = text(terminal.frame().lines);
    assert.match(argful, /\[Enter\] insert/);
    assert.doesNotMatch(argful, /\[Enter\] run/);
    assert.doesNotMatch(argful, /\[Enter\] open/);

    for (let index = 0; index < 11; index += 1) press(stdin, "down"); // -> clear
    // `/clear` takes nothing: Enter really does run it, and now says so.
    const argless = text(terminal.frame().lines);
    assert.match(argless, /\[Enter\] run/);
    assert.doesNotMatch(argless, /\[Enter\] insert/);
    assert.doesNotMatch(argless, /\[Enter\] open/);
    press(stdin, "escape");
    press(stdin, "escape");
  } finally {
    terminal.stop();
  }
});

test("FIX-11: the one actionable branch says 'insert', not 'open' — its Enter fills the composer with /cross instead of descending", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const value = terminal.readInput();
    press(stdin, "p", "", { ctrl: true });
    press(stdin, "return"); // drill into Models: model, fallback, think, compress, cross, panel
    for (let index = 0; index < 4; index += 1) press(stdin, "down"); // -> cross
    const frame = text(terminal.frame().lines);
    assert.match(frame, /\[Enter\] insert/);
    assert.doesNotMatch(frame, /\[Enter\] open/);
    // And the footer is telling the truth: Enter really does insert.
    press(stdin, "return");
    assert.match(text(terminal.frame().lines), /\/cross/);
    press(stdin, "return");
    assert.equal(await value, "/cross");
  } finally {
    terminal.stop();
  }
});


test("Ctrl+P and inline slash completion search the one shared data path — same input, same match", async () => {
  for (const prefix of ["co", "set", "pro", "mo"]) {
    const slashIn = new FakeInput();
    const slashOut = new FakeOutput();
    const slash = ui(slashIn, slashOut);
    const paletteIn = new FakeInput();
    const paletteOut = new FakeOutput();
    const palette = ui(paletteIn, paletteOut);
    slash.start();
    palette.start();
    try {
      slash.readInput();
      palette.readInput();
      type(slashIn, `/${prefix}`);
      press(paletteIn, "p", "\u0010", { ctrl: true });
      type(paletteIn, prefix);
      const slashProjection = slash.commandMenuProjection();
      const paletteProjection = palette.commandMenuProjection();
      assert.ok(slashProjection, `/${prefix} did not open the inline menu`);
      assert.ok(paletteProjection, `/${prefix} did not open the Ctrl+P palette`);
      assert.deepEqual(
        paletteProjection,
        slashProjection,
        `/${prefix} palette and inline completion diverged`,
      );
      assert.ok(slashProjection!.entries.length > 0, `/${prefix} returned no executable matches`);
    } finally {
      slash.stop();
      palette.stop();
    }
  }
});

test("an inline query with no matches clears the composer and opens the root tree instead of a dead end", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "/zzznope");
    // V3 reskin (F2 ruling 5): the recovery row's old "Show all commands /
    // No matches for …" wording is now one replacement line quoting the
    // failed query verbatim — exactly the composer text, slash included.
    assert.match(text(terminal.frame().lines), /No command matches "\/zzznope"/);
    assert.match(text(terminal.frame().lines), /\/help lists everything/);
    press(stdin, "return");
    assert.match(text(terminal.frame().lines), /Model[\s\S]*Chat[\s\S]*Work/);
    press(stdin, "escape");
    press(stdin, "return");
    assert.equal(await value, "/");
  } finally {
    terminal.stop();
  }
});

test("selecting the recovery entry from Ctrl+P opens the root tree without touching the original draft", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "unchanged");
    press(stdin, "p", "\u0010", { ctrl: true });
    type(stdin, "zzznope");
    // V3 reskin (F2 ruling 5): Ctrl+P's own search field never carries a
    // leading slash, so the verbatim quote here is the bare typed text —
    // unlike the inline-slash case above, which quotes "/zzznope".
    assert.match(text(terminal.frame().lines), /No command matches "zzznope"/);
    press(stdin, "return");
    assert.match(text(terminal.frame().lines), /Model[\s\S]*Chat[\s\S]*Work/);
    press(stdin, "escape");
    press(stdin, "return");
    assert.equal(await value, "unchanged");
  } finally {
    terminal.stop();
  }
});

// ---------------------------------------------------------------------------
// F2: the command palette's V3 reskin — the three binding frames from
// 2026-08-27-orcode-v3-interaction-fabric.md Phase F2, pinned verbatim.
// ---------------------------------------------------------------------------

// FIX-15 (command-IA, ratified): the `/budget` row's palette annotation read
// `state.maxCost` — the value `/max-cost` owns, one row below it in the same
// group — so the palette confidently stated the wrong setting. This asserts
// the LIVE wiring, not just the projection: the runtime map the real
// TerminalUi builds from its own DashboardState.
test("FIX-15: the palette annotates /budget with the budget and /max-cost with the run limit", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "/budget");
    const budgetFrame = text(terminal.frame().lines);
    assert.match(budgetFrame, /Day \$2\.000/);
    assert.doesNotMatch(budgetFrame, /\$1\.000/);
    for (let index = 0; index < "budget".length; index += 1) press(stdin, "backspace");
    type(stdin, "max-cost");
    const maxCostFrame = text(terminal.frame().lines);
    assert.match(maxCostFrame, /\$1\.000/);
    assert.doesNotMatch(maxCostFrame, /Day \$2\.000/);
    press(stdin, "escape");
    press(stdin, "return");
    assert.equal(await value, "/max-cost");
  } finally {
    terminal.stop();
  }
});

test("V3 palette state 1 (filter): the title bar carries the bare 'Commands' crumb (D1 ruling 4), and the action bar advertises Tab", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "/model");
    const frame = text(terminal.frame().lines);
    // D1 ruling 4 (superseding this test's old F2-ruling-3 "no crumb line"
    // pin, sanctioned by the D1 brief): the palette's top rule now shows in
    // every state, filtering included, so the block always has a visible
    // top boundary — a search still has no "current location" to show, so
    // the crumb text stays the bare "Commands" form (never a group), just
    // like true root browse; only the group-drilled form differs (state 2,
    // below).
    assert.match(frame, new RegExp(`${theme.glyph("divider")} Commands`));
    // FIX-11 (sanctioned update): the Enter verb is no longer a fixed
    // "run" — it names what Enter does to the SELECTED row. The `/model`
    // search selects `/model`, which takes arguments, so Enter inserts it
    // into the composer instead of running it, and the action bar says so.
    // V4-A (appearance pin changed, verbs unchanged): the footer is now the
    // action bar, built from the same keymap rows.
    assert.match(
      frame,
      new RegExp(
        plainText(actionBarLine(
          theme,
          listActionChips(theme, "Palette", { enter: "insert", esc: "close", tab: "complete" }),
          { leadingDivider: true },
        )).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ),
    );
    // Fix round 1 (the counter ruling): the old `3 of <catalog>` segment is
    // gone for good — `N of M` means the cursor's rank among the rows on
    // offer, and three matches in a four-row budget hide nothing, so there is
    // nothing to disclose. The counter's own invariant is pinned on real
    // browsing and filtering frames further down this file.
    assert.doesNotMatch(frame, new RegExp(`of ${COMMAND_CATALOG.length}`));
    press(stdin, "escape");
    press(stdin, "return");
    assert.equal(await value, "/model");
  } finally {
    terminal.stop();
  }
});

test("V3 palette: the top rule reads the bare '─ Commands' form at the tree root — no drill, no query (D1 ruling 4)", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    terminal.readInput();
    press(stdin, "p", "", { ctrl: true });
    const frame = text(terminal.frame().lines);
    assert.match(frame, new RegExp(`${theme.glyph("divider")} Commands$`, "m"));
    press(stdin, "escape");
  } finally {
    terminal.stop();
  }
});

test("FIX-5 ruling 1: the palette root discloses the groups its row budget hides — scroll glyph plus '<n> of <total>' — and the direction flips at the bottom", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    terminal.readInput();
    press(stdin, "p", "", { ctrl: true });
    const root = text(terminal.frame().lines);
    // Six groups, a four-row budget: before this ruling the last two (Safety,
    // System) were simply not on screen and nothing on the frame said so —
    // the browse footer prints no count (`hideCount`) and the list asks for
    // no inline one (FIX-14 ticket 10: the corner only renders on overflow).
    // V4-A: same two facts, the mockup's word order — the count leads, the
    // disclosure marker trails, and the marker is the disclosure glyph rather
    // than the arrow KEY the action bar prints beside it.
    assert.match(root, new RegExp(`1 of 6 · ${theme.glyph("disclosureDown")}`));
    assert.doesNotMatch(root, new RegExp(`${theme.glyph("disclosureUp")}${theme.glyph("disclosureDown")}`));
    // The rows they name are genuinely reachable, and at the far end the
    // disclosure flips to "there is more above".
    for (let step = 0; step < 5; step += 1) press(stdin, "down");
    const bottom = text(terminal.frame().lines);
    assert.match(bottom, /System/);
    assert.match(bottom, new RegExp(`6 of 6 · ${theme.glyph("disclosureUp")}`));
    press(stdin, "escape");
  } finally {
    terminal.stop();
  }
});

/**
 * Fix round 1 — the controller's ruling on the counter, pinned on real
 * frames: `N` is the CURSOR'S RANK among the `M` rows the list currently
 * holds, in every state. These two tests are the same palette a keystroke
 * apart, and the fraction must not change what it means between them.
 */
test("counter invariant on a real frame, BROWSING: N is the cursor's rank among the M groups on offer", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    terminal.readInput();
    press(stdin, "p", "", { ctrl: true });
    // Six groups on offer, cursor on the first: "row 1 of 6 candidates".
    assert.match(text(terminal.frame().lines), new RegExp(`1 of 6 · ${theme.glyph("disclosureDown")}`));
    press(stdin, "down");
    press(stdin, "down");
    // The cursor moved, so N moved — M did not.
    assert.match(text(terminal.frame().lines), /3 of 6 · /);
    press(stdin, "escape");
  } finally {
    terminal.stop();
  }
});

test("counter invariant on a real frame, FILTERING: N is STILL the cursor's rank — M is the matches, which are now the rows on offer", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const value = terminal.readInput();
    // A query broad enough to overflow the row budget, so the counter draws.
    type(stdin, "/e");
    const matches = searchCommands("e").length;
    const frame = text(terminal.frame().lines);
    // Cursor on the first match: "row 1 of <matches> candidates". NOT
    // "<matches> of <every command there is>" — that second meaning under the
    // same look is exactly what this ruling removed.
    assert.match(frame, new RegExp(`1 of ${matches} · ${theme.glyph("disclosureDown")}`));
    assert.doesNotMatch(frame, new RegExp(`of ${COMMAND_CATALOG.length}`));
    press(stdin, "down");
    press(stdin, "down");
    assert.match(text(terminal.frame().lines), new RegExp(`3 of ${matches} · `));
    press(stdin, "escape");
    press(stdin, "return");
    assert.equal(await value, "/e");
  } finally {
    terminal.stop();
  }
});

test("V3 palette state 2 (group drill): the '─ Commands › …' rule, and a footer with no count and no Tab mention", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "/");
    press(stdin, "return"); // drill into Models (model, fallback, think, compress, cross, panel)
    press(stdin, "down"); press(stdin, "down"); press(stdin, "down"); press(stdin, "down"); // -> cross
    // "cross" carries a handlerId that collapses straight to `/cross` on
    // Enter — Tab is the one key that still drills into it normally
    // (F2 ruling 3: Tab keeps working at every level even where the footer
    // stops advertising it).
    press(stdin, "tab");
    const frame = text(terminal.frame().lines);
    // D1 ruling 4: the old separate crumb line is now the top rule — same
    // "Commands › group" text, with the theme's divider glyph leading it.
    assert.match(frame, new RegExp(`${theme.glyph("divider")} Commands › Models › cross`));
    // FIX-11 (sanctioned update): the drilled level selects `run`
    // (`/cross run [task]`), an argument-taking leaf — Enter fills
    // the composer with it rather than running it, and the footer now says
    // "insert" instead of promising a run it does not perform. FIX-5
    // ruling 4 holds for the esc verb: Esc pops exactly one browsed level
    // (`#handleCommandMenuKey`: `path.slice(0, -1)`), so the bare "back"
    // is what the key actually does — not "back to all commands".
    assert.match(
      frame,
      new RegExp(
        plainText(actionBarLine(
          theme,
          listActionChips(theme, "Palette", { enter: "insert", esc: "back" }),
          { leadingDivider: true },
        )).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ),
    );
    assert.doesNotMatch(frame, /back to all commands/);
    assert.doesNotMatch(frame, /Tab complete/);
    press(stdin, "escape"); press(stdin, "escape"); press(stdin, "escape");
    press(stdin, "return");
    assert.equal(await value, "/");
  } finally {
    terminal.stop();
  }
});

test("V3 palette state 3 (no match): the recovery line replaces rows and footer entirely, query quoted verbatim", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "/xzy");
    const frame = text(terminal.frame().lines);
    // FIX-5 ruling 3 (appearance pin updated, behavior untouched): the line
    // used to say "Esc clears" — the one key on it that clears nothing. Tab
    // and Enter drop the failed query and reopen the root tree; Esc closes
    // the menu and leaves the typed text in the composer (pinned verbatim
    // just below, unchanged). The copy now names both truthfully.
    assert.match(
      frame,
      new RegExp(
        plainText(
          buildListEmptyLine(
            theme,
            `No command matches "/xzy" ${theme.glyph("emdash")} Enter clears`
              + `${theme.glyph("separator")}Esc closes`
              + `${theme.glyph("separator")}/help lists everything`,
          ),
        ).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ),
    );
    // The recovery row's own key handling is untouched by the reskin: Esc
    // just closes the menu (root-level path) without rewriting the
    // composer — the failed query stays exactly as typed — and the
    // following Enter submits it verbatim.
    press(stdin, "escape");
    press(stdin, "return");
    assert.equal(await value, "/xzy");
  } finally {
    terminal.stop();
  }
});

test("V3 palette: Ctrl+P renders the identical V3 footer and crumb as inline slash completion (ruling 6)", async () => {
  const slashIn = new FakeInput();
  const slashOut = new FakeOutput();
  const slash = ui(slashIn, slashOut);
  const paletteIn = new FakeInput();
  const paletteOut = new FakeOutput();
  const palette = ui(paletteIn, paletteOut);
  slash.start();
  palette.start();
  try {
    slash.readInput();
    palette.readInput();
    type(slashIn, "/model");
    press(paletteIn, "p", "\u0010", { ctrl: true });
    type(paletteIn, "model");
    const slashFrame = text(slash.frame().lines);
    const paletteFrame = text(palette.frame().lines);
    // FIX-11 (sanctioned update): both surfaces select the same
    // argument-taking `/model` leaf, so both footers read "Enter insert".
    // The point of this test — that the two paths render the IDENTICAL
    // footer — is what it still proves.
    const footer = plainText(
      actionBarLine(
        theme,
        listActionChips(theme, "Palette", { enter: "insert", esc: "close", tab: "complete" }),
        { leadingDivider: true },
      ),
    );
    assert.ok(slashFrame.includes(footer), slashFrame);
    assert.ok(paletteFrame.includes(footer), paletteFrame);
  } finally {
    slash.stop();
    palette.stop();
  }
});

// eslint-disable-next-line no-control-regex
const isPureAscii = (value: string): boolean => /^[\x20-\x7e]*$/.test(value);

test("V3 palette: ASCII mode renders the empty-state cross with only ASCII glyphs", async () => {
  const asciiTheme = createTheme({ level: 0, ascii: true });
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = new TerminalUi(
    () => state,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
    asciiTheme,
  );
  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "/xzy");
    const noMatchLine = plainText(
      terminal.frame().lines.find((line) => plainText(line).includes("No command matches"))!,
    );
    // FIX-5 ruling 3: same honest wording as the unicode pin above, still
    // pure ASCII (the em dash and the separator both asciify).
    assert.match(
      noMatchLine,
      /x No command matches "\/xzy" - Enter clears - Esc closes - \/help lists everything/,
    );
    assert.equal(isPureAscii(noMatchLine), true, noMatchLine);
    press(stdin, "escape");
    press(stdin, "return");
    assert.equal(await value, "/xzy");
  } finally {
    terminal.stop();
  }
});

test("V3 palette: ASCII mode renders the filter action bar's divider and chips with only ASCII glyphs", async () => {
  const asciiTheme = createTheme({ level: 0, ascii: true });
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = new TerminalUi(
    () => state,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
    asciiTheme,
  );
  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "/model");
    const footerLine = plainText(
      terminal.frame().lines.find((line) => plainText(line).includes("select"))!,
    );
    // V4-A (appearance pin changed, ASCII contract unchanged): the footer is
    // the action bar now, so the line carries the chips and the leading rule,
    // and the count moved onto the rows' own universal counter (asserted
    // separately below). FIX-11's `Enter insert` — `/model` takes arguments,
    // so Enter fills the composer — is what the chip still says.
    assert.match(
      footerLine,
      /- \[\^v\] select {2}\[Enter\] insert {2}\[Tab\] complete {2}\[Esc\] close/,
    );
    assert.equal(isPureAscii(footerLine), true, footerLine);
    press(stdin, "escape");
    press(stdin, "return");
    assert.equal(await value, "/model");
  } finally {
    terminal.stop();
  }
});

test("V3 palette: ASCII mode renders the top rule's crumb (root and drilled) with only ASCII glyphs (D1 ruling 2/4)", async () => {
  const asciiTheme = createTheme({ level: 0, ascii: true });
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = new TerminalUi(
    () => state,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
    asciiTheme,
  );
  terminal.start();
  try {
    terminal.readInput();
    press(stdin, "p", "", { ctrl: true });
    const rootRule = plainText(
      terminal.frame().lines.find((line) => plainText(line).includes("Commands"))!,
    );
    assert.equal(rootRule, "- Commands");
    assert.equal(isPureAscii(rootRule), true, rootRule);
    press(stdin, "return"); // drill into Model
    const drilledRule = plainText(
      terminal.frame().lines.find((line) => plainText(line).includes("Commands"))!,
    );
    assert.equal(drilledRule, "- Commands > Models");
    assert.equal(isPureAscii(drilledRule), true, drilledRule);
    press(stdin, "escape"); press(stdin, "escape");
  } finally {
    terminal.stop();
  }
});

// ---------------------------------------------------------------------------
// V4-A zone anatomy (consistency check), superseding D1 ruling 6's
// selection-bar wiring proof. `buildListLines` is still the one mechanism —
// what it renders changed: `inverse` now belongs to the title bar alone, ONE
// line per screen, and the selection is level 2 (accent + bold) behind the
// `❯` marker. Proving it end to end on the two real fullscreen picker call
// sites stands in for every other surface built on the same primitive.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fix round 1, review MAJOR 1: click-to-pick on a REAL zoned picker.
//
// The regression these pins exist for was invisible to the whole suite because
// the only SGR mouse test used a 2-item list — small enough that the window
// filled the budget whether or not the title bar had eaten a row. A list
// LONGER than the row budget is what exposes the off-by-one, so every case
// below uses nine items, at both of the two row budgets the frame has
// (`height >= 20 ? 6 : 4`, minus the picker's own chrome), and one of them
// uses ids that are substrings of each other — the shape that turns a silent
// no-op into a wrong-model resolve.
// ---------------------------------------------------------------------------

/** Clicks physical row `row` (1-based) with real SGR bytes, as a terminal would. */
function clickRow(stdin: FakeInput, row: number): void {
  stdin.emit("data", Buffer.from(`\u001b[<0;1;${row}M`));
}

/** The rows the frame says it rendered, as `{ line, label }` pairs. */
function renderedPickerRows(terminal: TerminalUi): { line: number; label: string }[] {
  const frame = terminal.frame();
  const geometry = frame.listRows;
  assert.ok(geometry, "the frame must report where it put the list's rows");
  return Array.from({ length: geometry!.count }, (_, offset) => ({
    line: geometry!.firstLine + offset,
    // The row is `<2-cell marker><name padded><2 spaces><description…>`, so
    // the name column is everything up to the first run of two spaces.
    label: plainText(frame.lines[geometry!.firstLine + offset]!).slice(2).split(/ {2,}/)[0]!,
  }));
}

for (const rows of [28, 16]) {
  test(`fix round 1: every rendered row of a 9-item model picker is clickable at ${rows} rows`, async () => {
    const stdin = new FakeInput();
    const stdout = new FakeOutput();
    stdout.rows = rows;
    const models = Array.from({ length: 9 }, (_, index) => modelInfo(`vendor/item-${index}`));
    for (const target of [0, 1, 2]) {
      const terminal = ui(stdin, stdout);
      terminal.start();
      try {
        terminal.readInput();
        const picker = terminal.pickModel(() => models, "vendor/item-0", "Models");
        const visible = renderedPickerRows(terminal);
        assert.ok(visible.length >= 3, `a ${rows}-row frame must render at least 3 picker rows`);
        // Physical row = reported line index + 1 (the frame is 0-based).
        clickRow(stdin, visible[target]!.line + 1);
        const picked = await picker;
        assert.equal(
          picked?.id,
          visible[target]!.label,
          `clicking the row that reads ${JSON.stringify(visible[target]!.label)} must resolve that model`,
        );
      } finally {
        terminal.stop();
      }
    }
  });
}

test("fix round 1: substring model ids never resolve the wrong row (glm-4 vs glm-4-air)", async () => {
  // The ids are deliberately prefixes of one another. Before the fix an
  // off-by-one window handed the click `glm-4` while the clicked line read
  // `glm-4-air`, and the old `includes` guard let that pass — a paid,
  // wrong-model switch with no visible sign anything went wrong.
  const ids = [
    "z-ai/glm-4",
    "z-ai/glm-4-air",
    "z-ai/glm-4-air-free",
    "z-ai/glm-4-plus",
    "z-ai/glm-4-plus-max",
    "z-ai/glm-4v",
    "z-ai/glm-5",
    "z-ai/glm-5-flash",
    "z-ai/glm-5-flash-lite",
  ];
  const models = ids.map((id) => modelInfo(id));
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  for (let target = 0; target < 3; target += 1) {
    const terminal = ui(stdin, stdout);
    terminal.start();
    try {
      terminal.readInput();
      const picker = terminal.pickModel(() => models, ids[0]!, "Models");
      const visible = renderedPickerRows(terminal);
      clickRow(stdin, visible[target]!.line + 1);
      const picked = await picker;
      assert.equal(picked?.id, visible[target]!.label);
    } finally {
      terminal.stop();
    }
  }
});

test("fix round 1: a click outside the reported rows resolves nothing — the title bar and the action bar are not rows", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    terminal.readInput();
    const models = Array.from({ length: 9 }, (_, index) => modelInfo(`vendor/item-${index}`));
    const picker = terminal.pickModel(() => models, "vendor/item-0", "Models");
    const geometry = terminal.frame().listRows!;
    // The title bar sits directly above the first row; the line after the last
    // is the divider. Neither may resolve anything.
    clickRow(stdin, geometry.firstLine); // the row above the first (1-based off-by-one)
    clickRow(stdin, geometry.firstLine + geometry.count + 1);
    let settled = false;
    void picker.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "a click off the rows must not resolve the picker");
    press(stdin, "escape");
    assert.equal(await picker, null);
  } finally {
    terminal.stop();
  }
});

test("fix round 1: a /chats section heading refuses a click, exactly as Enter already does", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    terminal.readInput();
    const picker = terminal.pickChoice("Chats", [
      { value: "", label: "Current folder", description: "", sectionHeading: true },
      { value: "local", label: "Local chat", description: "" },
      { value: "", label: "Other folders", description: "", sectionHeading: true },
      { value: "foreign", label: "Foreign chat", description: "" },
    ], "");
    const visible = renderedPickerRows(terminal);
    const heading = visible.find((entry) => entry.label.startsWith("Current folder"))
      ?? visible.find((entry) => entry.label.startsWith("Other folders"));
    assert.ok(heading, `a heading row must be on screen: ${JSON.stringify(visible)}`);
    clickRow(stdin, heading!.line + 1);
    let settled = false;
    void picker.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "clicking a section heading must resolve nothing");
    press(stdin, "escape");
    assert.equal(await picker, null);
  } finally {
    terminal.stop();
  }
});

test("V4-A: the fullscreen model picker paints ONE inverse line — its title bar — and marks the selection at level 2", async () => {
  const colored = createTheme({ level: 3 });
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = new TerminalUi(
    () => state,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
    colored,
  );
  terminal.start();
  try {
    terminal.readInput();
    const picker = terminal.pickModel(() => [modelInfo("vendor/a"), modelInfo("vendor/b")], "vendor/a", "Models");
    const lines = terminal.frame().lines;
    const inverseLines = lines.filter((line) => line.spans.some((part) => part.role === "inverse"));
    assert.equal(inverseLines.length, 1, "exactly one loud line per screen");
    assert.match(plainText(inverseLines[0]!), /^ Models {2}/, "and it is the title bar");
    const activeLine = lines.find((line) =>
      line.spans.some((part) => part.role === "accent" && part.text.includes("vendor/a")));
    assert.ok(activeLine, "expected the selected model row at level 2");
    assert.equal(activeLine!.spans[0]!.bold, true);
    assert.equal(activeLine!.spans.some((part) => part.role === "inverse"), false);
    press(stdin, "escape");
    await picker;
  } finally {
    terminal.stop();
  }
});

test("V4-A: the fullscreen choice picker paints ONE inverse line — its title bar — and marks the selection at level 2", async () => {
  const colored = createTheme({ level: 3 });
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = new TerminalUi(
    () => state,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
    colored,
  );
  terminal.start();
  try {
    terminal.readInput();
    const picker = terminal.pickChoice("Provider", [
      { value: "openrouter", label: "OpenRouter", description: "Ready" },
      { value: "kimi", label: "Kimi Code", description: "Ready" },
    ], "openrouter");
    const lines = terminal.frame().lines;
    const inverseLines = lines.filter((line) => line.spans.some((part) => part.role === "inverse"));
    assert.equal(inverseLines.length, 1, "exactly one loud line per screen");
    assert.match(plainText(inverseLines[0]!), /^ Provider {2}/, "and it is the title bar");
    const activeLine = lines.find((line) =>
      line.spans.some((part) => part.role === "accent" && part.text.includes("OpenRouter")));
    assert.ok(activeLine, "expected the selected provider row at level 2");
    assert.equal(activeLine!.spans[0]!.bold, true);
    assert.equal(activeLine!.spans.some((part) => part.role === "inverse"), false);
    press(stdin, "escape");
    await picker;
  } finally {
    terminal.stop();
  }
});

test("dashboard renders one bounded Cross collaboration block at compact and regular sizes", () => {
  const crossState: DashboardState = {
    ...state,
    cross: {
      sequence: 7,
      updatedAt: NOW,
      phase: "review",
      reason: null,
      verification: "passed",
      lead: "OpenRouter · lead-model",
      challenger: "Kimi Code · challenger-model",
      result: "Prüfung läuft",
    },
  };

  for (const [width, height] of [[40, 8], [80, 24]] as const) {
    const frame = buildDashboardFrame({
      width,
      height,
      theme,
      state: crossState,
      blocks: [],
      mode: "idle",
      input: "",
      cursor: 0,
      status: "Ready",
      now: NOW,
    });
    const rendered = text(frame.lines);
    assert.match(rendered, /Cross/);
    assert.match(rendered, /Coding/);
    assert.match(rendered, /Review/);
    assert.doesNotMatch(rendered, /Lead|Challenger/);
    assert.ok(frame.lines.length <= height, `${width}x${height} exceeded its frame`);
  }
});

test("D2: the Cross panel never shows phase and result as twin orphans (owner-flagged 'Cross · Blocked · Blocked')", () => {
  // A concluded run: the live coordinator phase has already settled onto
  // the same terminal label `dashboardState()` recorded as `result` — this
  // is exactly the shape that used to render "Cross · Blocked · Blocked".
  const concluded: DashboardState = {
    ...state,
    cross: {
      sequence: 4,
      updatedAt: NOW,
      phase: "Blocked",
      reason: "Task or context invalid",
      verification: "not run",
      lead: "OpenRouter · lead-model",
      challenger: "Kimi Code · challenger-model",
      result: "Blocked",
    },
  };
  const rendered = text(buildDashboardFrame({
    width: 80,
    height: 24,
    theme,
    state: concluded,
    blocks: [],
    mode: "idle",
    input: "",
    cursor: 0,
    status: "Ready",
    now: NOW,
  }).lines);
  assert.doesNotMatch(rendered, /Blocked.*Blocked/, "phase and an identical result must never both show as separate labels");
  assert.match(rendered, /Cross.*Blocked/);

  // Idle after a prior run: phase and result legitimately differ — both
  // must still show, nothing here should lose information.
  const idleAfterBlocked: DashboardState = {
    ...state,
    cross: { ...concluded.cross!, phase: "Ready", result: "Blocked" },
  };
  const renderedIdle = text(buildDashboardFrame({
    width: 80,
    height: 24,
    theme,
    state: idleAfterBlocked,
    blocks: [],
    mode: "idle",
    input: "",
    cursor: 0,
    status: "Ready",
    now: NOW,
  }).lines);
  assert.match(renderedIdle, /Cross.*Ready.*Blocked/, "distinct phase and result both survive");
});

test("active Cross with no chat blocks uses conversation chrome, compact mark, and no large start logo", () => {
  for (const [width, height] of [[40, 8], [80, 24], [100, 28]] as const) {
    const frame = buildDashboardFrame(input({
      width,
      height,
      blocks: [],
      state: {
        ...state,
        cross: {
          sequence: 3,
          updatedAt: NOW,
          phase: "Analysis",
          reason: null,
          verification: "Not run",
          lead: "OpenRouter · lead",
          challenger: "Kimi Code · challenger",
        },
      },
      brand: {
        showLargeLogo: true,
        showHeaderMark: true,
        largeLines: routeCoreLarge("ascii"),
        compactMark: routeCoreCompact("ascii"),
        version: "9.9.9",
      },
    }));
    const rendered = text(frame.lines);
    assert.doesNotMatch(rendered, /---------\*/);
    assert.match(rendered, />-\*/);
    assert.match(rendered, /Cross.*Analysis/);
    assert.equal(frame.lines.length <= height, true);
  }
});

test("Esc closes the command list and keeps the typed text", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "/");
    press(stdin, "return");
    assert.match(stdout.output, /main model/i);
    press(stdin, "escape");
    assert.match(stdout.output, /Model/);
    press(stdin, "escape");
    const afterEscape = stdout.output.length;
    terminal.refresh();
    assert.doesNotMatch(stdout.output.slice(afterEscape), /Esc Liste schließen/);

    press(stdin, "return");
    assert.equal(await value, "/");
  } finally {
    terminal.stop();
  }
});

test("editing away from and back to slash reopens a dismissed command menu", async () => {
  const stdin = new FakeInput(); const stdout = new FakeOutput(); const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "/"); press(stdin, "escape"); press(stdin, "backspace"); type(stdin, "/");
    assert.match(text(terminal.frame().lines), /Model/);
    press(stdin, "escape"); press(stdin, "escape"); press(stdin, "return");
    assert.equal(await value, "/");
  } finally { terminal.stop(); }
});

test("disabled command-menu leaves reject Tab and Enter without changing the draft", async () => {
  const stdin = new FakeInput(); const stdout = new FakeOutput();
  const terminal = new TerminalUi(() => state, stdin as unknown as ReadStream, stdout as unknown as WriteStream, theme, {
    commandMenuRuntime: () => new Map([["model", { disabledReason: "Offline" }]]),
  });
  terminal.start();
  try {
    const value = terminal.readInput(); type(stdin, "bleibt"); press(stdin, "p", "\u0010", { ctrl: true });
    press(stdin, "return"); press(stdin, "tab"); press(stdin, "return");
    assert.match(text(terminal.frame().lines), /Command is not available right now/);
    press(stdin, "escape"); press(stdin, "escape"); press(stdin, "return");
    assert.equal(await value, "bleibt");
  } finally { terminal.stop(); }
});

test("command list uses arrows and Tab without recalling chat history", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const value = terminal.readInput();
    press(stdin, "/", "/");
    press(stdin, "return");
    // Models: model, fallback, think — two rows down since FIX-15 moved
    // /fallback in beside /model.
    press(stdin, "down");
    press(stdin, "down");
    press(stdin, "tab");
    type(stdin, "high");
    press(stdin, "return");
    assert.equal(await value, "/think high");
  } finally {
    terminal.stop();
  }
});

test("Enter completion keeps dismissal while typing a /think argument", async () => {
  const stdin = new FakeInput(); const stdout = new FakeOutput(); const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const value = terminal.readInput(); type(stdin, "/"); press(stdin, "return"); press(stdin, "down"); press(stdin, "down"); press(stdin, "return");
    type(stdin, " high"); press(stdin, "return");
    assert.equal(await value, "/think high");
  } finally { terminal.stop(); }
});

test("@ opens fuzzy file completion and Tab inserts the relative path", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "routercode-at-"));
  writeFileSync(join(workspace, "compressor.ts"), "// stub");
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const localState: DashboardState = { ...state, workspace };
  const terminal = new TerminalUi(
    () => localState,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
    theme,
  );

  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "sieh dir @compr");
    terminal.refresh();
    assert.match(stdout.output, /compressor\.ts/);
    press(stdin, "tab");
    type(stdin, "an");
    press(stdin, "return");
    assert.equal(await value, "sieh dir compressor.ts an");
  } finally {
    terminal.stop();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Ctrl+R searches the own history; Tab inserts, Esc leaves the buffer alone", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const first = terminal.readInput();
    type(stdin, "npm test ausführen");
    press(stdin, "return");
    assert.equal(await first, "npm test ausführen");

    const second = terminal.readInput();
    press(stdin, "r", "r", { ctrl: true });
    type(stdin, "npm");
    terminal.refresh();
    assert.match(stdout.output, /npm test ausführen/);
    press(stdin, "tab");
    press(stdin, "return");
    assert.equal(await second, "npm test ausführen");
  } finally {
    terminal.stop();
  }
});

test("compress list selects the interactive model subcommand", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "/");
    press(stdin, "return");
    assert.match(stdout.output, /\/compress/);
    // Models: model, fallback, think, compress (FIX-15 ordering).
    press(stdin, "down");
    press(stdin, "down");
    press(stdin, "down");
    press(stdin, "tab");
    press(stdin, "return");
    assert.equal(await value, "/compress");
  } finally {
    terminal.stop();
  }
});

test("Tab keeps the primary /allow command instead of rewriting it", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "/");
    press(stdin, "down");
    press(stdin, "down");
    press(stdin, "down");
    press(stdin, "down");
    press(stdin, "return");
    press(stdin, "tab");
    press(stdin, "return");
    assert.equal(await value, "/allow");
  } finally {
    terminal.stop();
  }
});

test("generic choice picker filters and returns the selected option", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const selection = terminal.pickChoice(
      "Thinking",
      [
        { value: "auto", label: "Automatisch", description: "Modellvorgabe" },
        { value: "high", label: "High", description: "Mehr Reasoning" },
      ],
      "auto",
    );
    press(stdin, "h", "h");
    press(stdin, "return");
    assert.equal((await selection)?.value, "high");
    assert.match(stdout.output, /Mehr Reasoning/);
  } finally {
    terminal.stop();
  }
});

test("arrow keys submit a selected quick reply, typing overrides it", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    terminal.setSuggestedReplies(["Zeig mir den Diff", "Tests erneut ausführen"]);
    const first = terminal.readInput();
    press(stdin, "down");
    press(stdin, "return");
    assert.equal(await first, "Tests erneut ausführen");
    assert.match(stdout.output, /Zeig mir den Diff/);

    terminal.setSuggestedReplies(["Zeig mir den Diff"]);
    const second = terminal.readInput();
    type(stdin, "Mein eigener Kommentar");
    press(stdin, "return");
    assert.equal(await second, "Mein eigener Kommentar");
  } finally {
    terminal.stop();
  }
});

test("the hub always offers New chat, All chats, Folder and Settings, in that order (D8, superseding Continue)", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const rendered = text(terminal.frame().lines);
    const order = ["New chat", "All chats", "Folder", "Settings"].map((label) => rendered.indexOf(label));
    assert.ok(order.every((index) => index >= 0), `every quick action must render: ${rendered}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, "the four entries must appear in this order");
    // The single "Continue" quick action D8 superseded is gone entirely —
    // its job is now the "Recent" section below (dashboard-frame.ts owns
    // that rendering; this suite only proves the fixed row here).
    assert.doesNotMatch(rendered, /\bContinue\b/);
  } finally {
    terminal.stop();
  }
});

test("with recent chats, the hub lists them before the fixed quick actions, most-recent first", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const recentChatState: DashboardState = {
    ...state,
    recentChats: [
      {
        id: "chat-2",
        title: "Terminal look redesign",
        turnCount: 3,
        costUsd: 1.234,
        updatedAt: Date.now() - 2 * 60 * 60_000,
        workspace: state.workspace,
      },
      {
        id: "chat-3",
        title: "Older chat",
        turnCount: 1,
        costUsd: 0.01,
        updatedAt: Date.now() - 26 * 60 * 60_000,
        workspace: state.workspace,
      },
    ],
  };
  const terminal = new TerminalUi(
    () => recentChatState,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
    theme,
  );
  terminal.start();
  try {
    const rendered = text(terminal.frame().lines);
    const order = ["Terminal look redesign", "Older chat", "New chat", "All chats", "Folder", "Settings"]
      .map((label) => rendered.indexOf(label));
    assert.ok(order.every((index) => index >= 0), `every row must render: ${rendered}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, "Recent rows lead, then the fixed actions, in this order");
  } finally {
    terminal.stop();
  }
});

test("a Recent row's hint is formatChatRow verbatim — the same wording /chats renders for the same chat", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();

  const zeroCostState: DashboardState = {
    ...state,
    recentChats: [{
      id: "chat-2",
      title: "Kimi session",
      turnCount: 5,
      costUsd: 0,
      costKnowledge: "unknown",
      updatedAt: Date.now() - 60_000,
      workspace: state.workspace,
    }],
  };
  const zeroCostTerminal = new TerminalUi(
    () => zeroCostState,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
    theme,
  );
  zeroCostTerminal.start();
  try {
    const rendered = text(zeroCostTerminal.frame().lines);
    assert.match(
      rendered,
      /Kimi session\s+5 messages · provider-managed \/ unknown · 1m ago/,
    );
  } finally {
    zeroCostTerminal.stop();
  }

  // A partially-known cost keeps formatChatCost's "at least $X" floor —
  // dropping it (as a hand-rolled reimplementation once did) would have
  // silently hidden known spend behind a bare "provider-managed".
  const partialCostState: DashboardState = {
    ...state,
    recentChats: [{
      id: "chat-3",
      title: "Kimi session",
      turnCount: 5,
      costUsd: 0.5,
      costKnowledge: "unknown",
      updatedAt: Date.now() - 60_000,
      workspace: state.workspace,
    }],
  };
  const partialCostTerminal = new TerminalUi(
    () => partialCostState,
    new FakeInput() as unknown as ReadStream,
    new FakeOutput() as unknown as WriteStream,
    theme,
  );
  partialCostTerminal.start();
  try {
    const rendered = text(partialCostTerminal.frame().lines);
    assert.match(
      rendered,
      /Kimi session\s+5 messages · at least \$0\.500 · further provider-managed costs unknown · 1m ago/,
    );
  } finally {
    partialCostTerminal.stop();
  }
});

test("V3 interaction ruling: ↓ moves a visible selection into the combined Recent/quick-action list; ↑/↓ navigate it", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const recentChatState: DashboardState = {
    ...state,
    recentChats: [{
      id: "chat-2",
      title: "Terminal look redesign",
      turnCount: 3,
      costUsd: 1.234,
      updatedAt: Date.now() - 2 * 60 * 60_000,
      workspace: state.workspace,
    }],
  };
  const terminal = new TerminalUi(
    () => recentChatState,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
    theme,
  );
  terminal.start();
  try {
    const value = terminal.readInput();
    let settled = false;
    // The eventual Ctrl+C cleanup below rejects `value` — a second handler
    // here keeps that rejection from becoming unhandled independently of
    // the `.catch()` awaited at the end of the test.
    void value.then(() => { settled = true; }, () => {});

    const markerLine = (rendered: string, label: string): string | undefined =>
      rendered.split("\n").find((line) => line.includes(label));

    assert.doesNotMatch(text(terminal.frame().lines), /^❯ Terminal look redesign\b/m);

    press(stdin, "down");
    let rendered = text(terminal.frame().lines);
    assert.match(markerLine(rendered, "Terminal look redesign")!, /^❯ Terminal look redesign\b/);

    press(stdin, "down");
    rendered = text(terminal.frame().lines);
    assert.match(markerLine(rendered, "New chat")!, /^❯ New chat\b/);
    assert.doesNotMatch(markerLine(rendered, "Terminal look redesign")!, /^❯ Terminal look redesign\b/);

    press(stdin, "up");
    rendered = text(terminal.frame().lines);
    assert.match(markerLine(rendered, "Terminal look redesign")!, /^❯ Terminal look redesign\b/);

    press(stdin, "escape");
    rendered = text(terminal.frame().lines);
    assert.doesNotMatch(rendered, /^❯ /m);
    await Promise.resolve();
    assert.equal(settled, false, "Esc must return focus, not submit anything");

    // Two presses: the idle prompt follows the two-press quit convention.
    press(stdin, "c", "", { ctrl: true });
    press(stdin, "c", "", { ctrl: true });
    await value.catch(() => {});
  } finally {
    terminal.stop();
  }
});

test("V3 interaction ruling: Enter runs the selected fixed quick action exactly as typing it would", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const value = terminal.readInput();
    press(stdin, "down"); // New chat (no recentChats, so this is the first row)
    press(stdin, "return");
    assert.equal(await value, "/new");
    assert.equal(terminal.consumeQuickActionChat(), undefined);
  } finally {
    terminal.stop();
  }
});

test("FIX-8: Enter on the hub's Folder row submits a bare /folder — the flow that now asks for a path", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const value = terminal.readInput();
    // No recentChats, so the four fixed actions are the whole list:
    // New chat, All chats, Folder, Settings.
    press(stdin, "down");
    press(stdin, "down");
    press(stdin, "down");
    press(stdin, "return");
    // Pre-FIX-8 this exact string threw `Usage: /folder open <path> | …`;
    // the command itself is unchanged here, its handling is (commands.ts).
    assert.equal(await value, "/folder");
    assert.equal(terminal.consumeQuickActionChat(), undefined);
  } finally {
    terminal.stop();
  }
});

test("FIX-8: readPath opens the existing validated-input mode on the chat surface — Enter applies the trimmed value", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const answer = terminal.readPath({
      label: "Folder",
      description: "Now: ~/projects/robopet · type a path (~ works).",
    });
    const rendered = text(terminal.frame().lines);
    assert.match(rendered, /Folder/, `the prompt label must render: ${rendered}`);
    assert.match(rendered, /type a path \(~ works\)/, "the description must render");
    // The same footer every other validated-input already shows.
    assert.match(rendered, /Enter apply/);
    assert.match(rendered, /Esc cancel/);

    type(stdin, "  ~/projects/other  ");
    press(stdin, "return");
    assert.equal(await answer, "~/projects/other", "the shared validator trims; ~ is expanded by /folder itself");
  } finally {
    terminal.stop();
  }
});

test("FIX-8: Esc at a readPath prompt resolves null, and the chat surface comes back", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const answer = terminal.readPath({ label: "Folder", description: "Now: ~/projects/robopet" });
    type(stdin, "/tmp/never-used");
    press(stdin, "escape");
    assert.equal(await answer, null, "Esc must cancel honestly, never hand back a half-typed path");

    // The composer is usable again straight afterwards.
    const value = terminal.readInput();
    type(stdin, "hi");
    press(stdin, "return");
    assert.equal(await value, "hi");
  } finally {
    terminal.stop();
  }
});

test("V3 interaction ruling: Enter on a selected Recent row arms the one-shot chat-pick signal — the /chats preset-pick path", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const recentChatState: DashboardState = {
    ...state,
    recentChats: [{
      id: "chat-2",
      title: "Terminal look redesign",
      turnCount: 3,
      costUsd: 1.234,
      updatedAt: Date.now() - 2 * 60 * 60_000,
      workspace: state.workspace,
    }],
  };
  const terminal = new TerminalUi(
    () => recentChatState,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
    theme,
  );
  terminal.start();
  try {
    const value = terminal.readInput();
    press(stdin, "down"); // Terminal look redesign
    press(stdin, "return");
    assert.equal(await value, "");
    assert.equal(
      terminal.consumeQuickActionChat(),
      "chat-2",
      "Enter on a Recent row must arm the signal with that row's chat id",
    );
    assert.equal(terminal.consumeQuickActionChat(), undefined, "consuming it must clear it (one-shot)");
  } finally {
    terminal.stop();
  }
});

test("V3 interaction ruling: a bare Enter on the empty composer with no selection is a no-op", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const recentChatState: DashboardState = {
    ...state,
    recentChats: [{
      id: "chat-2",
      title: "Terminal look redesign",
      turnCount: 3,
      costUsd: 1.234,
      updatedAt: Date.now() - 2 * 60 * 60_000,
      workspace: state.workspace,
    }],
  };
  const terminal = new TerminalUi(
    () => recentChatState,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
    theme,
  );
  terminal.start();
  try {
    // A bare Enter on the empty composer still resolves `readInput()` with
    // "" exactly as any empty submit always has — the "no-op" is that the
    // dashboard loop's Recent-row pick does not fire, guaranteed by the
    // one-shot signal below staying unarmed.
    const value = terminal.readInput();
    press(stdin, "return");
    assert.equal(await value, "");
    assert.equal(terminal.consumeQuickActionChat(), undefined, "the old Enter-continues shortcut must be gone");
  } finally {
    terminal.stop();
  }
});

test("V3 interaction ruling: typing a character returns focus to the composer and still types", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const value = terminal.readInput();
    press(stdin, "down");
    assert.match(text(terminal.frame().lines), /^❯ New chat\b/m);

    type(stdin, "x");
    assert.doesNotMatch(text(terminal.frame().lines), /^❯ /m);

    press(stdin, "return");
    assert.equal(await value, "x");
  } finally {
    terminal.stop();
  }
});

// FIX-17 (fresh-launch audit) — the hub affordance that replaced the
// unsolicited launch modal: while provider setup is needed, "Set up a
// provider" LEADS the fixed quick actions; on a fresh home (no Recent rows)
// it is the first selectable row, and Enter runs the real /provider setup
// command exactly as typing it would. It retires with the flag.
test("FIX-17: the setup affordance leads the quick actions while setup is needed, and Enter runs /provider setup", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const setupState: DashboardState = { ...state, providerSetupNeeded: true };
  const terminal = new TerminalUi(
    () => setupState,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
    theme,
  );
  terminal.start();
  try {
    const rendered = text(terminal.frame().lines);
    const order = ["Set up a provider", "New chat", "All chats", "Folder", "Settings"]
      .map((label) => rendered.indexOf(label));
    assert.ok(order.every((index) => index >= 0), `the affordance and every fixed action must render: ${rendered}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, "the setup affordance must LEAD the fixed actions");
    assert.match(rendered, /Set up a provider\s+Connects OpenRouter or Kimi/);

    const value = terminal.readInput();
    press(stdin, "down"); // fresh home: no Recent rows, so ↓ lands on the affordance
    assert.match(
      text(terminal.frame().lines).split("\n").find((line) => line.includes("Set up a provider"))!,
      /^❯ Set up a provider\b/,
    );
    press(stdin, "return");
    assert.equal(await value, "/provider setup");
    assert.equal(terminal.consumeQuickActionChat(), undefined);
  } finally {
    terminal.stop();
  }
});

test("FIX-17: without providerSetupNeeded the affordance row is absent (it retires once a route resolves)", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    assert.doesNotMatch(text(terminal.frame().lines), /Set up a provider/);
  } finally {
    terminal.stop();
  }
});

// FIX-17 finding 1 (the measured launch bug): after a cancelled provider
// setup the transcript holds ONLY notice blocks — the exact sequence
// createTuiSetupSurface emits on Esc (coming-soon disclosures plus "Setup
// cancelled"). The hub and its quick-action selection must stay alive on
// such a transcript; pre-FIX-17 the `blocks.length === 0` conditions killed
// both for the whole session.
test("FIX-17: the setup-cancel notice sequence keeps the hub and quick actions alive (end to end)", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const setupState: DashboardState = { ...state, providerSetupNeeded: true };
  const terminal = new TerminalUi(
    () => setupState,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
    theme,
  );
  terminal.start();
  try {
    // The real TUI surface, fed the same presentations the setup hub sends
    // while opening and while being cancelled — not hand-built blocks.
    const surface = createTuiSetupSurface(terminal as unknown as TuiSetupPromptUi);
    surface.present({
      version: 1,
      type: "provider-state",
      entries: [
        { id: "anthropic", label: "Anthropic", description: "Coming soon", disabled: true, current: false, generation: 1 },
        { id: "other", label: "Other", description: "Coming soon", disabled: true, current: false, generation: 1 },
      ],
    });
    surface.present({ version: 1, type: "notice", message: "Setup cancelled. No account was connected." });

    const rendered = text(terminal.frame().lines);
    // The notices themselves stay visible (honesty) …
    assert.match(rendered, /Setup cancelled\. No account was connected\./);
    // … and the hub still renders around them: identity row, Recent
    // section, the setup affordance and the fixed actions.
    assert.match(rendered, /ORCODE/);
    assert.match(rendered, /Recent/);
    for (const label of ["Set up a provider", "New chat", "All chats", "Folder", "Settings"]) {
      assert.ok(rendered.includes(label), `hub row "${label}" must survive the cancel notices: ${rendered}`);
    }

    // The quick-action selection is alive too: ↓ arms, navigation works,
    // Enter runs the selected action — the measured bug was ↓ doing
    // nothing and New chat/Resume being dead after Esc.
    const value = terminal.readInput();
    press(stdin, "down");
    assert.match(text(terminal.frame().lines), /^❯ Set up a provider\b/m);
    press(stdin, "down");
    press(stdin, "return");
    assert.equal(await value, "/new");
    assert.equal(terminal.consumeQuickActionChat(), undefined);
  } finally {
    terminal.stop();
  }
});

test("FIX-17: a real conversation block still retires the hub — notice tolerance is not content tolerance", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    terminal.addMessage("system", "Some startup notice", "Startup");
    terminal.addMessage("user", "hello there");
    const rendered = text(terminal.frame().lines);
    assert.doesNotMatch(rendered, /Recent/);
    press(stdin, "down");
    assert.doesNotMatch(text(terminal.frame().lines), /^❯ /m, "quick actions must not arm over a real transcript");
  } finally {
    terminal.stop();
  }
});

// FIX-17 finding 2 (the activation race): refreshDashboardRecentChats
// prepends Recent rows fire-and-forget while a selection may already be
// armed. The armed selection is identity-anchored: it follows the SAME
// logical row when rows shift, and Enter never activates a row the owner
// did not see highlighted.
test("FIX-17: rows prepended under an armed selection — Enter still runs the row that was highlighted", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const liveState: { recentChats: DashboardState["recentChats"] } = { recentChats: undefined };
  const terminal = new TerminalUi(
    () => ({ ...state, recentChats: liveState.recentChats }),
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
    theme,
  );
  terminal.start();
  try {
    const value = terminal.readInput();
    // Arm before the async Recent refresh lands: the highlighted row is
    // "New chat" (index 0 of the not-yet-prepended list).
    press(stdin, "down");
    assert.match(text(terminal.frame().lines), /^❯ New chat\b/m);

    // The refresh lands: two Recent rows prepend, shifting every index.
    liveState.recentChats = [
      { id: "chat-2", title: "Terminal look redesign", turnCount: 3, costUsd: 1.234, updatedAt: Date.now() - 60_000, workspace: state.workspace },
      { id: "chat-3", title: "Older chat", turnCount: 1, costUsd: 0.01, updatedAt: Date.now() - 120_000, workspace: state.workspace },
    ];

    // The visible highlight follows the logical row, not the stale index …
    const rendered = text(terminal.frame().lines);
    assert.match(rendered.split("\n").find((line) => line.includes("New chat"))!, /^❯ New chat\b/);
    assert.doesNotMatch(rendered, /^❯ Terminal look redesign\b/m);

    // … and Enter runs exactly that row — never the chat now occupying the
    // armed-at-the-time index.
    press(stdin, "return");
    assert.equal(await value, "/new");
    assert.equal(terminal.consumeQuickActionChat(), undefined, "the prepended chat must NOT have been activated");
  } finally {
    terminal.stop();
  }
});

test("FIX-17: the armed row vanishing disarms the selection — Enter becomes the safe bare-Enter no-op", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const liveState: { recentChats: DashboardState["recentChats"] } = {
    recentChats: [
      { id: "chat-2", title: "Terminal look redesign", turnCount: 3, costUsd: 1.234, updatedAt: Date.now() - 60_000, workspace: state.workspace },
    ],
  };
  const terminal = new TerminalUi(
    () => ({ ...state, recentChats: liveState.recentChats }),
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
    theme,
  );
  terminal.start();
  try {
    const value = terminal.readInput();
    press(stdin, "down"); // arms on the chat-2 Recent row
    assert.match(text(terminal.frame().lines), /^❯ Terminal look redesign\b/m);

    // The refresh replaces the list and the armed chat is no longer in it.
    liveState.recentChats = [];

    press(stdin, "return");
    // Enter resolves as the plain empty submit (the V3 bare-Enter no-op) —
    // no chat pick fires, nothing is activated on the stale index.
    assert.equal(await value, "");
    assert.equal(terminal.consumeQuickActionChat(), undefined, "no row may activate after the armed row vanished");
    assert.doesNotMatch(text(terminal.frame().lines), /^❯ /m, "the selection must be disarmed");
  } finally {
    terminal.stop();
  }
});

// D4: `y` is the only accept key for a danger-class confirm now — `j` (the
// old German "ja" synonym) is unbound, same as any other stray key. This
// test used to be named "…accepts j as well as y…" and pinned the opposite;
// updated deliberately per the D4 controller decision's exact key table.
test("an approval accepts y (not j) and answers unbound keys", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const first = terminal.confirmApproval({
      name: "run_command",
      risk: "shell",
      summary: "rm -rf build",
      details: "rm -rf build dist",
    });
    press(stdin, "q", "q");
    // Fix round 1, MINOR 1: wording aligned to the same grammar the
    // footer states (was the pre-D4 "y yes · n no · … · Enter = no").
    assert.match(stdout.output, /That key does nothing here · y confirm · Enter\/Esc cancel/);
    press(stdin, "j", "j");
    assert.match(stdout.output, /That key does nothing here · y confirm · Enter\/Esc cancel/);
    press(stdin, "y", "y");
    assert.deepEqual(await first, { accepted: true });

    const second = terminal.confirmAction("Sitzung löschen", "alles weg");
    press(stdin, "n", "n");
    assert.deepEqual(await second, { accepted: false });
  } finally {
    terminal.stop();
  }
});

// Fix round 1, MINOR 2: `enter` (some inputs report `\n` with that key
// name instead of `return`) used to be unbound in the danger branch while
// the settings/ordinary branches already treated it exactly like `return`
// — unified so `\n` behaves as Enter everywhere; in the danger class that
// means it now declines (a sanctioned, safe-direction delta: it used to
// answer "Unbound", now it does what Enter is documented to do).
test("a key named enter (not return) declines a danger confirm exactly like Enter does", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const decision = terminal.confirmAction("Sitzung löschen", "alles weg");
    press(stdin, "enter", "");
    assert.deepEqual(await decision, { accepted: false });
    assert.doesNotMatch(stdout.output, /That key does nothing here/);
  } finally {
    terminal.stop();
  }
});

/**
 * FIX-14 fix round 1 (review M2, controller ruling), end to end through the
 * REAL seam: `CommandContext.confirm` -> `confirmAction`. `/panel`'s spend
 * confirm is `confirmPlain`'s documented `{ defaultAccept: false }` — an
 * ordinary action that must not be accepted by a stray Enter.
 */
test("an ordinary defaultAccept:false confirm declines on Enter, accepts on y, and advertises no reason control", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  // Exactly the wiring cli.ts installs on `context.confirm`.
  const confirm = async (
    request: { title: string; consequence?: string },
    options?: { danger?: boolean; defaultAccept?: boolean },
  ): Promise<boolean> => (
    await terminal.confirmAction(request.title, request.consequence ?? "", {
      danger: options?.danger === true,
      ...(options?.defaultAccept !== undefined ? { defaultAccept: options.defaultAccept } : {}),
    })
  ).accepted;

  terminal.start();
  try {
    const declined = confirm(
      { title: "Query 2 models in parallel (≈ $0.020)?" },
      { defaultAccept: false },
    );
    const footer = plainText(terminal.frame().lines.at(-1)!).trim();
    // The key truth is stated — a stray Enter cannot spend money.
    assert.equal(footer, "y confirm · Enter/Esc cancel");
    // …and nothing that does nothing is advertised alongside it: this
    // caller reads `.accepted` and would throw a typed reason away.
    assert.doesNotMatch(footer, /reason|always allow|never allow/);
    press(stdin, "return");
    assert.equal(await declined, false);

    const accepted = confirm(
      { title: "Query 2 models in parallel (≈ $0.020)?" },
      { defaultAccept: false },
    );
    press(stdin, "y", "y");
    assert.equal(await accepted, true);

    // `g` is inert here — it must answer like any other unbound key rather
    // than opening a reason prompt whose text nobody reads.
    const pending = confirm({ title: "Query 2 models in parallel (≈ $0.020)?" }, { defaultAccept: false });
    press(stdin, "g", "g");
    assert.doesNotMatch(stdout.output, /Enter a reason/);
    assert.match(stdout.output, /That key does nothing here/);
    press(stdin, "escape");
    assert.equal(await pending, false);

    // An ordinary confirm with no such option keeps Enter-accepts.
    const ordinary = confirm({ title: "Use this route?" });
    assert.equal(
      plainText(terminal.frame().lines.at(-1)!).trim(),
      "Enter confirm · Esc cancel",
    );
    press(stdin, "return");
    assert.equal(await ordinary, true);
  } finally {
    terminal.stop();
  }
});

test("always/never are available only when the same preview carries a safe exact subject", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const exactSubject = '{"kind":"selected-path","path":"src/index.ts"}';
    const allow = terminal.confirmApproval({
      name: "write_file",
      risk: "edit",
      summary: "src/index.ts schreiben",
      details: "eine synthetische Änderung",
      subject: exactSubject,
      rememberAvailable: true,
    });
    assert.match(stdout.output, /Applies only to:/);
    assert.match(stdout.output, /selected-path/);
    assert.match(stdout.output, /src\/index\.ts/);
    press(stdin, "a", "a");
    assert.deepEqual(await allow, { accepted: true, remember: "allow" });

    const deny = terminal.confirmApproval({
      name: "write_file",
      risk: "edit",
      summary: "src/index.ts schreiben",
      subject: exactSubject,
      rememberAvailable: true,
    });
    press(stdin, "d", "d");
    assert.deepEqual(await deny, { accepted: false, remember: "deny" });

    const unavailable = terminal.confirmAction("Sitzung löschen", "lokale Sitzung");
    press(stdin, "a", "a");
    assert.match(stdout.output, /'Always' and 'never' need a specific file or command/);
    // D4: `y`, not `j` — see the dedicated key-table test above.
    press(stdin, "y", "y");
    assert.deepEqual(await unavailable, { accepted: true });

    // FIX-14 fix round 1 (review M2.2): `g` belongs to the approval
    // mechanism — the one whose decision carries the typed reason onward
    // (into `PermissionDeniedError`, and from there to the model). Driven
    // through `confirmApproval`, which is where it is real.
    const reasoned = terminal.confirmApproval({
      name: "run_command",
      risk: "shell",
      summary: "SHELL · curl",
      details: "curl example.com",
    });
    press(stdin, "g", "g");
    assert.match(stdout.output, /Enter a reason/);
    type(stdin, "sieht verdächtig aus");
    press(stdin, "return");
    assert.deepEqual(await reasoned, { accepted: false, reason: "sieht verdächtig aus" });
  } finally {
    terminal.stop();
  }
});

test("scrolling back survives new tool output and End returns to the tail", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 20;
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    for (const turn of chat(8)) {
      if (turn.kind === "user") terminal.addMessage("user", turn.text);
      else if (turn.kind === "assistant") terminal.addMessage("assistant", turn.text);
    }
    press(stdin, "pageup");
    const before = plainText(terminal.frame().lines[2]!);
    assert.match(text(terminal.frame().lines), /lines above/);

    terminal.handleRunEvent({ type: "run-start", model: "m", maxSteps: 12, timestamp: NOW });
    terminal.handleRunEvent({
      type: "tool-start",
      id: "tool-1",
      number: 1,
      name: "run_command",
      input: { command: "npm test" },
      timestamp: NOW,
    });

    // R9: new content must not yank a scrolled-back viewport to the end.
    assert.equal(plainText(terminal.frame().lines[2]!), before);
    assert.match(text(terminal.frame().lines), /new lines/);

    press(stdin, "end");
    assert.doesNotMatch(plainText(terminal.frame().lines[1]!), /lines above/);
  } finally {
    terminal.stop();
  }
});

test("Ctrl+C requests cancellation during a busy run and restores raw mode on stop", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  let cancellations = 0;

  terminal.start();
  terminal.setStatus("Modell arbeitet");
  terminal.setCancelHandler(() => {
    cancellations += 1;
  });
  press(stdin, "c", "", { ctrl: true });

  assert.equal(cancellations, 1);
  assert.match(stdout.output, /Cancel requested/);
  terminal.stop();
  assert.equal(stdin.isRaw, false);
  assert.match(stdout.output, /\u001b\[\?25h\u001b\[\?1049l/);
});

test("Enter stops a /whisper recording, Escape cancels it", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const stopped = terminal.awaitRecordingControl("Recording · 0s · Enter stops · Esc cancels");
    terminal.updateRecordingStatus("Recording · 3s · Enter stops · Esc cancels");
    assert.match(stdout.output, /Recording · 3s/);
    press(stdin, "return");
    assert.equal(await stopped, "stop");

    const cancelled = terminal.awaitRecordingControl("Recording · 0s");
    press(stdin, "escape");
    assert.equal(await cancelled, "cancel");
  } finally {
    terminal.stop();
  }
});

test("Ctrl+C during a recording cancels it instead of exiting", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const recording = terminal.awaitRecordingControl("Recording · 0s");
    press(stdin, "c", "", { ctrl: true });
    assert.equal(await recording, "cancel");
  } finally {
    terminal.stop();
  }
});

test("triggerRecordingControl ends the recording programmatically, e.g. on a hard limit", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const recording = terminal.awaitRecordingControl("Recording · 0s");
    terminal.triggerRecordingControl("stop");
    assert.equal(await recording, "stop");
    // A no-op once the mode has already moved on -- must not throw or hang.
    terminal.triggerRecordingControl("stop");
  } finally {
    terminal.stop();
  }
});

test("insertInputText lands text in the input line, appending rather than replacing", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    void terminal.readInput().catch(() => {});
    terminal.insertInputText("Hallo Welt");
    assert.match(text(terminal.frame().lines), /Hallo Welt/);

    type(stdin, " bitte");
    assert.match(text(terminal.frame().lines), /Hallo Welt bitte/);

    terminal.insertInputText("und noch mehr");
    assert.match(text(terminal.frame().lines), /Hallo Welt bitte und noch mehr/);
  } finally {
    terminal.stop();
  }
});

// ---------------------------------------------------------------------------
// Phase 11, ruling 9 (PTY smoke, sanctioned in the brief as a fallback for
// scripts/check-pty.mjs): a real-TTY-shaped `TerminalUi` composed end to end
// — a completed run's real tracked file change plus a fabricated run log,
// `/undo` dispatched through the real command handler, the confirmation
// rendered through the SAME `confirmAction` other approval prompts use (not
// a stub), answered with a real keypress, and the file actually reverted.
// ---------------------------------------------------------------------------

test("composed: run, /undo, real confirmation (diff summary + disclosure), accept, file reverted", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "routercode-tui-undo-"));
  const home = join(workspace, ".state");
  try {
    const guard = await WorkspaceGuard.create(workspace);
    const approvals = new ApprovalManager("allow-all");
    const session = SessionStore.create(workspace, home, "Undo smoke");
    const chatId = session.data.id;
    const journal = new ChangeJournal({ appHome: home, chatId });
    const runId = createRunId();

    // The real, tracked half of the run: one file write the change journal
    // persists a checkpoint for, exactly like a live agent run would.
    writeFileSync(join(workspace, "kept.txt"), "original\n", "utf8");
    const tools = createCodingTools(guard, approvals, journal, { runId });
    const writeFileTool = tools.find((tool) => tool.function.name === "write_file")!;
    await writeFileTool.function.execute(
      { path: "kept.txt", content: "changed by the run\n" } as never,
      {} as never,
    );

    // The run log half: a matching write_file call plus one run_command call
    // — the disclosure must name the latter as not reverted.
    const log = await RunLog.open(home, chatId, runId);
    log.write({ type: "run-start", model: "vendor/model", maxSteps: 20, timestamp: 1 });
    log.write({
      type: "tool-start",
      id: "t1",
      number: 1,
      name: "write_file",
      input: { path: "kept.txt", content: "changed by the run\n" },
      timestamp: 2,
    });
    log.write({
      type: "tool-end",
      id: "t1",
      number: 1,
      name: "write_file",
      input: { path: "kept.txt", content: "changed by the run\n" },
      output: { ok: true, path: "kept.txt", bytes: 19 },
      durationMs: 5,
      timestamp: 3,
    });
    log.write({
      type: "tool-start",
      id: "t2",
      number: 2,
      name: "run_command",
      input: { command: "npm test" },
      timestamp: 4,
    });
    log.write({
      type: "tool-end",
      id: "t2",
      number: 2,
      name: "run_command",
      input: { command: "npm test" },
      output: { exitCode: 0, stdout: "ok", stderr: "" },
      durationMs: 10,
      timestamp: 5,
    });
    log.write({ type: "run-end", outcome: "complete", durationMs: 20, toolCount: 2, timestamp: 6 });
    await log.close();

    const stdin = new FakeInput();
    const stdout = new FakeOutput();
    const terminal = ui(stdin, stdout);
    terminal.start();
    try {
      const lines: string[] = [];
      const context: CommandContext = {
        config: {} as CommandContext["config"],
        approvals,
        openRouter: {} as CommandContext["openRouter"],
        session,
        agent: { journal, guard } as unknown as CommandContext["agent"],
        workspace,
        credentials: {} as CommandContext["credentials"],
        out: {
          text(value) { lines.push(value); },
          error(value, hint) { lines.push(hint ? `${value}\n${hint}` : value); },
        },
        ruleStore: {} as CommandContext["ruleStore"],
        confirm: async (request) => (await terminal.confirmAction(request.title, request.consequence ?? "")).accepted,
      };

      const outcome = handleSlashCommand("/undo", context);
      // The confirmation is reached only after real (if tiny) filesystem
      // I/O — run discovery, drift check, checkpoint hydration — so give it
      // a moment to actually render before answering.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.match(stdout.output, /Undo the last run\?/);
      assert.match(stdout.output, /kept\.txt/);
      assert.match(stdout.output, /Not reverted/);
      assert.match(stdout.output, /run_command/);
      assert.match(stdout.output, /This cannot be undone/);

      // D4: `y`, not `j` — /undo is danger-class, `y` is the only accept key.
      press(stdin, "y", "y");
      await outcome;

      assert.equal(readFileSync(join(workspace, "kept.txt"), "utf8"), "original\n");
      assert.ok(lines.some((line) => /restored/.test(line)));
    } finally {
      terminal.stop();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FIX-3 (audit Critical): in the auto modes the owner used to see only
// `● Edit(src/foo.ts)` + `⎿ ✓ 1 replacement(s)` — never WHAT changed. The
// transcript now carries the diff itself, from a real tool execution.
// ---------------------------------------------------------------------------

/** Exactly the translation `agent.ts` performs on the tool's own notice. */
function fileChangeEvents(terminal: TerminalUi, at: number): CodingToolOptions["onFileChange"] {
  return (change) => {
    terminal.handleRunEvent({
      type: "file-change",
      path: change.path,
      tool: change.tool,
      created: change.created,
      added: change.added,
      removed: change.removed,
      diff: change.diff,
      truncated: change.truncated,
      timestamp: at,
    });
  };
}

test("FIX-3: an allow-all edit puts its diff in the transcript, not just a result line", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "routercode-tui-diff-"));
  try {
    const guard = await WorkspaceGuard.create(workspace);
    const approvals = new ApprovalManager("allow-all");
    const journal = new ChangeJournal({ appHome: join(workspace, ".state"), chatId: "diff-chat" });
    writeFileSync(join(workspace, "foo.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n", "utf8");

    const stdin = new FakeInput();
    const stdout = new FakeOutput();
    const terminal = ui(stdin, stdout);
    terminal.start();
    try {
      const tools = createCodingTools(guard, approvals, journal, {
        runId: createRunId(),
        onFileChange: fileChangeEvents(terminal, NOW),
      });
      const replaceText = tools.find((tool) => tool.function.name === "replace_text")!;
      await replaceText.function.execute(
        { path: "foo.ts", oldText: "const b = 2;", newText: "const b = 22;", replaceAll: false } as never,
        {} as never,
      );

      const frame = text(terminal.frame().lines);
      assert.match(frame, /foo\.ts/);
      assert.match(frame, /\+1/);
      assert.match(frame, /-1/);
      // The change itself, both sides of it.
      assert.match(frame, /- const b = 2;/);
      assert.match(frame, /\+ const b = 22;/);
      assert.match(frame, /applied/);
      // The advertised way back is a command that exists, never a bare letter.
      assert.match(frame, /\/undo reverts the run/);
      assert.doesNotMatch(frame, /u undo/);
    } finally {
      terminal.stop();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("FIX-3 ask mode: the answered approval leaves the transcript, so the diff prints once", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "routercode-tui-diff-ask-"));
  try {
    const guard = await WorkspaceGuard.create(workspace);
    const approvals = new ApprovalManager("ask");
    const journal = new ChangeJournal({ appHome: join(workspace, ".state"), chatId: "diff-ask" });
    writeFileSync(join(workspace, "foo.ts"), "const a = 1;\nconst b = 2;\n", "utf8");

    const stdin = new FakeInput();
    const stdout = new FakeOutput();
    const terminal = ui(stdin, stdout);
    terminal.start();
    try {
      approvals.setPromptHandler((preview) => terminal.confirmApproval(preview));
      const tools = createCodingTools(guard, approvals, journal, {
        runId: createRunId(),
        onFileChange: fileChangeEvents(terminal, NOW),
      });
      const replaceText = tools.find((tool) => tool.function.name === "replace_text")!;
      const execution = replaceText.function.execute(
        { path: "foo.ts", oldText: "const b = 2;", newText: "const b = 22;", replaceAll: false } as never,
        {} as never,
      );

      // The approval is reached through real filesystem I/O (stale check,
      // read), so wait for it to actually render instead of guessing a delay.
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (/Approval/.test(text(terminal.frame().lines))) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const asking = text(terminal.frame().lines);
      // FIX-1 renamed the header from `Freigabe` to the English `⚠ Approval`.
      assert.match(asking, /Approval/, "the approval is what the owner sees before the write");

      press(stdin, "y", "y");
      await execution;

      const frame = text(terminal.frame().lines);
      // The approval block is dropped the moment it is answered, so the diff
      // block is the single surviving record of the change — no double print.
      // (`Approval · EDIT` is the block header; the status line's own
      // "Approval granted" notice is allowed to remain.)
      assert.doesNotMatch(frame, /Approval · /);
      assert.match(frame, /- const b = 2;/);
      assert.match(frame, /\+ const b = 22;/);
      assert.equal(frame.match(/\+ const b = 22;/g)?.length, 1);
    } finally {
      terminal.stop();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

/**
 * FIX-21 finding 5 (visual audit 2026-08-28, frame-verified): the hub's
 * "Recent" rows came out of `formatChatRow`, which hardcoded a `·`, so the
 * whole section stayed unicode in ASCII glyph mode while everything around
 * it asciified. The separator is `theme.glyph("separator")` now.
 */
test("the hub's Recent rows are pure ASCII in ascii glyph mode (FIX-21 finding 5)", () => {
  const ascii = createTheme({ level: 0, ascii: true });
  const recentState: DashboardState = {
    ...state,
    // `state.projectStatus` carries its own `·` from the fixture; the hub's
    // Recent rows are what this pin is about, so keep the surrounding
    // fixture text ASCII too and let the assertion cover the whole frame.
    projectStatus: "robopet",
    recentChats: [{
      id: "chat-2",
      title: "Terminal look redesign",
      turnCount: 3,
      costUsd: 1.234,
      model: "moonshotai/kimi-k3",
      updatedAt: NOW - 2 * 60 * 60_000,
      workspace: state.workspace,
    }],
  };
  const frame = buildDashboardFrame(input({
    theme: ascii,
    state: recentState,
    // The hub's Recent section only renders inside the branded start block.
    brand: {
      showLargeLogo: true,
      showHeaderMark: true,
      largeLines: routeCoreLarge("ascii"),
      compactMark: routeCoreCompact("ascii"),
      version: "9.9.9",
    },
  }));
  const rendered = text(frame.lines);
  const row = rendered.split("\n").find((value) => value.includes("3 messages"));
  assert.ok(row, `the Recent row must render: ${rendered}`);
  assert.doesNotMatch(row, /[^\x00-\x7f]/u, row);
  // The ASCII separator still sets every fact apart — nothing runs together.
  assert.match(row, /3 messages - \$1\.234 - kimi-k3 - /u);
});

/**
 * FIX-21 finding 5, the run-complete line: `runOutcomeLabel` composed a raw
 * `·` for the one outcome that needs a second clause, so the line leaked a
 * unicode byte in ASCII glyph mode. The separator is the theme's now, and
 * the parameter is required so no call site can drop back to a literal.
 */
test("the run-complete label takes its separator from the theme (FIX-21 finding 5)", () => {
  const unicode = createTheme({ level: 0 });
  const ascii = createTheme({ level: 0, ascii: true });
  assert.equal(
    runOutcomeLabel("unverified", unicode.glyph("separator")),
    "Run complete · unverified",
  );
  const asciiLabel = runOutcomeLabel("unverified", ascii.glyph("separator"));
  assert.equal(asciiLabel, "Run complete - unverified");
  assert.doesNotMatch(asciiLabel, /[^\x00-\x7f]/u, asciiLabel);
  // Every other outcome is a single clause and carries no separator at all.
  for (const outcome of ["complete", "step-limit", "cost-limit", "cancelled", "error"] as const) {
    const label = runOutcomeLabel(outcome, ascii.glyph("separator"));
    assert.doesNotMatch(label, /[^\x00-\x7f]/u, label);
  }
});

// --- FIX-20 tests carried over at merge (both-append reassembly) ---

/**
 * FIX-20, finding 9: a foreign `/chats` pick re-roots the entire runtime,
 * and the only visible trace in-chat was a short workspace basename quietly
 * changing. The chat that was actually opened appeared nowhere on screen —
 * so the header's identity line names it, beside the folder.
 */
test("the in-chat header names the open chat as well as the folder", () => {
  const frame = buildDashboardFrame(input({
    blocks: chat(1),
    state: { ...state, workspace: "/home/owner/projekt/other-checkout", chatTitle: "Cross failure rendering" },
  }));
  const header = plainText(frame.lines[0]!);

  assert.match(header, /other-checkout/, "the folder still identifies where this is");
  assert.match(header, /Cross failure rendering/, "and the chat identifies which conversation it is");
});

/**
 * The hub has no open chat to name — its welcome box already covers a chat
 * that has not started, and the header is omitted there wholesale.
 */
test("the hub header never names a chat", () => {
  const frame = buildDashboardFrame(input({
    blocks: [],
    state: { ...state, workspace: "/home/owner/projekt/other-checkout", chatTitle: "New Chat" },
    brand: {
      showLargeLogo: true,
      showHeaderMark: true,
      largeLines: routeCoreLarge("ascii"),
      compactMark: routeCoreCompact("ascii"),
      version: "9.9.9",
    },
  }));

  assert.doesNotMatch(text(frame.lines), /^New Chat$/m);
});

/**
 * FIX-20, finding 5: a confirm raised OUTSIDE a run (a settings-editor
 * confirm, say) has no repaint cadence at all — nothing redraws the frame
 * until the next keypress. Showing a number there is a stopped clock, and
 * the fix is not to start a timer for it: the line says "waiting" and
 * promises nothing it cannot keep.
 */
test("a confirm with no run behind it says waiting without a frozen number", () => {
  const frame = buildDashboardFrame(input({
    mode: "confirm",
    confirmDanger: true,
    waitingSince: NOW - 14_000,
  }));
  const screen = text(frame.lines);

  assert.match(screen, /waiting/);
  assert.doesNotMatch(screen, /waiting since/);
  assert.doesNotMatch(screen, /waiting \d/, "no number may be claimed without a cadence to advance it");
  assert.doesNotMatch(screen, /00:14/);
});

/**
 * FIX-20, finding 6: `/cross run <task>` carries its task as a command
 * ARGUMENT — nothing was ever captured from the composer, so the palette's
 * own restore had nothing to give back and Esc silently ate the typed task.
 * The abandoned gate visit now hands its pending text over explicitly.
 */
test("a cancelled Cross gate opened from a command argument puts that task text back in the composer", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    // No palette capture happened at all — this is the `/cross run <task>`
    // shape, where the text only ever existed as a command argument.
    assert.equal(terminal.consumeCrossCommandDraft(), "");
    terminal.restoreCrossCommandDraft("refactor the frame builder");
    const restored = terminal.readInput();
    press(stdin, "return");
    assert.equal(await restored, "refactor the frame builder");
  } finally {
    terminal.stop();
  }
});

/**
 * The fallback is a restore, never an overwrite: anything typed while the
 * gate was open wins over the abandoned task text.
 */
test("the Cross gate's restored task text never overwrites a composer the user has already typed into", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "typed while the gate was open");
    terminal.restoreCrossCommandDraft("the abandoned task");
    press(stdin, "return");
    assert.equal(await value, "typed while the gate was open");
  } finally {
    terminal.stop();
  }
});

/** The composer row — the only frame line prefixed with the `❯ `/`> ` input gutter. */
function composerRows(frame: { lines: readonly Line[] }): string[] {
  return frame.lines.map((line) => plainText(line)).filter((value) => /^[>❯] /.test(value));
}

// --- FIX-19 tests carried over at merge (both-append reassembly; the stale
// one-press Ctrl+C test is deliberately absent — FIX-1's two-press contract
// is the merged truth and already pinned above) ---

test("FIX-19: the composer placeholder never wraps — a deep workspace path is abbreviated to one line", () => {
  // The exact shape the flow hunters reproduced in a real PTY: a bare hub
  // whose workspace is a long absolute path, at the narrowest supported
  // frame. Before the fix the placeholder embedded the FULL path, so the
  // composer row alone was wider than the terminal and soft-wrapped —
  // desynchronising every later diff (stale duplicate placeholder rows, a
  // tripled composer, the logo pushed off, 4 of 12 rows eaten at 40×12).
  const homeDir = "/Users/demo";
  const workspace = `${homeDir}/projekt/routercode/packages/workbench/src/ui`;
  for (const width of [40, 48, 60, 72, 80, 120]) {
    const frame = buildDashboardFrame(input({
      width,
      height: 12,
      state: { ...state, workspace },
      homeDir,
      brand: {
        showLargeLogo: true,
        showHeaderMark: true,
        largeLines: routeCoreLarge("ascii"),
        compactMark: routeCoreCompact("ascii"),
        version: "9.9.9",
      },
    }));
    for (const line of frame.lines) {
      assert.ok(
        lineWidth(line) <= width - 1,
        `at ${width} columns a frame line is ${lineWidth(line)} cells wide: ${JSON.stringify(plainText(line))}`,
      );
    }
    assert.equal(frame.lines.length, 12, `at ${width} columns the frame is not the 12 rows it claims`);
    assert.equal(composerRows(frame).length, 1, `at ${width} columns the composer is not exactly one row`);
  }
});

test("FIX-19: the placeholder abbreviates the path instead of overflowing, and drops the folder form before it becomes a stub", () => {
  const homeDir = "/Users/demo";
  const workspace = `${homeDir}/projekt/routercode/packages/workbench`;
  const placeholderAt = (width: number): string =>
    composerRows(buildDashboardFrame(input({
      width,
      height: 12,
      state: { ...state, workspace },
      homeDir,
    })))[0]!;

  // Roomy: the whole `~`-abbreviated path — never the raw absolute one.
  const wide = placeholderAt(120);
  assert.match(wide, /Type to start a new chat in ~\/projekt\/routercode\/packages\/workbench/);
  assert.ok(!wide.includes("/Users/demo"), "the raw home path leaked into the placeholder");

  // Middle width: middle-ellipsised, so the `~` root AND the folder that
  // names the workspace both survive — a tail cut would keep neither.
  const middle = placeholderAt(60);
  assert.match(middle, /Type to start a new chat in ~\/.+workbench /);
  assert.ok(middle.includes("…"), "the abbreviated path carries no ellipsis");
  assert.ok(middle.length < wide.length, "the narrow placeholder was not shortened at all");

  // Narrower than any honest path stub: the generic prompt, never "~…h".
  assert.equal(placeholderAt(40), "> Describe your task …");
});

test("FIX-19: the help line and the settings editor prompt are held to the same one-line contract", () => {
  // The composer placeholder was the reported offender, but it was not the
  // only frame line that reached the terminal unfitted — the `?` help line
  // and the settings editor's label/description/validation rows were pushed
  // raw as well, and wrap exactly the same way at a narrow width.
  const width = 40;
  const help = buildDashboardFrame(input({ width, height: 12, input: "?", helpRequested: true }));
  for (const line of help.lines) {
    assert.ok(lineWidth(line) <= width - 1, `help frame line too wide: ${JSON.stringify(plainText(line))}`);
  }
  assert.equal(help.lines.length, 12);

  const editor = buildDashboardFrame(input({
    width,
    height: 12,
    mode: "validated-input",
    editorPrompt: {
      label: "Maximum cost per run in US dollars, saved to the config",
      description: "A number between 0.01 and 100 — every run stops once the ledger passes it.",
      validationMessage: "That is not a number orcode can spend against; enter something like 1.50.",
    },
  }));
  for (const line of editor.lines) {
    assert.ok(lineWidth(line) <= width - 1, `editor frame line too wide: ${JSON.stringify(plainText(line))}`);
  }
  assert.equal(editor.lines.length, 12);
});

test("FIX-19: a plain picker opened from a command suspends the dashboard instead of sharing its stdin", async () => {
  // The addendum's PTY finding: `/model`'s catalog pick ran the plain
  // in-place picker while the fullscreen UI was still attached, so both read
  // every byte — the picker's Escape looked dead (its frame was buried by
  // the next render) and its filter text was mirrored into the composer,
  // where a later Enter submitted it as a real, paid prompt.
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    assert.equal(terminal.active, true);
    assert.equal(terminalHeld(), true, "an attached dashboard must own the terminal");
    // A draft the owner has already typed: it must survive the pick exactly.
    terminal.insertInputText("write the release notes");

    let activeInsidePicker: boolean | null = null;
    let rawInsidePicker: boolean | null = null;
    const selected = await pickFromListPlain<string>({
      title: "Search models",
      choices: () => {
        activeInsidePicker = terminal.active;
        rawInsidePicker = stdin.isRaw;
        return [];
      },
      initialValue: "anything",
    });

    assert.equal(selected, null);
    assert.equal(activeInsidePicker, false, "the dashboard was still attached while the picker ran");
    assert.equal(rawInsidePicker, false, "the dashboard still held raw mode while the picker ran");
    // Restored afterwards, draft untouched — never the picker's filter text.
    assert.equal(terminal.active, true);
    assert.equal(terminalHeld(), true);
    assert.equal(plainText(terminal.frame().lines.at(-1)!).trim(), "> write the release notes");
  } finally {
    terminal.stop();
    terminal.dispose();
  }
  assert.equal(terminalHeld(), false, "a stopped dashboard releases the terminal");
});

test("FIX-19: a submission refused before any run started comes back to the composer", async () => {
  // A provider-required refusal used to destroy typed or pasted text: the
  // composer clears on submit, the run never starts, and only an unsaid `↑`
  // could recover it.
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const pending = terminal.readInput();
    type(stdin, "summarise the release notes");
    press(stdin, "return");
    const submitted = await pending;
    assert.equal(submitted, "summarise the release notes");
    // Submitting clears the composer — that is what the run consumes.
    assert.equal(plainText(terminal.frame().lines.at(-1)!).trim(), ">");

    terminal.restoreSubmittedDraft(submitted);
    assert.equal(
      plainText(terminal.frame().lines.at(-1)!).trim(),
      "> summarise the release notes",
    );

    // Restoring never appends onto newer text the user has already typed.
    terminal.restoreSubmittedDraft("something else entirely");
    assert.equal(
      plainText(terminal.frame().lines.at(-1)!).trim(),
      "> summarise the release notes",
    );
  } finally {
    terminal.stop();
    terminal.dispose();
  }
});

test("FIX-19: a slash command typed while a gate is busy stays a command, and the queue notice never invents a run", async () => {
  // Reproduced in a real PTY during provider activation: the terminal read
  // "busy" while NOTHING was running, so `/allow` was silently reclassified
  // as a message ("1 message queued for the next run · current run keeps
  // going"), its picker never opened, and the text later vanished into a
  // refusal.
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const first = terminal.readInput();
    type(stdin, "erste Aufgabe");
    press(stdin, "return");
    assert.equal(await first, "erste Aufgabe");
    // Busy, but no run snapshot and no cancel handler: a gate, not a run.

    const before = stdout.output.length;
    type(stdin, "/allow");
    press(stdin, "return");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const shown = stdout.output.slice(before);
    // Never silently a message …
    assert.doesNotMatch(shown, /message queued/);
    // … and the command is still there, editable, to send once the gate clears.
    assert.match(shown, /your text stays/);
    assert.equal(plainText(terminal.frame().lines.at(-1)!).trim(), "> /allow");

    // A plain message is still queued — never lost — but the notice does not
    // claim a run is continuing when none is.
    press(stdin, "u", "", { ctrl: true });
    const beforeMessage = stdout.output.length;
    type(stdin, "zweite Aufgabe");
    press(stdin, "return");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const queued = stdout.output.slice(beforeMessage);
    assert.match(queued, /1 message queued/);
    assert.match(queued, /nothing is running yet/);
    assert.doesNotMatch(queued, /current run keeps going/);
    assert.equal(await terminal.readInput(), "zweite Aufgabe");
  } finally {
    terminal.stop();
    terminal.dispose();
  }
});

test("FIX-19: typeahead typed before the composer exists is replayed into it, not dropped", async () => {
  // The startup screen paints seconds before the loop first asks for input,
  // and looks ready the whole time. Everything typed into that window used
  // to be discarded (measured: 16 characters swallowed at the hub).
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    // No `readInput()` yet — the UI is idle, exactly as during startup work.
    type(stdin, "fix the flaky test");
    const pending = terminal.readInput();
    assert.equal(
      plainText(terminal.frame().lines.at(-1)!).trim(),
      "> fix the flaky test",
    );
    // Still a draft: nothing is sent without an Enter of its own.
    type(stdin, " please");
    press(stdin, "return");
    assert.equal(await pending, "fix the flaky test please");
  } finally {
    terminal.stop();
    terminal.dispose();
  }
});

test("FIX-19: replayed typeahead behaves like text typed a moment later, and an overflow is said out loud", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    // A slash typed into the startup window still opens the palette.
    type(stdin, "/mod");
    const pending = terminal.readInput();
    assert.equal(plainText(terminal.frame().lines.at(-1)!).trim(), "> /mod");
    assert.match(text(terminal.frame().lines), /model/);
    press(stdin, "escape");
    press(stdin, "u", "", { ctrl: true });
    press(stdin, "return");
    assert.equal(await pending, "");
  } finally {
    terminal.stop();
    terminal.dispose();
  }

  const stdin2 = new FakeInput();
  const stdout2 = new FakeOutput();
  const second = ui(stdin2, stdout2);
  second.start();
  try {
    type(stdin2, "x".repeat(2_100));
    const pending = second.readInput();
    const composer = plainText(second.frame().lines.at(-1)!);
    // Held up to the cap — and the loss past it is reported, never silent.
    assert.ok(composer.includes("x"), "the held typeahead never reached the composer");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.match(stdout2.output, /did not fit and was discarded/);
    press(stdin2, "u", "", { ctrl: true });
    press(stdin2, "return");
    assert.equal(await pending, "");
  } finally {
    second.stop();
    second.dispose();
  }
});
