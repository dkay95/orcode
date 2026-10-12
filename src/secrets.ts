/**
 * Outbound-Secret-Scanner: erkennt gängige Zugangsdaten-Muster in Inhalten,
 * die das System verlassen (Modellkontext und Tool-Ergebnisse, die in die
 * Konversationshistorie und damit zu OpenRouter wandern).
 *
 * Bewusst warn-only: der Agent arbeitet legitimerweise oft an Dateien mit
 * Tokens (z. B. .env-Vorlagen rotieren). Automatisches Redigieren würde den
 * Kontext still verändern — stattdessen wird sichtbar gewarnt.
 */

import type { SecretFinding } from "./redaction.js";

export { scanForSecrets, type SecretFinding } from "./redaction.js";

/** Warning line for status/notices; names the source and categories. */
export function formatSecretWarning(
  quelle: string,
  findings: SecretFinding[],
): string {
  const liste = findings.map((f) => `${f.kind} ×${f.count}`).join(", ");
  return (
    `Security notice: ${quelle} may contain credentials (${liste}). ` +
    "This content is sent to OpenRouter — please check whether that is intended."
  );
}
