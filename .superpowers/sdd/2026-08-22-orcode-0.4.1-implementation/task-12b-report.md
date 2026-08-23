# Task 12b — echter POSIX-PTY-Smoke

## Umfang

- `scripts/check-pty.mjs`: begrenzter Release-Smoke über Python-stdlib `openpty()` ohne neue native/npm-Abhängigkeit.
- `tests/fixtures/pty-harness.mjs`: minimales Harness, das das gebaute `dist/tui.js` importiert und `TerminalUi` mit echtem `process.stdin`/`process.stdout` startet.
- `tests/pty-release.test.ts`: deterministische Vertrags- und Fehlerpfadtests über injizierbare Dateizugriffe/Controller.

## RED

`node --import tsx --test tests/pty-release.test.ts`

- 0/4 bestanden.
- Erwarteter Grund: `scripts/check-pty.mjs` existierte noch nicht (`ERR_MODULE_NOT_FOUND`).

## GREEN

`node --import tsx --test tests/pty-release.test.ts`

- 4/4 bestanden.
- Prüft feste Geometrie 100x28, separates Enter, verpflichtenden Paste-/Screen-Cleanup und explizites Windows/ConPTY-Nichtversprechen.

`npm run build && node scripts/check-pty.mjs`

- Echter lokaler macOS-PTY-Lauf bestanden.
- Kindprozess sah stdin und stdout als TTY.
- Mehrzeiliges Bracketed Paste ergab exakt `Erste Zeile\nZweite Zeile` und blieb bis zum später gesendeten Enter unsubmitted/aktiv.
- Roh-Transcript enthielt Enable-Paste sowie danach Disable-Paste und Leave-Alternate-Screen vor Ergebnis/Exit.
- Der Controller begrenzt Laufzeit und Ausgabe; `finally` beendet die eigene Prozessgruppe und schließt alle PTY-Deskriptoren. SIGINT/SIGTERM werden in den Cleanup-Pfad überführt.

Weitere lokale Prüfungen:

- `npx tsc -p tsconfig.json --noEmit` — bestanden.
- `node --check scripts/check-pty.mjs` — bestanden.
- `node --check tests/fixtures/pty-harness.mjs` — bestanden.
- `git diff --check -- scripts/check-pty.mjs tests/pty-release.test.ts tests/fixtures/pty-harness.mjs` — bestanden.

Der gemeinsame `tsconfig.tests.json`-Lauf war zu diesem Zeitpunkt durch die parallele, fremde neue Datei `tests/release-metadata.test.ts` blockiert (`TS7016` für deren `check-release-metadata.mjs`). Die Task-12b-Fokusprüfung selbst ist grün; nach Abschluss der Parallelspur muss der Root-Agent den gemeinsamen Typcheck erneut laufen lassen.

## Ehrliche Grenze

Das ist echte POSIX-PTY-Abdeckung für macOS/Linux. Windows wird mit einer klaren Fehlermeldung abgelehnt und muss in CI explizit übersprungen werden. Es gibt keine ConPTY-Abdeckung und keinen entsprechenden Claim.
