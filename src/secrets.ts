/**
 * Outbound-Secret-Scanner: erkennt gängige Zugangsdaten-Muster in Inhalten,
 * die das System verlassen (Modellkontext und Tool-Ergebnisse, die in die
 * Konversationshistorie und damit zu OpenRouter wandern).
 *
 * Bewusst warn-only: der Agent arbeitet legitimerweise oft an Dateien mit
 * Tokens (z. B. .env-Vorlagen rotieren). Automatisches Redigieren würde den
 * Kontext still verändern — stattdessen wird sichtbar gewarnt.
 */

export interface SecretFinding {
  /** Menschenlesbare Kategorie (für die Warnung). */
  kind: string;
  /** Wie oft das Muster im gescannten Text vorkam. */
  count: number;
}

interface SecretPattern {
  kind: string;
  pattern: RegExp;
}

/**
 * Reihenfolge beachten: spezifische Muster vor generischen. Das generische
 * `sk-…`-Muster schließt `sk-or-` per Negative Lookahead aus, damit
 * OpenRouter-Keys nicht doppelt gemeldet werden.
 */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  { kind: "OpenRouter-Key", pattern: /\bsk-or-v1-[0-9a-f]{32,}\b/g },
  { kind: "Anthropic-Key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "API-Key (sk-…)", pattern: /\bsk-(?!or-|ant-)[A-Za-z0-9_-]{20,}\b/g },
  { kind: "AWS-Access-Key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    kind: "GitHub-Token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
  },
  { kind: "GitLab-Token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "Slack-Token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "Google-API-Key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "npm-Token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  {
    kind: "Private Key",
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
];

/** Scannt `text` und meldet je Kategorie die Trefferzahl (leer = sauber). */
export function scanForSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const { kind, pattern } of SECRET_PATTERNS) {
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      findings.push({ kind, count: matches.length });
    }
  }
  return findings;
}

/** Deutsche Warnzeile für Status/Notices; nennt Quelle und Kategorien. */
export function formatSecretWarning(
  quelle: string,
  findings: SecretFinding[],
): string {
  const liste = findings.map((f) => `${f.kind} ×${f.count}`).join(", ");
  return (
    `Sicherheitshinweis: ${quelle} enthält mögliche Zugangsdaten (${liste}). ` +
    "Der Inhalt wird an OpenRouter gesendet — bitte prüfen, ob das beabsichtigt ist."
  );
}
