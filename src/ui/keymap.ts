import type { Theme } from "./theme.js";
import type { ActionChip } from "./zones.js";

// ---------------------------------------------------------------------------
// The keymap table (FIX-4). One source of truth for every binding a user is
// expected to find on their own: `/help`'s `─ Shortcuts` section and the `?`
// footer hint both render FROM this array, so neither can drift away from the
// other or from `tui.ts` — the same shape `command-catalog.ts` gives `/help`'s
// command groups (D5). `tests/ui-keymap.test.ts` is the tripwire: every row's
// `proof` must still be found in `tui.ts`'s keypress handlers, and `/help`
// must render every row.
//
// Scope (controller ruling): everything a user coming from another tool would
// otherwise miss — palette, history, thinking toggle, the scroll set, the
// readline set, newline, cancel semantics, approval arming, `@` mentions.
// Purely internal keys (paste bracketing, mouse tokens) are deliberately
// absent, and so are the Settings surface's own category ordinals: since V4-B
// the tab bar prints them beside the categories they select (`●1 Models`), so
// the surface discloses them itself and a `/help` row would be a second copy.
// ---------------------------------------------------------------------------

/** The five screens a binding can belong to, in the order `/help` prints them. */
export const SHORTCUT_CONTEXTS = [
  "Composer",
  "Palette",
  "During a run",
  "Lists & pickers",
  "Settings",
] as const;

export type ShortcutContext = (typeof SHORTCUT_CONTEXTS)[number];

export interface ShortcutBinding {
  readonly context: ShortcutContext;
  /**
   * The key column. `<up>`/`<down>`/`<left>`/`<right>` are placeholders
   * expanded through the theme by `shortcutKeys` — never raw `↑↓`/`←→`
   * literals, so `glyphMode: "ascii"` stays ASCII wherever this column is
   * rendered (`/help`, the `?` hint, and V4's action bars, which all go
   * through `shortcutKeys`). A key named as part of a MODIFIER combination
   * (`Alt+Left`) is still spelled as a word: it is a key name there, not an
   * arrow the reader is meant to see drawn.
   */
  readonly keys: string;
  /** Plain English, one clause. Ellipsized when the row runs out of room. */
  readonly action: string;
  /**
   * Source text that must still exist in `src/tui.ts` for this row to be
   * true. Not a second implementation — a tripwire anchor.
   */
  readonly proof: readonly string[];
  /**
   * Present on the six bindings the `?` footer advertises; the word shown
   * after the key there. Footer order is this table's own order.
   */
  readonly hint?: string;
  /**
   * V4-A (zone 3): the DEFAULT one-word effect this key's action-bar chip
   * shows (`Enter apply`, `Esc cancel`). Present only on the bindings that
   * actually appear on an action bar — `listActionChips` below reads the KEY
   * out of this table and takes the word from here unless the surface hands
   * it a truer one of its own (FIX-11's `commandMenuEnterVerb` computes what
   * Enter really does to the selected row; FIX-5 ruling 4 decides whether Esc
   * says `back` or `close`). A surface may override the word; it may never
   * invent the key, which is what keeps a chip from lying.
   *
   * Lowercase, one clause, English — `tests/ui-keymap.test.ts` pins that,
   * along with the presence of every row `listActionChips` asks for.
   */
  readonly chip?: string;
  /**
   * A binding whose handler is landing in a parallel lane, listed here ahead
   * of time so the table is correct after both merges. The tripwire asserts
   * such a row has NO handler yet — it fails the moment the lane lands, and
   * the fix is to delete this flag.
   */
  readonly pendingLane?: string;
}

export const SHORTCUTS: readonly ShortcutBinding[] = [
  // -- Composer -----------------------------------------------------------
  {
    context: "Composer",
    keys: "/",
    action: "Open the command palette right in the composer",
    hint: "commands",
    proof: ['input.startsWith("/")'],
  },
  {
    context: "Composer",
    keys: "@",
    action: "Put a workspace file into the message",
    hint: "files",
    proof: ["#handleAtKey(key)"],
  },
  {
    context: "Composer",
    keys: "Ctrl+P",
    action: "Open the command palette over an untouched draft",
    hint: "palette",
    proof: ['key.ctrl && key.name === "p"'],
  },
  {
    context: "Composer",
    keys: "Ctrl+O",
    action: "Show or hide the thinking panel (Ctrl+T does the same)",
    hint: "thinking",
    proof: ['key.ctrl && (key.name === "t" || key.name === "o")'],
  },
  {
    context: "Composer",
    keys: "Shift+Enter",
    action: "Add a line break instead of sending",
    hint: "newline",
    proof: ['(key.name === "return" || key.name === "enter") && key.shift'],
  },
  {
    context: "Composer",
    keys: "Enter",
    action: "Send the message",
    proof: ["this.#submit();"],
  },
  {
    context: "Composer",
    keys: "Ctrl+R",
    action: "Search the messages you sent before",
    proof: ['key.ctrl && key.name === "r"'],
  },
  {
    context: "Composer",
    keys: "<up><down>",
    action: "Step back and forth through those messages",
    proof: ["this.#recallHistory("],
  },
  {
    context: "Composer",
    keys: "<down>",
    action: "On an empty composer: move into Recent and quick actions",
    proof: ['key.name !== "down"'],
  },
  {
    context: "Composer",
    keys: "Shift+Tab",
    action: "Cycle the approval mode",
    proof: ['key.name === "tab" && key.shift'],
  },
  {
    context: "Composer",
    keys: "Ctrl+A / Ctrl+E",
    action: "Jump to the start or the end of the line",
    proof: ['key.ctrl && key.name === "a"', 'key.ctrl && key.name === "e"'],
  },
  {
    context: "Composer",
    keys: "Ctrl+U / Ctrl+K",
    action: "Delete back to the start, or on to the end, of the line",
    proof: ['key.ctrl && key.name === "u"', 'key.ctrl && key.name === "k"'],
  },
  {
    context: "Composer",
    keys: "Ctrl+W",
    action: "Delete the word before the cursor",
    proof: ['key.ctrl && key.name === "w"'],
  },
  {
    context: "Composer",
    keys: "Alt+Left / Alt+Right",
    action: "Move the cursor one word at a time",
    proof: ['key.meta && key.name === "left"', 'key.meta && key.name === "right"'],
  },
  {
    context: "Composer",
    keys: "Ctrl+L",
    action: "Redraw the screen after the terminal garbles it",
    proof: ['key.ctrl && key.name === "l"'],
  },
  {
    context: "Composer",
    keys: "PgUp / PgDn",
    action: "Scroll the transcript one page",
    proof: ['key.name === "pageup" || key.name === "pagedown"'],
  },
  {
    context: "Composer",
    keys: "Ctrl+Home / Ctrl+End",
    action: "Jump to the top or the bottom of the transcript",
    proof: ['key.ctrl && (key.name === "home" || key.name === "end")'],
  },
  {
    context: "Composer",
    keys: "End",
    action: "Back to the newest output while scrolled away",
    proof: ['key.name === "end" && this.#viewport.anchor !== "tail"'],
  },
  // -- Palette ------------------------------------------------------------
  {
    context: "Palette",
    keys: "<up><down>",
    action: "Move the selection",
    chip: "select",
    proof: ['intent === "up" || intent === "down"'],
  },
  {
    context: "Palette",
    keys: "Tab",
    action: "Open a group, or put the command in the composer",
    chip: "open",
    proof: ['(key.name === "tab" || key.name === "return") && selected'],
  },
  {
    context: "Palette",
    keys: "Enter",
    action: "Run the highlighted command",
    chip: "run",
    proof: ["#activateCommandLeaf("],
  },
  {
    context: "Palette",
    keys: "Esc",
    action: "Go back one level, or close the palette",
    chip: "close",
    proof: ["else this.#closeCommandMenu();"],
  },
  {
    context: "Palette",
    keys: "Backspace",
    action: "Trim the search, then step back a level",
    proof: ['key.name === "backspace" && menu.query'],
  },
  // -- During a run -------------------------------------------------------
  {
    context: "During a run",
    keys: "Esc",
    action: "End the thinking, or stop the run",
    proof: ["this.#endThinkingHandler?.();"],
  },
  {
    context: "During a run",
    keys: "Ctrl+C",
    action: "Cancel · twice to quit",
    hint: "cancel",
    proof: ['key.ctrl && key.name === "c"'],
  },
  {
    context: "During a run",
    keys: "Enter",
    action: "Send a steer into the running task, or queue it for the next",
    proof: ["this.#queuedInputs.push(value);"],
  },
  // -- Lists & pickers ----------------------------------------------------
  {
    context: "Lists & pickers",
    keys: "Typing",
    action: "Filter the list as you type",
    chip: "filters",
    proof: ["this.#refreshChoices();"],
  },
  {
    context: "Lists & pickers",
    keys: "<up><down>",
    action: "Move the selection",
    chip: "select",
    proof: ["stepSelectableListIndex("],
  },
  {
    context: "Lists & pickers",
    keys: "PgUp / PgDn",
    action: "Move the selection a page at a time",
    proof: ['intent === "pageUp"'],
  },
  {
    context: "Lists & pickers",
    keys: "Enter",
    action: "Take the highlighted entry",
    chip: "apply",
    proof: ["this.#resolveSelection(chosen);"],
  },
  {
    context: "Lists & pickers",
    keys: "Tab",
    action: "Put the highlighted entry in the composer",
    chip: "insert",
    proof: ['key.name === "tab" || key.name === "return"'],
  },
  {
    context: "Lists & pickers",
    keys: "Space",
    action: "Pick more than one, where the list allows it",
    proof: ['interpretListKey(key) === "toggle"'],
  },
  {
    context: "Lists & pickers",
    keys: "Esc",
    action: "Close without choosing anything",
    chip: "cancel",
    proof: ["this.#resolveSelection(null);"],
  },
  // -- Settings -----------------------------------------------------------
  // V4-B: the Settings surface's own five keys, so its action bar is built
  // out of the same table every other bar reads. The category ORDINALS stay
  // out on purpose (see the scope note at the top): the tab bar prints them
  // beside the categories they select, which is closer to the reader than a
  // `/help` row could be, and `←→` is the same jump anyway.
  {
    context: "Settings",
    keys: "<left><right>",
    action: "Switch to the previous or next category",
    chip: "category",
    proof: ['(key.name === "left" || key.name === "right")'],
  },
  {
    context: "Settings",
    keys: "<up><down>",
    action: "Move between the rows of the open category",
    chip: "row",
    proof: ['this.#emitSettingsIntent({ kind: "move", delta: key.name === "up" ? -1 : 1 });'],
  },
  {
    context: "Settings",
    keys: "Enter",
    action: "Change the highlighted setting",
    chip: "change",
    proof: ['this.#emitSettingsIntent({ kind: "activate" });'],
  },
  {
    context: "Settings",
    keys: "/",
    action: "Search every setting in every category",
    chip: "search",
    proof: ['this.#emitSettingsIntent({ kind: "search-start" });'],
  },
  {
    context: "Settings",
    keys: "Esc",
    action: "Leave the search, or close Settings",
    chip: "back",
    proof: ['this.#emitSettingsIntent({ kind: "back" });'],
  },
];

/**
 * The key column as it is printed: `<up>`/`<down>` expanded through the
 * theme's own glyphs, so `glyphMode: "ascii"` never leaks Unicode.
 */
export function shortcutKeys(theme: Theme, binding: ShortcutBinding): string {
  return binding.keys
    .replaceAll("<up>", theme.glyph("scrollUp"))
    .replaceAll("<down>", theme.glyph("scrollDown"))
    .replaceAll("<left>", theme.glyph("scrollLeft"))
    .replaceAll("<right>", theme.glyph("scrollRight"));
}

/**
 * V4-A zone 3: the action bar's chips for a list-shaped surface, taken FROM
 * this table.
 *
 * The keys are looked up here, never spelled at the call site — that is the
 * whole mechanism. Delete the `Esc` row from "Lists & pickers" and every
 * picker's Esc chip disappears with it (and `tests/ui-keymap.test.ts` fails),
 * instead of a hand-written footer going on advertising a key that no longer
 * exists. `<up><down>` is expanded through `shortcutKeys`, so ASCII glyph
 * mode stays ASCII.
 *
 * The effect WORDS are the surface's own truth wherever the surface has one:
 * `enter` carries FIX-11's `commandMenuEnterVerb` result (run/insert/open —
 * what Enter really does to the row under the cursor), `esc` carries FIX-5
 * ruling 4's back-vs-close split, `tab` is present only while the surface
 * actually advertises Tab. Anything left unset falls back to this table's own
 * `chip` word. Order is the mockup's: filter, move, take, insert, leave.
 *
 * This is the one builder that replaced the palette footer
 * (`buildListFooterLine` + its four reshaping options), the generic
 * list-consumer hint (`commandMenuKeyHints`), the fullscreen picker branch of
 * `dashboard-frame.ts`'s `helpText`, and the plain picker's footer — four
 * hand-kept key lines, one derivation.
 */
export function listActionChips(
  theme: Theme,
  context: ShortcutContext,
  verbs: {
    /**
     * V4-B: `←→ category`, the sideways axis. Opt-in like `tab` — only the
     * Settings surface has a second axis, and a surface that does not bind
     * the arrows must not claim them. `true` takes the table's own word,
     * which is what a surface whose verb never varies should pass: then the
     * key AND the word both come from the one source.
     */
    readonly horizontal?: string | true;
    /** Shown as `Typing filters` ahead of everything else. */
    readonly typing?: boolean;
    readonly select?: string;
    readonly enter?: string;
    /** Omitted entirely when unset — a surface that does not bind Tab must not claim it. */
    readonly tab?: string;
    /** V4-B: `/ search`. Opt-in, `true` for the table's own word — see `horizontal`. */
    readonly search?: string | true;
    readonly esc?: string;
  },
): ActionChip[] {
  /** `true` means "no override" — `chip` then falls back to the table's own word. */
  const tableWord = (verb: string | true): string | undefined =>
    verb === true ? undefined : verb;
  const chip = (keys: string, priority: number, effect?: string): ActionChip | null => {
    const binding = SHORTCUTS.find((item) => item.context === context && item.keys === keys);
    const word = effect ?? binding?.chip;
    if (!binding || !word) return null;
    return { key: shortcutKeys(theme, binding), effect: word, priority };
  };
  // The shedding order a narrow terminal follows (`ActionBarOptions.width`).
  // The way OUT ranks highest — FIX-11 addendum ruling A's rule, that a hint
  // may get shorter but the escape key is never what disappears — then what
  // Enter does, then Tab, and last the two a reader can find by trying: the
  // arrows and the "typing filters" hint.
  //
  // V4-B inserts the two Settings-only slots at the ranks F6 ruling 3 already
  // gave them on the old settings footer: `/ search` above the category axis
  // (bound but undiscoverable, so it outranks the axis a reader can find by
  // pressing an arrow), both below Enter.
  //
  // Chip ORDER is the mockup's, per surface: `←→ category  ↑↓ row  Enter
  // change  / search  Esc back`, and `Typing filters  ↑↓ select  Enter apply
  // …` for a picker. One list, because the two orders agree everywhere they
  // overlap.
  return [
    ...(verbs.horizontal === undefined ? [] : [chip("<left><right>", 75, tableWord(verbs.horizontal))]),
    ...(verbs.typing ? [chip("Typing", 50)] : []),
    chip("<up><down>", 60, verbs.select),
    chip("Enter", 90, verbs.enter),
    ...(verbs.tab === undefined ? [] : [chip("Tab", 70, verbs.tab)]),
    ...(verbs.search === undefined ? [] : [chip("/", 80, tableWord(verbs.search))]),
    chip("Esc", 100, verbs.esc),
  ].filter((item): item is ActionChip => item !== null);
}

/** The table split into `/help`'s printed order; empty contexts are dropped. */
export function shortcutsByContext(): ReadonlyArray<{
  readonly context: ShortcutContext;
  readonly bindings: readonly ShortcutBinding[];
}> {
  return SHORTCUT_CONTEXTS.map((context) => ({
    context,
    bindings: SHORTCUTS.filter((binding) => binding.context === context),
  })).filter((group) => group.bindings.length > 0);
}

/**
 * The one-line `?` footer hint: the six most-missed bindings, in table order,
 * `<key> <word>` joined by the theme's separator. Muted and single-line by
 * contract — the full table lives in `/help`.
 */
export function shortcutHintLine(theme: Theme): string {
  return SHORTCUTS
    .filter((binding) => binding.hint)
    .map((binding) => `${shortcutKeys(theme, binding)} ${binding.hint}`)
    .join(theme.glyph("separator"));
}
