import { AsyncEntry } from "@napi-rs/keyring";
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
    try {
      await this.entry(kind).setPassword(normalized);
    } catch (error) {
      throw credentialError("speichern", error, normalized);
    }
  }

  async delete(kind: CredentialKind): Promise<boolean> {
    try {
      if (!(await this.get(kind))) {
        return false;
      }
      return await this.entry(kind).deleteCredential();
    } catch (error) {
      if (error instanceof CredentialStoreError) {
        throw error;
      }
      throw credentialError("löschen", error);
    }
  }

  async has(kind: CredentialKind): Promise<boolean> {
    return Boolean(await this.get(kind));
  }

  private entry(kind: CredentialKind): KeyringEntry {
    return this.createEntry(SERVICE, ACCOUNTS[kind]);
  }
}

export class CredentialStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialStoreError";
  }
}

function credentialError(
  operation: "lesen" | "speichern" | "löschen",
  error: unknown,
  secret?: string,
): CredentialStoreError {
  const rawDetail = errorMessage(error);
  const detail = secret
    ? rawDetail.split(secret).join("[REDACTED]")
    : rawDetail;
  return new CredentialStoreError(
    `Der System-Schlüsselbund konnte nicht ${operation} werden: ${detail}`,
  );
}
