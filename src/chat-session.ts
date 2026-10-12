/**
 * Opening a chat — the session handoff and the workspace re-root — with no
 * surface of its own.
 *
 * Sibling of `run-session.ts` and extracted for the same reason: until G1b
 * this was the second half of `pickDashboardChat` (cli.ts), inseparable from
 * the terminal picker that chose the row. The GUI's hub is a Recent list too,
 * and its rows must do exactly what the TUI's do — adopt the chat's route,
 * re-root the workspace when the chat lives elsewhere, and say so — so the
 * machinery moved here against a port and `pickDashboardChat` kept only the
 * picker.
 *
 * Deliberately NOT a redesign: the body below is the dashboard's own code,
 * moved. Same order, same wording, same honesty rules — most importantly the
 * `isUntouched` ghost-file guard (D8c / FIX-20 finding 7), which is why a
 * `+ New Chat` pick does not leave a permanent empty file behind.
 *
 * `ChatSessionSurface`'s members are `TerminalUi` method names, so the
 * dashboard passes its `ui` directly and nothing translates in between.
 */

import { homedir } from "node:os";
import { basename } from "node:path";

import type { RouteIdentityV1 } from "./backends.js";
import { ProviderSetupRequiredError } from "./backends.js";
import { saveConfig, type OrcodeConfigWithBudget } from "./config.js";
import { getReasoningSetting, setReasoningSetting } from "./reasoning.js";
import { validateRouteIdentityV1 } from "./provider-state.js";
import type { ProviderConnectionStateV3 } from "./provider-state.js";
import {
  SessionStore,
  listChatsAcrossWorkspaces,
  type CrossWorkspaceChat,
  type SaveOutcome,
} from "./session.js";
import { STALE_CHAT_DELETE_TITLE, staleChatDeleteDetails } from "./commands.js";
import { abbreviateHome } from "./ui/workbench.js";
import type { ChatTurn } from "./types.js";
import type { WorkspaceReRootResult } from "./workspace.js";
import type { SetupSurface } from "./setup-surface/index.js";
import type { OrcodeAgent } from "./agent.js";

/**
 * How many turns a surface loads when a chat opens. One definition; the
 * dashboard imports it rather than keeping a second copy.
 */
export const VISIBLE_TURNS = 40;

/** What opening a chat says to a surface — and nothing else. */
export interface ChatSessionSurface {
  addMessage(
    role: "user" | "assistant" | "system" | "error",
    content: string,
    meta?: string,
  ): void;
  setStatus(status: string, busy?: boolean): void;
  loadTurns(turns: readonly ChatTurn[], maximum?: number): void;
  /**
   * D4: the stale-entry deletion is the one destructive question this path
   * asks, and it is danger-class — an explicit yes, never Enter.
   */
  confirmAction(
    title: string,
    details: string,
    options?: { danger?: boolean },
  ): Promise<{ accepted: boolean }>;
}

/** The runtime context members a chat switch touches. Structural on purpose. */
export interface ChatSessionContext {
  workspace: string;
  config: OrcodeConfigWithBudget;
  configPath: string;
  session: SessionStore;
  agent: OrcodeAgent | null;
  readonly providerRuntime: {
    migratedSessionConnection(): ProviderConnectionStateV3 | undefined;
    currentSessionRoute?(): RouteIdentityV1;
    selectSessionRoute?(
      route: RouteIdentityV1,
      surface?: SetupSurface | "plain" | "fullscreen",
    ): Promise<RouteIdentityV1>;
    transitionModel(
      modelId: string,
      canonicalModelId?: string,
      surface?: SetupSurface | "plain" | "fullscreen",
    ): Promise<unknown>;
    adoptSession?(session: SessionStore): void;
  };
  providerRouteSurface?: SetupSurface | "plain" | "fullscreen";
  reRootWorkspace?(newWorkspace: string): Promise<WorkspaceReRootResult>;
  commitSessionHandoff?(session: SessionStore): void;
  readonly localRuntime: { setSession(session: SessionStore): void };
}

/**
 * The state a switch is decided against, read once before a row is chosen.
 *
 * Shared by the terminal picker and the GUI's `chat.open`, so both compute
 * "which route was active" and "which chats exist" the same way.
 */
export interface ChatSwitchContext {
  readonly selectedRoute: RouteIdentityV1 | null;
  readonly previousRoute: RouteIdentityV1 | null;
  readonly migratedConnection: ProviderConnectionStateV3 | undefined;
  readonly allChats: readonly CrossWorkspaceChat[];
  readonly chatById: ReadonlyMap<string, CrossWorkspaceChat>;
  /**
   * FIX-20, finding 9: a foreign pick re-roots the runtime under the user's
   * feet. Captured before anything moves so the confirmation can compare
   * against `context.workspace` afterwards and report what actually happened,
   * rather than re-deriving it from the picked chat.
   */
  readonly workspaceBeforePick: string;
}

export async function readChatSwitchContext(
  context: ChatSessionContext,
): Promise<ChatSwitchContext> {
  let selectedRoute: RouteIdentityV1 | null = null;
  let previousRoute = validateRouteIdentityV1(context.session.data.route);
  if (typeof context.providerRuntime.currentSessionRoute === "function") {
    try {
      selectedRoute = context.providerRuntime.currentSessionRoute();
      previousRoute = selectedRoute;
    } catch (error) {
      if (
        !(error instanceof ProviderSetupRequiredError)
        && !(typeof error === "object" && error !== null && "code" in error
          && error.code === "provider-setup-required")
      ) {
        throw error;
      }
    }
  }
  const migratedConnection = context.providerRuntime.migratedSessionConnection();
  const allChats = await listChatsAcrossWorkspaces(
    context.session.appHome,
    migratedConnection,
  );
  return {
    selectedRoute,
    previousRoute,
    migratedConnection,
    allChats,
    chatById: new Map(allChats.map((chat) => [chat.id, chat])),
    workspaceBeforePick: context.workspace,
  };
}

/** What a surface asked to open. */
export type ChatSelection =
  | { readonly kind: "new"; readonly title?: string }
  | { readonly kind: "existing"; readonly chatId: string };

export interface OpenChatInput {
  readonly surface: ChatSessionSurface;
  readonly context: ChatSessionContext;
  readonly switchContext: ChatSwitchContext;
  readonly selection: ChatSelection;
}

/**
 * Everything a chat pick does once a row has been chosen.
 *
 * Returns `false` when nothing moved: the same chat was already open, the
 * chat's folder cannot be trusted, or the re-root was refused. Each of those
 * says why on the surface before returning — a silent `false` would leave a
 * hub row looking broken.
 */
export async function openChatSelection(input: OpenChatInput): Promise<boolean> {
  const { surface, context, switchContext, selection } = input;
  const { chatById, migratedConnection, previousRoute, workspaceBeforePick } = switchContext;
  let selectedRoute = switchContext.selectedRoute;
  const home = homedir();

  let next: SessionStore;
  if (selection.kind === "new") {
    next = selection.title
      ? SessionStore.create(context.workspace, context.session.appHome, selection.title)
      : SessionStore.create(context.workspace, context.session.appHome);
  } else {
    if (selection.chatId === context.session.data.id) {
      return false;
    }
    const target = chatById.get(selection.chatId);
    if (target && target.workspace !== context.workspace) {
      if (!target.workspaceVerified) {
        surface.addMessage(
          "system",
          `"${target.title}" has no folder orcode can trust — it cannot be reopened from here.`,
          "Chats",
        );
        return false;
      }
      // `reRootWorkspace` is always wired in production (`runCli`); this
      // branch is only reachable from a lightweight test context that never
      // set it, so it deliberately carries no `reason` — the stale-entry
      // offer below only ever fires for a real "not-found"/"not-a-directory".
      const outcome = await context.reRootWorkspace?.(target.workspace) ?? {
        ok: false as const,
        message: "This surface cannot switch folders.",
      };
      if (!outcome.ok) {
        surface.addMessage("error", outcome.message, "Chats");
        if (outcome.reason === "not-found" || outcome.reason === "not-a-directory") {
          // FIX-20, finding 10: D4 danger class (the explicit `y` confirm,
          // which `confirmAction` defaults to) with copy that names the
          // irreversible thing it does — see `staleChatDeleteDetails`.
          const remove = await surface.confirmAction(
            STALE_CHAT_DELETE_TITLE,
            staleChatDeleteDetails(target.title, target.workspace),
            { danger: true },
          );
          if (remove.accepted) {
            const deletion = await SessionStore.remove(
              target.workspace,
              target.id,
              context.session.appHome,
            );
            surface.addMessage(
              deletion.errors.length > 0 ? "error" : "system",
              deletion.errors.length > 0
                ? "Stale entry could not be fully removed."
                : `Stale entry removed: ${target.title}`,
              "Chats",
            );
          }
        }
        return false;
      }
      if (outcome.homeWarning) {
        surface.addMessage("system", outcome.homeWarning, "Chats");
      }
    }
    next = await SessionStore.openById(
      context.workspace,
      selection.chatId,
      context.session.appHome,
      migratedConnection,
    );
    const historicalRoute = validateRouteIdentityV1(next.data.route);
    if (next.data.routeCleared) {
      // The lifecycle tombstone is authoritative over the route of the chat
      // that happened to be open before the switch.
      selectedRoute = null;
    } else if (historicalRoute?.resolutionState === "resolved") {
      if (typeof context.providerRuntime.selectSessionRoute !== "function") {
        throw new ProviderSetupRequiredError();
      }
      selectedRoute = await context.providerRuntime.selectSessionRoute(
        historicalRoute,
        context.providerRouteSurface,
      );
    } else if (next.data.model && next.data.model !== context.config.mainModel) {
      await context.providerRuntime.transitionModel(
        next.data.model,
        undefined,
        context.providerRouteSurface,
      );
      selectedRoute = typeof context.providerRuntime.currentSessionRoute === "function"
        ? context.providerRuntime.currentSessionRoute()
        : historicalRoute;
    }
  }

  await saveChatSessionPreferences(context, surface, previousRoute ?? undefined);
  commitChatSessionHandoff(context, next);
  if (selectedRoute) context.config.mainModel = selectedRoute.requestedModelId;
  if (!selectedRoute && next.data.model) context.config.mainModel = next.data.model;
  if (next.data.reasoning) {
    setReasoningSetting(context.config, next.data.reasoning);
  }
  next.setPreferences(
    selectedRoute?.requestedModelId ?? next.data.model ?? context.config.mainModel,
    getReasoningSetting(context.config),
    selectedRoute ?? undefined,
  );
  await saveChatSessionPreferences(context, surface, selectedRoute ?? undefined);
  await saveConfig(context.config, context.configPath);
  surface.loadTurns(next.recentTurns(VISIBLE_TURNS));
  // FIX-20, finding 9: a re-root is the biggest thing a chat pick can do —
  // every later command runs somewhere else — and the only trace it left was
  // a short workspace basename quietly changing in the header. The full,
  // home-abbreviated destination and the chat that was opened are named
  // outright; an ordinary same-folder pick keeps its existing wording, where
  // the folder never moved and repeating it would be noise.
  surface.setStatus(
    context.workspace === workspaceBeforePick
      ? `Chat opened: ${next.data.title}`
      : `Folder switched: ${abbreviateHome(context.workspace, home)} · chat: ${next.data.title}`,
    false,
  );
  return true;
}

/** Commits every mutable chat owner after the previous chat is durable. */
export function commitChatSessionHandoff(
  context: ChatSessionContext,
  next: SessionStore,
): void {
  if (context.commitSessionHandoff) {
    context.commitSessionHandoff(next);
    return;
  }
  context.providerRuntime.adoptSession?.(next);
  context.session = next;
  context.agent?.setSession(next);
  context.localRuntime.setSession(next);
}

export async function saveChatSessionPreferences(
  context: ChatSessionContext,
  surface: Pick<ChatSessionSurface, "addMessage"> | undefined,
  route?: RouteIdentityV1,
  /** Kept for the documented no-surface branch; see `reportChatSaveOutcome`. */
  fallback?: (message: string) => void,
): Promise<void> {
  context.session.setPreferences(
    context.config.mainModel,
    getReasoningSetting(context.config),
    route,
  );
  // D8c/FIX-20 finding 7: the same discipline both loops' exit-time saves
  // already follow — an untouched chat (no turns, no cost, still the default
  // title) has nothing worth a file yet, and writing one here turned every
  // `+ New Chat` pick into a permanent ghost. The preferences just set stay
  // in memory and are written by the first save that has real content behind
  // it; `isUntouched` cannot be true once anything is actually said.
  if (context.session.isUntouched) return;
  reportChatSaveOutcome(await context.session.save(), surface, fallback);
}

/**
 * A second orcode window writing the same chat is resolved by a merge, not
 * by a silent overwrite — but the user should learn that it happened.
 */
export function reportChatSaveOutcome(
  outcome: SaveOutcome,
  surface: Pick<ChatSessionSurface, "addMessage"> | undefined,
  /**
   * The documented no-surface branch: a caller with no surface in scope
   * hands its own sink rather than losing a merge notice entirely.
   */
  fallback?: (message: string) => void,
): void {
  if (!outcome.merged && !outcome.conflictBackupPath) {
    return;
  }
  const lines = [
    outcome.merged
      ? "The chat was merged with changes from a second orcode instance."
      : "",
    outcome.conflictBackupPath
      ? `An unreadable chat file was backed up: ${outcome.conflictBackupPath}`
      : "",
  ].filter(Boolean);
  const message = lines.join("\n");
  if (surface) {
    surface.addMessage("system", message, "Chat");
    return;
  }
  fallback?.(message);
}

/** The folder label a surface shows for a chat that lives somewhere else. */
export function foreignChatFolderLabel(chat: CrossWorkspaceChat, home = homedir()): string {
  return chat.workspaceVerified ? abbreviateHome(chat.workspace, home) : "unknown folder";
}

/** The picker's own title, shared so both surfaces name the screen alike. */
export function chatPickerTitle(workspace: string, separator: string): string {
  return `Chats${separator}${basename(workspace)}`;
}
