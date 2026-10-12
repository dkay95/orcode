import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { pickFromListPlain, type PlainListChoice, type PlainListIo } from "../src/ui/list-plain.js";
import { holdTerminal, terminalHeld } from "../src/ui/terminal-lease.js";
import { createTheme } from "../src/ui/theme.js";

const theme = createTheme({ level: 0 });

class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  setRawMode(value: boolean): this {
    this.isRaw = value;
    return this;
  }
  resume(): this { return this; }
  pause(): this { return this; }
}

class FakeOutput extends EventEmitter {
  isTTY = true;
  columns = 100;
  output = "";
  write(value: string): boolean {
    this.output += value;
    return true;
  }
}

function io(): { stdin: FakeInput; stdout: FakeOutput; io: PlainListIo } {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  return { stdin, stdout, io: { input: stdin as unknown as PlainListIo["input"], output: stdout as unknown as PlainListIo["output"] } };
}

function press(stdin: FakeInput, name: string, character = ""): void {
  stdin.emit("keypress", character, { name, ctrl: false, meta: false });
}

function type(stdin: FakeInput, text: string): void {
  for (const character of text) stdin.emit("keypress", character, { name: character, ctrl: false, meta: false });
}

/** Flushes pending microtasks (an async `choices` source's own `await`s included). */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function choices(): readonly PlainListChoice<string>[] {
  return [
    { value: "openrouter", name: "OpenRouter", description: "API key · Pay as you go" },
    { value: "kimi-code", name: "Kimi Code membership", description: "Membership key" },
    { value: "codex", name: "Codex", description: "Coming soon", disabled: true, disabledReason: "Coming soon" },
  ];
}

// ---------------------------------------------------------------------------
// V4-A emphasis levels — this line-printed surface shares `list-core.ts`'s
// `buildListLines` unchanged, so D1 ruling 3's full-row `inverse` bar is gone
// here for the same reason it is gone there: `inverse` is now the title bar's
// alone, once per screen. The selection is level 2 (accent + bold) behind the
// `❯` marker, and the one inverse line of this surface is the bar at the top.
// ---------------------------------------------------------------------------

test("the repainted picker paints one inverse line — the title bar — and marks the selection at level 2", async () => {
  const esc = String.fromCharCode(27);
  const colored = createTheme({ level: 3 });
  const { stdin, stdout, io: channel } = io();
  const picked = pickFromListPlain({ title: "Choose a provider", choices: choices() }, channel, colored);
  await flush();
  // Exactly one inverse run in the whole frame, and it is the title bar.
  const inverseRuns = stdout.output.split(`${esc}[7m`).length - 1;
  assert.equal(inverseRuns, 1, stdout.output);
  assert.match(stdout.output, new RegExp(`${esc}\\[7m Choose a provider`));
  // The first row ("OpenRouter") is selected by default and reads from the
  // marker plus level 2 (bold + the one accent hue) — never from a bar.
  assert.match(stdout.output, new RegExp(`${esc}\\[1m${esc}\\[38;2;232;137;12m❯ `));
  press(stdin, "escape");
  assert.equal(await picked, null);
});

test("a non-TTY channel never draws a picker list at all — never a fake selection where nothing is interactive (ruling 3's exception, checked: doesn't apply here)", async () => {
  const plainInput = new EventEmitter() as unknown as PlainListIo["input"];
  const plainOutput = new EventEmitter() as unknown as PlainListIo["output"];
  Object.assign(plainInput, { isTTY: false });
  let wrote = "";
  Object.assign(plainOutput, { isTTY: false, write: (value: string) => { wrote += value; return true; } });

  const result = await pickFromListPlain(
    { title: "Choose a provider", choices: choices(), initialValue: "kimi-code" },
    { input: plainInput, output: plainOutput },
    theme,
  );
  assert.equal(result, "kimi-code");
  // Non-interactive resolution never renders the list body (no header, no
  // rows, no bar) — there is nothing to leave "bar-less" here because
  // nothing is drawn in the first place, so ruling 3's exception clause
  // doesn't apply to this module.
  assert.equal(wrote, "");
});

test("arrow down + Enter resolves the next static choice", async () => {
  const { stdin, io: channel } = io();
  const picked = pickFromListPlain({ title: "Choose a provider", choices: choices() }, channel, theme);
  press(stdin, "down");
  press(stdin, "return");
  assert.equal(await picked, "kimi-code");
});

test("the first row is selected by default and Enter resolves it immediately", async () => {
  const { stdin, io: channel } = io();
  const picked = pickFromListPlain({ title: "Choose a provider", choices: choices() }, channel, theme);
  press(stdin, "return");
  assert.equal(await picked, "openrouter");
});

test("typing filters the static list, live", async () => {
  const { stdin, stdout, io: channel } = io();
  const picked = pickFromListPlain({ title: "Choose a provider", choices: choices() }, channel, theme);
  type(stdin, "kimi");
  await flush();
  assert.match(stdout.output, /Kimi Code membership/);
  assert.doesNotMatch(stdout.output.split("\n").slice(-6).join("\n"), /OpenRouter/);
  press(stdin, "return");
  assert.equal(await picked, "kimi-code");
});

test("backspace narrows the query back down one character", async () => {
  const { stdin, io: channel } = io();
  const picked = pickFromListPlain({ title: "Choose a provider", choices: choices() }, channel, theme);
  type(stdin, "kimiX");
  await flush();
  press(stdin, "backspace");
  await flush();
  press(stdin, "return");
  assert.equal(await picked, "kimi-code");
});

test("Escape cancels and resolves null", async () => {
  const { stdin, stdout, io: channel } = io();
  const picked = pickFromListPlain({ title: "Choose a provider", choices: choices() }, channel, theme);
  press(stdin, "escape");
  assert.equal(await picked, null);
  assert.match(stdout.output, /Cancelled\./);
});

test("Ctrl+C cancels and resolves null, same as Escape", async () => {
  const { stdin, io: channel } = io();
  const picked = pickFromListPlain({ title: "Choose a provider", choices: choices() }, channel, theme);
  stdin.emit("keypress", "c", { name: "c", ctrl: true, meta: false });
  assert.equal(await picked, null);
});

test("a disabled row cannot be resolved by Enter — the picker stays open", async () => {
  const { stdin, io: channel } = io();
  const picked = pickFromListPlain({ title: "Choose a provider", choices: choices() }, channel, theme);
  press(stdin, "down");
  press(stdin, "down");
  press(stdin, "return");
  // Still open: escape now to end the test.
  press(stdin, "escape");
  assert.equal(await picked, null);
});

test("PageDown steps by the shared page size, clamped to the list length", async () => {
  const many: PlainListChoice<number>[] = Array.from({ length: 20 }, (_, index) => ({
    value: index,
    name: `item-${index}`,
  }));
  const { stdin, io: channel } = io();
  const picked = pickFromListPlain({ title: "Pick a number", choices: many }, channel, theme);
  press(stdin, "pagedown");
  press(stdin, "return");
  assert.equal(await picked, 8);
});

test("an async choices source (model search) is re-queried on every keystroke", async () => {
  const models = ["vendor/alpha", "vendor/beta", "vendor/gamma"];
  const calls: string[] = [];
  const { stdin, io: channel } = io();
  const picked = pickFromListPlain<string>({
    title: "Search models",
    choices: async (query) => {
      calls.push(query);
      return models
        .filter((id) => id.includes(query))
        .map((id) => ({ value: id, name: id }));
    },
  }, channel, theme);
  await flush();
  type(stdin, "beta");
  await flush();
  press(stdin, "return");
  assert.equal(await picked, "vendor/beta");
  assert.deepEqual(calls, ["", "b", "be", "bet", "beta"]);
});

test("initialValue preselects the matching row so Enter resolves it with no navigation", async () => {
  const { stdin, io: channel } = io();
  const picked = pickFromListPlain({
    title: "Choose a provider",
    choices: choices(),
    initialValue: "kimi-code",
  }, channel, theme);
  await flush();
  press(stdin, "return");
  assert.equal(await picked, "kimi-code");
});

test("a non-TTY channel never throws: resolves the initial value when present, else null", async () => {
  const plainInput = new EventEmitter() as unknown as PlainListIo["input"];
  const plainOutput = new EventEmitter() as unknown as PlainListIo["output"];
  Object.assign(plainInput, { isTTY: false });
  Object.assign(plainOutput, { isTTY: false, write: () => true });

  const withInitial = await pickFromListPlain(
    { title: "Choose a provider", choices: choices(), initialValue: "kimi-code" },
    { input: plainInput, output: plainOutput },
    theme,
  );
  assert.equal(withInitial, "kimi-code");

  const withoutInitial = await pickFromListPlain(
    { title: "Choose a provider", choices: choices() },
    { input: plainInput, output: plainOutput },
    theme,
  );
  assert.equal(withoutInitial, null);
});

test("a disabled initialValue never auto-resolves on a non-TTY channel", async () => {
  const plainInput = new EventEmitter() as unknown as PlainListIo["input"];
  const plainOutput = new EventEmitter() as unknown as PlainListIo["output"];
  Object.assign(plainInput, { isTTY: false });
  Object.assign(plainOutput, { isTTY: false, write: () => true });

  const result = await pickFromListPlain(
    { title: "Choose a provider", choices: choices(), initialValue: "codex" },
    { input: plainInput, output: plainOutput },
    theme,
  );
  assert.equal(result, null);
});

/** Two sections, mirroring the sectioned /chats list (workspace-mobility Phase F1b). */
function sectionedChoices(): readonly PlainListChoice<string>[] {
  return [
    { name: "Current folder", value: "__section__current", sectionHeading: true },
    { name: "Local chat", value: "local-chat", description: "1 message(s)" },
    { name: "Other folders", value: "__section__other", sectionHeading: true },
    { name: "Foreign chat", value: "foreign-chat", description: "2 message(s) · ~/projects/other" },
  ];
}

test("a typed query never shows an orphaned section-heading row (fix round 1, IMPORTANT 1)", async () => {
  const { stdin, stdout, io: channel } = io();
  const picked = pickFromListPlain({ title: "Choose a chat", choices: sectionedChoices() }, channel, theme);
  type(stdin, "folder");
  await flush();
  assert.doesNotMatch(stdout.output, /Current folder/);
  assert.doesNotMatch(stdout.output, /Other folders/);
  press(stdin, "escape");
  await picked;
});

test("an exact heading-text query never resolves to the heading itself, even as the only 'match'", async () => {
  const { stdin, stdout, io: channel } = io();
  const picked = pickFromListPlain({ title: "Choose a chat", choices: sectionedChoices() }, channel, theme);
  // Before the fix, an exact "other folders" query scored the heading row
  // itself as a perfect match (`scoreListEntry`'s exact tier) and rendered
  // it as the sole, selectable-looking result — a dead end that resolves to
  // nothing real. After the fix, headings are excluded outright, so an exact
  // heading-text query honestly reports no matches instead.
  type(stdin, "other folders");
  await flush();
  // V4-A: the footer's `0 matches` segment is gone with the footer. A list
  // with nothing in it now renders the shared never-a-dead-end line, which
  // names the failed query and the way out instead of a bare count.
  assert.match(stdout.output, /No match for "other folders"/);
  // Case-sensitive: the filter line echoes back the typed (lowercase) query
  // text verbatim, so only a rendered row (which preserves the entry's own
  // "Other folders" casing) could produce a case-sensitive match here.
  assert.doesNotMatch(stdout.output, /Other folders/);
  press(stdin, "return");
  await flush();
  press(stdin, "escape");
  assert.equal(await picked, null, "Enter on an empty (heading-only) result set must resolve nothing");
});

test("the counter stays silent on a wholly visible list, filtered or not", async () => {
  const { stdin, stdout, io: channel } = io();
  const picked = pickFromListPlain({ title: "Choose a chat", choices: sectionedChoices() }, channel, theme);
  await flush();
  // Fix round 1 (the counter ruling): `N of M` is the cursor's rank among the
  // rows on offer, drawn exactly when rows lie off screen. Every row of this
  // list is visible before AND after the filter, so it says nothing either
  // way — the old footer's unconditional `2 matches` was chrome that repeated
  // what the rows already showed.
  assert.doesNotMatch(stdout.output, /\d+ of \d+/);
  type(stdin, "Local");
  await flush();
  assert.doesNotMatch(stdout.output, /\d+ of \d+/);
  assert.match(stdout.output, /Local chat/);
  press(stdin, "escape");
  await picked;
});

// ---------------------------------------------------------------------------
// FIX-19 (findings 3 + addendum): terminal ownership.
//
// The flow hunters reproduced, in a real PTY, a `/model` catalog pick opened
// from inside the fullscreen dashboard: the picker's Escape looked dead
// (three presses, the picker stayed), every character typed as a filter was
// mirrored into the fullscreen composer as a draft, and a later Enter
// submitted that polluted draft as a real prompt — an unrequested, PAID run.
// Root cause: both surfaces were attached to stdin at once. The fix is
// ownership (`terminal-lease.ts`), proven here at the seam and, in
// tui.test.ts, against a live `TerminalUi`.
// ---------------------------------------------------------------------------

test("FIX-19: a pick on the real terminal runs inside the owning surface's handover", async () => {
  const handled: string[] = [];
  holdTerminal(async (operation) => {
    handled.push("suspend");
    try {
      return await operation();
    } finally {
      handled.push("restore");
    }
  });
  try {
    const selected = await pickFromListPlain<string>({
      title: "Search models",
      choices: () => {
        handled.push("picker");
        return [];
      },
      initialValue: "anything",
    });
    assert.equal(selected, null);
  } finally {
    holdTerminal(null);
  }
  // The picker never runs alongside the owner — only inside its handover.
  assert.deepEqual(handled, ["suspend", "picker", "restore"]);
  assert.equal(terminalHeld(), false);
});

test("FIX-19: an injected channel is not the shared terminal and never suspends the owner", async () => {
  let suspended = false;
  holdTerminal(async (operation) => {
    suspended = true;
    return operation();
  });
  try {
    const channel = io();
    channel.stdin.isTTY = false;
    channel.stdout.isTTY = false;
    const selected = await pickFromListPlain<string>(
      { title: "Choose a chat", choices: choices(), initialValue: "openrouter" },
      channel.io,
      theme,
    );
    assert.equal(selected, "openrouter");
  } finally {
    holdTerminal(null);
  }
  assert.equal(suspended, false);
});
