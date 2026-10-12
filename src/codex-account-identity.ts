import { createHash } from "node:crypto";

const PREFIX = "codex-sha256:";

/** Private, per-home account binding. Raw provider identity is never retained. */
export function codexAccountFingerprint(homeId: string, accountRead: unknown): string {
  const account = accountRead !== null && typeof accountRead === "object"
    ? (accountRead as Record<string, unknown>).account : null;
  const email = account !== null && typeof account === "object"
    ? (account as Record<string, unknown>).email : null;
  if (!/^codex-[0-9a-f]{32}$/.test(homeId) || typeof email !== "string"
    || email.trim().length === 0 || email.length > 1_024) {
    throw new Error("Codex account identity could not be verified. Reconnect the ChatGPT profile.");
  }
  return PREFIX + createHash("sha256")
    .update("orcode-codex-account-v1\0").update(homeId).update("\0").update(email).digest("hex");
}

/** Legacy bindings retain their existing gates; new profiles require exact identity. */
export function assertCodexAccountFingerprint(expectedFingerprint: string, homeId: string, accountRead: unknown): void {
  if (expectedFingerprint.startsWith(PREFIX)
    && expectedFingerprint !== codexAccountFingerprint(homeId, accountRead)) {
    throw new Error("Codex account changed. Reconnect the ChatGPT profile before choosing a model.");
  }
}
