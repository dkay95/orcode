/**
 * Block model of the stream (Bauplan K2).
 *
 * The stream is a list of blocks, not a list of glued strings. Every block
 * knows its own state; no renderer ever re-derives meaning from text.
 */

import type { PanelJudgment, PanelResult } from "../panel.js";
import type { NoticeKind, ToolRisk } from "../types.js";
import { TOOL_BLOCK_STATES, type ToolBlockState } from "../utils.js";
import type { DiffHunkView } from "./diff-view.js";

/**
 * The five states, declared in `utils.ts` — the one module with no imports,
 * so the surface that has no Node underneath it (the desktop window) shares
 * these words and the function that assigns them instead of keeping a copy.
 * `utils.ts` imports nothing, so this direction cannot cycle.
 */
export type BlockState = ToolBlockState;

export const BLOCK_STATES: readonly BlockState[] = TOOL_BLOCK_STATES;

// Not exported (F6 dead-layer sweep): nothing outside this file's own
// ChatBlock union below needs the shared base fields by name.
interface BlockBase {
  id: string;
  at: number;
}

export type ChatBlock =
  | (BlockBase & {
      kind: "user";
      text: string;
      attachmentCount: number;
      /**
       * True for a mid-run interjection (Phase 3b, Part B): rendered with the
       * `interject` glyph plus an acceptance footer instead of the plain
       * user gutter.
       */
      interjected?: boolean;
    })
  | (BlockBase & { kind: "assistant"; text: string; costUsd?: number })
  | (BlockBase & {
      kind: "reasoning";
      text: string;
      tokens: number;
      /** True while `tokens` is a live estimate, not the provider's count. */
      estimated: boolean;
      live: boolean;
      expanded: boolean;
      truncated: boolean;
    })
  | (BlockBase & {
      kind: "tool";
      tool: string;
      label: string;
      title: string;
      input: string;
      state: BlockState;
      durationMs?: number;
      exitCode?: number;
      tail: string[];
      totalLines: number;
      step: number;
      expanded: boolean;
    })
  | (BlockBase & {
      kind: "diff";
      path: string;
      added: number;
      removed: number;
      hunks: DiffHunkView[];
      hiddenHunks: number;
      /** True when the differ itself dropped changed lines, not just hunks. */
      truncated: boolean;
      state: BlockState;
      undoable: boolean;
    })
  | (BlockBase & {
      kind: "approval";
      risk: ToolRisk;
      summary: string;
      details: string[];
      diff?: DiffHunkView[];
      waitingSince: number;
      rememberHint: string;
      /**
       * Audit FIX-1 (2026-08-28): approvals with more than
       * `APPROVAL_DETAIL_LINES` detail lines advertise `Ctrl+O shows all` —
       * this flag (toggled by Ctrl+O/Ctrl+T inside confirm mode, the same
       * `RunViewModel.toggle` mechanism tool/reasoning blocks use) makes
       * that hint true: expanded shows every detail line, so a large write
       * is never approved blind.
       */
      expanded: boolean;
    })
  | (BlockBase & {
      kind: "notice";
      /**
       * FIX-14 ticket 5: the shared vocabulary (`NoticeKind`, types.ts).
       * This used to be its own three-value union while the settings slot
       * one keystroke away had a different four-value one. Narrowed here to
       * the three a transcript block can actually render: a transcript is a
       * record of what HAPPENED, so "busy" (an in-progress state, which
       * belongs in a slot that can be replaced) and "success" (the
       * transcript already shows the thing that succeeded) have no meaning
       * on a block — but they are excluded FROM the one vocabulary rather
       * than by declaring a second one.
       */
      level: Exclude<NoticeKind, "busy" | "success">;
      title: string;
      cause: string[];
      /**
       * D3 (owner design batch): render-layer repeat collapse. Set once a
       * second, third, … identical notice (same title + cause) arrives right
       * after this one — `pushNotice` (view-model.ts) increments this in
       * place instead of appending a new block. `undefined`/`1` both mean
       * "no repeats yet"; the renderer only shows the `× N` suffix once this
       * is `>= 2`. Persisted session history never sees this field — it
       * exists purely on the live in-memory block.
       */
      repeatCount?: number;
    })
  | (BlockBase & {
      kind: "panel";
      result: PanelResult;
      judgment: PanelJudgment | null;
      /** Index into `result.answers` shown in full; `null` collapses every answer to its teaser (see `renderPanel`). */
      expandedIndex: number | null;
    });

/**
 * FIX-17 (fresh-launch audit): the ONE hub-compatibility rule. A transcript
 * still counts as "the start hub" while it carries ONLY notice blocks (any
 * level — info, warn, error): a cancelled provider setup, a coming-soon
 * disclosure, a surfaced startup warning are all commentary ABOUT the empty
 * chat, not conversation IN it. The moment any user/assistant/reasoning/
 * tool/diff/approval/panel block exists, real content has started and the
 * hub (and its quick-action selection) yields to the transcript for good.
 *
 * Shared by all three hub-detection seams — `dashboard-frame.ts`'s D8d
 * `isHub`, `render-frame.ts`'s structural `isHub`, and `tui.ts`'s
 * quick-action arming condition — precisely so the definition cannot drift
 * between them (the pre-FIX-17 `blocks.length === 0` copies did, and a
 * single startup notice then killed the hub for the whole session).
 */
export function isHubTranscript(blocks: readonly ChatBlock[]): boolean {
  return blocks.every((block) => block.kind === "notice");
}

/**
 * Scroll anchor. A block id plus a line offset inside that block survives
 * every re-layout; a plain number offset does not (B10, B11).
 */
export interface Viewport {
  anchor: { blockId: string; lineOffset: number } | "tail";
}

export const TAIL: Viewport = Object.freeze({ anchor: "tail" as const });

/**
 * The tail budgets moved to `utils.ts` (G3, the G2 debt list) so the window
 * keeps the same amount of output the terminal keeps rather than its own
 * round number. Re-exported here so every existing importer is unchanged.
 */
export { REASONING_MAX_LINES, RUNNING_TAIL_LINES, TAIL_CAPACITY } from "../utils.js";
