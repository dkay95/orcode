# orcode: native Windows-11-x64-App ohne WSL

Status: Architektur am 15.10.2026 mit "Kannst loslegen" freigegeben; Windows-Unterstützung noch nicht implementiert.
Datum: 15.10.2026.

## Ziel und bestätigte Vorgaben

Der Nutzer hat eine native Windows-App ohne WSL-Pflicht gewählt. Ziel ist der
vollständige lokale Ablauf der bestehenden Tauri-GUI: Projekt öffnen, Anbieter
verbinden, Modell selbst wählen, in einer getrennten Arbeitskopie arbeiten,
prüfen, Diff ansehen und erst nach Bestätigung ins Original übernehmen.

- Windows 11 x64 ist das erste Abnahmeziel; Windows ARM64, Windows 10 und Server
  werden nicht implizit als getestet bezeichnet.
- Keine WSL-, Docker-, Hyper-V- oder globale Node-Installation als Voraussetzung.
- AI-Prozess und Permissions bleiben unabhängig. Das Lead-Modell wählt immer
  der Nutzer. Der aktuelle Auto-Ablauf plant und implementiert mit diesem Lead;
  dynamische Mehragenten-Orchestrierung wird durch diese Portierung nicht erfunden.
- Permissions behalten ihre sichtbare, aktionsgebundene Bedeutung. Keine
  automatische Administratorfreigabe, Provider-Installation oder finale Übernahme.
- Abo-first, kein bezahlter API-Fallback, kein Credential-Export und keine
  Überlassung persönlicher Abos an andere Nutzer.
- macOS bleibt unterstützt. Keine pauschale Lockerung bisheriger Schutzgrenzen.
- Kein SSH-/VPN-/Cluster-Modul, keine neuen Remote-Hosts und kein öffentlicher
  Release ohne bestandene Plattformabnahme.

## Nachgewiesener Ausgangspunkt

Der aktuelle Entwicklungsstand ist auf macOS geprüft, nicht unter Windows.
Die bestehenden Windows-CI-Jobs prüfen Node/Core/npm-Paket, nicht die native GUI.

| Bereich | Aktuelle Grenze | Benötigte Windows-Entsprechung |
| --- | --- | --- |
| Rust-Build | Unbedingte Unix-Imports in build.rs/engine.rs | Getrennte Unix-/Windows-Plattformmodule |
| Private Kontrolle | Feste Unix-FDs, pipe/fcntl/dup2/pre_exec | Windows-private IPC mit gebundenem Kind und Generation |
| Prozessende | POSIX-Prozessgruppen und Signale | Prozessbaum unter Job Object, kein Einzel-PID-Versprechen |
| Lokale Isolation | sandbox-exec, Nicht-Darwin wird abgelehnt | Nachgewiesene native Windows-Schreib-/Netzwerkgrenze |
| Private Dateien | POSIX-Modi/UIDs im neuen Runjournal | Windows-DACL- und Handle-Identitätsprüfung |
| CLI-Prüfung | Mac-Pfade und codesign | Plattformgebundene Herkunfts-/Versionsprüfung |
| Setup | Nicht-macOS-Presenter derzeit deaktiviert | Eigene physische Windows-Bestätigung und Hersteller-Handoff |
| Verpackung | node, lipo, chmod, .app/DMG | node.exe, Windows-Abhängigkeiten, NSIS-Installer |

Relevante bestehende Dateien: gui/src-tauri/build.rs,
gui/src-tauri/src/engine.rs, lib.rs, manufacturer_cli.rs, scripts/gui.mjs,
src/local-process-isolation.ts, local-project-run.ts, private-store.ts,
official-cli-host.ts, native-sidecar-channel.ts und workspace.ts.

## Architekturentscheidung

Tauri, WebView-Oberfläche, TypeScript-Core und der öffentliche JSONL-Vertrag
bleiben erhalten. Eine schmale native Plattformschicht übernimmt OS-spezifische
IPC, Dateischutz, Start, Sandbox und Prozessende. Unix-Code wird nicht durch
Windows-Attrappen oder bedingungsloses Erfolgsmelden ersetzt.

### 1. App und Installer

Ein zunächst per-user installierbarer NSIS-Setup-Installer enthält die geprüfte
Node-x64-Runtime, den gebauten Core und die plattformrichtig auf Windows
installierten Produktionsabhängigkeiten. Keine vom Mac kopierten nativen
Node-Addons. Die Windows-Runtime-Version wird im Implementierungsplan exakt
gepinnt und vor dem Verpacken geprüft.

WebView2 wird explizit erkannt; der Installer bietet die offizielle Installation
an, wenn nötig. MSI ist kein zusätzliches Erstziel. Tauri unterstützt NSIS-EXE
und MSI; der Windows-Build wird auf Windows ausgeführt, nicht durch einen
Mac-Build als funktionierend angenommen. Siehe
[Tauri Windows Installer](https://v2.tauri.app/distribute/windows-installer/)
und [Voraussetzungen](https://v2.tauri.app/start/prerequisites/).

Start funktioniert aus Startmenü und Explorer, ohne Terminal/PATH-Annahmen.
Projektordner werden ausdrücklich gewählt; ein fehlendes Projekt startet
keinen Agenten über das gesamte Benutzerverzeichnis. Installation, Update und
Deinstallation löschen keine Chats, Arbeitskopien oder Konten stillschweigend.

### 2. Private IPC und Prozessbesitz

Öffentliche GUI-Frames bleiben secretless. Separate native Kontrollkanäle sind
keine weiteren WebView-Kommandos. Windows nutzt zufällig benannte lokale Pipes
mit expliziten DACLs, Remote-Client-Ausschluss und gebundener tatsächlicher
Kindprozessidentität. Anfrage, Challenge, Generation und Deadline werden vor
jeder Freigabe geprüft. Ein Pipe-Name oder PID allein ist keine Autorität.

Vererbte Handles werden über eine exakte Allowlist begrenzt. Sandbox-Toolkinder
erben weder Setup-Kontrollkanal noch Credentials oder Job-Kontrollhandles.
Microsoft beschreibt DACL-geschützte Pipe-Endpunkte in
[Named Pipe Security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights).

Die native App besitzt Engine und Tool-Prozessbäume über Job Objects mit
Kill-on-close und deaktiviertem Breakaway. Prozesse werden vor ihrer ersten
Instruktion dem Job zugeordnet. Stop versucht geordnetes Abbrechen und beendet
nach begrenztem Drain verbleibende eigene Prozesse. Ein Job Object ist
Prozessbesitz, keine Dateisandbox. Siehe
[Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

### 3. Dateischutz, Arbeitskopie und Apply

Der vorhandene PrivateStore/WindowsPrivateStoreAdapter ist Ausgangspunkt für
ownergebundene DACLs. Der Runpfad prüft Schutz und Objektidentität erneut;
POSIX-mode-Bits gelten unter Windows nicht als Sicherheitsbeweis.

Das erste unterstützte Projekt-Dateisystem ist lokales NTFS mit regulären,
vollständig lokal verfügbaren Dateien. Netzwerk-/UNC-Pfade, unbekannte
Dateisysteme, Junctions/Reparse-Points und Cloud-Platzhalter bleiben bis zu
eigenen Nachweisen sichtbar abgelehnt. Kein Aufweichen bei Fehlern.

Kanonische Wurzeln werden über geöffnete Handles, Volume-/Dateiidentität und
Windows-Pfadregeln gebunden: Laufwerksbuchstaben, Groß-/Kleinschreibung,
UNC-/Device-Namespace, Alternate Data Streams, reservierte Gerätenamen,
abschließende Punkte/Leerzeichen und Hardlinks dürfen die Grenze nicht umgehen.

Original-Baseline, Kandidatenhash, Testbindung, Stop-Epoche und bestätigte
Übernahme behalten die bestehenden Verträge. Journale enthalten dauerhafte
Vorherbilder; fehlgeschlagene Teilübernahme ist nicht automatisch erfolgreich
zurückgerollt. Fremdänderungen bleiben erhalten und werden als Konflikt gemeldet.
Es gibt weiterhin keine behauptete universelle atomare Mehrdatei-Transaktion.

### 4. Native Ausführungsisolation

Vorgesehen ist ein eigener eng begrenzter Windows-Sandbox-Launcher mit
AppContainer-Sicherheitskontext pro Lauf, ohne allgemeine Netzwerk-Capabilities.
Nur Arbeitskopie, laufbezogenes Temp und notwendige System-/Runtime-Leserechte
werden erteilt. Original, andere Projekte und private Appdaten erhalten keine
Worker-Schreibberechtigung. DACLs des Originals werden nicht angepasst.

Modellanfragen und Credentials bleiben im autorisierten Core; der Sandbox-
Prozess erhält nur seine konkrete Toolaufgabe und eine bereinigte Umgebung.
File-Tools außerhalb des Workerprozesses bleiben an den WorkspaceGuard gebunden.
AppContainer ist eine geeignete Windows-Isolationsgrundlage, aber die konkrete
Toolkompatibilität und Schutzwirkung müssen bewiesen werden:
[Microsoft AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation).

Vor Freischaltung muss ein echter Windows-Canary Schreiben in die Arbeitskopie
erlauben und absolute Original-/Geschwisterpfade, Link-Ausbrüche, allgemeine
Temp-Pfade und Netzwerkzugriff verweigern. Derselbe Nachweis gilt für Kinder.
Scheitert die Probe oder fehlen OS-Fähigkeiten, wird Ausführung gesperrt. Kein
Fallback auf ungeschütztes PowerShell/cmd und kein Ersatz durch WSL.

Keine Behauptung, jede beliebige Buildkette sei AppContainer-kompatibel. Der
erste Kompatibilitätskorpus umfasst gebündeltes node.exe, cmd und die ausdrücklich
ermittelte PowerShell. Weitere Tools werden nur nach echten Windows-Proben
freigeschaltet. Fehlschläge verlangen eine konkrete Designkorrektur, keine
globale Abschaltung des Schutzes.

### 5. Hersteller-CLI und manuelle Modellwahl

Installation, Version, Herkunft, Login, Abo-Berechtigung und GUI-Ausführbarkeit
bleiben getrennte Fakten mit yes/no/unknown. Windows-Pfade kommen aus bekannten
Installationswurzeln; ein beliebiger PATH-Treffer ist kein Herkunftsbeweis.
Signaturen werden geprüft, wenn vorhanden; andernfalls braucht der Adapter
einen versionsgebundenen, unabhängig vertrauenswürdigen Paket-/Hashnachweis.

Installieren, Anmelden und Hersteller-Terminal öffnen sind geschlossene native
Aktionen nach Besitzerklick. Keine WebView-Befehlsstrings, kein OAuth-Scraping,
kein Profilkopieren, kein stiller Logout oder Kontowechsel. Externe Hersteller-
Sessions sind nicht automatisch GUI-Agenten und nicht durch orcode-Stop steuerbar.

Ein Codex-Windows-Adapter braucht einen eigenen versionsgebundenen Nachweis;
Windows-Unterstützung des Herstellers beweist nicht die Integration in orcode.
Auch die vorhandene Mac-Profilinkompatibilität wird nicht kaschiert. Siehe
[offizielle Codex-Windows-Dokumentation](https://learn.chatgpt.com/docs/windows/windows-sandbox).
Claude/Kimi bleiben extern, bis ein tatsächlicher GUI-Turn-Adapter geprüft ist.
Keine versprochene Hersteller-Modellverfügbarkeit ohne Accountnachweis.

### 6. Verifikation und Auslieferung

Ein dedizierter Windows-GUI-CI-Job baut Core, GUI, Rust und Installer mit minimalen
GitHub-Berechtigungen. Er veröffentlicht Testartefakte, nicht automatisch ein
GitHub-/npm-Release. Bestehende Mac-Gates bleiben bestehen. Plattformtests werden
bewusst getrennt; allgemeine Core-Regressionen dürfen nicht pauschal übersprungen
werden, nur weil ein macOS-Canary auf Windows nicht ausführbar ist.

Verpflichtende Abnahme auf tatsächlichem Windows 11 x64:

1. Frische Standardbenutzer-Installation ohne Node, Git Bash, WSL oder globale
   Entwicklungsumgebung; WebView2-Fehlfall und Startmenü/Explorer-Start.
2. Projektordner mit Leerzeichen und Umlauten öffnen; Cancel erhält Projekt
   und Entwurf; keine implizite Modellwahl.
3. Private IPC: fremdes Kind, falsche Generation, Wiederholung, verspätete
   Bestätigung und Prozessabsturz erzeugen keine Freigabe oder Geheimnisabgabe.
4. DACL-/Pfad-/Link-Angriffe sowie Baselineänderung blockieren Apply, ohne
   Original oder fremde Änderungen zu überschreiben.
5. Echter Prozess-Canary inklusive Nachkommen; Stop bei Vorbereitung, Start,
   Tool, Test und Apply; Engine-/App-Absturz hinterlässt keine Worker.
6. Neustart lädt gestoppten Zustand. Erst ausdrückliches Resume ermöglicht
   weitere Arbeit; alte Freigaben bleiben ungültig.
7. Hersteller-Setup nach Besitzerentscheidung, tatsächliches manuell gewähltes
   Modell und reale Aufgabe: Arbeitskopie -> Test -> Diff -> bestätigtes Apply.
   Keine Credentials oder Live-Accounts in Hosted CI.
8. Gebautes und installiertes Artefakt wird über Commit und Hash identifiziert.
   Code-Signing-Zertifikate werden nicht gekauft, ersetzt oder aus CI exportiert.

Ein startender Installer ist nur ein Zwischenstand. "Windows-ready" verlangt
alle anwendbaren Kriterien; fehlende Modell-/OS-Abnahme bleibt ungeprüft.
Die vorhandenen Auditwarnungen der Produktionsabhängigkeiten werden vor einem
öffentlichen Release separat bewertet und nicht durch grüne GUI-Tests erledigt.

## Freigabe und nächster Schritt

Die Zielwahl und dieser Architekturentwurf sind bestätigt. Der datei- und
testgenaue [Umsetzungsplan](../plans/2026-10-15-windows-native.md) konkretisiert
die Plattformgrenzen, Tests und Auslieferungsstufen. Seine Freigabe geht den
Produktänderungen voraus. Kein Main-Merge, Tag oder Release ist damit verbunden.
