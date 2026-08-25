import assert from "node:assert/strict";
import test from "node:test";
import {
  handleSlashCommand,
  type CommandContext,
  type SettingsCommandPort,
} from "../src/commands.js";
import {
  createSettingsCommandPort,
  runSettingsProviderAction,
  runSettingsVerifySuggestion,
  runSettingsTerminalOwner,
} from "../src/cli.js";
import { SessionProviderRuntimeGuard } from "../src/cli.js";
import type { ProviderExecutionMode } from "../src/setup.js";
import { describeOpenRouterFailure, formatFailure } from "../src/openrouter.js";
import { errorMessage } from "../src/utils.js";

const SETTINGS_INTERACTIVE_REQUIRED_CODE = "settings-interactive-required";
const SETTINGS_INTERACTIVE_REQUIRED_MESSAGE =
  "settings-interactive-required · /settings ist nur im lokalen interaktiven Eigentümer-Terminal verfügbar.";

test("Settings command factory fails closed before creating a session outside an owner TTY", async () => {
  const modes: readonly ProviderExecutionMode[] = [
    "local-interactive-owner",
    "json",
    "piped",
    "scheduled",
    "batch",
    "relay",
    "collaborator",
    "shared-service",
    "multi-user",
    "unenrolled-device",
  ];
  for (const executionMode of modes) {
    for (const [stdinIsTty, stdoutIsTty] of [[true, true], [true, false], [false, true], [false, false]] as const) {
      let created = 0;
      const port = createSettingsCommandPort({
        executionMode,
        stdinIsTty,
        stdoutIsTty,
        async createSession() {
          created += 1;
          return { async open() {} };
        },
      });
      const accepted = executionMode === "local-interactive-owner" && stdinIsTty && stdoutIsTty;
      assert.equal(port === undefined, !accepted, `${executionMode}/${stdinIsTty}/${stdoutIsTty}`);
      assert.equal(created, 0, `${executionMode}/${stdinIsTty}/${stdoutIsTty}`);
      if (port) await port.open();
      assert.equal(created, accepted ? 1 : 0, `${executionMode}/${stdinIsTty}/${stdoutIsTty}`);
    }
  }
});

test("cached runtime activity reflects a run without acquiring a lease", () => {
  const guard = new SessionProviderRuntimeGuard();
  assert.deepEqual(guard.activity(), { runActive: false, activationHeld: false });
  const release = guard.beginRun();
  assert.deepEqual(guard.activity(), { runActive: true, activationHeld: false });
  release();
  assert.deepEqual(guard.activity(), { runActive: false, activationHeld: false });
});

test("/settings opens the installed command port exactly once and stays in chat", async () => {
  const argumentCounts: number[] = [];
  const settings = {
    async open() {
      argumentCounts.push(arguments.length);
    },
  } satisfies SettingsCommandPort;
  const context = {
    settings,
    out: { text() {}, error() {} },
  } as unknown as CommandContext;

  assert.equal(await handleSlashCommand("/settings", context), "continue");
  assert.deepEqual(argumentCounts, [0]);
});

test("Plain besitzt temporär Raw/Alternate, Dashboard nutzt den aktiven Owner und beide bewahren den Chat-Draft", async () => {
  const calls: string[] = [];
  let raw = false;
  let alternate = false;
  let draft = "unveränderter chat-draft";
  const surface = {
    start() {
      calls.push("start");
      raw = true;
      alternate = true;
    },
    stop() {
      calls.push("stop");
      raw = false;
      alternate = false;
    },
  };

  await assert.rejects(
    runSettingsTerminalOwner(surface, true, async () => {
      calls.push("plain-settings");
      assert.equal(raw, true);
      assert.equal(alternate, true);
      assert.equal(draft, "unveränderter chat-draft");
      throw new Error("scripted-escape");
    }),
    /scripted-escape/,
  );
  assert.equal(raw, false);
  assert.equal(alternate, false);
  assert.equal(draft, "unveränderter chat-draft");

  await runSettingsTerminalOwner(surface, false, async () => {
    calls.push("dashboard-settings");
    draft = `${draft}`;
  });
  assert.deepEqual(calls, ["start", "plain-settings", "stop", "dashboard-settings"]);
  assert.equal(draft, "unveränderter chat-draft");
});

test("Verify-Suggest übernimmt echte Skripte typisiert und lässt bestehende Kommandos bei Cancel/Fehler unverändert", async () => {
  let commands = ["npm run existing"];
  let persists = 0;
  await assert.rejects(runSettingsVerifySuggestion({
    packageJson: { scripts: { check: "tsc", test: "node --test" } },
    confirm: async () => false,
    persist: async (next) => {
      persists += 1;
      commands = [...next];
    },
  }), (error: unknown) => error instanceof Error && error.name === "SettingsExternalActionCancelledError");
  assert.deepEqual(commands, ["npm run existing"]);
  assert.equal(persists, 0);

  await assert.rejects(runSettingsVerifySuggestion({
    packageJson: { scripts: { check: "tsc" } },
    confirm: async () => true,
    persist: async () => {
      persists += 1;
      throw new Error("durable-config-failure");
    },
  }), /durable-config-failure/);
  assert.deepEqual(commands, ["npm run existing"]);

  await runSettingsVerifySuggestion({
    packageJson: { scripts: { build: "vite build", test: "node --test", check: "tsc" } },
    confirm: async (next) => {
      assert.deepEqual(next, ["npm run check", "npm run test", "npm run build"]);
      return true;
    },
    persist: async (next) => {
      persists += 1;
      commands = [...next];
    },
  });
  assert.deepEqual(commands, ["npm run check", "npm run test", "npm run build"]);
  assert.equal(persists, 2);
});

test("Settings-Providerbestätigung bindet den echten Token an exakte Aktion und Backend", async () => {
  const seen: unknown[] = [];
  const surface = {} as never;
  await runSettingsProviderAction({
    intent: { kind: "logout", backendId: "kimi-code" },
    surface,
    execute: async (intent) => {
      seen.push(intent);
      if (!("confirmationToken" in intent)) {
        return {
          kind: "confirmation-required",
          operation: "logout",
          backendId: "kimi-code",
          message: "Kimi wirklich abmelden?",
          confirmationToken: "real-authority-token",
        };
      }
      return {
        kind: "changed",
        operation: "logout",
        backendId: "kimi-code",
        setupRequired: true,
        defaultCleared: true,
      };
    },
    confirm: async (message) => message === "Kimi wirklich abmelden?",
  });
  assert.deepEqual(seen, [
    { kind: "logout", backendId: "kimi-code" },
    { kind: "logout", backendId: "kimi-code", confirmationToken: "real-authority-token" },
  ]);

  let cancelledCalls = 0;
  await assert.rejects(runSettingsProviderAction({
    intent: { kind: "disable", backendId: "openrouter" },
    surface,
    execute: async () => {
      cancelledCalls += 1;
      return {
        kind: "confirmation-required",
        operation: "disable",
        backendId: "openrouter",
        message: "Deaktivieren?",
        confirmationToken: "must-not-be-used",
      };
    },
    confirm: async () => false,
  }), (error: unknown) => error instanceof Error && error.name === "SettingsExternalActionCancelledError");
  assert.equal(cancelledCalls, 1);
});

test("a missing /settings port rejects before config, credentials, providers, routes, sessions, or network", async () => {
  const forbiddenReads: PropertyKey[] = [];
  const context = new Proxy(
    Object.create(null) as Record<PropertyKey, unknown>,
    {
      get(_target, property) {
        if (property === "settings") return undefined;
        forbiddenReads.push(property);
        throw new Error(`forbidden pre-gate read: ${String(property)}`);
      },
    },
  ) as unknown as CommandContext;

  let caught: unknown;
  try {
    await handleSlashCommand("/settings", context);
  } catch (error) {
    caught = error;
  }

  const commands = await import("../src/commands.js") as unknown as Record<string, unknown>;
  const ErrorType = commands.SettingsInteractiveRequiredError as
    | (new () => Error & { readonly code: string })
    | undefined;
  assert.equal(typeof ErrorType, "function");
  assert.ok(caught instanceof ErrorType!);
  assert.equal(caught.name, "SettingsInteractiveRequiredError");
  assert.equal(caught.code, SETTINGS_INTERACTIVE_REQUIRED_CODE);
  assert.equal(caught.message, SETTINGS_INTERACTIVE_REQUIRED_MESSAGE);
  assert.equal(errorMessage(caught), SETTINGS_INTERACTIVE_REQUIRED_MESSAGE);
  assert.equal(
    formatFailure(describeOpenRouterFailure(caught)),
    SETTINGS_INTERACTIVE_REQUIRED_MESSAGE,
  );
  assert.deepEqual(forbiddenReads, []);

  const rendered = JSON.stringify({
    code: caught.code,
    message: errorMessage(caught),
  });
  assert.deepEqual(JSON.parse(rendered), {
    code: SETTINGS_INTERACTIVE_REQUIRED_CODE,
    message: SETTINGS_INTERACTIVE_REQUIRED_MESSAGE,
  });
  assert.doesNotMatch(
    rendered,
    /api[-_]?key|secret|credential|account(?:Fingerprint|Id)|requestId|cookie|authorization|\/Users\//i,
  );
});
