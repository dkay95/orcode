/**
 * Block model of the stream (Bauplan K2).
 *
 * The stream is a list of blocks, not a list of glued strings. Every block
 * knows its own state; no renderer ever re-derives meaning from text.
 */

import type { PanelJudgment, PanelResult } from "../panel.js";
import type { ToolRisk } from "../types.js";
import type { DiffHunkView } from "./diff-view.js";

export type { DiffHunkView };

export type BlockState = "running" | "ok" | "unverified" | "failed" | "cancelled";

export const BLOCK_STATES: readonly BlockState[] = Object.freeze([
  "running",
  "ok",
  "unverified",
  "failed",
  "cancelled",
] as const);

export interface BlockBase {
  id: string;
  at: number;
}

export type ChatBlock =
  | (BlockBase & { kind: "user"; text: string; attachmentCount: number })
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
    })
  | (BlockBase & {
      kind: "notice";
      level: "info" | "warn" | "error";
      title: string;
      cause: string[];
      actions: Array<{ key: string; label: string }>;
    })
  | (BlockBase & {
      kind: "panel";
      result: PanelResult;
      judgment: PanelJudgment | null;
      /** Index into `result.answers` shown in full; `null` collapses every answer to its teaser (see `renderPanel`). */
      expandedIndex: number | null;
    });

export type BlockKind = ChatBlock["kind"];

/**
 * Scroll anchor. A block id plus a line offset inside that block survives
 * every re-layout; a plain number offset does not (B10, B11).
 */
export interface Viewport {
  anchor: { blockId: string; lineOffset: number } | "tail";
}

export const TAIL: Viewport = Object.freeze({ anchor: "tail" as const });

/** Visible output lines of a running tool block — the block never grows. */
export const RUNNING_TAIL_LINES = 3;

/** Ring buffer size per tool block. */
export const TAIL_CAPACITY = 200;

/** Collapsed reasoning shows one line; expanded at most this many. */
export const REASONING_MAX_LINES = 12;
