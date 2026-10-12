/**
 * The plain (non-fullscreen) renderer for the list core (Phase F1).
 *
 * Replaces every `@inquirer/prompts` `select`/`search` call in the codebase
 * (cli.ts's cross-gate plain surface + resume-choice prompt, the 3
 * setup-surface plain sites, commands.ts's two model-search sites) with one
 * engine, sharing list-core.ts's data model, fuzzy filter, navigation and
 * key classification with the fullscreen TUI pickers and the command menu.
 * "Plain" contrasts with the TUI's alternate-screen frame buffer, not with
 * interactivity: this still redraws in place (arrow keys, live typing
 * filter, Enter/Esc) inside the normal scrolling terminal — a
 * "line-printed" variant of the exact same picker, using the full V3
 * anatomy (header/filter/footer) from day one since, unlike the fullscreen
 * pickers, there is no pre-existing visual output to keep pinned.
 */

import { emitKeypressEvents, type Key } from "node:readline";
import { renderLines } from "./compose.js";
import {
  buildListEmptyLine,
  buildListFilterLine,
  buildListLines,
  filterListEntries,
  interpretListKey,
  isListEntryDisabled,
  LIST_PAGE_STEP,
  stepSelectableListIndex,
  type ListEntry,
} from "./list-core.js";
import { listActionChips } from "./keymap.js";
import { withTerminalHandover } from "./terminal-lease.js";
import { createTheme, type Theme } from "./theme.js";
import { actionBarLine, titleBarLine } from "./zones.js";

export interface PlainListChoice<T> {
  readonly value: T;
  readonly name: string;
  readonly description?: string;
  /** See `ListEntry.descriptionParts` (list-core.ts) — indivisible description parts, shed whole. */
  readonly descriptionParts?: readonly string[];
  readonly current?: string | boolean;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  /**
   * A non-selectable divider row introducing a section (`ListSection`,
   * `withListSections`, workspace-mobility Phase F1b's sectioned `/chats`
   * list — "current folder" then "Other folders"). `value` is never read for
   * such a row; navigation skips it (`stepSelectableListIndex`) and Enter is
   * a no-op on it (`isListEntryDisabled`).
   */
  readonly sectionHeading?: boolean;
}

export type PlainListChoiceSource<T> =
  | readonly PlainListChoice<T>[]
  | ((query: string) => readonly PlainListChoice<T>[] | Promise<readonly PlainListChoice<T>[]>);

export interface PlainListPrompt<T> {
  readonly title: string;
  readonly context?: string;
  readonly choices: PlainListChoiceSource<T>;
  /** Which choice starts selected — compared with `isSame` (defaults to `===`). */
  readonly initialValue?: T;
  readonly isSame?: (a: T, b: T) => boolean;
  readonly enterVerb?: string;
  readonly escVerb?: string;
}

export interface PlainListIo {
  readonly input: NodeJS.ReadableStream & {
    readonly isTTY?: boolean;
    setRawMode?: (mode: boolean) => unknown;
  };
  readonly output: NodeJS.WritableStream & {
    readonly isTTY?: boolean;
    readonly columns?: number;
  };
}

function defaultIo(): PlainListIo {
  return { input: process.stdin, output: process.stdout };
}

function toEntry<T>(choice: PlainListChoice<T>): ListEntry {
  return {
    name: choice.name,
    description: choice.description,
    ...(choice.descriptionParts ? { descriptionParts: choice.descriptionParts } : {}),
    current: choice.current,
    disabled: choice.disabled,
    disabledReason: choice.disabledReason,
    sectionHeading: choice.sectionHeading,
  };
}

/** The first selectable (non-heading) index at or after `from`, clamped to the list. */
function firstSelectableIndex<T>(choices: readonly PlainListChoice<T>[], from: number): number {
  if (!choices[from]?.sectionHeading) return Math.max(0, from);
  return stepSelectableListIndex(choices.map(toEntry), from, 1);
}

const CANCEL_LINE = "Cancelled.";

/** Visible row cap — matches the `pageSize: 12` every migrated Inquirer `search` call used. */
const VISIBLE_ROWS = 12;

/**
 * Runs one interactive pick list on the normal (non-alternate-screen)
 * terminal. Resolves the chosen value, or `null` on Escape/Ctrl+C — never
 * throws to signal a cancel (call sites that need to distinguish a genuine
 * I/O error still see it as a rejection).
 */
export async function pickFromListPlain<T>(
  prompt: PlainListPrompt<T>,
  io: PlainListIo = defaultIo(),
  theme: Theme = createTheme(),
): Promise<T | null> {
  // FIX-19 (findings 3 + addendum): on the real terminal this picker must
  // own stdin alone. A fullscreen surface that is still attached reads the
  // same bytes — its next render buries this frame (Escape then looks dead
  // while the picker is in fact still open) and every filter character is
  // ALSO typed into its composer, where a later Enter submits the polluted
  // draft as a real, paid prompt. `withTerminalHandover` suspends whatever
  // owns the terminal for exactly the duration of this pick, and is a plain
  // pass-through when nothing does. An injected `io` (tests, a piped
  // stream) is not the shared terminal, so it never triggers a handover.
  return io.input === process.stdin
    ? withTerminalHandover(() => runPlainList(prompt, io, theme))
    : runPlainList(prompt, io, theme);
}

async function runPlainList<T>(
  prompt: PlainListPrompt<T>,
  io: PlainListIo,
  theme: Theme,
): Promise<T | null> {
  const isSame = prompt.isSame ?? ((a: T, b: T) => a === b);
  const staticChoices = typeof prompt.choices === "function" ? null : prompt.choices;
  // V4-C ruling: like the frame renderer (`usableWidth = width - 1`), the
  // plain picker never spends the terminal's last column — a glyph written
  // there arms autowrap on many terminals, and one wrapped line breaks the
  // cursor-up repaint for the whole frame below it.
  const width = Math.max(40, (io.output.columns || 80) - 1);
  // V4-A zone 3: the same two call-site verbs this picker always took, now
  // rendered as chips whose KEYS come from the one keymap table. `enterVerb`
  // still defaults to "select" (not the table's "apply") because that is the
  // wording every plain call site has been reading for two releases; the
  // table's word is a default for surfaces with nothing truer to say.
  const chips = listActionChips(theme, "Lists & pickers", {
    typing: true,
    enter: prompt.enterVerb ?? "select",
    esc: prompt.escVerb ?? "cancel",
  });

  const interactive = io.input.isTTY === true
    && io.output.isTTY === true
    && typeof io.input.setRawMode === "function";

  async function resolveChoices(query: string): Promise<readonly PlainListChoice<T>[]> {
    if (staticChoices) {
      if (!query.trim()) return staticChoices;
      // A live search flattens sections outright (mirrors tui.ts's
      // fullscreen `#refreshChoices`): a heading never matches typed text
      // and would otherwise survive `filterListEntries` as an orphaned,
      // unlabeled row — or, on an exact "other folders"-style query, rank
      // ahead of the real matches it was supposed to introduce.
      const selectable = staticChoices.filter((choice) => !choice.sectionHeading);
      return filterListEntries(selectable, query, (choice) => ({
        name: choice.name,
        description: choice.description,
        ...(choice.descriptionParts ? { descriptionParts: choice.descriptionParts } : {}),
      }));
    }
    return (prompt.choices as (q: string) => readonly PlainListChoice<T>[] | Promise<readonly PlainListChoice<T>[]>)(query);
  }

  if (!interactive) {
    // Non-interactive stdin/stdout (piped, redirected, no raw mode): there is
    // no live redraw to do — print the picker's title once and resolve to
    // the caller's initial value if one was given, else cancel. This never
    // throws, matching the interactive path's contract.
    const initial = prompt.initialValue;
    if (initial === undefined) return null;
    const choices = await resolveChoices("");
    const match = choices.find((choice) => isSame(choice.value, initial as T));
    return match && !isListEntryDisabled(toEntry(match)) ? match.value : null;
  }

  return new Promise<T | null>((resolve) => {
    let query = "";
    let selectedIndex = 0;
    let choices: readonly PlainListChoice<T>[] = staticChoices ?? [];
    let generation = 0;
    let previousLineCount = 0;
    let settled = false;

    const write = (text: string): void => {
      io.output.write(text);
    };

    const clearFrame = (): void => {
      if (previousLineCount > 0) write(`\x1b[${previousLineCount}A\x1b[0J`);
      previousLineCount = 0;
    };

    const render = (): void => {
      clearFrame();
      const entries = choices.map(toEntry);
      // V4-A: this picker wears the same three zones as the fullscreen ones.
      // Zone 1 replaces the old `❯─● <Title> · <context>` header row — same
      // line, same position, same text (the optional context still joins on
      // the theme separator, since a crumb chevron would claim a hierarchy
      // these callers do not have). Zone 3 replaces the footer's verb join;
      // its match count is gone from the line because the rows' own corner
      // counter (`buildListLines`) is the product's single counter now, and
      // it discloses exactly when there IS something off screen.
      const title = prompt.context
        ? `${prompt.title}${theme.glyph("separator")}${prompt.context}`
        : prompt.title;
      // The old footer's `<n> matches` segment, kept where V4 keeps it.
      // "Where am I among what is on offer" is the one overflow counter
      // (`buildListLines`, drawn exactly when rows lie off screen — fix round
      // 1's ruling: `N` is the cursor's rank in every state). "None at all"
      // is the shared never-a-dead-end line, which states the failed query
      // and the way out instead of a bare `0 matches`.
      const lines = [
        titleBarLine(theme, title, { width }),
        buildListFilterLine(theme, query),
        ...(entries.length === 0
          ? [buildListEmptyLine(
              theme,
              `No match for "${query}" ${theme.glyph("emdash")} Backspace narrows less`
                + `${theme.glyph("separator")}Esc ${prompt.escVerb ?? "cancel"}`,
            )]
          : buildListLines(
              { entries, selectedIndex },
              width,
              Math.min(VISIBLE_ROWS, Math.max(1, entries.length)),
              theme,
            )),
        actionBarLine(theme, chips, { width }),
      ];
      const text = renderLines(lines, theme).join("\n");
      write(`${text}\n`);
      previousLineCount = lines.length;
    };

    const finish = (value: T | null, summary: string): void => {
      if (settled) return;
      settled = true;
      clearFrame();
      write(`${summary}\n`);
      cleanup();
      resolve(value);
    };

    const refresh = async (): Promise<void> => {
      const mine = (generation += 1);
      const next = await resolveChoices(query);
      if (mine !== generation || settled) return;
      choices = next;
      const initial = prompt.initialValue;
      const initialIndex = query.trim() || initial === undefined
        ? -1
        : choices.findIndex((choice) => isSame(choice.value, initial as T));
      selectedIndex = firstSelectableIndex(choices, Math.max(0, initialIndex));
      render();
    };

    const onKeypress = (character: string, key: Key): void => {
      if (settled) return;
      if (key.ctrl && key.name === "c") {
        finish(null, CANCEL_LINE);
        return;
      }
      const intent = interpretListKey(key);
      if (intent === "escape") {
        finish(null, CANCEL_LINE);
        return;
      }
      if (intent === "enter") {
        const chosen = choices[selectedIndex];
        if (!chosen || isListEntryDisabled(toEntry(chosen))) return;
        finish(chosen.value, `${prompt.title}: ${chosen.name}`);
        return;
      }
      if (intent === "up" || intent === "down" || intent === "pageUp" || intent === "pageDown") {
        const delta = intent === "up" ? -1 : intent === "down" ? 1 : intent === "pageUp" ? -LIST_PAGE_STEP : LIST_PAGE_STEP;
        selectedIndex = stepSelectableListIndex(choices.map(toEntry), selectedIndex, delta);
        render();
        return;
      }
      if (intent === "backspace") {
        if (query.length === 0) return;
        query = query.slice(0, -1);
        void refresh();
        return;
      }
      if (character && !key.ctrl && !key.meta && character >= " ") {
        query += character;
        void refresh();
      }
    };

    const cleanup = (): void => {
      io.input.off("keypress", onKeypress);
      io.input.setRawMode?.(false);
      io.input.pause?.();
    };

    emitKeypressEvents(io.input as NodeJS.ReadStream);
    io.input.setRawMode?.(true);
    io.input.resume?.();
    io.input.on("keypress", onKeypress);
    void refresh();
  });
}
