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
class DemoBridge {
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
      this.emit("desktop.snapshot", { snapshot: { schemaVersion: 1, revision: 7, generation: 3,
        routeRunnable: true, activeRoute: { routeHandle: "demo-route", providerLabel: "Demo",
          modelLabel: "Beispielmodell", accountLabel: "Demo · keine Verbindung" },
        providers: [], undoAvailable: true, appearance: { showLargeLogo: true, showHeaderMark: true } } });
      if (!this.shown) { this.shown = true; queueMicrotask(() => this.showExample()); }
      return {};
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
