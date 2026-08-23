import { AsyncEntry } from "@napi-rs/keyring";
import { redactText } from "./redaction.js";
import { errorMessage } from "./utils.js";

export type CredentialKind = "inference" | "management";

export interface CredentialStoreLike {
  readonly location: string;
  get(kind: CredentialKind): Promise<string | null>;
  set(kind: CredentialKind, secret: string): Promise<void>;
  delete(kind: CredentialKind): Promise<boolean>;
  has(kind: CredentialKind): Promise<boolean>;
}

interface KeyringEntry {
  getPassword(): Promise<string | undefined | null>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

type EntryFactory = (service: string, account: string) => KeyringEntry;

// Deliberately still "routercode", not "orcode": this is the OS keychain
// service identifier the app was published under before the rename. It is
// never shown to the user in orcode's own UI, so there is no branding cost to
// leaving it as is — but changing it would mean a stored key filed under the
// old identifier can no longer be found, forcing every existing user to
// re-enter their API key. Keeping it exactly as it was is the zero-risk
// choice; see the rename task notes for the alternative (an on-first-run
// keychain migration) that was considered and rejected as unnecessary risk
// for no user-visible benefit.
const SERVICE = "de.routercode.openrouter";
const ACCOUNTS: Record<CredentialKind, string> = {
  inference: "inference-api-key",
  management: "management-api-key",
};

export class CredentialStore implements CredentialStoreLike {
  readonly location =
    process.platform === "darwin"
      ? "macOS-Schlüsselbund"
      : "System-Schlüsselbund";

  constructor(
    private readonly createEntry: EntryFactory = (service, account) =>
      new AsyncEntry(service, account),
  ) {}

  async get(kind: CredentialKind): Promise<string | null> {
    try {
      const value = await this.entry(kind).getPassword();
      const normalized = value?.trim();
      return normalized || null;
    } catch (error) {
      throw credentialError("lesen", error);
    }
  }

  async set(kind: CredentialKind, secret: string): Promise<void> {
    const normalized = secret.trim();
    if (normalized.length < 20 || /\s/.test(normalized)) {
      throw new Error("Der API-Key sieht ungültig aus und wurde nicht gespeichert.");
    }
    const entry = this.entry(kind);
    let previous: string | null;
    try {
      previous = normalizeStored(await entry.getPassword());
    } catch (error) {
      throw credentialError("speichern", error, normalized);
    }

    let writeError: unknown;
    try {
      await entry.setPassword(normalized);
    } catch (error) {
      writeError = error;
    }

    let stored: string | null = null;
    try {
      stored = normalizeStored(await entry.getPassword());
    } catch (error) {
      writeError ??= error;
    }
    if (!writeError && stored === normalized) {
      return;
    }

    const primaryError = writeError ?? new Error(
      "Der Schlüsselbund hat den neuen API-Key nicht unverändert gespeichert.",
    );
    let rollbackError: unknown;
    try {
      if (previous) {
        await entry.setPassword(previous);
      } else {
        await entry.deleteCredential();
      }
    } catch (error) {
      rollbackError = error;
    }

    let restored: string | null = null;
    let restoredReadSucceeded = false;
    try {
      restored = normalizeStored(await entry.getPassword());
      restoredReadSucceeded = true;
    } catch (error) {
      rollbackError ??= error;
    }
    if (!restoredReadSucceeded || restored !== previous) {
      const primary = credentialError(
        "speichern",
        primaryError,
        normalized,
        previous ?? undefined,
      );
      const rollback = credentialError(
        "speichern",
        rollbackError ?? new Error("der vorherige Key konnte nicht wiederhergestellt werden"),
        normalized,
        previous ?? undefined,
      );
      throw new CredentialStoreError(
        `${primary.message} Der vorherige Schlüsselbund-Zustand konnte nicht sicher wiederhergestellt werden: ${rollback.message}`,
        "unknown",
      );
    }
    throw credentialError(
      "speichern",
      primaryError,
      normalized,
      previous ?? undefined,
    );
  }

  async delete(kind: CredentialKind): Promise<boolean> {
    let existing: string | null = null;
    try {
      existing = await this.get(kind);
      if (!existing) {
        return false;
      }
      await this.entry(kind).deleteCredential();
      if (await this.get(kind)) {
        throw new CredentialStoreError(
          "Der System-Schlüsselbund hat den API-Key nicht gelöscht. Versuche es erneut.",
        );
      }
      return true;
    } catch (error) {
      throw credentialError("löschen", error, existing ?? undefined);
    }
  }

  async has(kind: CredentialKind): Promise<boolean> {
    return Boolean(await this.get(kind));
  }

  private entry(kind: CredentialKind): KeyringEntry {
    return this.createEntry(SERVICE, ACCOUNTS[kind]);
  }
}

function normalizeStored(value: string | undefined | null): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

export class CredentialStoreError extends Error {
  constructor(
    message: string,
    readonly persistenceState: "unchanged" | "unknown" = "unchanged",
  ) {
    super(message);
    this.name = "CredentialStoreError";
  }
}

function credentialError(
  operation: "lesen" | "speichern" | "löschen",
  error: unknown,
  ...secrets: Array<string | undefined>
): CredentialStoreError {
  const rawDetail = errorMessage(error);
  const explicitlyRedacted = secrets.reduce<string>(
    (current, secret) => secret
      ? current.split(secret).join("[REDACTED]")
      : current,
    rawDetail,
  );
  const detail = redactText(explicitlyRedacted);
  return new CredentialStoreError(
    `Der System-Schlüsselbund konnte nicht ${operation} werden: ${detail}`,
  );
}
