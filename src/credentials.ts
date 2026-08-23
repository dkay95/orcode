import { AsyncEntry } from "@napi-rs/keyring";
import { randomBytes, randomUUID } from "node:crypto";
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

export interface CredentialSlotRef {
  version: 1;
  kind: CredentialKind;
  id: string;
}

export interface VersionedCredentialStoreLike extends CredentialStoreLike {
  reserveSlot(kind: CredentialSlotRef["kind"]): CredentialSlotRef;
  writeSlot(slot: CredentialSlotRef, secret: string): Promise<void>;
  readSlot(slot: CredentialSlotRef): Promise<string | null>;
  deleteSlot(slot: CredentialSlotRef): Promise<boolean>;
  getOrCreateAccountHmacKey(): Promise<Uint8Array>;
}

export function normalizeProviderSecret(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    /\s/u.test(normalized) ||
    /[\0-\x1f\x7f\u001b]/u.test(normalized)
  ) {
    throw new Error(
      "Der Provider-Key ist ungültig oder enthält Leerzeichen/Steuerzeichen.",
    );
  }
  return normalized;
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
const ACCOUNT_HMAC_KEY = "provider-account-hmac-v1";
const SLOT_ACCOUNT_PREFIX = "provider-slot:";
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class CredentialStore implements VersionedCredentialStoreLike {
  readonly location =
    process.platform === "darwin"
      ? "macOS-Schlüsselbund"
      : "System-Schlüsselbund";

  constructor(
    private readonly createEntry: EntryFactory = (service, account) =>
      new AsyncEntry(service, account),
    private readonly createUuid: () => string = randomUUID,
    private readonly createAccountHmacKey: () => Uint8Array = () =>
      randomBytes(32),
  ) {}

  reserveSlot(kind: CredentialSlotRef["kind"]): CredentialSlotRef {
    if (kind !== "inference" && kind !== "management") {
      throw new Error("Der Credential-Slot-Typ ist ungültig.");
    }
    const uuid = this.createUuid();
    if (!CANONICAL_UUID.test(uuid)) {
      throw new Error("Der erzeugte Credential-Slot ist ungültig.");
    }
    return Object.freeze({
      version: 1 as const,
      kind,
      id: `v1:${kind}:${uuid}`,
    });
  }

  async writeSlot(slot: CredentialSlotRef, secret: string): Promise<void> {
    const normalized = normalizeProviderSecret(secret);
    const entry = this.slotEntry(slot);
    let primaryError: unknown;
    try {
      await entry.setPassword(normalized);
    } catch (error) {
      primaryError = error;
    }

    let stored: string | null = null;
    try {
      stored = rawStored(await entry.getPassword());
    } catch (error) {
      primaryError ??= error;
    }
    if (!primaryError && stored === normalized) {
      return;
    }

    primaryError ??= new Error(
      "Der Schlüsselbund hat den neuen Provider-Key nicht unverändert gespeichert.",
    );
    let cleanupError: unknown;
    try {
      await entry.deleteCredential();
    } catch (error) {
      cleanupError = error;
    }
    let remaining: string | null = null;
    let cleanupReadSucceeded = false;
    try {
      remaining = rawStored(await entry.getPassword());
      cleanupReadSucceeded = true;
    } catch (error) {
      cleanupError ??= error;
    }
    if (!cleanupReadSucceeded || remaining !== null) {
      const primary = credentialError(
        "speichern",
        primaryError,
        normalized,
        stored ?? undefined,
      );
      const cleanup = credentialError(
        "löschen",
        cleanupError ?? new Error("der Kandidaten-Slot blieb belegt"),
        normalized,
        stored ?? undefined,
        remaining ?? undefined,
      );
      throw new CredentialStoreError(
        `${primary.message} Der Kandidaten-Slot konnte nicht sicher bereinigt werden: ${cleanup.message}`,
        "unknown",
      );
    }
    throw credentialError(
      "speichern",
      primaryError,
      normalized,
      stored ?? undefined,
    );
  }

  async readSlot(slot: CredentialSlotRef): Promise<string | null> {
    try {
      return rawStored(await this.slotEntry(slot).getPassword());
    } catch (error) {
      throw credentialError("lesen", error);
    }
  }

  async deleteSlot(slot: CredentialSlotRef): Promise<boolean> {
    const entry = this.slotEntry(slot);
    let existing: string | null = null;
    try {
      existing = rawStored(await entry.getPassword());
      if (existing === null) return false;
      await entry.deleteCredential();
      if (rawStored(await entry.getPassword()) !== null) {
        throw new CredentialStoreError(
          "Der System-Schlüsselbund hat den Provider-Key nicht gelöscht. Versuche es erneut.",
        );
      }
      return true;
    } catch (error) {
      throw credentialError("löschen", error, existing ?? undefined);
    }
  }

  async getOrCreateAccountHmacKey(): Promise<Uint8Array> {
    const entry = this.createEntry(SERVICE, ACCOUNT_HMAC_KEY);
    let existing: string | null;
    try {
      existing = rawStored(await entry.getPassword());
    } catch (error) {
      throw credentialError("lesen", error);
    }
    if (existing !== null) {
      return decodeAccountHmacKey(existing);
    }

    const generated = this.createAccountHmacKey();
    if (generated.byteLength !== 32) {
      throw new CredentialStoreError(
        "Der lokale Account-HMAC-Key konnte nicht sicher erzeugt werden.",
      );
    }
    const encoded = Buffer.from(generated).toString("base64url");
    try {
      await entry.setPassword(encoded);
      const readback = rawStored(await entry.getPassword());
      if (readback !== encoded) {
        throw new Error(
          "Der Schlüsselbund hat den Account-HMAC-Key nicht unverändert gespeichert.",
        );
      }
      return decodeAccountHmacKey(readback);
    } catch (error) {
      throw credentialError("speichern", error, encoded);
    }
  }

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

  private slotEntry(slot: CredentialSlotRef): KeyringEntry {
    validateSlotRef(slot);
    return this.createEntry(SERVICE, `${SLOT_ACCOUNT_PREFIX}${slot.id}`);
  }
}

function normalizeStored(value: string | undefined | null): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function rawStored(value: string | undefined | null): string | null {
  return value === undefined || value === null || value.length === 0
    ? null
    : value;
}

function validateSlotRef(slot: CredentialSlotRef): void {
  if (
    !slot ||
    slot.version !== 1 ||
    (slot.kind !== "inference" && slot.kind !== "management")
  ) {
    throw new Error("Der Credential-Slot ist ungültig.");
  }
  const prefix = `v1:${slot.kind}:`;
  if (!slot.id.startsWith(prefix) || !CANONICAL_UUID.test(slot.id.slice(prefix.length))) {
    throw new Error("Der Credential-Slot ist ungültig oder nicht kanonisch.");
  }
}

function decodeAccountHmacKey(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new CredentialStoreError(
      "Der lokale Account-HMAC-Key im System-Schlüsselbund ist ungültig.",
    );
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) {
    throw new CredentialStoreError(
      "Der lokale Account-HMAC-Key im System-Schlüsselbund ist ungültig.",
    );
  }
  return new Uint8Array(decoded);
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
