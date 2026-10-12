// Isolated visual fixture. Never imported by the app's production entrypoint.
import { mountDesktopWindow } from "../src/main.ts";
import { RequestFailed } from "../src/bridge.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";

const workspace = "/demo/kaya-workspace";
const status = {
  model: "Beispielmodell", resolvedModel: "demo/model", workspace,
  chatId: "demo-session", chatTitle: "Login verständlicher gestalten", approval: "ask",
  routeConnected: true, providerManaged: false, balanceHedged: true,
  lowBalanceThresholdUsd: 1, sessionUsd: 0, sessionCostKnowledge: "unknown",
  balanceRemainingUsd: undefined, dayUsd: undefined,
  runActive: false, executionMode: "desktop", ownerPathsAllowed: false,
};
// These routes exist only in this browser fixture: no provider, account or
// credential is connected, and choosing one cannot execute a model call.
const demoRoutes = ["A", "B"].map((name) => ({
  handle: `demo-route-${name.toLowerCase()}`,
  providerId: "demo-provider",
  connectionId: `demo-account-${name.toLowerCase()}`,
  accountLabel: `Demo-Konto ${name}`,
  canonicalModelId: `demo/model-${name.toLowerCase()}`,
  displayName: `Demo Modell ${name}`,
  reasoning: "unknown",
  capabilities: ["text", "tools", "patch"],
  cost: { kind: "known", label: "Demo · keine Abrechnung", source: "provider" },
  dataPolicy: { kind: "known", label: "Demo · nur im Browser", source: "owner-config" },
  runnable: true,
}));
const demoProviders = demoRoutes.map((route) => ({
  providerId: route.providerId,
  providerLabel: "Demo-Provider · nur lokal",
  connectionId: route.connectionId,
  accountLabel: route.accountLabel,
  state: "ready",
  setupMethods: [],
  multiProfile: { enabled: false },
  routes: [route],
}));
class DemoBridge {
  // Preserve the existing sample header until an explicit picker confirmation.
  activeRoute = { routeHandle: "demo-route", providerLabel: "Demo",
    modelLabel: "Beispielmodell", accountLabel: "Demo · keine Verbindung" };
  picker = null;
  pickerGeneration = 0;
  async start(handlers) {
    this.handlers = handlers;
    queueMicrotask(() => this.handlers.onFrame({ t: "hello", v: PROTOCOL_VERSION,
      protocol: PROTOCOL_VERSION, orcode: "0.7.0 · Vorschau", node: "DEMO", pid: 0, capabilities: [] }));
    return { node: "DEMO", script: "DEMO", workspace, home: "/demo/home", realHome: false, pid: 0 };
  }
  emit(e, payload) { this.handlers.onFrame({ t: "event", v: PROTOCOL_VERSION, e, ...payload }); }
  async request(t, payload = {}) {
    if (t === "hello-ack") return {};
    if (t === "status.get") return status;
    if (t === "chats.list") return { chats: [
      { id: "demo-session", title: status.chatTitle, workspace, turnCount: 4,
        costUsd: 0, costKnowledge: "unknown", model: "Beispielmodell", updatedAt: new Date().toISOString() },
      { id: "demo-2", title: "Fehlerfall im Formular prüfen", workspace, turnCount: 2,
        costUsd: 0, costKnowledge: "unknown", updatedAt: new Date(Date.now() - 3600000).toISOString() },
    ] };
    if (t === "desktop.snapshot.get") {
      this.emitSnapshot();
      if (!this.shown) { this.shown = true; queueMicrotask(() => this.showExample()); }
      return {};
    }
    if (t === "onboarding.dispatch") {
      const intent = payload.intent;
      if (intent?.revision !== 7 || intent?.generation !== 3) {
        throw new RequestFailed({ code: "preview-only", message: "Die Demo-Auswahl ist nicht mehr aktuell. Bitte erneut öffnen." });
      }
      if (intent.kind === "open-model-picker") {
        this.picker = { revision: 7, generation: 3, step: "model", returnTo: intent.returnTo,
          operationHandle: `demo-picker-${++this.pickerGeneration}`,
          providers: demoProviders, candidates: demoRoutes };
        this.emit("onboarding.view", { view: this.picker });
        return { kind: "view", view: this.picker };
      }
      if (this.picker?.step === "model" && (intent.kind === "cancel" || intent.kind === "back")) {
        const view = this.picker;
        this.picker = null;
        return { kind: "cancelled", view };
      }
      if (this.picker?.step === "model" && intent.kind === "choose-model") {
        const route = demoRoutes.find((candidate) => candidate.handle === intent.routeHandle);
        if (route) {
          this.activeRoute = { routeHandle: route.handle, providerLabel: "Demo-Provider · nur lokal",
            modelLabel: route.displayName, accountLabel: route.accountLabel };
          this.emitSnapshot();
          this.picker = { ...this.picker, step: "ready" };
          this.emit("onboarding.view", { view: this.picker });
          return { kind: "ready", routeHandle: route.handle, routeRunnable: true };
        }
      }
      throw new RequestFailed({ code: "preview-only", message:
        "Die Demo zeigt nur eine lokale Modellauswahl; sie verbindet keine Provider oder Konten." });
    }
    if (t === "cost.forecast") return { kind: "none" };
    if (t === "command") {
      this.emit("transcript", { role: "system", content:
        `Vorschau: ${payload.raw} wäre ein echter Engine-Befehl. Hier wird nichts ausgeführt.` });
      if (payload.draft) this.emit("draft", { text: payload.draft, reason: "restore" });
      return {};
    }
    if (t === "submit") {
      this.emit("transcript", { role: "user", content: payload.text });
      this.emit("transcript", { role: "assistant", content: "Dies ist die Design-Vorschau. Dein Text wurde nur lokal angezeigt; kein Modell wurde aufgerufen." });
      return {};
    }
    if (t === "chat.new") {
      this.emit("chat.reset", { chatId: "demo-new", title: "Neuer Chat", workspace });
      return {};
    }
    if (t === "catalog.level" || t === "catalog.search") return { crumb: ["Vorschau"], rows: [], total: 0 };
    throw new RequestFailed({ code: "preview-only", message:
      "Diese Funktion braucht die echte orcode-Engine. Die Design-Vorschau verändert keine Konten oder Einstellungen." });
  }
  async write() {}
  emitSnapshot() {
    this.emit("desktop.snapshot", { snapshot: { schemaVersion: 1, revision: 7, generation: 3,
      routeRunnable: true, activeRoute: this.activeRoute,
      providers: demoProviders, undoAvailable: true, appearance: { showLargeLogo: true, showHeaderMark: true } } });
  }
  showExample() {
    this.emit("transcript", { role: "user", content: "Mach den Login einfacher: klare Fehlermeldungen und ein sichtbarer nächster Schritt." });
    this.emit("transcript", { role: "assistant", content: "## Ein klarer Einstieg\n\nIch fasse die Anmeldung in einem Formular zusammen. Der Fehlertext steht direkt am betroffenen Feld; die Eingaben bleiben erhalten.\n\nDie rechte Ansicht zeigt die gemeldete Dateiänderung und den ausgeführten Prüfbefehl. Alle Daten hier sind Beispiele." });
    this.emit("run", { event: { type: "file-change", path: "src/auth/login.ts", tool: "apply_patch", created: false,
      added: 3, removed: 1, truncated: false,
      diff: "@@ -12,2 +12,4 @@\n export function validate(email) {\n-  return false;\n+  if (!email.includes('@')) {\n+    return { field: 'email', message: 'Bitte prüfe deine E-Mail-Adresse.' };\n+  }" } });
    this.emit("run", { event: { type: "tool-start", id: "demo-check", name: "run_command", input: { command: "npm test -- login" } } });
    this.emit("run", { event: { type: "tool-output", id: "demo-check", text: "Vorschauausgabe – kein Test wurde tatsächlich ausgeführt.\n" } });
    this.emit("run", { event: { type: "tool-end", id: "demo-check", output: { exitCode: 0,
      stdout: "Vorschauausgabe – kein Test wurde tatsächlich ausgeführt." }, durationMs: 1040 } });
  }
}
const root = document.querySelector("#preview-app");
root.id = "app";
export const demoMount = mountDesktopWindow({ bridge: new DemoBridge(), root });
