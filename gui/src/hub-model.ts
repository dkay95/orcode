/**
 * The hub's rows — the same sentence the terminal writes, from the same
 * function.
 *
 * `formatChatRow` (`src/utils.ts`) composes "N messages · $cost · model ·
 * age [· folder]" and is used verbatim by the `/chats` picker and the start
 * hub. This screen imports it rather than re-typing it, so the GUI cannot
 * drift from the TUI on a chat's own summary — including the parts that are
 * honesty rules rather than formatting: `formatChatCost` renders
 * "provider-managed / unknown" instead of a fabricated `$0.00`, and
 * `formatMessageCount` says "80+ messages" at the retention cap instead of
 * silently saturating.
 */

import {
  formatChatCost,
  formatChatRow,
  formatUsd,
  isLowBalance,
  relativeAge,
  shortModelName,
} from "@core/utils";

import type { ChatRow, GuiStatus } from "./protocol.js";

/** The separator the V4 grammar uses; spaces baked in, as everywhere else. */
export const SEPARATOR = " · ";

export interface HubRow {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly workspace: string;
  /** True when the chat lives in another folder — opening it RE-ROOTS. */
  readonly foreign: boolean;
  /*
   * Desktop v2 lays a recent chat out over two lines instead of one, so the
   * sidebar needs the row's facts SEPARATELY as well as composed.
   *
   * They are not cut out of `detail` — a string split is exactly how two
   * surfaces start disagreeing about a chat. Each part below is produced by
   * the SAME shared formatter `formatChatRow` composes with (`relativeAge`,
   * `formatChatCost`, `shortModelName`), so every individual fact still has
   * one source; only the arrangement differs, and `detail` keeps the
   * terminal's own composed sentence for the row's tooltip.
   */
  readonly age: string;
  readonly cost: string;
  readonly model: string;
  /** The abbreviated folder, and only for a chat that lives in another one. */
  readonly folder: string | null;
}

/** `/Users/me/x` → `~/x`, for a row that has to name someone else's folder. */
export function abbreviateHome(path: string, homeDir: string | null): string {
  if (!homeDir) return path;
  if (path === homeDir) return "~";
  return path.startsWith(`${homeDir}/`) ? `~${path.slice(homeDir.length)}` : path;
}

/**
 * `nowMs` is the FALLBACK instant for a row whose `updatedAt` will not
 * parse — the age itself is `formatChatRow`'s own reading of the clock, and
 * this side does not get a second one.
 */
export function hubRows(
  chats: readonly ChatRow[],
  currentWorkspace: string,
  homeDir: string | null,
  nowMs: number,
  limit = 8,
): readonly HubRow[] {
  return chats.slice(0, limit).map((chat) => {
    const foreign = Boolean(chat.workspace) && chat.workspace !== currentWorkspace;
    const folder = foreign ? abbreviateHome(chat.workspace, homeDir) : undefined;
    const parsed = Date.parse(chat.updatedAt);
    const updatedAt = Number.isNaN(parsed) ? nowMs : parsed;
    const { label, description } = formatChatRow(chat, updatedAt, folder, SEPARATOR);
    return {
      id: chat.id,
      title: label,
      detail: description,
      workspace: chat.workspace,
      foreign,
      // `formatChatRow` reads the clock itself (`relativeAge(Date.now(), …)`),
      // so the composed sentence and this part are the same reading of the
      // same instant.
      age: relativeAge(Date.now(), updatedAt),
      cost: formatChatCost(chat, SEPARATOR),
      model: chat.model ? shortModelName(chat.model) : "",
      folder: folder ?? null,
    };
  });
}

export interface StatusSegments {
  readonly approval: string;
  readonly model: string;
  readonly chat: string;
  readonly folder: string;
  /** Omitted entirely when unknown — absent never means free. */
  readonly today: string | null;
  readonly session: string;
  readonly balance: string | null;
  readonly balanceLow: boolean;
  readonly routeConnected: boolean | undefined;
}

/**
 * The status line, tri-states intact.
 *
 * Every "null" here means the engine did not claim a figure, and the segment
 * is left out rather than rendered as zero: `balanceRemainingUsd:undefined`
 * with `providerManaged` is the difference between "we do not know" and
 * "free", and `sessionCostKnowledge:"unknown"` means the session total is a
 * floor, not a total.
 */
export function statusSegments(status: GuiStatus, homeDir: string | null): StatusSegments {
  return {
    approval: status.approval,
    model: status.resolvedModel || status.model,
    chat: status.chatTitle,
    folder: abbreviateHome(status.workspace, homeDir),
    // The FIGURES are the engine's, through the shared `formatUsd`; the words
    // around them are this window's own chrome, and Desktop v2's chrome is
    // German (the mockup's `$0.006 heute` / `$0.006 dieser Chat`). Nothing the
    // wire SAYS is translated here — only the labels this file writes itself.
    today: status.dayUsd === undefined ? null : `${formatUsd(status.dayUsd)} heute`,
    session: status.sessionCostKnowledge === "unknown"
      // The engine says the total is not fully known; "mindestens" is the same
      // hedge `formatChatCost` states as "at least" for exactly this case.
      ? `mindestens ${formatUsd(status.sessionUsd)} dieser Chat`
      : `${formatUsd(status.sessionUsd)} dieser Chat`,
    balance: status.providerManaged
      // The codebase's own term for a cost nobody local can price — kept as
      // the shared vocabulary `formatChatCost` prints, not translated.
      ? "provider-managed"
      : status.balanceRemainingUsd === undefined
        ? null
        : `${formatUsd(status.balanceRemainingUsd)} übrig`,
    balanceLow: isLowBalance(status.balanceRemainingUsd, status.lowBalanceThresholdUsd),
    routeConnected: status.routeConnected,
  };
}
