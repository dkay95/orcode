export const SDK_RETRY_CODES = ["408", "429", "5XX"] as const;

export const SDK_RECONNECT_POLICY = {
  strategy: "backoff",
  backoff: {
    initialInterval: 500,
    maxInterval: 5_000,
    exponent: 1.5,
    maxElapsedTime: 30_000,
  },
  retryConnectionErrors: true,
} as const;

export type ConnectionEventPhase =
  | "retry-scheduled"
  | "retrying"
  | "restored";

export interface ConnectionEvent {
  phase: ConnectionEventPhase;
  operation: string;
  attempt: number;
  status?: number;
  reason?: string;
}

export type ConnectionEventListener = (event: ConnectionEvent) => void;

export class SdkReconnectMonitor {
  #attempt = 0;
  #operation = "";
  #lastStatus: number | undefined;

  constructor(private readonly emit: ConnectionEventListener) {}

  beforeRequest(operation: string): void {
    if (this.#attempt === 0 || this.#operation !== operation) {
      this.#operation = operation;
      this.#attempt = 1;
      return;
    }

    this.#attempt += 1;
    this.emit({
      phase: "retrying",
      operation,
      attempt: this.#attempt,
      status: this.#lastStatus,
      reason: this.#lastStatus
        ? `OpenRouter HTTP ${this.#lastStatus}`
        : "Verbindung unterbrochen oder Zeitüberschreitung",
    });
  }

  afterError(operation: string, response: Response | null): void {
    this.#operation = operation;
    this.#lastStatus = response?.status;
    if (!response || !isTransientStatus(response.status)) {
      return;
    }
    this.emit({
      phase: "retry-scheduled",
      operation,
      attempt: Math.max(1, this.#attempt),
      status: response.status,
      reason: `OpenRouter HTTP ${response.status}`,
    });
  }

  afterSuccess(operation: string): void {
    if (this.#attempt > 1) {
      this.emit({
        phase: "restored",
        operation,
        attempt: this.#attempt,
        status: this.#lastStatus,
      });
    }
    this.reset();
  }

  reset(): void {
    this.#attempt = 0;
    this.#operation = "";
    this.#lastStatus = undefined;
  }
}

export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function formatConnectionEvent(event: ConnectionEvent): string {
  const target = operationLabel(event.operation);
  if (event.phase === "retry-scheduled") {
    return `${event.reason ?? "Verbindung unterbrochen"} · Reconnect wird vorbereitet`;
  }
  if (event.phase === "retrying") {
    return `Reconnect-Versuch ${event.attempt} · ${target}`;
  }
  return `Verbindung wiederhergestellt · ${target} · ${event.attempt} Versuche`;
}

function operationLabel(operation: string): string {
  if (operation === "createResponses") {
    return "Modellstream";
  }
  if (operation === "models") {
    return "Modellliste";
  }
  if (operation === "key") {
    return "Key-Prüfung";
  }
  if (operation === "credits") {
    return "Guthabenprüfung";
  }
  return operation || "OpenRouter";
}
