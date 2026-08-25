import assert from "node:assert/strict";
import test from "node:test";
import {
  handleSlashCommand,
  type CommandContext,
  type SettingsCommandPort,
} from "../src/commands.js";
import { createSettingsCommandPort } from "../src/cli.js";
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
