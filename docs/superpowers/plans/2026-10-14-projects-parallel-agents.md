# orcode Projects and Parallel Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein Projekt über die native Ordnerauswahl öffnen und darin bis zu drei unabhängige Coding-Agenten mit eigenen Ansichten, Aufgaben und ausdrücklich manuell gewählten Modellen betreiben.

**Architecture:** Die Engine besitzt Projektidentität, Agenten, Routen, Freigaben und Ergebnisse; die GUI zeigt ausschließlich sichere Projektionen und sendet strukturierte Anforderungen. Jeder Agent erhält eine geprüfte Arbeitskopie, eine eigene Sitzung und ein eigenes Abbruchsignal. Der bestehende sichere Veröffentlichungsalgorithmus übernimmt einen exakt freigegebenen Ergebnisdiff erst nach erneuter Prüfung des Originalprojekts.

**Tech Stack:** Node.js >=22, TypeScript, node:test, vorhandenes OpenRouter Agent SDK und Nano-GPT-Laufzeit, PrivateStore, Vanilla-TypeScript-GUI, Vitest, Playwright, Tauri v2 mit installiertem Dialog-Plugin. Keine neue Laufzeitabhängigkeit.

**Spec:** [Freigegebenes Design](../specs/2026-10-14-projects-parallel-agents-design.md), Commit `1467d4a87a0c01dd8004a5b9f1a405d417bf05d2`.

## Global Constraints

- „Normale Bedienung verlangt keine Slash-Befehle.“
- „Konten und Zugangsdaten bleiben ausschließlich beim lokalen Eigentümer.“
- „Kein Agent wählt automatisch ein anderes Modell, Konto oder einen anderen Abrechnungsmodus.“
- „Die vorhandene Nano-GPT-Erweiterung bleibt erhalten.“
- „Pro Projekt können zunächst drei Agenten gleichzeitig laufen.“
- „Weitere Starts werden mit einer verständlichen Meldung abgelehnt; es gibt keine unsichtbare kostenpflichtige Warteschlange.“
- „Ein Projekt ist in der ersten Ausbaustufe aktiv.“
- „Projektwechsel ist gesperrt, solange Agenten oder ein Übernahmevorgang laufen.“
- Für Git-Worktrees gilt: „Sie gehören nicht in die erste Ausbaustufe.“
- „Arbeitskopien sind keine behauptete Betriebssystem-Sandbox; bestehende Shell-Freigaben gelten weiter.“
- „Nur der ausdrücklich bestätigte, vollständige Ergebnisdiff wird veröffentlicht.“
- „Die erste Ausbaustufe unterstützt Textdateien zum Hinzufügen, Ändern und Löschen.“
- „Codex-spezifische Freigabeautoritäten werden weder für andere Provider wiederverwendet noch gelockert.“
- „Ein Neustart startet keine Provideranfrage automatisch.“
- „Die private Originalkonfiguration wird nie zum Testziel.“
- „Tests verwenden explizite temporäre App-Homes und Credential-Doubles.“
- „GitHub-Push, Installation, Live-Providerkosten und ein Umbau des unveränderten Originalcheckouts sind keine automatischen Schritte dieser Designfreigabe.“

Bestehende Aufnahmegrenzen aus `src/codex-staging-workspace.ts` bleiben bei der gemeinsamen Extraktion erhalten: 32 MiB je Datei, 512 MiB je Baum, 100.000 Einträge, 2 MiB Patch-Diff. Die Task-Ergebnisablage wird von der wegwerfbaren Kopie getrennt. Überschreitungen verweigern Aufnahme beziehungsweise Vorschau nachvollziehbar; sie kürzen niemals einen zur Übernahme freigegebenen Diff.

## Review Focus

1. **Doppelklick und vier gleichzeitige Starts:** atomare Platzreservierung vor jedem `await`, maximal drei Läufe und kein vierter Provideraufruf — Task 4.
2. **Ordnerauswahl wird erst nach Engine-/Projektwechsel beantwortet:** den alten Auswahlvorgang ablehnen, niemals das Ersatzprojekt umschalten — Tasks 1 und 8.
3. **Quellbaum verändert sich während der Aufnahme oder wird per Symlink/Inode ersetzt:** keine Provideranfrage und kein unvollständiger Ausgangsstand — Task 2.
4. **Übernahme scheitert, danach Neustart und erneute Übernahme:** unveränderte Ergebnisbytes bleiben verfügbar, aktuelle Vorbedingungen werden erneut geprüft, keine automatische Fortsetzung — Tasks 5 und 9.
5. **Verspätete, doppelte oder fremde Frames/Freigaben:** keine Ausgabe und keine Freigabewirkung im falschen Agenten; bei Sequenzlücken gezielt neu synchronisieren — Tasks 4, 6 und 7.

---

## Ausgangspunkt und Reihenfolge

Arbeitsverzeichnis für alle relativen Pfade und Befehle:

```text
/Users/dogancankaya/Documents/Codex/2026-08-22/ok-wie-siehts-da-eigentlich-aus/orcode-github-workbench-2026-10-12
```

Der Checkout enthält noch nicht committete Nano-GPT-Änderungen. Vor der Ausführung `git status --short`, `git diff --stat` und `git diff --cached --stat` erfassen; nur die tatsächlich selbst bearbeiteten Hunks stagen. Kein `git add .`, kein Reset, kein ungeprüfter Wechsel auf einen nur auf HEAD basierenden Checkout. Muss die gewählte Ausführung isoliert werden, die vorhandenen Änderungen nach dem Worktree-Skill kontrolliert mitnehmen; ein neuer Checkout nur von HEAD würde Nano-GPT verlieren.

Dies ist ein zusammenhängender Plan: Projektöffnung ist ein eigenes nutzbares erstes Paket, die folgenden Pakete teilen dieselbe Projekt-/Laufidentität. Eine zweite Orchestrierung oder unabhängige Backend-Control-Plane entsteht nicht.

```text
1 Projekt öffnen
       ↓
2 Kopien und dauerhafte Ergebnisse → 3 exakte Task-Routen und Factory
       └───────────────────────────────┬─────────────────────┘
                                     ↓
                              4 Agentenmanager
                                     ↓
                         5 Freigabe und Übernahme
                                     ↓
                       6 strukturierter GUI-Vertrag
                                     ↓
                    7 Agentenübersicht und eigene Ansichten
                                     ↓
                  8 sicherer Wechsel und Laufzeitverdrahtung
                                     ↓
                       9 echte Engine-/App-Abnahme
```

Vor Task 9 dürfen unabhängige Modulprüfungen grün sein, aber das Gesamtprodukt wird noch nicht als fertig bezeichnet. Neue Schnittstellen laufen erst nach Task 8 im tatsächlichen GUI-Engine-Pfad.

Alle folgenden Node-Testbefehle laufen **ab Task 1** mit dem dort angelegten Home-Preload. Dafür einmal je Testsession einen privaten temporären Ordner erzeugen und taskbezogene Variablen setzen; vorhandene Node-Optionen bleiben erhalten:

```bash
ORCODE_TEST_HOME=$(mktemp -d /tmp/orcode-task-tests.XXXXXX)
ORCODE_TASK_PRELOAD="$PWD/tests/fixtures/isolated-app-home.mjs"
ORCODE_TASK_ORIGINAL_NODE_OPTIONS="${NODE_OPTIONS-}"
export ORCODE_TEST_HOME
export NODE_OPTIONS="$ORCODE_TASK_ORIGINAL_NODE_OPTIONS --import=$ORCODE_TASK_PRELOAD"
```

Das gilt auch für bestehende Regressionstests und deren Kindprozesse. Kein echtes Home wird als Variable umdefiniert. Builds und UI-Teststarts nicht aus einem Terminal mit tatsächlichen privaten Credentials ableiten. Nach Abschluss `NODE_OPTIONS` auf `ORCODE_TASK_ORIGINAL_NODE_OPTIONS` zurücksetzen und nur taskbezogene Exporte entfernen; keine Shellprofile ändern.

## Dateiverantwortung

| Dateien | Verantwortung |
| --- | --- |
| `src/projects.ts`, `src/project-operation-gate.ts` | Private Projektzuordnung, jüngste Projekte, vollständiger Projektwechsel, atomare Zulassung von Start/Apply/Wechsel |
| `src/task-agents/contracts.ts` | Gemeinsame sichere Ansichten, Lauf-/Ergebnisstatus und Identitätsfelder |
| `src/verified-workspace-copy.ts` | Providerneutrale Extraktion der bestehenden Aufnahme-/Scanalgorithmen, ohne Freigabeautorität |
| `src/task-agents/workspaces.ts`, `result-store.ts` | Task-Kopien, zweite Aufnahmeprüfung, dauerhaft gespeicherte vollständige Ergebniseffekte |
| `src/task-agents/routes.ts`, `openrouter-runtime.ts`, `factory.ts` | Lesende manuelle Routenauswahl, exakte Credential-Prüfung vor Anfragen, unabhängige Agentenerzeugung |
| `src/task-agents/manager.ts`, `approvals.ts` | Drei Plätze, Lebenszyklus, eigene Ereignisse/Asks, Abbruch und kontrollierter Shutdown |
| `src/task-agents/apply.ts` | Neue Task-Freigabeautorität, serialisierte Veröffentlichung, Konflikt-/Rollback-/Undo-Verhalten |
| `src/task-agents/gui-port.ts` | Strukturierte Anforderungen und sichere Protokollprojektion; kein zweiter Manager |
| `gui/src/project-open.ts`, `agent-state.ts`, `agent-overview.ts`, `agent-start.ts`, `agent-view.ts` | Native Auswahl, manuelle Auswahl, Agentenansichten und reine Darstellung |
| `src/cli.ts`, `src/gui-server.ts`, `src/commands.ts`, `src/workspace.ts` | Kleine Zusammensetzungs-/Extraktionsstellen im vorhandenen Kern |
| `src/gui-protocol.ts`, `gui/src/protocol.ts`, `gui/src/bridge.ts`, `gui/src-tauri/src/lib.rs` | Handshake, identitätsgebundene Frames und generationengebundene native Ordnerauswahl |

## Gemeinsame Schnittstellen

Die folgenden neuen Typen werden in Task 1 beziehungsweise Task 2 angelegt. Kernprivate Objekte werden nicht in das GUI-Protokoll exportiert.

```ts
// src/projects.ts — kernel private except ProjectView
export interface ProjectBinding {
  readonly id: string;
  readonly epoch: number;
  readonly guard: WorkspaceGuard;
  readonly appHome: string;
  readonly name: string;
}
export interface ProjectView {
  readonly id: string;
  readonly epoch: number;
  readonly name: string;
}
export interface ProjectOpenIntent {
  readonly path: string; // untrusted picker input, never authority
  readonly expectedProjectId: string;
  readonly expectedEpoch: number;
}
export interface ProjectPort {
  current(): ProjectBinding;
  recent(): Promise<readonly ProjectView[]>;
  open(intent: ProjectOpenIntent): Promise<ProjectView>;
  openRecent(id: string, expectedEpoch: number): Promise<ProjectView>;
}

// src/task-agents/contracts.ts — public projections
export interface TaskRunKey {
  readonly projectId: string;
  readonly agentId: string;
  readonly runId: string;
}
export type TaskRunState = "starting" | "running" | "waiting-approval"
  | "stopping" | "stopped" | "completed" | "failed" | "interrupted";
export type TaskResultState = "unreviewed" | "applying" | "applied" | "conflict";
export interface TaskAgentView extends TaskRunKey {
  readonly name: string;
  readonly task: string;
  readonly model: DesktopRoutePickerCandidate;
  readonly state: TaskRunState;
  readonly resultState: TaskResultState | null;
  readonly openApprovalCount: number;
  readonly cost: { readonly kind: "known"; readonly usd: number }
    | { readonly kind: "unknown" };
}
export interface TaskAgentEvent extends TaskRunKey {
  readonly sequence: number;
  readonly event: AgentRunEvent;
}
export interface TaskAgentSnapshot {
  readonly view: TaskAgentView;
  readonly highWater: number;
  readonly events: readonly TaskAgentEvent[];
  readonly nextCursor: string | null;
}
export interface TaskResultView extends TaskRunKey {
  readonly resultHandle: string;
  readonly digest: string;
  readonly state: TaskResultState;
  readonly changes: readonly {
    readonly path: string; readonly kind: "add" | "update" | "delete";
    readonly diff: string;
  }[];
  readonly verification: "verified" | "unverified" | "failed";
  readonly exclusions: readonly string[];
  readonly notice?: string; // issued safe failure/recovery text only
}
```

`WorkspaceGuard` kommt aus `src/workspace.ts`, `DesktopRoutePickerCandidate` aus `src/route-picker.ts`, `AgentRunEvent` aus `src/types.ts`. `TaskRunKey.runId` ist die Manager-Laufidentität. Die separate interne Agent-Run-ID aus `OrcodeAgent.run()` wird privat beim `run-start`-Ereignis erfasst, nicht mit ihr verwechselt.

### Task 1: Projekt tatsächlich öffnen statt einen Ordnerbefehl anzeigen

**Files:**

- Create: `src/projects.ts`, `src/project-operation-gate.ts`, `gui/src/project-open.ts`, `tests/fixtures/isolated-app-home.mjs`
- Modify: `src/commands.ts:769,3781`, `gui/src-tauri/src/lib.rs:1336,3602`, `gui/src/sidebar.ts:79`
- Test: `tests/projects.test.ts`, `tests/project-operation-gate.test.ts`, `gui/tests/project-open.test.ts`, Rust-Tests in `gui/src-tauri/src/lib.rs`

**Interfaces:**

- Consumes: `CommandContext.reRootWorkspace?(newWorkspace: string): Promise<WorkspaceReRootResult>`, `SessionStore.open(workspace, appHome, providerConnection?)`, den vorhandenen `replaceSession`-Pfad.
- Produces: `ProjectPort` und `ProjectBinding` wie oben; `openExistingProject(context: CommandContext, path: string): Promise<WorkspaceReRootResult>` als vollständiger geteilter Command-/GUI-Pfad.
- Produces: `ProjectOperationGate.reserveAgent(projectId: string): () => void`, `withApply<T>(projectId: string, operation: () => Promise<T>): Promise<T>`, `withSwitch<T>(operation: () => Promise<T>): Promise<T>`, `isBusy(): boolean`.
- Produces: `chooseProject(pick: () => Promise<string | null>, open: (path: string) => Promise<void>): Promise<"cancelled" | "opened">`; Tauri `project_pick_folder(expected_generation: u64) -> Result<Option<String>, ShellError>`.

- [ ] **1. Home-Isolation vor dem ersten Test anlegen.** Das Preload enthält keine Providerauflösung und verändert keine Datei des realen Homes:

```js
// tests/fixtures/isolated-app-home.mjs
import os from "node:os";
import { lstatSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = os.homedir;
const real = original();
const testRoot = process.env.ORCODE_TEST_HOME;
if (!testRoot || !lstatSync(testRoot).isDirectory() || testRoot === real) {
  throw new Error("A separate explicit test home is required");
}
os.homedir = () => { const value = original(); return value === real ? testRoot : value; };
syncBuiltinESMExports();
```

Guard zusätzlich vor Import von `src/config.ts` prüfen: `APP_HOME` muss im Temp-Root liegen. Test-only Overrides anderer Fixture-Homes bleiben wirksam. Alle neuen Tests verlangen darüber hinaus explizite App-Home-Konstruktorargumente.

- [ ] **2. Cancel- und Fehlerprüfungen zuerst schreiben.** Native Auswahlabbruch darf nicht einmal die Engine-Öffnung aufrufen:

```ts
test("picker cancellation makes no engine request", async () => {
  let opens = 0;
  const result = await chooseProject(async () => null, async () => { opens++; });
  assert.equal(result, "cancelled");
  assert.equal(opens, 0);
});
```

Zusätzlich mit `mkdtemp`, `mkdir` und `writeFile` aus `node:fs/promises` in temporären Ordnern testen: existierendes Nicht-Git-Projekt, fehlender Ordner, Datei statt Ordner, Pfad mit Leerzeichen/Umlauten, Dateisystemwurzel, aktuelles Home, App-Home sowie dessen überlappende Eltern/Kinder. Ablehnung muss Projekt, Session und Recent-Liste unverändert lassen; es wird kein Ordner angelegt. Ein alter `expectedEpoch` scheitert vor `openExistingProject`.

- [ ] **3. Rote Tests ausführen.** `env -u FORCE_COLOR node --import tsx --test tests/projects.test.ts tests/project-operation-gate.test.ts`; `npm --prefix gui test -- project-open.test.ts`. Erwartet: fehlende neue Module/Exporte, nicht ein Test gegen die echte Konfiguration.
- [ ] **4. Den vollständigen bestehenden Folder-open-Pfad extrahieren.** `openExistingProject` prüft das Ziel und ruft `reRootCommandWorkspace`, `SessionStore.open` mit explizitem bisherigen App-Home sowie `replaceSession` auf. Bei fehlgeschlagenem ReRoot das typisierte Ergebnis zurückgeben, ohne „gewechselt“ auszugeben. `/folder open` nutzt denselben Export; `/folder new` behält seine eigene ausdrückliche Erstellungsfreigabe. Die neue GUI-Öffnung verwendet nie den `new`-Pfad.
- [ ] **5. Gate und private Projektliste implementieren.** `reserveAgent` erhöht synchron einen Zähler vor asynchroner Aufnahme; `withSwitch` setzt synchron eine exklusive Wechselmarkierung und verweigert aktive Reservierungen/Applies. `withApply` reiht nur explizit gestartete Applies pro Projekt ein und blockiert Projektwechsel ab Einreihung, nicht erst ab Schreiben. Alle Freigaben werden im `finally` gelöst. Recent-Liste unter einem privaten `PrivateStore`-Pfad speichern; UUIDs sind öffentliche IDs, kanonische Pfade und dev/ino bleiben privat. Erst erfolgreicher vollständiger Sessionwechsel aktualisiert die Liste. Fehlende Recent-Ziele markieren, aber weder Projektdateien noch Chats löschen.

Das Switch-Primitive erhält synchron seine Markierung, nicht erst nach einem Lock-`await`:

```ts
async withSwitch<T>(operation: () => Promise<T>): Promise<T> {
  if (this.isBusy()) throw new Error("project-busy");
  this.#switching = true;
  try { return await operation(); }
  finally { this.#switching = false; }
}
```

`#switching: boolean = false` gehört zum Gate; `isBusy()` umfasst diese Markierung, aktive Reservierungen sowie eingereihte Applies. `ProjectPort.open` besitzt den Switch-Gate genau einmal und prüft darin den erwarteten Project-Epoch erneut.
- [ ] **6. Native Auswahl asynchron und generationengebunden ergänzen.** Installiertes `app.dialog().file().pick_folder(...)` verwenden; kein blockierender Dialog auf dem UI-Thread. Mit `tokio::sync::oneshot` den Callback zurückgeben. Vor Aufruf und nach Callback dieselbe aktive Enginegeneration prüfen; bei Abweichung `engine-restarted`. Bestehenden Live-Engine-Handle/Writer-Präzedenzfall bei `TauriNativeLocalActionPrompter::show` nutzen; keine vom WebView frei erfundene Generation akzeptieren. `None` bleibt Cancel. Den neuen Invoke-Handler registrieren.

```rust
let (sender, receiver) = tokio::sync::oneshot::channel();
app.dialog().file().pick_folder(move |folder| {
    let _ = sender.send(folder);
});
let selected = receiver.await;
```

`selected` wird erst nach erneutem Vergleich mit dem beim Start privat erfassten Enginegeneration-Handle verarbeitet. Channel-Abbruch ist ein sicherer Shell-Fehler, kein „letztes gewähltes Projekt“.
- [ ] **7. Kleine GUI-Öffnung schreiben.**

```ts
export async function chooseProject(
  pick: () => Promise<string | null>,
  open: (path: string) => Promise<void>,
): Promise<"cancelled" | "opened"> {
  const path = await pick();
  if (path === null) return "cancelled";
  await open(path);
  return "opened";
}
```

Der Sidebar-Handler wird `openProject(): void` statt `run("/folder")`; die produktive Protokollverdrahtung folgt in Task 8. Native Cancel, Callback nach Engineersatz und zwei gleichzeitig geöffnete Dialoge in Rust negativ testen. Die spätere Auswahl darf eine frühere nicht heimlich ersetzen.
- [ ] **8. Grün prüfen und genau dieses Paket committen.** Obige Tests plus `tests/workspace.test.ts`, `tests/commands.test.ts` und `cargo test --manifest-path gui/src-tauri/Cargo.toml`. `git diff --check`; nur neue Dateien und eigene Hunks der bereits schmutzigen Dateien stagen. Commit: `feat(projects): add native project opening and guarded handoff`.

### Task 2: Geprüfte Agentenkopien und dauerhaft erhaltene Ergebnisse

**Files:**

- Create: `src/task-agents/contracts.ts`, `src/verified-workspace-copy.ts`, `src/task-agents/workspaces.ts`, `src/task-agents/result-store.ts`
- Modify: `src/codex-staging-workspace.ts:172,551` ausschließlich gemeinsame Aufnahme-/Scanalgorithmen extrahieren
- Test: `tests/task-agent-workspaces.test.ts`, `tests/task-agent-result-store.test.ts`, bestehend `tests/codex-staging-workspace.test.ts`

**Interfaces:**

- Consumes: `ProjectBinding`, `WorkspaceGuard.assertCurrent(): Promise<void>`, `PrivateStore` mit Directory-Claims.
- Produces: `TaskWorkspace` als kernprivates, authentisches Objekt mit `key: TaskRunKey`, `canonicalPath: string`, `baselineDigest: string`, `exclusions: readonly string[]`.
- Produces: `createTaskWorkspace({project: ProjectBinding, key: TaskRunKey, signal: AbortSignal}): Promise<TaskWorkspace>`; `captureTaskResult(workspace: TaskWorkspace, verification: TaskResultView["verification"]): Promise<TaskStoredResult>`; `discardTaskWorkspace(workspace: TaskWorkspace): Promise<void>`.
- Produces: `TaskStoredResult` kernprivat mit `key: TaskRunKey`, `digest: string`, `baselineDigest: string`, `projectRootIdentity: {canonicalRoot: string; dev: string; ino: string}`, `effects: readonly GuardedWorkspaceFileEffect[]`, `exclusions: readonly string[]`, `verification: TaskResultView["verification"]`; die bestehenden `GuardedWorkspaceFileEffect`-Vorbedingungen um den ursprünglichen Manifest-/Metadatenstand ergänzen, ohne sie abzuschwächen. Effekte enthalten vollständige Before-/After-Inhalte und Metadaten, niemals nur einen dargestellten Diff.
- Produces: `TaskResultStore.open(appHome: string): Promise<TaskResultStore>`, `.save(result: TaskStoredResult): Promise<TaskResultView>`, `.read(key: TaskRunKey): Promise<TaskStoredResult>`, `.view(key: TaskRunKey): Promise<TaskResultView>`, `.setState(key: TaskRunKey, state: TaskResultState): Promise<void>`, `.saveRun(view: TaskAgentView): Promise<void>`, `.listRuns(projectId: string): Promise<readonly TaskAgentView[]>`, `.recoverRuns(): Promise<readonly TaskAgentView[]>`.

- [ ] **1. Aufnahme- und Dauerhaftigkeitstests schreiben.** Der nachstehende Kern prüft aktuelle Arbeitsdateien statt HEAD und Ergebnisverlust nach Aufräumen:

```ts
test("current bytes survive staging disposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-task-copy-"));
  const source = join(root, "project");
  const appHome = join(root, "app");
  await mkdir(source); await mkdir(appHome, { mode: 0o700 });
  await writeFile(join(source, "a.txt"), "dirty working bytes\n");
  const project = { id: "p", epoch: 1, name: "project", appHome,
    guard: await WorkspaceGuard.create(source) };
  const key = { projectId: "p", agentId: "a", runId: "r" };
  const copy = await createTaskWorkspace({ project, key,
    signal: new AbortController().signal });
  assert.equal(await readFile(join(copy.canonicalPath, "a.txt"), "utf8"),
    "dirty working bytes\n");
  await writeFile(join(copy.canonicalPath, "a.txt"), "agent result\n");
  const store = await TaskResultStore.open(appHome);
  const result = await captureTaskResult(copy, "unverified");
  await store.save(result);
  await discardTaskWorkspace(copy);
  assert.equal((await store.view(key)).changes[0]!.kind, "update");
  assert.equal(await readFile(join(source, "a.txt"), "utf8"), "dirty working bytes\n");
  assert.equal((await (await TaskResultStore.open(appHome)).read(key)).digest, result.digest);
});
```

- [ ] **2. Review-Focus 3 als deterministischen Race-Test ergänzen.** Dem kernprivaten Copy-Scanner ein ausschließlich injiziertes `afterInitialCapture?: () => Promise<void>`-Testhook geben. Dort Quellinhalt ändern; `createTaskWorkspace` muss `snapshot-unstable` ablehnen. Weitere Fälle: Verzeichnis-/Inodewechsel, ausbrechender Symlink, Hardlink, Mountgrenze, geschützter Pfad, `.git`, ignorierte Dependency-Verzeichnisse und private App-/Provider-Speicher. Ein Test-Dispatchzähler bleibt bei null. `.git`-Index und zugelassene untracked/staged/unstaged Arbeitsbytes getrennt prüfen, ohne History in die Kopie zu kopieren.
- [ ] **3. Rot ausführen.** `env -u FORCE_COLOR node --import tsx --test tests/task-agent-workspaces.test.ts tests/task-agent-result-store.test.ts`; erwartet fehlende neue Exporte.
- [ ] **4. Nur authorityfreie Copy-Algorithmen extrahieren.** Die vorhandenen `copyVerifiedWorkspace`, `scanTree`, Manifest-/Metadatenvergleich und Bounds aus `codex-staging-workspace.ts` in `verified-workspace-copy.ts` verschieben. Codex ruft sie mit seinen bisherigen Optionen auf; seine WeakMaps, Preview-/Receipt-Typen und Cleanup-Semantik bleiben unverändert. Der neue Task-Pfad erstellt eigene owner-only Claims unter `<appHome>/task-agents/workspaces/<run>` und validiert zusätzlich den gesamten zugelassenen Quellmanifeststand ein zweites Mal vor Dispatch.
- [ ] **5. Private Store-Commit-Reihenfolge implementieren.**

```ts
// After run settlement; the manager must await each operation.
const stored = await captureTaskResult(workspace, verification);
const publicResult = await resultStore.save(stored);
// save() is durable before cleanup; conflict cases keep the workspace.
return publicResult;
```

`save` verwendet die vorhandene atomare/dauerhafte PrivateStore-Schreibprimitive, prüft root/Claims vor und nach dem Schreiben und verifiziert SHA-256 über vollständige Effekte und Vorbedingungen. Resultatdaten liegen außerhalb der wegwerfbaren Kopie. `read` prüft Schema, Digests, Identität und lokale Eigentümerschaft neu; ein JSON-Objekt allein wird keine Apply-Autorität. Die Aufnahme lehnt unsichere Dateitypen/Links ab, nicht unveränderte zulässige Binärassets. Der Resultatabschluss lehnt geänderte Binärdateien, ungültiges UTF-8 in geänderten Textdateien und unbekannte Effekte ab; ausgeschlossene Build-Abhängigkeiten werden separat sichtbar aufgelistet.
- [ ] **6. Grün und Codex-Regression prüfen.** Obige neue Tests plus `tests/codex-staging-workspace.test.ts`, `tests/private-store.test.ts`, `tests/private-store-identity-races.test.ts`. Test für Result-Store-Schreibfehler: Arbeitskopie nicht löschen, keine Übernahme ermöglichen, klarer Fehler. Commit: `feat(agents): preserve verified isolated task results`.

### Task 3: Manuelle Task-Routen und wirklich taskgebundene Laufzeit

**Files:**

- Create: `src/task-agents/routes.ts`, `src/task-agents/openrouter-runtime.ts`, `src/task-agents/factory.ts`, `tests/fixtures/route-picker-fixture.ts`
- Modify: `src/cli.ts:919,1807,2699` kleine Task-Port-Zusammensetzung; kein Onboarding-Aktivieren
- Modify: `tests/route-picker.test.ts` nur gemeinsame Fixture-Helfer importieren
- Test: `tests/task-agent-routes.test.ts`, `tests/task-agent-openrouter-runtime.test.ts`, `tests/task-agent-factory.test.ts`

**Interfaces:**

- Consumes: `RoutePickerAuthority.view({role: "executor"})`, `.resolve({role: "executor"}, selection: RoutePickerSelectionIntent)`, `ProviderCredentialAuthorityLike.withCredential`, `createNanoGptModelRuntime`, `OrcodeAgent.create`.
- Produces: `TaskRoutePort.view(): RoutePickerView`, `.resolve(selection: RoutePickerSelectionIntent): TaskRouteProof`, `.assertCurrent(proof: TaskRouteProof): Promise<void>`, `.createRuntime(proof: TaskRouteProof, config: OrcodeConfigWithBudget): Promise<{runtime: ModelRuntime; binding: ModelRuntimeBindingIdentityV1}>`.
- Produces: `TaskRouteProof` authentisches kernprivates Objekt, nur durch `resolve` ausgegeben; enthält exact route, connectionId, revision/generation und sichere Candidate-Projektion in privater WeakMap.
- Produces: `createTaskConfig(base: OrcodeConfigWithBudget, modelId: string): OrcodeConfigWithBudget`.
- Produces: `TaskAgentFactory` constructor dependencies `{appHome: string; baseConfig: OrcodeConfigWithBudget; routes: TaskRoutePort}`, `.create({key: TaskRunKey, workspace: TaskWorkspace, task: string, proof: TaskRouteProof, approvals: ApprovalManager}): Promise<TaskAgentInstance>`.
- Produces: `TaskAgentInstance.run(observer: AgentRunObserver): Promise<AgentRunResult>`; keine erfundene `agent.dispose()`-Methode.

**Verifizierte Stolperfalle:** Der aktuelle OpenRouter-`modelRuntime` prüft zwar das Route-Argument, verwendet danach aber `this.openRouter` mit dessen globalem Key und `this.config` mit Default/Fallback-Modellen. Das ist für unabhängige Task-Konten kein ausreichender Nachweis. Ein separater requestautorisierter Adapter gehört deshalb ausdrücklich zu diesem Paket; unverändertes Wiederverwenden ist verboten.

- [ ] **1. Konfigurations- und Picker-Tests schreiben.**

```ts
test("task config cannot inherit another model or mutate the default", () => {
  const base = structuredClone(DEFAULT_CONFIG);
  base.mainModel = "default/model";
  base.fallbackModels = ["other/model"];
  const before = structuredClone(base);
  const task = createTaskConfig(base, "chosen/model");
  assert.equal(task.mainModel, "chosen/model");
  assert.deepEqual(task.fallbackModels, []);
  assert.equal(task.compressionMode, "off");
  assert.equal(task.provider.allowFallbacks, false);
  assert.deepEqual(base, before);
});
```

In `tests/route-picker.test.ts` bestehende `pickerFixture`, `candidate`, `snapshot`-Helfer in einen test-only Helper `tests/fixtures/route-picker-fixture.ts` extrahieren und dort exportieren; keine Produktionsautorität exportieren. Neue Tests: zwei ausgewählte Modelle/Konten, unbekannter Handle, stale revision/generation, widerrufene Tool-Fähigkeit, veränderte Billing-Metadaten. Öffnen/Resolve dürfen keinen Config-/Session-/ProviderState-Write auslösen. Kimi/Codex erscheinen ausdrücklich nicht runnable mit Grund; OpenRouter/Nano bleiben exakt gewählte Kandidaten.
- [ ] **2. Rot ausführen.** `env -u FORCE_COLOR node --import tsx --test tests/task-agent-routes.test.ts tests/task-agent-openrouter-runtime.test.ts tests/task-agent-factory.test.ts`.
- [ ] **3. Konfigurationsklon und authentische Task-Selektion implementieren.**

```ts
export function createTaskConfig(base: OrcodeConfigWithBudget, modelId: string) {
  const config = structuredClone(base);
  config.mainModel = modelId;
  config.fallbackModels = [];
  config.compressionMode = "off";
  config.provider = { ...config.provider, allowFallbacks: false };
  return config;
}
```

Kein heimlicher zweiter Compressor-Call in V1. `TaskRoutePort` nutzt die lesende Executor-Auswahl, versieht nur OpenRouter und Nano-GPT mit Task-runnable-Status und prüft zusätzlich die Provider-Task-Unterstützung beim Resolve. Jede Proof-Autorität wird in einer privaten WeakMap registriert; JSON-Kopien und selektierte Kandidaten eines anderen Ports bleiben ungültig. `assertCurrent` vergleicht aktuelle Eigentümerschaft, Revision, Generation, Billing und Credential-Pointer.
- [ ] **4. OpenRouter vor jeder tatsächlichen Anfrage autorisieren.** `createTaskOpenRouterRuntime(options)` im neuen Modul erzeugt einen eigenen SDK-Client mit injiziertem `HTTPClient`/Fetcher, nicht mit dem globalen `OpenRouterService.client()`. Der Fetcher erlaubt ausschließlich die vorhandenen OpenRouter-Inference-/Spend-/Catalog-Endpunkte und verweigert Redirects. Für jeden autorisierten Request `withCredential({backendId: "openrouter", connectionId: proof.connectionId, purpose: "runtime-bind", credentialKind: "inference", environmentEligibility: "forbidden", deadlineAt, signal}, callback)` aufrufen, aktuelle Bindung im Callback gegen Proof prüfen und erst dann Authorization setzen. SDK-Sentinel-Key nie über das Netzwerk schicken. Keine Management-Credentials, kein gecachter echter Key außerhalb des Callbacks, keine Ersatzverbindung. Auch SDK-Retries und Tool-Follow-up-POSTs gehen erneut durch diese Schranke. Exact-Modellpayload und `allowFallbacks: false` unveränderlich binden; `createClient({scope: "compressor"})` für V1 ablehnen. `safeMessage` liefert ausschließlich ausgegebene sichere Fehlercodes.

Der neue Adapter exportiert:

```ts
export interface TaskOpenRouterOptions {
  readonly route: RouteIdentityV1;
  readonly binding: ModelRuntimeBindingIdentityV1;
  readonly credentialAuthority: ProviderCredentialAuthorityLike;
  readonly config: OrcodeConfigWithBudget;
  readonly fetchImpl: typeof fetch;
  readonly now: () => number;
}
export function createTaskOpenRouterRuntime(options: TaskOpenRouterOptions): ModelRuntime;
```

Den Nano-GPT-Adapter mit seinem exakten Proof und getrenntem Subscription/PAYG-Realm verwenden; vor jedem POST die vorhandene Billing-/Credential-Schrankenkette erhalten. Tests verwenden injizierte SDK-Responses, niemals reale Keys.
- [ ] **5. Zweiter-Request-Widerruf negativ testen.** Erste Fixture-Anfrage gelingt; dann Credential-Pointer oder revision ändern. Zweite Anfrage muss scheitern, Netzwerk-POST-Zähler bleibt bei eins. Zwei gleichzeitige Accounts sehen je nur ihren Fixture-Key. Bei 401, exhausted quota und stale proof weder anderes Konto noch Modell noch Subscription→PAYG aufrufen. Öffentliche Views/Logs mit Canary-Key und privatem Fingerprint prüfen.
- [ ] **6. Factory über bestehende APIs implementieren.**

```ts
await routes.assertCurrent(proof);
const config = createTaskConfig(baseConfig, resolved.route.requestedModelId);
const { runtime, binding } = await routes.createRuntime(proof, config);
const session = SessionStore.create(workspace.canonicalPath, appHome, task);
session.setPreferences(config.mainModel, getReasoningSetting(config), resolved.route);
await session.save();
const agent = await OrcodeAgent.create({ runtime, runtimeBinding: binding,
  route: resolved.route, approvals, session, config, workspace: workspace.canonicalPath });
return { run: (observer: AgentRunObserver) => agent.run(task, observer) };
```

Hier sind `resolved` die intern aus dem authentischen Proof gelesenen Daten, `baseConfig` und `appHome` explizite Factory-Konstruktorabhängigkeiten, `routes: TaskRoutePort`. Keine globalen Defaults speichern. Das bestehende Coding-Tool-Factory-Testseam prüft unterschiedliche Guards/ReadRegistries/Journals je Instance und verweigert Pfade in Geschwisterkopien. Agent-interne Journal-/Run-ID bleibt an seine eigene Session gebunden.
- [ ] **7. Grün prüfen und committen.** Neue Tests plus `tests/route-picker.test.ts`, `tests/nanogpt-model-runtime.test.ts`, `tests/openrouter.test.ts`, `tests/agent.test.ts`; beide Core-`tsc`-Projekte. Commit: `feat(agents): bind manually selected task runtimes exactly`.

### Task 4: Drei echte unabhängige Läufe und eigene Freigaben verwalten

**Files:**

- Create: `src/task-agents/manager.ts`, `src/task-agents/approvals.ts`
- Test: `tests/task-agent-manager.test.ts`, `tests/task-agent-approvals.test.ts`

**Interfaces:**

- Consumes: `ProjectPort`, `ProjectOperationGate`, `TaskRoutePort`, `TaskAgentFactory`, `TaskResultStore`, Task-Workspace-Funktionen aus Task 2.
- Produces: `TaskAgentManager.start({projectId: string, expectedEpoch: number, requestId: string, name?: string, task: string, selection: RoutePickerSelectionIntent}): Promise<TaskAgentView>`.
- Produces: `.list(projectId: string): readonly TaskAgentView[]`, `.snapshot(key: TaskRunKey, cursor?: string): Promise<TaskAgentSnapshot>`, `.stop(key: TaskRunKey): Promise<void>`, `.stopAll(projectId: string): Promise<void>`, `.message(key: TaskRunKey, text: string): Promise<void>`, `.shutdown(): Promise<{unsettled: readonly TaskRunKey[]}>`, `.subscribe(listener: (event: TaskAgentEvent) => void): () => void`, `.hasActive(): boolean`. Constructor receives `{projects: ProjectPort; gate: ProjectOperationGate; routes: TaskRoutePort; factory: TaskAgentFactory; results: TaskResultStore; asks: TaskAskRouter}`; Workspace-Aufnahmefunktionen werden direkt aus Task 2 importiert.
- Produces: `TaskAgentSlots.reserve(): () => void`; `TaskApprovalQueue.request(key: TaskRunKey, preview: ToolCallPreview, signal: AbortSignal): Promise<ApprovalDecision>`, `.answer({key: TaskRunKey, askId: string, accepted: boolean}): boolean`, `.close(key: TaskRunKey): void`, `.pending(key: TaskRunKey): readonly TaskAgentAsk[]`.
- Produces: `TaskAgentAsk extends TaskRunKey {askId: string; preview: ToolCallPreview}`. Private Queue keys use the entire Tuple, nicht einen Anzeigenamen.
- Produces: `TaskAskRouter.register(ask: TaskAgentAsk, answer: (accepted: boolean) => boolean): () => void`, `.answer({key: TaskRunKey, askId: string, accepted: boolean}): boolean`. Jede Queue bekommt den gemeinsamen Router als Konstruktorabhängigkeit; nur tests dürfen eine eigene unverbundene Queue erzeugen. Der Router weist jedem Ask-ID die tatsächliche private Queue zu, nicht die gerade gewählte GUI-Ansicht.

- [ ] **1. Review-Focus 1 und Freigabeisolation rot testen.**

```ts
test("four synchronous admissions reserve only three slots", () => {
  const slots = new TaskAgentSlots();
  const release = [slots.reserve(), slots.reserve(), slots.reserve()];
  assert.throws(() => slots.reserve(), /agent-limit/);
  release[0]!(); release[0]!(); // idempotent release
  const fourth = slots.reserve();
  assert.throws(() => slots.reserve(), /agent-limit/);
  fourth(); release[1]!(); release[2]!();
});

test("foreign approval and retired approval cannot authorize a task", async () => {
  const queue = new TaskApprovalQueue();
  const a = { projectId: "p", agentId: "a", runId: "r-a" };
  const b = { projectId: "p", agentId: "b", runId: "r-b" };
  const answer = queue.request(a, { name: "shell", risk: "shell", summary: "Run check" },
    new AbortController().signal);
  const ask = queue.pending(a)[0]!;
  assert.equal(queue.answer({ key: b, askId: ask.askId, accepted: true }), false);
  queue.close(a);
  assert.equal((await answer).accepted, false);
  assert.equal(queue.answer({ key: a, askId: ask.askId, accepted: true }), false);
});
```

Managerintegration: drei Factory-Runs über getrennte `Promise.withResolvers<AgentRunResult>()` kontrollieren. Vierter Start verweigert vor Factory und Provider. Gleiche `requestId` im selben Projekt/Epoch wird idempotent beantwortet; gleicher Idempotency-Key mit anderem Task/Modell verweigert. Abbruch während Aufnahme/Factory, Start-Fehler, fehlende Aufgabe, stale Project-ID und verspäteter Event nach Stop jeweils testen.
- [ ] **2. Rot ausführen.** `env -u FORCE_COLOR node --import tsx --test tests/task-agent-manager.test.ts tests/task-agent-approvals.test.ts`.
- [ ] **3. Plätze atomar und Freigaben separat implementieren.**

```ts
export class TaskAgentSlots {
  #active = 0;
  reserve(): () => void {
    if (this.#active >= 3) throw new Error("agent-limit");
    this.#active++;
    let released = false;
    return () => { if (!released) { released = true; this.#active--; } };
  }
}
```

Jeder Managerlauf erzeugt **einen neuen** `ApprovalManager` mit Task-Kopien-Workspace und eigenem PromptHandler. Queue beantwortet nur das vollständige Tuple plus aktuelle Ask-ID; ein Ask kann einmal konsumiert werden. Stop/Abort löst ausschließlich die Asks dieses Laufs ablehnend auf. Status `waiting-approval` wird aus seiner eigenen Queue abgeleitet, niemals aus dem Hauptchat-AskQueue.
- [ ] **4. Startreihenfolge und Statuspersistenz implementieren.** Synchronously Slot und Project-Gate reservieren → typisierten Startdatensatz dauerhaft speichern → Proof prüfen → Snapshot aufnehmen → Proof erneut prüfen → Factory erzeugen → `.run({signal, interjections, onEvent, onText, onStatus})` starten. `start()` wartet nicht auf den kompletten Lauf. Jede Instance besitzt Controller, `InterjectionQueue`, Settlement-Promise und Listener. `onText`/`onStatus` in vorhandene AgentRunEvent-Formen projizieren; doppelte Textevents vermeiden. `run-start` erfasst die interne Run-ID. Fehler-/Abbruchpfad sichert zulässige Teilergebnisse vor Freigabe der Reservierungen. Ein fehlgeschlagener Store-Commit bleibt sichtbarer Fehler, kein angeblich fertiges Ergebnis.

```ts
// After synchronous reservation and durable starting view:
const workspace = await createTaskWorkspace({ project, key, signal: controller.signal });
await routes.assertCurrent(proof);
const instance = await factory.create({ key, workspace, task, proof, approvals });
const settled = instance.run({ signal: controller.signal, interjections, onEvent });
// Store settled with this key immediately, before returning the starting view.
```

`project: ProjectBinding`, `key: TaskRunKey`, `controller: AbortController`, `interjections: InterjectionQueue` und `approvals: ApprovalManager` werden neu im Start erzeugt. `onEvent` ist der tuplegebundene Callback des Managers. Abbruch während Factory-Erzeugung wird direkt vor `instance.run` nochmals geprüft; dann darf kein Providerrequest beginnen.
- [ ] **5. Stop- und Shutdown-Verhalten implementieren.**

```ts
// owned is one private manager run, not the currently selected GUI card.
owned.controller.abort(new Error("Task stopped by owner."));
approvalQueue.close(owned.key);
await owned.settled;
```

Der vorhandene Coding-Tool-Signalpfad beendet detached Prozessgruppen mit TERM/KILL; kein zweites PID-kill-System bauen. Für `shutdown` alle Controller zuerst abbrechen, dann Asks schließen, danach alle Settlement-Promises mit insgesamt 5.000 ms Drain-Budget beobachten. Nicht erledigte Identitäten melden; Projektwechsel bleibt solange gesperrt. `AgentRunError.result` auch beim Abbruch sichern, Kostenkenntnis erhalten und unbekannte Teilkosten nicht als null ausgeben. Bei Recovery nichtterminal gespeicherte Läufe zu `interrupted` ändern, niemals Factory/Provider aufrufen. `.message()` nutzt ausschließlich die InterjectionQueue eines laufenden exakten Tuples; ein terminaler Lauf erfordert einen ausdrücklich neuen Start.
- [ ] **6. Grün und Prozessverhalten prüfen.** Obige Tests plus `tests/workspace.test.ts`. Ein Fixture-Shellprozess je Agent; Stop A beendet A, B und C bleiben lebend. Listenerzahl nach drei Abschlüssen ist wieder Ausgangswert. Fortgesetzte Nachricht an B landet nicht in A. Commit: `feat(agents): manage three isolated task lifecycles`.

### Task 5: Ergebnisse gesondert freigeben und sicher übernehmen

**Files:**

- Create: `src/task-agents/apply.ts`
- Modify: `src/workspace.ts:501,616` eigene Task-Autorität konsumieren, bestehenden Publisher privat behalten
- Test: `tests/task-agent-apply.test.ts`, bestehende Journal-/Codex-Publisher-Tests

**Interfaces:**

- Consumes: `TaskResultStore`, `ProjectBinding`, `ProjectOperationGate.withApply`, `authorizeOneShotApproval`, `ChangeJournal`, den bisherigen privaten `publishGuardedWorkspaceFiles`.
- Produces: `TaskApplyService` constructor dependencies `{projects: ProjectPort; gate: ProjectOperationGate; results: TaskResultStore; asks: TaskAskRouter; journalFor: (key: TaskRunKey) => ChangeJournal}`, `.preview(key: TaskRunKey): Promise<TaskResultView>`, `.apply({key: TaskRunKey, resultHandle: string, digest: string, signal: AbortSignal}): Promise<TaskResultView>`, `.undo(key: TaskRunKey): Promise<{skippedPaths: readonly string[]}>`, `.isApplying(): boolean`.
- Produces: `consumeTaskAgentPublicationAuthority(authority: object, workspace: WorkspaceGuard): readonly GuardedWorkspaceFileEffect[]`; `WorkspaceGuard.publishTaskAgentApprovedEffects(authority: object, journal: ChangeJournal, runId: string): Promise<{publishedPaths: readonly string[]}>`.
- Task-Publication-Autorität und Result-Handle sind unterschiedliche Objekte; nur ein echtes OneShot-Receipt kann die erste ausgeben.

- [ ] **1. Konflikt und Wiederstart rot testen.** Fixture erstellt ein gespeichertes Update `old→agent`, verändert Original zu `external`, akzeptiert die Apply-Freigabe. Erwartung:

```ts
assert.equal((await apply.apply({ key, resultHandle: view.resultHandle,
  digest: view.digest, signal })).state, "conflict");
assert.equal(await readFile(original, "utf8"), "external");
assert.equal((await (await TaskResultStore.open(appHome)).read(key)).digest, view.digest);
assert.equal(await readFile(copyPath, "utf8"), "agent");
```

Diese Variablen stammen aus demselben Temp-Workspace-/Result-Store-Aufbau wie Task 2; `apply` ist die mit Project-Gate, Quelle und neuer Apply-`ApprovalManager("ask")` erzeugte Service-Instanz. Test muss Service und Store neu öffnen und denselben aktuellen Konflikt erneut feststellen, ohne einen Provider zu starten. Zusätzlich zwei widersprüchliche Agentenergebnisse, unveränderter erfolgreicher Apply und wiederholter Apply testen.
- [ ] **2. Fälschung und Rollback negativ testen.** Ein plain `{accepted:true}` oder ein kopiertes Receipt reicht nicht. Foreign key, anderes Result-Digest, stale Preview, anderes Projekt, vorherige Freigabe und Codex-Receipt `codex_file_change` jeweils verweigern. Eine All-or-nothing-Mehrdateiübernahme erhält injizierten Fehler nach dem ersten Write: alle Ausgangsbytes wiederherstellen; bei fremder Änderung während Rollback diese nicht überschreiben und sichtbaren Rollbackfehler liefern. Binärdatei, ungültiges UTF-8, unsichtbarer zusätzlicher Effekt und Path-/Parent-Swap verhindern alle Writes.
- [ ] **3. Rot ausführen.** `env -u FORCE_COLOR node --import tsx --test tests/task-agent-apply.test.ts`.
- [ ] **4. Eigenständige ausdrückliche Apply-Freigabe ausgeben.**

```ts
const authorityBinding = Object.freeze({}); // registered privately with key + digest
const receipt = await authorizeOneShotApproval(applyApprovals, {
  name: "task_agent_apply", risk: "edit", alwaysAsk: true,
  rememberable: false, summary: "Diesen vollständigen Agenten-Diff übernehmen?",
  details: exactDiff,
}, { signal, authorityBinding });
```

`key`, `digest`, `resultHandle` und vollständige Effekte werden vor dem Ask in einer privaten WeakMap an `authorityBinding` gebunden. Bei Receipt-Verbrauch `isOneShotApprovalReceipt`, exaktes Request-Name, `decision === "accept"`, identische Binding-Objektidentität und OneShot-Verbrauch verlangen. `applyApprovals` ist eine neue explizite Ask-Instanz mit eigener Queue, nicht die allow-all-Instanz innerhalb der Kopie. Ihre Asks werden im gemeinsamen `TaskAskRouter` registriert; so kann ein beendeter Lauf einen neuen Apply-Ask erhalten, ohne alte Ausführungs-Asks zu reaktivieren. Eine laufende Apply-Operation besitzt einen eigenen Abort-/Gültigkeitsscope und blockiert das Projekt-Gate bereits vor ihrem Ask. Nach Engine-Neustart aus verified StoredResult eine neue Vorschau/einen neuen Ask erzeugen; keine gespeicherte Zustimmung reaktivieren.
- [ ] **5. Veröffentlichung unter dem Projekt-Gate implementieren.** Vollständige aktuelle StoredResult-Effekte mit genau genehmigtem Digest vergleichen, Source-Guard-Identität erneut prüfen; dann neue nicht fälschbare Task-Publication-Autorität ausgeben. `publishTaskAgentApprovedEffects` konsumiert nur diese neue Autorität und ruft denselben privaten Publisher auf. Der Publisher prüft **alle** Preimages und Metadaten vor dem ersten Write, nutzt echtes ChangeJournal und die bestehende Rollback-Logik. Keine öffentliche beliebige Effects-API einführen. `setState("applying")` vor Veröffentlichung, danach `applied` oder `conflict`; Fehlerhinweise redigieren und persistieren. Kein `finally { discard() }` für Konflikt/Fehler. Nach erfolgreichem Apply darf die wegwerfbare Kopie erst nach dauerhaftem Ergebnis-/Statuscommit entfernt werden.
- [ ] **6. Serialisierung und Undo prüfen.** Zwei gleichzeitig ausdrücklich bestätigte Applies werden pro Projekt serialisiert; zweiter prüft nach erstem Commit neu und wird bei überlappender Vorbedingung Konflikt. Undo nutzt den echten projektgebundenen ChangeJournal-Run, überspringt fremd geänderte Dateien und zeigt `skippedPaths`; Hauptchat- oder fremdes Agentenjournal nicht auswählen. Obige Tests plus `tests/codex-staging-workspace.test.ts`, `tests/workspace.test.ts`. Commit: `feat(agents): approve and publish exact task results safely`.

### Task 6: Strukturierte Projekt- und Agentenoperationen mit Fähigkeitshandshake

**Files:**

- Create: `src/task-agents/gui-port.ts`
- Modify: `src/gui-protocol.ts:72,80,182,623,1013`, `src/gui-server.ts:546,803,3660`, `gui/src/protocol.ts:21,23,51`, `gui/src/bridge.ts:126`
- Test: `tests/task-agent-gui-port.test.ts`, `tests/gui-server-protocol.test.ts`, `tests/gui-protocol.test.ts`, `gui/tests/protocol-inventory.test.ts`

**Interfaces:**

- Consumes: `ProjectPort`, `TaskAgentManager`, `TaskApplyService`, `TaskRoutePort`, `TaskAskRouter`; public types from Task 2. `agents.answer` delegiert ausschließlich an den Router des tatsächlich registrierten Ask, nie an die Mainchat-Queue.
- Produces requests: `project.open`, `project.recent`, `project.open-recent`, `project.switch`, `agents.routes`, `agents.list`, `agents.start`, `agents.snapshot`, `agents.stop`, `agents.stop-all`, `agents.message`, `agents.answer`, `agents.result`, `agents.apply`, `agents.undo`.
- Produces events: `agents.changed` (safe inventory), `agent.event` (TaskAgentEvent), `agent.ask` (TaskAgentAsk), `agent.ask-closed` (exact key+askId), `agent.result` (TaskResultView), `project.changed` (ProjectView).
- All agent-mutating payloads carry the exact `TaskRunKey`; starts carry projectId/expectedEpoch/requestId/task/name/selection. Apply carries resultHandle/digest; ask answers carry askId and boolean, no arbitrary tool parameters. `project.switch` carries `ProjectOpenIntent` and explicitly confirmed `stopAll: true`; ordinary `project.open` never implicitly stops.

- [ ] **1. Handshake- und Boundarytests zuerst schreiben.**

```ts
test("agent feature negotiation is explicit", () => {
  assert.equal(negotiateTaskAgents([]), false);
  assert.equal(negotiateTaskAgents(["task-agents-v1"]), true);
});
```

`negotiateTaskAgents(features: readonly string[]): boolean` in `gui-port.ts` exportieren. Ein alter v2-Client ohne Fähigkeit darf weder Agenten starten noch Asks beantworten und erhält keine Agentenframes. Ungültige/neue Version zeigt `update-required`. Ein korrekter Client erhält beide Main-/Agentenereignisse nur auf ihren getrennten Namen. Fremde IDs, zusätzliche verbotene Routingfelder und übergroße Inputs scheitern vor Manageraufruf.
- [ ] **2. Review-Focus 5 mit echter Transportprüfung ergänzen.** A und B senden je Sequenz 1/2; ausgewählte Ansicht B ändert nicht das Ausgangsframe-Tuple. Duplikat A/2 und verspätetes A/1 dürfen nicht B erreichen. Canary-API-Key, accountFingerprint, credentialPointer, private proof, kanonischer Kopienpfad in verschachtelten Payloads prüfen: outbound Guard verweigert oder entfernt die privaten Werte. Eigene `ProcessEventRedactor`-Instanz je Lauf, damit ein geteilter Chunk-Filter keine Texte zweier Agenten zusammensetzt.
- [ ] **3. Rot ausführen.** `env -u FORCE_COLOR node --import tsx --test tests/task-agent-gui-port.test.ts tests/gui-protocol.test.ts tests/gui-server-protocol.test.ts`; `npm --prefix gui test -- protocol-inventory.test.ts`.
- [ ] **4. Fähigkeiten aushandeln, Version 2 beibehalten.** Keine bisherige v2-Frameform brechen. Server bietet `task-agents-v1` an; neues optionales `features` im `hello-ack` hält die ausgehandelte Schnittmenge pro Transport. `negotiateTaskAgents` ist Mitgliedschaftsprüfung, keine implizite Freigabe durch bekannte Engineversion. Router verweigert die neuen Anforderungen ohne Aushandlung und filtert die neuen Events aus. Beide Inventare und Schema-/Boundaryguards zusammen ändern; Terminal-/alter Hauptchatbetrieb bleibt unverändert.
- [ ] **5. Dünne Requestdelegation und Snapshot-Replay implementieren.**

```ts
export function negotiateTaskAgents(features: readonly string[]): boolean {
  return features.includes("task-agents-v1");
}
// Each accepted agents.stop request delegates exactly once:
await manager.stop({ projectId: payload.projectId,
  agentId: payload.agentId, runId: payload.runId });
```

Payload ist erst nach dem neuen exakten Schema typisiert. Runtimeautoritäten nie aus Payload konstruieren. Sequenz steigt monoton je Tuple, vollständige redigierte Ausgabe wird privat gespeichert. In-memory Replay begrenzen auf 256 Ereignisse und 1 MiB; Snapshot-Seiten auf 64 KiB inklusive Envelope begrenzen. Zu große Einzelinhalte auf mehrere redigierte Frames verteilen, ohne Tools-/Ask-Identität zu verlieren. `nextCursor` ist privater opaque Paging-Handle, an Lauf und Snapshot-High-Water gebunden. Bei älterem Cursor aus durable Log paginieren; bei ungültigem Cursor neuen Snapshot verlangen, nie stillschweigend in den Hauptchat fallen.
- [ ] **6. Grün, Inventare und Datenschutz prüfen.** Obige Tests plus vorhandene GUI-Onboarding-/Settings-Protokolltests. Beide Core-`tsc`-Projekte und GUI-`tsc` grün. Commit: `feat(gui): negotiate structured project and task-agent operations`.

### Task 7: Übersichtlicher Agentenbereich mit drei eigenen Ansichten

**Files:**

- Create: `gui/src/agent-state.ts`, `gui/src/agent-overview.ts`, `gui/src/agent-start.ts`, `gui/src/agent-view.ts`
- Modify: `gui/src/main.ts:165,301,1290`, `gui/src/sidebar.ts`, `gui/src/route-picker.ts:18,67`, `gui/src/styles.css`
- Test: `gui/tests/agent-state.test.ts`, `gui/tests/agent-start.test.ts`, `gui/tests/agent-view.test.ts`, `gui/tests/sidebar.test.ts`, `gui/browser-tests/task-agents.browser.test.ts`

**Interfaces:**

- Consumes: negotiated bridge requests/events and TaskAgentView/TaskAgentSnapshot/TaskResultView; existing `ChatModel`, `routePicker` and Run-/Markdown components.
- Produces: `AgentViewStore.select(key: TaskRunKey | null): void`, `.accept(event: TaskAgentEvent): "accepted" | "duplicate" | "resync" | "foreign"`, `.restore(snapshot: TaskAgentSnapshot): void`, `.model(key: TaskRunKey): ChatModel`; no runtime effects in `.select`.
- Produces: `canStartTask(task: string, selection: RoutePickerSelectionIntent | null, candidate: DesktopRoutePickerCandidate | null): boolean`.
- Produces: `agentOverview(views, handlers): HTMLElement`, `agentStart(view: RoutePickerView, handlers): HTMLElement`, `agentView(snapshot: TaskAgentSnapshot, result: TaskResultView | null, handlers): HTMLElement`; handlers are typed callbacks onto the structured bridge, not command-string dispatchers.

- [ ] **1. Manuelle Auswahl und Ansichtsisolation rot testen.**

```ts
test("no model is selected automatically", () => {
  assert.equal(canStartTask("Repair tests", null, null), false);
  assert.equal(canStartTask("   ", null, null), false);
});
```

Ein Runnable-Route-Fixture aus dem vorhandenen Route-Picker-Testhelper hinzufügen: Aufgabe plus **ausdrücklich gewählte** gültige Selection ergibt true; disabled/stale/foreign candidate ergibt false. Dialogöffnung und Overview-Klick rufen weder `onboarding.dispatch` noch `agents.start` noch `/cross` auf. No-tools/Kimi/Codex-Gründe erscheinen als verständliche Zeile, ohne Ersatzmodell vorzuzeigen.
- [ ] **2. Sequenz- und View-Test schreiben.** Store mit Snapshots A und B öffnen; A/2 empfangen während B sichtbar ist. Nur `store.model(a)` ändert sich; B bleibt bytegleich. A/2 erneut ergibt duplicate; fehlende A/3 vor A/4 ergibt resync und **kein** partiell gerenderter A/4-Text. Neuer Lauf mit gleichem Anzeigenamen kann keine alten Tuple-Frames konsumieren. Ein voll abgeschlossener Snapshot wird atomar eingesetzt, anschließend gepufferte Events oberhalb High-Water anwenden.
- [ ] **3. Rot ausführen.** `npm --prefix gui test -- agent-state.test.ts agent-start.test.ts agent-view.test.ts sidebar.test.ts`.
- [ ] **4. Getrennten reinen Ansichtsspeicher implementieren.** Die bestehende globale Hauptchat-Instanz behalten; Agenten erhalten eine Map von `JSON.stringify([projectId, agentId, runId])` zu eigenem `ChatModel`, eigenem lastSequence und Ask-Liste. Kein Hauptchat-Sessionwechsel beim Agentenwechsel. Nicht registrierte Tuples verweigern. Der Store projiziert Task-AgentRunEvents auf die vorhandenen ChatModel-Run-Komponenten über einen kleinen Adapter; Core-Instanzen/Proofs bleiben außerhalb der GUI.

```ts
// The only view-selection effect; bridge is deliberately absent here.
select(key: TaskRunKey | null): void {
  this.#selected = key === null ? null
    : JSON.stringify([key.projectId, key.agentId, key.runId]);
}
```

`#selected: string | null = null` gehört nur dem GUI-Store. `accept` findet seine eigene Modellinstanz per vollständigem Tuple und Sequenz, nie über `#selected`.
- [ ] **5. Startdialog und ruhige Übersicht bauen.**

```ts
export function canStartTask(task: string,
  selection: RoutePickerSelectionIntent | null,
  candidate: DesktopRoutePickerCandidate | null): boolean {
  return task.trim().length > 0 && selection !== null && candidate !== null
    && selection.handle === candidate.handle && candidate.runnable
    && candidate.disabled === undefined;
}
```

Candidate- und Selection-Epoch werden vom aktuellen RoutePickerView gehalten; neues View invalidiert die Auswahl. `routePicker` um Zweck `task-agent` mit Titel „Modell für diesen Agenten wählen“ erweitern. Aufgabe, optionaler Name, sichtbares Provider/Konto/Modell und Billing-/Kosteninformation; keine Vorauswahl. Einschränkung sichtbar: „Eigene Arbeitskopie · Änderungen erst nach Freigabe · keine Git-Historie in der Kopie“. Sidebar: Projektname, Projekt öffnen, jüngste Projekte, Chats, Agenten. Overview zeigt maximal drei aktive Agentenkarten und abgeschlossene Ergebnisse separat; Start bleibt bei drei aktiven Karten disabled, Enginegate bleibt trotzdem autoritativ.
- [ ] **6. Eigene Run-/Ergebnisansicht implementieren.** Pro Agent Live-Chat, Toolausgaben, Status, offene Freigaben und eingeklappte Änderungen; sichtbare Buttons Nachricht senden, Stoppen, Änderungen prüfen, Übernehmen. Ask-Antworten enthalten immer gespeichertes exact Tuple. Übernehmen zeigt vollständigen Diff und verified/unverified-Status und öffnet den separaten Engine-Ask. Kosten `unknown` als „Kosten noch unbekannt“, nicht „0 €“. Stop-all als eigenständige Gefahrenbestätigung. Fokus zurück in das aktive Eingabefeld; Tab/Escape/Enter testen, bei Escape kein unbeabsichtigter Start/Apply. Graphit/Amber-Stil und bestehendes Route-Core-Logo erhalten; keine zweite Terminaloberfläche.
- [ ] **7. Grün und Browser-DOM prüfen.** Obige Tests, gesamte GUI-Vitest-Suite und `npm --prefix gui run test:browser -- task-agents.browser.test.ts`. Browsertest deckt 1.024-px- und schmale 720-px-Ansicht, lange deutsche Aufgaben/Modellnamen, keyboard-only Auswahl, drei Karten, zwei gleichzeitige Asks und lesbare Konfliktanzeige ab. Screenshot visuell prüfen; eine reine Browserdemo ersetzt Task 9 nicht. Commit: `feat(gui): add separate manually configured agent views`.

### Task 8: Projektwechsel, Provider-Sperren und produktiver Engine-Pfad

**Files:**

- Modify: `src/cli.ts:8716` Zusammensetzung, `src/gui-server.ts:803,2227,3546`, `src/settings-controller.ts`, `src/commands.ts` mutation/reRoot gates, `gui/src/main.ts`, `gui/src/bridge.ts`, `gui/src/project-open.ts`
- Test: `tests/task-agent-composition.test.ts`, `tests/gui-server-protocol.test.ts`, `tests/settings-controller.test.ts`, `gui/tests/project-open.test.ts`

**Interfaces:**

- Consumes: vorherige ProjectPort/Manager/Apply/Routes und alle Protokollhandler.
- Produces: `TaskAgentServices {projects: ProjectPort; routes: TaskRoutePort; manager: TaskAgentManager; apply: TaskApplyService; asks: TaskAskRouter}` als optionaler expliziter GUI-Session-Composition-Port.
- Produces: `switchProjectAfterStop({intent: ProjectOpenIntent, confirmedStopAll: boolean}, services: TaskAgentServices): Promise<ProjectView>`; `assertProviderMutationAllowed(manager: TaskAgentManager): void`.

- [ ] **1. Review-Focus 2 und sichere Interlocks rot testen.** Projektpicker geöffnet → Agent beginnt → Picker antwortet: `project.open` liefert busy, kein ReRoot. Picker geöffnet → Engine ersetzt: native Callback liefert `engine-restarted`, kein GUI-Request an Ersatzengine. Projektwechsel mit Stop-all-Abbruch lässt alles unverändert. Bestätigter Wechsel wartet auf Prozess- und Ask-Settlement; ein drain timeout lässt ursprüngliches Projekt aktiv. Ein in Apply wartender zweiter Job blockiert Wechsel ebenfalls.
- [ ] **2. Provider-/Command-Schlupflöcher testen.** Während starting/running/waiting-approval/stopping sind connect, logout, account/billing switch und Credentials-Löschung gesperrt; reine Settings-/Catalog-Lektüre funktioniert. Auch Hauptchat-Slash/Onboarding-Pfade dürfen diese Sperre nicht umgehen. Normale Hauptchat-Modellwahl und Cross ändern keine Task-Modelle; konflikthafte globale Provider-State-Mutation bleibt gesperrt. Auch `/folder` und Fremdchat-Öffnung können das Project-Gate nicht umgehen. Aktiver Main-/Cross-/Architect-Lauf blockiert ReRoot zusätzlich zu Task-Agenten.
- [ ] **3. Rot ausführen.** `env -u FORCE_COLOR node --import tsx --test tests/task-agent-composition.test.ts tests/gui-server-protocol.test.ts tests/settings-controller.test.ts`; GUI-Project-open-Test.
- [ ] **4. Ports einmal in CLI zusammensetzen.** Die bestehenden Providerinstanzen/Authority und das explizite App-Home als Abhängigkeiten einspeisen. `runGuiSession` erhält den optionalen `TaskAgentServices`-Port und delegiert an `gui-port.ts`; kein zweiter Manager in `gui-server.ts`. `context.reRootWorkspace` mit Project-Gate verbinden, der weiterhin den bisherigen runtime-cache-reset und Session-Handoff verwendet. Kein `providerRuntime.selectSessionRoute`, keine Default-/Config-Aktivierung im Task-Picker.
- [ ] **5. Stop-all-and-switch implementieren.**

```ts
if (!confirmedStopAll) throw new Error("project-switch-cancelled");
await services.manager.stopAll(intent.expectedProjectId);
if (services.manager.hasActive() || services.apply.isApplying()) {
  throw new Error("project-busy");
}
return services.projects.open(intent);
```

Der letzte Schritt bleibt atomar über `ProjectOperationGate.withSwitch`; neue Starts zwischen Stop-all und ReRoot werden entweder davor zugelassen und blockieren den Switch oder nach aktiver Wechselmarkierung abgelehnt. Bestätigung gehört exakt zum alten Project-Epoch und gewählten Ziel. Native Bridge hält ihre Enginegeneration privat und sendet nach `chooseProject` die strukturierte `project.open`-Anforderung. Frische Projektliste/Chats laden erst nach `project.changed`; Ergebnisse des alten Projekts bleiben im ResultStore.
- [ ] **6. Shutdown gemeinsam verdrahten.** EOF, Fenster schließen, engine_stop und Bootstrapfehler rufen Manager-shutdown zusätzlich zum bestehenden Main-Run-Abbruch auf, schließen owned Asks und drainen Settlement. Keine persistenten Requests bei Restart. Nach erfolgreichem Lauf Recoverydaten lesend verfügbar machen; explizites „Als neue Aufgabe fortsetzen“ füllt nur den Startdialog, fordert Modellbestätigung und startet erst nach Klick.
- [ ] **7. Grün und kleiner Integration-Smoke prüfen.** Obige Tests plus vorhandene Project-/Cross-/Architect-ReRoot-Tests. GUI mit kontrollierter Temp-Engine öffnen und Projektbutton, Recent, Startdialog und eigene Agentenansicht tatsächlich erreichen. Commit: `feat(agents): wire guarded task workspaces into desktop runtime`.

### Task 9: Drei Engine-Agenten, echte App und Datenverlustfälle abnehmen

**Files:**

- Create: `tests/fixtures/task-agent-engine.ts`, `tests/task-agent-journey.test.ts`, `scripts/check-task-agent-journey.mjs`, `docs/task-agents.md`
- Verify: `tests/fixtures/isolated-app-home.mjs` aus Task 1
- Modify: `package.json` additive `test:task-agents`-Verifikation, `README.md` nur dieser Featureabschnitt
- Evidence: `docs/qa/2026-10-14-task-agents.md` mit exakt getesteter Revision und Working-Diff-Digest, nicht als ungetestete Erfolgsvorlage anlegen

**Interfaces:**

- Consumes: echte TaskAgentFactory/OrcodeAgent/Manager/GUI-Ports mit injiziertem SDK-Fetch und Credential-Doubles; keine Fake-Agentenkarten als Laufzeitbeweis.
- Produces: `test:task-agents` startet ausschließlich hermetische Tests; die Test-Engine ist nur ein expliziter Fixture-Einstieg unter `tests/fixtures`, nie eine Umgebungsvariable, die den ausgelieferten Providerpfad umschaltet.
- Fixture-Typ: `FixtureProviderBarrier {entered: Set<string>; release(modelId: string): void; waitForCount(count: number): Promise<void>}`; ankommende SDK-POSTs registrieren exact model und blockieren bis zum expliziten Release. Mock-Fetch lehnt jede nicht fixturedefinierte URL ab.

- [ ] **1. Isolierten Prozess-Home-Guard für Kindprozesse nachweisen.** Der bereits seit Task 1 verwendete Guard muss auch in einer separat gestarteten Fixture-Engine vor deren Config-Import laufen. Alle neuen Test-Factories weiterhin mit explizitem `appHome` bauen. Child-Engines erben den Guard über testprozesslokales `NODE_OPTIONS=--import=<absolute preload path>`, nicht durch Änderung der Shellprofile. Keine echten Keys, Keychains, Providerprofile, `.orcode`-Backups oder SSH-Konfigurationen kopieren. Der Fixture-Einstieg prüft Temp-Home und nimmt Produktions-Credential-Auflösung nicht in seine Abhängigkeiten auf. `check-task-agent-journey.mjs` erzeugt seinen eigenen `mkdtempSync`-Ordner und setzt `ORCODE_TEST_HOME`/`NODE_OPTIONS` nur im `spawnSync`-Env der Tests; er leitet bei fehlgeschlagenen Tests einen ungleichen Null-Exitcode weiter. Das Package-Script lautet `"test:task-agents": "node scripts/check-task-agent-journey.mjs"`.
- [ ] **2. Echte Parallelität rot testen.**

```ts
// In the journey: factory is real, fetch/credential authority are fixtures.
await Promise.all([startA, startB, startC]);
await barrier.waitForCount(3);
assert.deepEqual([...barrier.entered].sort(), ["fixture/a", "fixture/b", "fixture/c"]);
assert.equal(manager.list(project.id).filter(v => v.state === "running").length, 3);
await assert.rejects(startFourth(), /agent-limit/);
assert.equal(barrier.entered.size, 3);
```

`startA/B/C` sind zuvor mit `manager.start` erzeugte Promises für getrennte Aufgaben und manuell aus Fixture-RoutePickerView gewählte Modelle; `startFourth(): Promise<TaskAgentView>` ist dieselbe Startanforderung mit eigenem requestId. SDK-Antworten erst nach allen drei ankommenden POSTs freigeben. Tool-Follow-up erzeugt echte Textdateiänderung in A-Kopie und einen Ask in B, C streamt weiter. Source-Datei bleibt unverändert. So kann ein serieller Loop nicht fälschlich bestehen.
- [ ] **3. Gesamten Datenpfad und Negativfälle ausführen.** Open/cancel/bad path → zwei Starts → dritter Start → vierter refusal → B ansehen → A-Frame → B-Ask bestätigen → nur A stoppen → B/C abschließen → B-Diff prüfen → ausdrücklich Apply → source bytes prüfen. Danach widersprüchliches C-Result, externes File-Update, Crash, Restart, neuer Apply-Ask, Replay und Undo mit foreign edit. Result-Hashes, Provider-POST-Zähler, Process-PIDs und Log-/View-Canaries als Assertions ausgeben. Keine Testschleife darf ewig warten: Barrier und Drain jeweils Timeout mit Diagnose.
- [ ] **4. Rot/Grün-Kernlauf und Builds sequenziell prüfen.**

```bash
env -u FORCE_COLOR node --import tsx --test tests/task-agent-journey.test.ts
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.tests.json --noEmit
npm run build
npm --prefix gui test
npm --prefix gui run build
cargo test --manifest-path gui/src-tauri/Cargo.toml
```

Build nicht parallel mit Tests betreiben, die `dist` lesen: der vorhandene Build löscht `dist` zuerst. Gesamtsuite separat mit demselben isolierten Guard laufen lassen, Exitcode/Pass/Fail/Skip und konkrete Fehlertitel festhalten. Vorhandene Codex-Trust-/Version-Gates weder lockern noch als neue Agentenregression etikettieren; ein fehlgeschlagener Gate verhindert die Behauptung einer uneingeschränkten Releasefreigabe.
- [ ] **5. Tatsächliche native App mit Fixture-Engine bedienen.** Erst vorhandenen Desktop-/Engine-Teststartpfad auf seine zugelassenen Fixture-Overrides prüfen und für einen lokalen Debug-Build nutzen; keinen Debugbypass in Release hinzufügen. Native Ordnerauswahl wirklich öffnen, canceln und einen Temp-Projektordner wählen. Zwei Agenten über Buttons mit eigener Modellwahl starten, Ansichten wechseln, Tool-Ask beantworten, A stoppen, B-Ergebnis prüfen und übernehmen. Browser- oder Desktop-Control-Skill vor dem tatsächlichen UI-Test lesen. Native Fenster und Dateiendzustand prüfen; Screenshot allein beweist keinen funktionierenden Provider-/Apply-Pfad. Falls diese Umgebung keine echte native Fixture-App kontrollieren kann, diesen Gate ausdrücklich als ungeprüft ausweisen und nicht als fertig abhaken.
- [ ] **6. Dokumentation und Abnahme schreiben.** `docs/task-agents.md` erklärt Projektöffnung, drei Plätze, manuelle Auswahl, Original-vs-Kopie, unbekannte Kosten, Stop/Apply/Konflikt, keine Git-Historie in der Kopie und V1-Adaptergrenzen. QA-Datei enthält Version/Revision/Diff-Digest, exakt ausgeführte Befehle, Testzahlen, echte Native-Schritte, pass/fail/unverified und verbliebene Baseline-Gates. Keine Credentials oder private Pfade in Screenshots/Logs publizieren. Commit nur Feature-Dokumentation, Fixture und eigene Hunks: `test(agents): verify parallel desktop task journeys`.

## Planprüfung und Ausführungshandoff

Zuordnung des freigegebenen Designs: Bedienablauf/Projektöffnung → 1/7/8; Snapshot/Ausschlüsse → 2; private manuelle Providerbindung → 3; drei Läufe/Stop/Crash → 4/8; Ergebnisse/Approve/Apply/Rollback/Undo → 2/5; Protokoll/Privacy/Replay → 6; echte GUI- und Engine-Abnahme → 9. Alle fünf Review-Focus-Fälle besitzen oben einen benannten Test.

Ausführungsoptionen nach Planreview:

- **Native:** Ein Implementierer bearbeitet die abhängigen Pakete in dieser Sitzung; ein unabhängiger Abschlussreview prüft den gesamten Stand einschließlich Credential-/Apply-Grenzen. Weniger frische Kontexte, kein unabhängiger Zwischenreview.
- **Subagent-driven:** Je Paket ein frischer Implementierer und unabhängiger Reviewer, danach Gesamtbranch-Review. Strengere Zwischengates, höhere Kontextkosten.

Für diesen eng gekoppelten Plan und den ausdrücklichen Token-Sparwunsch ist **Native** die Empfehlung. Der abschließende unabhängige Review und die echten Task-9-Abnahmeschritte bleiben Pflicht. Nach Planfreigabe beziehungsweise Methodenwahl beginnt die Implementierung; dieser Plan selbst verändert noch keinen Produktcode.
