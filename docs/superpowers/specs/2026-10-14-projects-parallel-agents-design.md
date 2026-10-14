# orcode Projekte und parallele Agenten

Design vom 14. Oktober 2026. Ergänzung auf Nutzerwunsch: Codex-Abonnement
gehört zur ersten Ausbaustufe; der ergänzte Plan bleibt vor Umsetzung zu prüfen.

## Ziel und vereinbarter Umfang

orcode soll eine einfach bedienbare lokale Coding-GUI sein. Der Nutzer öffnet
ein Projekt, vergibt mehrere Aufgaben und wählt für jeden Agenten selbst ein
Modell, einschließlich der über sein Codex-Abonnement verfügbaren Modelle.
Die Agenten arbeiten parallel am selben logischen Projekt und haben
eigene Ansichten für Chat, Fortschritt, Freigaben und Änderungen. Normale
Bedienung verlangt keine Slash-Befehle.

Konten und Zugangsdaten bleiben ausschließlich beim lokalen Eigentümer.
Kein Agent wählt automatisch ein anderes Modell, Konto oder einen anderen
Abrechnungsmodus. Die vorhandene Nano-GPT-Erweiterung bleibt erhalten.

## Arbeitskopien und erste Ausbaustufe

Die empfohlene erste Ausbaustufe verwendet geprüfte, getrennte Arbeitskopien.
Jeder Agent bearbeitet seine eigene Kopie; Änderungen am Originalprojekt
werden anschließend ausdrücklich übernommen. Das funktioniert auch ohne Git
und kann auf vorhandenen Snapshot-, Vorschau- und Veröffentlichungsalgorithmen
aufbauen.

Git-Worktrees wären eine Alternative mit echter Git-Historie pro Agent. Dafür
fehlen aktuell verwaltete Erstellung, sichere Dirty-Tree-Übernahme und
Aufräumlogik. Sie gehören nicht in die erste Ausbaustufe. Gemeinsame direkte
Schreibzugriffe aller Agenten auf dasselbe Verzeichnis werden nicht verwendet:
Ein Dateilock schützt nicht zuverlässig vor beliebigen Shell-Kommandos.

Diese erste Ausbaustufe erlaubt Dateiänderungen in isolierten Kopien. Sie
bietet dort keine vollständige Git-Historie und keine automatischen Commits,
Merges, Pushes oder Änderungen am Git-Index des Originalprojekts. Diese
Einschränkung muss im Startdialog sichtbar sein. Arbeitskopien sind keine
behauptete Betriebssystem-Sandbox; bestehende Shell-Freigaben gelten weiter.

## Bedienablauf

1. **Projekt öffnen:** Ein sichtbarer Button öffnet die native Ordnerauswahl.
   Abbrechen verändert nichts. Die Engine prüft den gewählten Ordner und nutzt
   den vorhandenen sicheren Projektwechsel. Der Projektname steht dauerhaft
   oben; eine kurze Liste zuletzt geöffneter Projekte bleibt erreichbar.
2. **Agent starten:** Ein Dialog verlangt Aufgabe und eine ausdrücklich
   bestätigte Anbieter-, Konto- und Modellroute. Der Name ist optional. Ohne
   Aufgabe oder gültige Modellwahl ist Starten gesperrt. Kosteninformationen
   sind bekannt oder ausdrücklich unbekannt, niemals erfunden.
3. **Parallel arbeiten:** Die Agentenübersicht zeigt Name, Aufgabe, Modell,
   Zustand und offene Freigaben. Pro Projekt können zunächst drei Agenten
   gleichzeitig laufen. Weitere Starts werden mit einer verständlichen
   Meldung abgelehnt; es gibt keine unsichtbare kostenpflichtige Warteschlange.
4. **Agent ansehen:** Eine Auswahl öffnet ausschließlich die Ansicht dieses
   Agenten. Live-Text, Werkzeugausgaben, Dateien, Freigaben und neue Nachrichten
   gehören eindeutig zu ihm. Der Wechsel der Ansicht startet oder stoppt
   keinen Agenten und verändert keine Modellwahl.
5. **Stoppen:** Stoppen betrifft genau den ausgewählten Lauf. Alle stoppen
   verlangt eine ausdrückliche Bestätigung. Laufende Prozesse werden beendet
   beziehungsweise kontrolliert abgebrochen; Ergebnisse und Logs bleiben
   erreichbar. Bereits entstandene Providerkosten werden nicht als null
   dargestellt.
6. **Änderungen übernehmen:** Die Ansicht zeigt den genauen Dateidiff und
   Prüfstatus. Übernehmen ist eine neue explizite Freigabe, unabhängig von
   automatischen Freigaben innerhalb der Arbeitskopie. Bei Änderungen am
   Original seit der Aufnahme erscheint ein Konflikt statt eines Overwrites.

Annahmen dieser Ausbaustufe sind das Limit von drei Agenten, die getrennten
Arbeitskopien und eine explizite Ergebnisübernahme. Sie ergänzen den vom
Nutzer bestätigten Funktionsumfang und sind Teil dieser Designfreigabe.

## Projektwechsel und Ergebnisse

Ein Projekt ist in der ersten Ausbaustufe aktiv. Projektwechsel ist gesperrt,
solange Agenten oder ein Übernahmevorgang laufen. Die Oberfläche bietet
Abbrechen oder Alle stoppen und wechseln an. Erst nach bestätigtem Abbruch
und Prozessende wird der vorhandene Projektwechsel ausgeführt. Bereits
beendete Agenten und nicht übernommene Ergebnisse bleiben beim ursprünglichen
Projekt gespeichert.

Der ursprüngliche Ordner, vorhandene Änderungen und bestehende Chats werden
nicht gelöscht. Neue Ordner werden nicht ungefragt angelegt. Ganze Homes,
Dateisystemwurzeln und ungeeignete Projektziele erhalten die vorhandenen
Schutzprüfungen und nachvollziehbare Hinweise.

## Sichere Arbeitskopien und Übernahme

Ein Agent startet von den aktuell vorhandenen zugelassenen Arbeitsdateien,
nicht nur von einem früheren Git-Commit. Erfasst werden Dateiinhalt,
Metadaten, Projektidentität und Ausschlüsse. Ein zweiter Manifestvergleich
vor dem Start erkennt Änderungen während der Aufnahme; eine unstabile
Aufnahme wird verworfen, ohne einen Modellaufruf zu starten.

Die Kopie ist ausdrücklich kein vollständiger Snapshot des gesamten Rechners
oder Git-Index. Private Speicher, Providerprofile, Zugangsdaten, `.git`,
geschützte beziehungsweise ausgeschlossene Dateien, gefährliche Symlinks und
Mount-Ausbrüche werden nicht übernommen. Nicht kopierte Build-Abhängigkeiten
und Snapshot-Grenzen werden angezeigt. Für Agenten gestartete Installationen
unterliegen weiter den bestehenden Freigaben.

Jeder Lauf erhält eine eigene Arbeitskopie, Sitzung, Änderungshistorie und
Prozessgruppe. Der Agent bekommt keine Schreibberechtigung auf andere
Agentenkopien über die Coding-Werkzeuge. Eine Abschlussprüfung ermittelt den
vollständigen zulässigen Diff und bewahrt die dazugehörigen Bytes und
Vorbedingungen vor jedem Aufräum- oder Übernahmeversuch dauerhaft auf.

Übernahmen werden je Originalprojekt serialisiert. Vor dem ersten Schreiben
werden alle Originaldateien und die Projektidentität mit ihren Vorbedingungen
verglichen. Nur der ausdrücklich bestätigte, vollständige Ergebnisdiff wird
veröffentlicht. Die erste Ausbaustufe unterstützt Textdateien zum Hinzufügen,
Ändern und Löschen. Binärdateien und unbekannte Effekte werden klar abgelehnt.
Konflikte behalten Ergebnis und Arbeitskopie für spätere Prüfung. Bei einem
Teilfehler wird die vorhandene journalbasierte Rücknahme genutzt; unsichere
Rücknahmen werden sichtbar gemeldet.

Die vorhandenen Codex-Snapshot- und Veröffentlichungsalgorithmen dienen als
Vorlage für eine providerneutrale Implementierung. Codex-spezifische
Freigabeautoritäten werden weder für andere Provider wiederverwendet noch
gelockert. Neue Task-Agent-Freigaben erhalten einen eigenen nicht fälschbaren
Geltungsbereich. Die bestehenden Codex-Prüfungen bleiben erhalten.

## Agentenlaufzeit und Modellbindung

Ein neuer `TaskAgentFactory` erzeugt aus Projekt, Aufgabe und einem gültigen
Route-Handle einen unabhängigen Agenten. OpenRouter und Nano-GPT nutzen
`OrcodeAgent.create()`; Codex nutzt einen eigenen Managed-Task-Adapter über den
offiziellen App Server, nicht den OpenRouter-SDK-Pfad. Jeder Adapter besitzt
einen eigenen `SessionStore`, `ApprovalManager`, Konfigurationsklon, Journal,
Arbeitsverzeichnis und Abbruchsignal. Ein Manager begrenzt Parallelität und
führt Zustand, Ergebnis und Ereignisse je Agent.

Die Agenten-Modellauswahl darf nicht den vorhandenen Onboarding-Aktivierungsweg
verwenden: Dieser verändert aktuell Default-Route und Sitzung. Stattdessen
validiert eine eigene Auswahlautorität den ausdrücklich gewählten Kandidaten
für den Task, ohne globale Modellpräferenzen zu schreiben. Die Task-Konfiguration
enthält ausschließlich das bestätigte Modell und keine geerbte Modellfallbackkette.

Route, Konto, Abrechnung und aktuelle Credential-Bindung werden vor Start und
Provideranfragen geprüft. Ein Zustand, dessen Autorität ungültig geworden ist,
führt zu einer sichtbaren Unterbrechung beziehungsweise einem Fehler. Er wird
nicht durch ein anderes Modell oder Konto ersetzt. Kontoverbindung, Logout
und Abrechnungsänderung werden während laufender Task-Agenten gesperrt;
lesende Einstellungen bleiben verfügbar.

Codex, OpenRouter und Nano-GPT gehören zur ersten Ausbaustufe. Codex ist kein
optional auf später verschobener Adapter. Kimi bleibt bis zu eigenen gültigen
nativen Freigaben je Task mit nachvollziehbarer Erklärung gesperrt. Es gibt
keinen Ersatzprovider. Ein sichtbares Modell ist nicht automatisch eine
lauffähige beziehungsweise für dieses Konto freigeschaltete Route.

## Codex Abonnement und unabhängige Task Läufe

Codex-Agenten verwenden den ausdrücklich verbundenen lokalen ChatGPT-Account.
Sie verlangen keinen OpenAI-API-Key und wechseln bei einem Fehler oder Limit
nicht auf API-Abrechnung, ein anderes Konto oder ein anderes Modell. Drei
Codex-Agenten dürfen gleichzeitig mit jeweils manuell gewähltem Modell
laufen. Gemischte Codex-/OpenRouter-/Nano-GPT-Aufgaben sind ebenfalls möglich;
das gemeinsame Limit bleibt drei Agenten insgesamt.

Der Modellwähler verwendet den aktuellen Codex-Katalog des verbundenen
Accounts. Es gibt keine fest codierte Modellliste und keine automatische
Default-Modellwahl. Ein Katalogeintrag allein beweist keinen Modellzugang;
eine Ablehnung durch Codex wird sichtbar beim gewählten Modell gemeldet.
Die native Login-/Modellwahl und das Abo-Verfahren sind im offiziellen
[Authentifizierungsleitfaden](https://learn.chatgpt.com/docs/auth) und
[App-Server-Protokoll](https://learn.chatgpt.com/docs/app-server) beschrieben.

Jeder Codex-Task erhält einen eigenen App-Server-Child, eigene Thread-/Turn-IDs,
einen eigenen Route-Gate und eine eigene Freigabebrücke. Die globale
`currentExecutionAuthority()`-Methode ist dafür ungeeignet: Sie setzt die
Default-Route voraus und erneuert beziehungsweise schließt den Hauptclient.
Task-Abbruch und Drain dürfen diesen Hauptclient oder einen Geschwistertask
nicht erreichen.

Eine private abonnementgebundene Auth-Koordination besitzt allein die
Erneuerung des verbundenen Profils. Task-Children erhalten eigene private
Laufzeit-Homes und nur kurzlebige, exakt accountgebundene Auth-Leases, keine
Kopien gemeinsam verwendeter Refresh-Tokens. Für diese Children wird der
offizielle hostverwaltete `chatgptAuthTokens`-Modus ausdrücklich ausgehandelt;
dieser ist experimentell und erfordert einen geprüften kompatiblen App Server.
Die bestehenden nicht-taskbezogenen Vertrauensprüfungen bleiben unverändert.
Neue Task-Freigaben akzeptieren diesen Modus nur mit einer authentischen,
child- und accountgebundenen Autorität, niemals durch ein öffentliches Flag.

Während Task-Auth-Leases aktiv sind, darf der alte Codex-Hauptlauf denselben
Profil-Refresh nicht parallel besitzen. Ein bestehender alter Hauptlauf wird
nicht beendet; der Start weist auf dessen Abschluss hin. Weitere Aufgaben
werden dann über die Agentenverwaltung gestartet. Die gespeicherte
Hauptchat-Modellroute bleibt erhalten. So konkurrieren keine unabhängigen
OAuth-Refresh-Schreiber um das Profil, ohne die drei Task-Läufe zu serialisieren.

Die vorhandene Codex-Ausführung veröffentlicht momentan nach Laufabschluss
ihre genehmigten Effekte. Der neue Task-Adapter erhält deshalb einen eigenen
Capture-only-Abschluss: Child und Freigabebrücke erst drainen, sämtliche
zulässigen Ergebnisbytes dauerhaft sichern, später separat über die Task-
Übernahme freigeben. Er ruft keinen Originalprojekt-Publisher automatisch auf.
Auch Abbruch-/Fehlerbereinigung darf die einzige Kopie eines Teilergebnisses
nicht vorher löschen. Die native Codex-Patchautorität bleibt innerhalb des
Codex-Tasks; Originalprojekt-Apply bekommt die neue Task-Agent-Autorität.

Alle Codex-Agenten desselben Accounts verbrauchen dessen gemeinsames
Kontingent. Die GUI zeigt diese gemeinsame Zuordnung und nur tatsächlich
bekannte Limits beziehungsweise „Limit unbekannt“. Es gibt keine behaupteten
drei unabhängigen Abokontingente und keine erfundenen Kostenwerte. Limit-
Resets, zusätzliche Credits und kostenpflichtige Ersatzwege werden nicht
automatisch aktiviert. Bei Auth-/Limitfehlern bleiben Ergebnisse erhalten;
Fortsetzen ist eine ausdrückliche neue Aktion.

Jeder Agent erhält eine eigene Freigabewarteschlange. Antworten sind an
`projectId`, `agentId`, `runId` und `askId` gebunden. Eine Freigabe aus einer
anderen Ansicht, ein alter Ask oder ein beendeter Lauf darf keinen Effekt
auslösen. Offene Freigaben werden beim Stoppen geschlossen; andere Agenten
laufen unverändert weiter.

## GUI und Protokoll

Die bestehende ruhige Projektoberfläche wird erweitert, nicht durch ein
zweites Terminal ersetzt. Links stehen Projekt und Chats; eine Agentenübersicht
ist direkt erreichbar. Im Hauptbereich erscheinen der ausgewählte Chat oder
die eigene Agentenansicht. Änderungen bleiben als aufklappbare Detailansicht
bei ihrem Agenten. Starten, Stoppen und Übernehmen sind sichtbare Buttons.

Neue strukturierte Projekt- und Agentenbefehle nutzen die vorhandene Engine.
Die GUI baut dafür keine Slash-Befehlsstrings. Kernzustand und Nebenwirkungen
bleiben Engine-Aufgaben; Komponenten in der GUI dürfen keine Agenteninstanzen,
Credentials oder Projektpfade als Autorität verwalten.

Jedes Agentenereignis trägt `projectId`, `agentId`, `runId`, Sequenznummer und
ein vorhandenes redigiertes Run-Ereignis. Ansichten filtern nach exakter
Identität, erkennen Wiederholungen und dürfen fremde Ereignisse nicht als
eigene Ausgabe zeigen. Die Engine liefert auch nach einem Ansichtswechsel
einen begrenzten Snapshot mit aktuellem Zustand und bisheriger Ausgabe.

Der neue Funktionsumfang wird im GUI-Handshake ausdrücklich ausgehandelt.
Ein Client ohne passende Agentenfähigkeit kann keinen Task-Agenten starten
oder Freigaben beantworten und bekommt keine ihm unbekannten Agentenframes.
Versionskonflikte führen zu einem sichtbaren Updatehinweis, nicht zu einer
falschen Zuordnung zum Hauptchat.

Laufstatus und Ergebnisstatus sind getrennt. Die Laufzustände heißen Startet,
Läuft, Wartet auf Freigabe, Wird gestoppt, Gestoppt, Abgeschlossen und
Fehlgeschlagen. Nach einem Engineabbruch sind unvollendete Läufe Unterbrochen.
Ergebnisse sind Ungeprüft, Werden übernommen, Übernommen oder Im Konflikt.
Ein Neustart startet keine Provideranfrage automatisch. Fortsetzen ist eine
bewusste neue Aktion.

## Integrationsgrenzen

Der neue Manager, die Arbeitskopien, Routenauswahl und Protokollprojektionen
werden eigene Module. `src/cli.ts` bleibt der Zusammensetzungspunkt für die
bereits vorhandenen Provider und bekommt keine zweite vollständige Orchestrierung.
`src/gui-server.ts` delegiert neue Befehle an diese Module. Die Oberfläche
nutzt die vorhandenen Modellwähler und Run-Komponenten mit getrenntem Zustand
je Ansicht.

Die private Originalkonfiguration wird nie zum Testziel. Tests verwenden
explizite temporäre App-Homes und Credential-Doubles. Bestehende uncommittete
Nano-GPT-Änderungen und fremde Repositoryänderungen werden erhalten. GitHub-Push,
Installation, Live-Providerkosten und ein Umbau des unveränderten Originalcheckouts
sind keine automatischen Schritte dieser Designfreigabe.

## Abnahmekriterien

- Eine echte lokale GUI öffnet einen gewählten Testprojektordner; Abbrechen,
  ungültige Pfade und Projektwechsel während laufender Agenten haben definierte
  Ergebnisse ohne Datenverlust.
- Zwei echte Engine-Agenten starten mit verschiedenen Aufgaben und ausdrücklich
  gewählten Fixture-Modellen parallel. Das ist ein Laufzeittest, keine bloße
  Agentenkarten-Demo. Ein dritter Agent läuft unabhängig; das Parallelitätslimit
  startet keinen weiteren versteckten Job.
- Drei Codex-Task-Adapter laufen über unabhängige App-Server-Children und
  manuell gewählte Fixture-Modelle tatsächlich gleichzeitig; A stoppen oder
  dessen Freigabe schließen lässt B und C weiterlaufen. Der echte native
  Codex-Abo-/Modellpfad erhält eine eigene Abnahme; ein Fixture allein belegt
  keinen echten Abozugang. Eine kostenpflichtige Live-Aufgabe gehört nur nach
  gesonderter Freigabe zur Abnahme.
- Codex-Modelle kommen aus dem verbundenen Katalog. Auth-Erneuerung ist
  serialisiert, Inferenz nicht; accountfremde Tokens, fremde Child-IDs,
  Modellsubstitution und API-Fallback starten keinen Task.
- Live-Text, Werkzeugausgaben, Freigaben und Kosten landen ausschließlich beim
  jeweiligen Agenten. Ansichtwechsel und verspätete Frames vermischen sie nicht.
- Stoppen eines Agenten beendet seine Anfragen, Prozesse und Freigaben, nicht
  die anderen Läufe. Schließen beziehungsweise Engineabbruch hinterlässt keine
  unkontrollierten Hintergrundprozesse oder automatischen Neustarts.
- Originaldateien bleiben bei Agentenarbeit unverändert. Zwei widersprüchliche
  Ergebnisse, externe Änderungen, Teilfehler und erneute Übernahmeversuche werden
  gegen genaue Datei-Vorbedingungen getestet. Ergebnisse bleiben nach Konflikten
  verfügbar; Undo überschreibt keine inzwischen fremd geänderten Dateien.
- Schlüssel, private Kontofingerprints und Bindungsdaten gelangen nicht in
  Ansichten, Logs oder Ergebnisse. Modell-, Konto- und Abrechnungsfallbacks sowie
  Freigaben für einen fremden Lauf werden negativ getestet.
- Die tatsächliche App wird in einem temporären Home mit kontrollierter Engine
  durch Öffnen, zwei Starts, Ansichtwechsel, Freigabe, Stoppen und Ergebnisübernahme
  geprüft. Bestehende Provider- und Codex-Gates werden getrennt ausgewiesen;
  Komponententests allein sind keine Releasefreigabe.
