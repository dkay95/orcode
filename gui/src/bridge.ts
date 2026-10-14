/**
 * The pipe, from the page's side.
 *
 * The shell owns the process; this owns nothing but a request id counter.
 * It parses just enough of each line to route a `response` back to whoever
 * asked, and hands every other frame on untouched — a second reading of the
 * protocol here would be a second implementation of it.
 */

import { Channel, invoke } from "@tauri-apps/api/core";

import type { ErrorBody, ServerFrame } from "./protocol.js";
import { PROTOCOL_VERSION, parseFrame } from "./protocol.js";

/**
 * Direct Desktop controls are only shortcuts into the existing command
 * catalog. Keeping the closed mapping beside the request bridge prevents a
 * button from growing a second Cross protocol or runtime path.
 */
export const CROSS_ACTION_COMMANDS = Object.freeze({
  models: "/cross models",
  swap: "/cross swap",
  status: "/cross status",
  stop: "/cross stop",
} as const);

export type CrossAction = keyof typeof CROSS_ACTION_COMMANDS;

export interface CrossActionHandlers {
  models(): void;
  swap(): void;
  status(): void;
  stop(): void;
}

/** Build the four controls over one caller-owned catalog dispatcher. */
export function createCrossActionHandlers(
  dispatch: (raw: (typeof CROSS_ACTION_COMMANDS)[CrossAction]) => void,
): CrossActionHandlers {
  return {
    models: () => dispatch(CROSS_ACTION_COMMANDS.models),
    swap: () => dispatch(CROSS_ACTION_COMMANDS.swap),
    status: () => dispatch(CROSS_ACTION_COMMANDS.status),
    stop: () => dispatch(CROSS_ACTION_COMMANDS.stop),
  };
}

export type EngineMessage =
  | { readonly kind: "frame"; readonly line: string }
  | {
      readonly kind: "exited";
      readonly code: number | null;
      readonly signal: number | null;
      /**
       * The shell's CLASSIFICATION of the engine's last stderr, from a closed
       * vocabulary (`engine::EXIT_CAUSES`). Never the engine's own bytes —
       * R-SEC-5 is unchanged; this is one word about them.
       */
      readonly cause?: string | null;
    }
  /** A code, never the operating system's own text (see `lib.rs`). */
  | { readonly kind: "failed"; readonly code: string };

/**
 * A refusal the SHELL wrote, as opposed to an exception that happened to
 * have a `.message`. Recognised by shape, because that is the difference
 * that decides whether the text may be shown to an owner at all.
 */
export function asShellError(value: unknown): ErrorBody | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { code?: unknown; message?: unknown; hint?: unknown };
  if (typeof candidate.code !== "string" || typeof candidate.message !== "string") return null;
  return {
    code: candidate.code,
    message: candidate.message,
    ...(typeof candidate.hint === "string" ? { hint: candidate.hint } : {}),
  };
}

export interface EngineInfo {
  readonly node: string;
  readonly script: string;
  readonly workspace: string;
  readonly home: string;
  readonly realHome: boolean;
  readonly pid: number;
}

export class RequestFailed extends Error {
  readonly body: ErrorBody;
  constructor(body: ErrorBody) {
    super(body.message);
    this.name = "RequestFailed";
    this.body = body;
  }
}

export interface BridgeHandlers {
  onFrame(frame: ServerFrame): void;
  onUnparseable(line: string): void;
  onExit(code: number | null, signal: number | null, cause: string | null): void;
  onFailure(code: string): void;
}

export class EngineBridge {
  readonly #handlers: BridgeHandlers;
  readonly #pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  #sequence = 0;
  /**
   * Which engine the messages arriving now belong to.
   *
   * A replaced engine's reader task publishes its own `Terminated` through
   * the OLD channel, and that can land after the new one has been spawned —
   * which would put a freshly started engine's window into "the engine
   * stopped". A superseded channel is simply not listened to any more.
   */
  #generation = 0;

  constructor(handlers: BridgeHandlers) {
    this.#handlers = handlers;
  }

  /** Spawns (or replaces) the engine and starts the stream. */
  async start(): Promise<EngineInfo> {
    this.#failPending(new RequestFailed({ code: "engine-restarted", message: "The engine was restarted." }));
    this.#generation += 1;
    const generation = this.#generation;
    const channel = new Channel<EngineMessage>();
    channel.onmessage = (message) => {
      if (generation !== this.#generation) return;
      this.#accept(message);
    };
    return await invoke<EngineInfo>("engine_start", { onMessage: channel });
  }

  async stop(): Promise<string> {
    return await invoke<string>("engine_stop");
  }

  async chooseProject():Promise<string|null> {
    return await invoke<string|null>('project_choose');
  }

  /** One request, one response. Rejects with the engine's own error body. */
  request<T = unknown>(t: string, payload: Record<string, unknown> = {}): Promise<T> {
    this.#sequence += 1;
    const id = `c${this.#sequence}`;
    const settled = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
    void this.write({ t, id, ...payload }).catch((error: unknown) => {
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      pending.reject(error);
    });
    return settled;
  }

  /** A frame with no response — an `answer`. */
  async write(frame: Record<string, unknown>): Promise<void> {
    await invoke("engine_send", { line: JSON.stringify({ v: PROTOCOL_VERSION, ...frame }) });
  }

  #accept(message: EngineMessage): void {
    if (message.kind === "exited") {
      this.#failPending(
        new RequestFailed({ code: "engine-stopped", message: "The engine stopped before answering." }),
      );
      this.#handlers.onExit(message.code, message.signal, message.cause ?? null);
      return;
    }
    if (message.kind === "failed") {
      this.#failPending(
        new RequestFailed({ code: "engine-failed", message: "The engine stopped answering." }),
      );
      this.#handlers.onFailure(message.code);
      return;
    }
    const frame = parseFrame(message.line);
    if (!frame) {
      // Counted and named, never rendered as content.
      this.#handlers.onUnparseable(message.line);
      return;
    }
    if (frame.t === "response") {
      const waiter = this.#pending.get(frame.id);
      if (waiter) {
        this.#pending.delete(frame.id);
        if (frame.ok) waiter.resolve(frame.result);
        else waiter.reject(new RequestFailed(frame.error));
      }
    }
    this.#handlers.onFrame(frame);
  }

  #failPending(error: RequestFailed): void {
    for (const [, waiter] of [...this.#pending]) waiter.reject(error);
    this.#pending.clear();
  }
}
