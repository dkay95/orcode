import { AsyncEntry } from "@napi-rs/keyring";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PrivateStore } from "./private-store.js";

export type CredentialKind = "inference" | "management";
export type CredentialSlotKind = CredentialKind | "kimi-code";

export interface CredentialStoreLike {
  readonly location: string;
  get(kind: CredentialKind): Promise<string | null>;
  set(kind: CredentialKind, secret: string): Promise<void>;
  delete(kind: CredentialKind): Promise<boolean>;
  has(kind: CredentialKind): Promise<boolean>;
}

export interface CredentialSlotRef {
  version: 1;
  kind: CredentialSlotKind;
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
const HMAC_INIT_LEASE = "provider-account-hmac-init.lock";
const HMAC_WAIT_ATTEMPTS = 80;
const HMAC_WAIT_DELAY_MS = 25;

interface ParsedSlot extends CredentialSlotRef {
  id: string;
  account: string;
}

interface OwnedReservation extends ParsedSlot {
  state: "reserved" | "written" | "unsafe";
}

export class CredentialStore implements VersionedCredentialStoreLike {
  readonly location =
    process.platform === "darwin"
      ? "macOS-Schlüsselbund"
      : "System-Schlüsselbund";
  readonly #reservationIds = new Set<string>();
  readonly #reservations = new WeakMap<object, OwnedReservation>();
  readonly #hmacPrivateStore: PrivateStore | null;
  readonly #hmacLeasePath: string | null;
  #hmacInitialization: Promise<Uint8Array> | null = null;

  constructor(
    private readonly createEntry: EntryFactory = (service, account) =>
      new AsyncEntry(service, account),
    private readonly createUuid: () => string = randomUUID,
    private readonly createAccountHmacKey: () => Uint8Array = () =>
      randomBytes(32),
    appHome?: string,
  ) {
    this.#hmacPrivateStore = appHome ? new PrivateStore({ root: appHome }) : null;
    this.#hmacLeasePath = appHome ? join(appHome, HMAC_INIT_LEASE) : null;
  }

  reserveSlot(kind: CredentialSlotKind): CredentialSlotRef {
    if (!isCredentialSlotKind(kind)) {
      throw new Error("Der Credential-Slot-Typ ist ungültig.");
    }
    const uuid = this.createUuid();
    if (!CANONICAL_UUID.test(uuid)) {
      throw new Error("Der erzeugte Credential-Slot ist ungültig.");
    }
    const id = `v1:${kind}:${uuid}`;
    if (this.#reservationIds.has(id)) {
      throw new Error("Der erzeugte Credential-Slot kollidiert mit einer bestehenden Reservierung.");
    }
    this.#reservationIds.add(id);
    const slot = Object.freeze({
      version: 1 as const,
      kind,
      id,
    });
    this.#reservations.set(slot, {
      version: 1,
      kind,
      id,
      account: `${SLOT_ACCOUNT_PREFIX}${id}`,
      state: "reserved",
    });
    return slot;
  }

  async writeSlot(slot: CredentialSlotRef, secret: string): Promise<void> {
    const normalized = normalizeProviderSecret(secret);
    const reservation = typeof slot === "object" && slot !== null
      ? this.#reservations.get(slot)
      : undefined;
    if (!reservation || reservation.state !== "reserved") {
      throw new Error("Der Credential-Slot wurde nicht frisch von diesem Store reserviert.");
    }
    const entry = this.createEntry(SERVICE, reservation.account);
    let previous: string | null;
    try {
      previous = rawStored(await entry.getPassword());
    } catch (error) {
      throw credentialError("lesen", error);
    }
    if (previous !== null) {
      throw new CredentialStoreError(
        "Der reservierte Credential-Slot ist bereits belegt und wurde nicht verändert.",
      );
    }

    let primaryError: unknown;
    try {
      await entry.setPassword(normalized);
    } catch (error) {
      primaryError = error;
    }

    let stored: string | null = null;
    let storedReadSucceeded = false;
    try {
      stored = rawStored(await entry.getPassword());
      storedReadSucceeded = true;
    } catch (error) {
      primaryError ??= error;
    }
    if (!primaryError && stored === normalized) {
      reservation.state = "written";
      return;
    }

    primaryError ??= new Error(
      "Der Schlüsselbund hat den neuen Provider-Key nicht unverändert gespeichert.",
    );
    if (!storedReadSucceeded || (stored !== null && stored !== normalized)) {
      reservation.state = "unsafe";
      throw new CredentialStoreError(
        "Der reservierte Credential-Slot konnte nach dem Schreibversuch nicht sicher zugeordnet werden.",
        "unknown",
      );
    }
    if (stored !== normalized) {
      throw credentialError("speichern", primaryError, normalized);
    }

    // A throwing backend may still have written the candidate. Recheck exact
    // bytes immediately before deleting; never clean an absent or foreign slot.
    let candidateStillPresent = false;
    try {
      candidateStillPresent = rawStored(await entry.getPassword()) === normalized;
    } catch {
      reservation.state = "unsafe";
      throw new CredentialStoreError(
        "Der Kandidaten-Slot konnte nach dem Schreibfehler nicht sicher geprüft werden.",
        "unknown",
      );
    }
    if (!candidateStillPresent) {
      reservation.state = "unsafe";
      throw new CredentialStoreError(
        "Der Kandidaten-Slot änderte sich während der Bereinigung.",
        "unknown",
      );
    }
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
      reservation.state = "unsafe";
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
    const parsed = parseSlotRef(slot);
    try {
      return rawStored(await this.createEntry(SERVICE, parsed.account).getPassword());
    } catch (error) {
      throw credentialError("lesen", error);
    }
  }

  async deleteSlot(slot: CredentialSlotRef): Promise<boolean> {
    const parsed = parseSlotRef(slot);
    const entry = this.createEntry(SERVICE, parsed.account);
    let existing: string | null = null;
    try {
      existing = rawStored(await entry.getPassword());
    } catch (error) {
      throw credentialError("lesen", error);
    }
    if (existing === null) return false;

    let deleteError: unknown;
    try {
      await entry.deleteCredential();
    } catch (error) {
      deleteError = error;
    }
    let remaining: string | null;
    try {
      remaining = rawStored(await entry.getPassword());
    } catch {
      throw new CredentialStoreError(
        "Der Credential-Slot konnte nach dem Löschversuch nicht sicher gelesen werden.",
        "unknown",
      );
    }
    if (remaining === null) return true;
    if (remaining === existing) {
      throw credentialError("löschen", deleteError ?? new Error("unverändert"), existing);
    }
    throw new CredentialStoreError(
      "Der Credential-Slot änderte sich während des Löschversuchs.",
      "unknown",
    );
  }

  async getOrCreateAccountHmacKey(): Promise<Uint8Array> {
    if (this.#hmacInitialization) {
      return new Uint8Array(await this.#hmacInitialization);
    }
    const initialization = this.#initializeAccountHmacKey();
    this.#hmacInitialization = initialization;
    try {
      return new Uint8Array(await initialization);
    } finally {
      if (this.#hmacInitialization === initialization) {
        this.#hmacInitialization = null;
      }
    }
  }

  async #initializeAccountHmacKey(): Promise<Uint8Array> {
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

    if (this.#hmacPrivateStore && this.#hmacLeasePath) {
      let claim: Awaited<ReturnType<PrivateStore["createDirectoryExclusive"]>>;
      try {
        claim = await this.#hmacPrivateStore.createDirectoryExclusive(
          this.#hmacLeasePath,
        );
      } catch (error) {
        throw credentialError("lesen", error);
      }
      if (claim === null) {
        for (let attempt = 0; attempt < HMAC_WAIT_ATTEMPTS; attempt += 1) {
          await delay(HMAC_WAIT_DELAY_MS);
          let persisted: string | null;
          try {
            persisted = rawStored(await entry.getPassword());
          } catch (error) {
            throw credentialError("lesen", error);
          }
          if (persisted !== null) return decodeAccountHmacKey(persisted);
        }
        throw new CredentialStoreError(
          "Die lokale Account-HMAC-Initialisierung ist noch exklusiv belegt.",
          "unknown",
        );
      }

      try {
        const raced = rawStored(await entry.getPassword());
        if (raced !== null) return decodeAccountHmacKey(raced);
        return await this.#writeNewAccountHmacKey(entry);
      } catch (error) {
        if (error instanceof CredentialStoreError) throw error;
        throw credentialError("speichern", error);
      }
    }

    return this.#writeNewAccountHmacKey(entry);
  }

  async #writeNewAccountHmacKey(entry: KeyringEntry): Promise<Uint8Array> {
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
    assertLegacyCredentialKind(kind);
    let value: string | undefined | null;
    try {
      value = await this.entry(kind).getPassword();
    } catch (error) {
      throw credentialError("lesen", error);
    }
    return value === undefined || value === null
      ? null
      : normalizeProviderSecret(value);
  }

  async set(kind: CredentialKind, secret: string): Promise<void> {
    assertLegacyCredentialKind(kind);
    const normalized = normalizeProviderSecret(secret);
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
    assertLegacyCredentialKind(kind);
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
    assertLegacyCredentialKind(kind);
    return Boolean(await this.get(kind));
  }

  private entry(kind: CredentialKind): KeyringEntry {
    return this.createEntry(SERVICE, ACCOUNTS[kind]);
  }

}

function normalizeStored(value: string | undefined | null): string | null {
  return value === undefined || value === null
    ? null
    : normalizeProviderSecret(value);
}

function rawStored(value: string | undefined | null): string | null {
  return value === undefined || value === null || value.length === 0
    ? null
    : value;
}

export function parseCredentialSlotRef(value: unknown): CredentialSlotRef {
  if (typeof value !== "string") {
    throw new Error("Der Credential-Slot ist ungültig oder nicht kanonisch.");
  }
  const match = /^v1:(inference|management|kimi-code):([0-9a-f-]+)$/.exec(value);
  if (!match || !CANONICAL_UUID.test(match[2] ?? "")) {
    throw new Error("Der Credential-Slot ist ungültig oder nicht kanonisch.");
  }
  return Object.freeze({
    version: 1 as const,
    kind: match[1] as CredentialSlotKind,
    id: value,
  });
}

function parseSlotRef(slot: CredentialSlotRef): ParsedSlot {
  const parsed = parseCredentialSlotRef(slot?.id);
  if (slot?.version !== parsed.version || slot.kind !== parsed.kind) {
    throw new Error("Der Credential-Slot ist ungültig oder nicht kanonisch.");
  }
  return { ...parsed, account: `${SLOT_ACCOUNT_PREFIX}${parsed.id}` };
}

function isCredentialSlotKind(value: unknown): value is CredentialSlotKind {
  return value === "inference" || value === "management" || value === "kimi-code";
}

function assertLegacyCredentialKind(value: unknown): asserts value is CredentialKind {
  if (value !== "inference" && value !== "management") {
    throw new Error("Der Credential-Typ ist ungültig.");
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
  ..._secrets: Array<string | undefined>
): CredentialStoreError {
  const persistenceState = error instanceof CredentialStoreError
    ? error.persistenceState
    : "unchanged";
  return new CredentialStoreError(
    `Der System-Schlüsselbund konnte nicht ${operation} werden: [REDACTED]`,
    persistenceState,
  );
}
