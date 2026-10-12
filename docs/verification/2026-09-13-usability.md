# orcode: Bedienbarkeit und Codex-Anbindung – 13.09.2026

## Stand und Grenzen

Arbeitsbranch: `feature/orcode-desktop-redesign`, Basis `a0680ad9b151dcee4cd14078c3babf0451e4273a`.
Dies ist ein lokal gebauter Entwicklungsstand von 0.7.0, keine veröffentlichte oder signierte Release-Freigabe.
Die Änderungen liegen uncommitted in diesem Worktree; es wurde kein Commit integriert oder veröffentlicht.

Die Änderungen wurden im Arbeitsverzeichnis `/Users/dogancankaya/projekt/routercode/.worktrees/orcode-desktop-redesign` umgesetzt. Main, Remote, Tags und bestehende Zugangsdaten wurden nicht verändert. Keine echten Anmeldungen oder bezahlten Modellaufrufe wurden zur Verifikation verwendet.

## Nutzbare Verbesserungen

- Modellwahl: Zurück führt aus der direkten Modellansicht zur Anbieterauswahl. Cold-Cross lädt den Katalog mit sichtbarem Ladezustand. Beide Rollen bleiben ausdrücklich durch den Nutzer auszuwählen.
- Bestätigte Modelle ohne Werkzeugunterstützung werden nicht mehr als ausführbare Coding-Modelle angeboten; ihre Eignung für Textkompression bleibt getrennt.
- GUI-Anfragen enden bei fehlgeschlagenem Transport mit einem Fehler statt einer unaufgelösten Promise.
- Antwort-Streaming erhält die Scrollabsicht, geöffnete Details und den Tastaturfokus.
- Anhänge sind im Composer sichtbar. Überholte Kostenvorschauen verschwinden beim Bearbeiten und Absenden.
- Sichere Markdown-Teilmenge mit Codeblöcken, Kopieren, Überschriften, Listen und HTTP(S)-Links. HTML wird nicht ausgeführt; externe Bilder werden nicht geladen.
- Fehlende native Anmeldemöglichkeit wird ausdrücklich erklärt. Identische Sperrhinweise werden nicht doppelt angezeigt.

## Codex: implementierter lokaler Ablauf, noch keine reale Login-Abnahme

Der neue Ablauf trennt die providerverwaltete Codex-Ausführung vom OpenRouter-Agenten. Er enthält ein privates erstes Profil, native Browser-/Gerätecode-Anmeldung, transaktionale Profilübernahme, ausdrücklich gewählte Modelle, frische Prozess-/Account-Autorität pro Aufgabe, Staging, Freigaben, Prozessende vor Dateiübernahme, Abbruch und gespeicherte Teilantworten. Aboverbrauch wird als unbekannt ausgewiesen, nicht als kostenlos.

Unabhängige Reviews führten zu Regressionstests für zusammengeführte Chat-Anweisungen, fremde Modelländerung/Abmeldung vor Dispatch, vorbereitete Prozesse bei Speicherfehlern, Reihenfolge von Stream-Nachrichten, private Werte über Chunk-Grenzen und verspätete Arbeit nach Abschluss.

Eine Offline-Probe der signatur-/hashgeprüften offiziellen Codex-Version 0.142.5 sendete ausschließlich initialize/initialized in einem frischen isolierten Home unter Netzwerkverbot. Sie zeigte eine `remoteControl/status/changed`-Meldung, aber keine initiale `account/updated`-Meldung. Deshalb werden tatsächliche frische Account-Reads und Ereignis-Epochen getrennt behandelt; ein Anmeldeereignis darf nicht erfunden werden.

Offene Produktgrenzen:

- Die lokale Debug-App hat keine konfigurierte signierte Paketvertrauenskette. Abo-Anmeldungen bleiben dort gesperrt.
- Kein echter Browser-/Gerätecode-Login und kein echter Codex-Arbeitslauf wurden abgenommen. Der konkrete Browser-Login-Originator ist noch nicht live bestätigt.
- Mehrere ChatGPT-Profile, Konto-Pooling, Kontoersatz sowie vollständiges Abmelden/Neuverbinden sind nicht freigegeben.
- Abgebrochene, nicht übernommene neue Profile können private verwaiste Profilverzeichnisse hinterlassen. Sie werden nicht automatisch importiert oder anderen Nutzern zugänglich gemacht.
- Markdown ist eine sichere Teilmenge; natives Clipboard/externes Link-Öffnen wurde nicht mit realen Modellantworten geprüft.

## Verifikation

- GUI: 230/230 Unit-/Integrationstests.
- Installiertes Chromium: 44/44 Browsertests einschließlich sechs neuer Usability-Regressionen.
- TypeScript: Produktions- und Testkonfiguration ohne Fehler; GUI-Typecheck/Vite-Build und macOS-Debug-App erfolgreich gebaut.
- Echte POSIX-Terminals: mehrzeiliges Einfügen wartet auf separates Enter; Esc trennt Denkende und Aufgabenabbruch; `/provider setup` lässt sich ohne Provider-Nebenwirkung abbrechen und unmittelbar ausdrücklich erneut öffnen. Alle drei PTY-Prüfprogramme erfolgreich.
- Codex: 211/211 gezielte Tests; nach der letzten Verschärfung des initialen Konto-Guards nochmals 61/61 relevante Tests erfolgreich. Diese Tests ersetzen keine echte Kontoanmeldung.
- Native macOS-App frisch gebaut und im isolierten Testprofil bedient: Einstellungen, Kategorien, Anbieteransicht und Abbrechen mit Rückkehr und Fokus auf die aufrufende Settings-Zeile erfolgreich. Keine Anmeldung ausgelöst. Testprozesse anschließend beendet.
- Erster Kern-Gesamtlauf: 4413 Tests, 4386 bestanden, eine erwartungsbedürftige neue Sperrtext-Assertion, 25 Folgeabbrüche durch einen lastempfindlichen 200-ms-Test-Latch, ein Skip. Sperrtexttest korrigiert; der Latch propagiert nun frühe Fehler und hat eine angemessene Testfrist. Produktionsfristen wurden dafür nicht verändert.
- Ein Zwischenlauf über 4438 Tests hatte ausschließlich zwei zusammenhängende Fehlschläge durch einen isolierten Build während laufender Quelländerungen. Der betreffende Privacy-/PTY-Test bestand nach dem Einfrieren der Quellen separat (2/2).
- Abschließender vollständiger Kernlauf auf dem eingefrorenen Quellstand: **4452 Tests, 4451 bestanden, 0 Fehler, 0 Abbrüche, 1 Skip** (170,84 s). Aufruf: `env -u FORCE_COLOR node --import tsx --test --test-concurrency=4 tests/*.test.ts`; beim Nachweis zusätzlich Dot-/TAP-Reporter verwendet. Rohprotokoll: `/tmp/orcode-usability-2026-09-13-core-frozen.tap`.
- Endgültig gebautes `dist/gui-server.js`: **123/123 GUI-Protokolltests** über `env -u FORCE_COLOR npm run test:gui-dist` (130,42 s). Rohprotokoll: `/tmp/orcode-usability-2026-09-13-gui-dist-frozen.log`.
- Abschließender `git diff --check` ohne Fehler. Alle unabhängigen Code-Reviews abgeschlossen, keine bekannten offenen konkreten Review-Findings innerhalb dieses Änderungspakets. Die oben genannten fehlenden Produktabnahmen bleiben davon unberührt.

## Starten

- Terminal: `orcode` oder `orcode-next` (beide lokalen Starter zeigen auf diesen Arbeitsstand).
- GUI: `orcode-desktop.command` im Projekt doppelklicken. Das startet den lokalen Build mit den bestehenden orcode-Daten, nicht mit dem Wegwerf-Testprofil.
- Debug-App: `gui/src-tauri/target/debug/bundle/macos/orcode.app`.
- Alter Preview-Starter: `/Users/dogancankaya/.local/bin/orcode-next.before-2026-09-13`.
- Bestehender `routercode`-Alias wurde nicht verändert; er zeigt weiterhin auf den anderen Checkout.

Ein zukünftiger Übernehmer sollte vor einem Release echte signierte Paket-/Login-Prüfungen durchführen und die genannten Produktgrenzen nicht aus grünen Fake-Transporttests als erledigt ableiten.
