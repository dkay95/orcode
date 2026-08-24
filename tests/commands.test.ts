import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { SpendUnavailableError, assertSpendAvailable } from "../src/agent.js";
import {
  handleSlashCommand,
  promptForValidKey,
  shouldReplaceCredential,
  validateAndActivateInferenceKey,
  validateAndActivateManagementKey,
  type CommandContext,
} from "../src/commands.js";
import { OpenRouterHttpError, OpenRouterService } from "../src/openrouter.js";
import type { CredentialStoreLike } from "../src/credentials.js";
import { CredentialStoreError } from "../src/credentials.js";
import { SessionStore } from "../src/session.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { migrationManifestPath } from "../src/storage.js";
import type { AgentRunEvent, ModelInfo } from "../src/types.js";

const run = promisify(execFile);

test("only an observed active-scope rejection triggers replacement", () => {
  assert.equal(
    shouldReplaceCredential(new OpenRouterHttpError(401, "User not found")),
    false,
    "a context-free 401 may belong to a replacement candidate",
  );
  assert.equal(
    shouldReplaceCredential(new OpenRouterHttpError(403, "Forbidden")),
    false,
  );
  assert.equal(
    shouldReplaceCredential(
      new SpendUnavailableError("key-expired", "Der OpenRouter-Key ist abgelaufen."),
    ),
    false,
  );
  assert.equal(
    shouldReplaceCredential(new Error("OpenRouter ist nicht erreichbar")),
    false,
  );
  assert.equal(
    shouldReplaceCredential(new OpenRouterHttpError(500, "Provider down")),
    false,
  );
});

test("an SDK-shaped error replaces only after the active runtime observed a real 401", async () => {
  const key = `${KEY_PREFIX}sdk-active-auth-key-12345`;
  const service = new OpenRouterService(key, undefined, {}, {
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: "rejected" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
  });
  await assert.rejects(service.getCurrentKey());

  assert.equal(
    shouldReplaceCredential(new Error("opaque SDK request failure"), service),
    true,
  );
  const unverified = lifecycleService(`${KEY_PREFIX}sdk-unknown-key-456`);
  assert.equal(
    shouldReplaceCredential(new Error("opaque SDK request failure"), unverified),
    false,
  );
});

function spendError(balance: Parameters<typeof assertSpendAvailable>[0]) {
  try {
    assertSpendAvailable(balance);
  } catch (error) {
    assert.ok(
      error instanceof SpendUnavailableError,
      `Erwartet wurde ein SpendUnavailableError, bekommen: ${String(error)}`,
    );
    return error;
  }
  throw new assert.AssertionError({
    message: "assertSpendAvailable hat nichts geworfen.",
  });
}

test("an exhausted balance never deletes a valid key (B3)", () => {
  // The verdict must not depend on the wording of a German message: the old
  // /aufgebraucht|abgelaufen/ regex deleted keys that OpenRouter had just
  // confirmed as valid.
  const noCredits = spendError({
    key: { limit: null, limitRemaining: null },
    credits: { totalCredits: 5, totalUsage: 5, remaining: 0 },
  });
  assert.equal(noCredits.reason, "account-credits");
  assert.match(noCredits.message, /aufgebraucht/);
  assert.equal(shouldReplaceCredential(noCredits), false);

  const noKeyLimit = spendError({ key: { limit: 10, limitRemaining: 0 } });
  assert.equal(noKeyLimit.reason, "key-limit");
  assert.equal(shouldReplaceCredential(noKeyLimit), false);

  // A plain error that merely *reads* like an expiry stays harmless too.
  assert.equal(
    shouldReplaceCredential(new Error("Der Cache ist abgelaufen.")),
    false,
  );
});

test("an expired key stays loaded and can be saved or forgotten explicitly", () => {
  const expired = spendError({
    key: {
      limit: null,
      limitRemaining: null,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    },
  });
  assert.equal(expired.reason, "key-expired");
  assert.equal(shouldReplaceCredential(expired), false);
});

test("explicit key save authenticates and persists even when run spending is unavailable", async (t) => {
  const fixtures = [
    {
      name: "expired metadata",
      data: {
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        limit: null,
        limit_remaining: null,
      },
    },
    {
      name: "exhausted key limit",
      data: { limit: 1, limit_remaining: 0 },
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const key = `${KEY_PREFIX}save-nonspendable-${fixture.name.replace(/\s/g, "-")}-123`;
      const service = new OpenRouterService(
        key,
        undefined,
        { inference: "environment" },
        {
          fetchImpl: async () => new Response(JSON.stringify({
            data: {
              label: fixture.name,
              is_free_tier: false,
              is_management_key: false,
              usage: 1,
              usage_daily: 1,
              usage_weekly: 1,
              usage_monthly: 1,
              ...fixture.data,
            },
          }), { status: 200, headers: { "content-type": "application/json" } }),
        },
      );
      const credentials = lifecycleCredentials();
      const { context } = lifecycleContext(service, credentials.store);

      await handleSlashCommand("/key save", context);

      assert.equal(credentials.current(), key);
      assert.equal(service.requireKey(), key);
      assert.equal(service.keyOrigin, "keychain");
      assert.equal(service.runtimeState.inferenceValidity, "valid");
    });
  }
});

test("a first valid but unfunded replacement is persisted and activated before the run spend gate", async () => {
  const candidate = `${KEY_PREFIX}valid-unfunded-replacement-123456`;
  const service = new OpenRouterService(undefined, undefined, {}, {
    fetchImpl: async () => new Response(JSON.stringify({
      data: {
        label: "valid but unfunded",
        is_free_tier: false,
        is_management_key: false,
        usage: 1,
        limit: 1,
        limit_remaining: 0,
      },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const credentials = lifecycleCredentials();
  const { context } = lifecycleContext(service, credentials.store, {
    readCredentialSecret: async () => candidate,
  } as Partial<CommandContext>);

  await handleSlashCommand("/key replace", context);

  assert.equal(credentials.current(), candidate);
  assert.equal(service.requireKey(), candidate);
  assert.equal(service.keyOrigin, "keychain");
  assert.equal(service.runtimeState.inferenceValidity, "valid");
  assert.equal(service.runtimeState.connectivity, "connected");
  assert.equal(service.runtimeState.credit, "insufficient");
});

test("locally rejected setup input makes zero network and keychain calls", async () => {
  const calls: string[] = [];
  const context = {
    credentials: {
      location: "Test-Schlüsselbund",
      async set() { calls.push("keychain"); },
    },
    openRouter: {
      async validateInferenceKey() {
        calls.push("network");
        return {};
      },
      activateValidatedKey() { calls.push("activate"); },
    },
  } as unknown as Pick<CommandContext, "credentials" | "openRouter">;

  await assert.rejects(
    validateAndActivateInferenceKey(`bad\n${"x".repeat(30)}`, context),
    /ungültig|Steuer|Leerzeichen/i,
  );
  assert.deepEqual(calls, []);
});

test("inference and management activation use the same normalized candidate for network, keychain, and memory", async () => {
  const body = `${KEY_PREFIX}${"n".repeat(48)}`;
  const raw = `\u00a0\r\n${body}\r\n\u2003`;
  const calls: string[] = [];
  const context = {
    credentials: {
      location: "Test-Schlüsselbund",
      async set(kind: string, secret: string) {
        calls.push(`store:${kind}:${secret}`);
      },
    },
    openRouter: {
      async validateInferenceKey(secret: string) {
        calls.push(`network:inference:${secret}`);
        return { key: {}, credits: null };
      },
      activateValidatedKey(secret: string) {
        calls.push(`activate:inference:${secret}`);
      },
      async validateManagementKey(secret: string) {
        calls.push(`network:management:${secret}`);
        return { totalCredits: 10, totalUsage: 2, remaining: 8 };
      },
      activateValidatedManagementKey(secret: string) {
        calls.push(`activate:management:${secret}`);
      },
    },
  } as unknown as Pick<CommandContext, "credentials" | "openRouter">;

  await validateAndActivateInferenceKey(raw, context);
  await validateAndActivateManagementKey(raw, context);

  assert.deepEqual(calls, [
    `network:inference:${body}`,
    `store:inference:${body}`,
    `activate:inference:${body}`,
    `network:management:${body}`,
    `store:management:${body}`,
    `activate:management:${body}`,
  ]);
});

test("key replace and management replace reject embedded controls before provider or store side effects", async () => {
  for (const command of ["/key replace", "/key management replace"]) {
    const calls: string[] = [];
    const service = new OpenRouterService(undefined, undefined, {}, {
      fetchImpl: async () => {
        calls.push("network");
        return new Response(JSON.stringify({ data: {} }), { status: 200 });
      },
    });
    const credentials = lifecycleCredentials();
    const { context } = lifecycleContext(service, credentials.store, {
      readCredentialSecret: async () => `bad\u001b[31m${"x".repeat(30)}`,
    } as Partial<CommandContext>);

    await assert.rejects(
      handleSlashCommand(command, context),
      /ungültig|Steuer|Leerzeichen/i,
    );
    assert.deepEqual(calls, [], command);
    assert.equal(credentials.calls.includes("set"), false, command);
  }
});

const KEY_PREFIX = `${["sk", "or", "v1"].join("-")}-`;

function lifecycleService(
  key: string,
  origin: "environment" | "keychain" | "interactive" = "environment",
): OpenRouterService {
  return new OpenRouterService(key, undefined, { inference: origin }, {
    fetchImpl: async () => new Response(JSON.stringify({
      data: {
        label: "Lifecycle fixture",
        is_free_tier: false,
        is_management_key: false,
        usage: 1,
        usage_daily: 1,
        usage_weekly: 1,
        usage_monthly: 1,
        limit: 100,
        limit_remaining: 99,
      },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
}

function lifecycleCredentials(initial: string | null = null): {
  store: CredentialStoreLike;
  calls: string[];
  current: () => string | null;
  failDelete: { value: boolean };
  failSet: { value: boolean };
} {
  let stored = initial;
  const calls: string[] = [];
  const failDelete = { value: false };
  const failSet = { value: false };
  return {
    store: {
      location: "Test-Schlüsselbund",
      async get() {
        calls.push("get");
        return stored;
      },
      async set(_kind, secret) {
        calls.push("set");
        if (failSet.value) throw new Error("synthetic keychain unavailable");
        stored = secret;
      },
      async delete() {
        calls.push("delete");
        if (failDelete.value) throw new Error("synthetic delete failure");
        const existed = stored !== null;
        stored = null;
        return existed;
      },
      async has() {
        calls.push("has");
        return stored !== null;
      },
    },
    calls,
    current: () => stored,
    failDelete,
    failSet,
  };
}

function lifecycleContext(
  openRouter: OpenRouterService,
  credentials: CredentialStoreLike,
  overrides: Partial<CommandContext> = {},
): { context: CommandContext; output: string[] } {
  const output: string[] = [];
  return {
    context: {
      openRouter,
      credentials,
      out: {
        text: (value: string) => output.push(value),
        error: (value: string) => output.push(value),
      },
      ...overrides,
    } as unknown as CommandContext,
    output,
  };
}

test("slash help renders every shared catalog usage and catalog aliases dispatch", async () => {
  const catalogModule = await import("../src/command-catalog.js") as unknown as {
    COMMAND_CATALOG: ReadonlyArray<{ usage: string }>;
  };
  const output: string[] = [];
  const context = {
    out: {
      text: (value: string) => output.push(value),
      error: (value: string) => output.push(value),
    },
  } as unknown as CommandContext;

  assert.equal(await handleSlashCommand("/?", context), "continue");
  const help = output.join("\n");
  for (const entry of catalogModule.COMMAND_CATALOG) {
    assert.ok(help.includes(entry.usage), `help is missing ${entry.usage}`);
  }
  assert.equal(await handleSlashCommand("/q", context), "exit");
});

test("bare and legacy provider routing policy remain byte exact", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-provider-compat-"));
  const config = structuredClone(DEFAULT_CONFIG);
  const output: string[] = [];
  const context = {
    config,
    configPath: join(root, "config.json"),
    out: {
      text: (value: string) => output.push(value),
      error: (value: string) => output.push(value),
    },
  } as unknown as CommandContext;

  await handleSlashCommand("/provider", context);
  assert.equal(
    output.pop(),
    "Sortierung: Standard (Preis/Verfügbarkeit) · Datenweitergabe: deny · Provider-Fallbacks: an",
  );

  const commands = [
    "/provider sort price",
    "/provider deny",
    "/provider only anthropic openai",
    "/provider ignore meta",
    "/provider fallbacks off",
    "/provider sort none",
    "/provider reset",
  ];
  for (const command of commands) await handleSlashCommand(command, context);

  assert.deepEqual(context.config.provider, { dataCollection: "deny" });
  assert.equal(
    output.at(-1),
    "Sortierung: Standard (Preis/Verfügbarkeit) · Datenweitergabe: deny · Provider-Fallbacks: an",
  );
  const saved = JSON.parse(await readFile(context.configPath!, "utf8")) as {
    provider: Record<string, unknown>;
  };
  assert.deepEqual(saved.provider, { dataCollection: "deny" });
});

test("provider setup, connect, status, models, and reconnect dispatch one typed intent port", async () => {
  const output: string[] = [];
  const intents: Array<Record<string, unknown>> = [];
  const surface = { present() {} };
  const context = {
    config: structuredClone(DEFAULT_CONFIG),
    providerRouteSurface: surface,
    providerCommands: {
      async execute(intent: Record<string, unknown>, receivedSurface: unknown) {
        intents.push({ ...intent, sameSurface: receivedSurface === surface });
        if (intent.kind === "status") {
          return {
            kind: "status",
            providers: [{
              backendId: "openrouter",
              displayName: "OpenRouter",
              availability: "connectable",
              configuration: "enabled",
              maturity: "stable",
              billingRealm: "openrouter-payg",
              accountFingerprintSuffix: "…c0ffee",
              headline: "ready",
              health: {
                credential: "valid",
                connectivity: "connected",
                spend: "unknown",
                runtime: "not-applicable",
              },
              isDefault: true,
            }, {
              backendId: "anthropic",
              displayName: "Anthropic / Claude-Abo",
              availability: "coming-soon",
              configuration: "disabled",
              maturity: "coming-soon",
              billingRealm: "none",
              accountFingerprintSuffix: null,
              headline: null,
              health: null,
              isDefault: false,
            }],
            crossEnabled: false,
          };
        }
        if (intent.kind === "models") {
          return {
            kind: "models",
            backendId: "openrouter",
            models: [{ requestedModelId: "vendor/model", canonicalModelId: "vendor/model", displayName: "Model" }],
          };
        }
        if (intent.kind === "reconnect") {
          return { kind: "reconnected", backendId: "openrouter", headline: "ready", generation: 9 };
        }
        return { kind: "setup", backendId: "openrouter", outcome: "ready" };
      },
    },
    out: {
      text: (value: string) => output.push(value),
      error: (value: string) => output.push(value),
    },
  } as unknown as CommandContext;

  await handleSlashCommand("/provider setup", context);
  await handleSlashCommand("/provider connect openrouter", context);
  await handleSlashCommand("/provider status", context);
  await handleSlashCommand("/provider models openrouter", context);
  await handleSlashCommand("/provider reconnect openrouter", context);

  assert.deepEqual(intents, [
    { kind: "setup", sameSurface: true },
    { kind: "connect", backendId: "openrouter", sameSurface: true },
    { kind: "status", sameSurface: true },
    { kind: "models", backendId: "openrouter", sameSurface: true },
    { kind: "reconnect", backendId: "openrouter", sameSurface: true },
  ]);
  const rendered = output.join("\n");
  assert.match(rendered, /OpenRouter.*enabled.*ready.*openrouter-payg.*Standard/s);
  assert.match(rendered, /credential=valid.*connectivity=connected.*spend=unknown.*runtime=not-applicable/s);
  assert.match(rendered, /Anthropic.*Coming soon/s);
  assert.match(rendered, /Cross: aus/);
  assert.match(rendered, /vendor\/model/);
  // Privacy contract: the fingerprint suffix supplied by the port must never
  // reach the rendered status output.
  assert.doesNotMatch(rendered, /…c0ffee/);
  assert.doesNotMatch(rendered, /creator|credentialSlot|account-id|\/Users\//i);
});

test("every Anthropic provider command returns one typed coming-soon result with no legacy side effects", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const output: string[] = [];
  const forbidden = () => {
    throw new Error("forbidden provider side effect");
  };
  const context = {
    config: structuredClone(DEFAULT_CONFIG),
    providerCommands: {
      async execute(intent: Record<string, unknown>) {
        calls.push(intent);
        return {
          kind: "provider-coming-soon",
          backendId: "anthropic",
          displayName: "Anthropic / Claude-Abo",
          explanation: "Coming soon · Claude-Modelle sind heute über OpenRouter verfügbar.",
        };
      },
    },
    credentials: { get: forbidden, set: forbidden, delete: forbidden, has: forbidden },
    openRouter: new Proxy({}, { get: forbidden }),
    approvals: new Proxy({}, { get: forbidden }),
    out: {
      text: (value: string) => output.push(value),
      error: (value: string) => output.push(value),
    },
  } as unknown as CommandContext;

  for (const action of ["connect", "enable", "reconnect", "logout", "models", "disconnect", "disable"]) {
    await handleSlashCommand(`/provider ${action} anthropic`, context);
  }

  assert.deepEqual(calls.map((intent) => intent.kind), [
    "connect", "enable", "reconnect", "logout", "models", "disconnect", "disable",
  ]);
  assert.equal(output.length, 7);
  assert.ok(output.every((line) => /Coming soon/.test(line)));
});

test("provider disable and logout confirmations are exact, never YOLO-bypassed, and cancellation stays in chat", async () => {
  const intents: Array<Record<string, unknown>> = [];
  const confirmations: Array<{ operation: string; backendId: string; message: string }> = [];
  let accept = false;
  const context = {
    config: structuredClone(DEFAULT_CONFIG),
    approvals: { mode: "allow-all" },
    providerCommands: {
      async execute(intent: Record<string, unknown>) {
        intents.push(intent);
        if (intent.confirmationToken !== "opaque-confirmation-token") {
          return {
            kind: "confirmation-required",
            operation: intent.kind,
            backendId: intent.backendId,
            message: `Bestätige ${String(intent.kind)}.`,
            confirmationToken: "opaque-confirmation-token",
          };
        }
        return {
          kind: "changed",
          operation: intent.kind,
          backendId: intent.backendId,
          setupRequired: true,
          defaultCleared: true,
        };
      },
    },
    confirmProviderMutation: async (operation: string, backendId: string, message: string) => {
      confirmations.push({ operation, backendId, message });
      return accept;
    },
    out: { text: () => undefined, error: () => undefined },
  } as unknown as CommandContext;

  assert.equal(await handleSlashCommand("/provider disable openrouter", context), "continue");
  assert.equal(confirmations.length, 1);
  assert.deepEqual(intents, [{ kind: "disable", backendId: "openrouter" }]);

  accept = true;
  assert.equal(await handleSlashCommand("/provider logout openrouter", context), "continue");
  assert.equal(confirmations.length, 2);
  assert.deepEqual(intents.slice(1), [
    { kind: "logout", backendId: "openrouter" },
    {
      kind: "logout",
      backendId: "openrouter",
      confirmationToken: "opaque-confirmation-token",
    },
  ]);
});

test("unknown and partial provider subcommands use the exact new usage without mutation", async () => {
  const calls: unknown[] = [];
  const context = {
    config: structuredClone(DEFAULT_CONFIG),
    providerCommands: { execute: async (intent: unknown) => { calls.push(intent); } },
    out: { text: () => undefined, error: () => undefined },
  } as unknown as CommandContext;

  const expected = "Verwendung: /provider [setup|connect|enable|disable|disconnect|reconnect|status|models|logout|sort|allow|deny|only|ignore|fallback|clear]";
  for (const command of ["/provider con openrouter", "/provider STATUSS", "/provider setup-now"]) {
    await assert.rejects(handleSlashCommand(command, context), (error: unknown) =>
      error instanceof Error && error.message === expected
    );
  }
  assert.deepEqual(calls, []);
});

test("every kimi provider account command dispatches one exact kimi-code intent", async () => {
  const intents: Array<Record<string, unknown>> = [];
  const output: string[] = [];
  const context = {
    config: structuredClone(DEFAULT_CONFIG),
    providerCommands: {
      async execute(intent: Record<string, unknown>) {
        intents.push(intent);
        if (intent.kind === "status") {
          return { kind: "status", providers: [], crossEnabled: false };
        }
        return {
          kind: "unchanged",
          backendId: "kimi-code",
          reason: "pure-domain-double",
        };
      },
    },
    out: {
      text: (value: string) => output.push(value),
      error: (value: string) => output.push(value),
    },
  } as unknown as CommandContext;

  for (const action of ["connect", "enable", "disable", "reconnect", "models", "logout"]) {
    await handleSlashCommand(`/provider ${action} kimi-code`, context);
  }
  await handleSlashCommand("/provider status", context);

  assert.deepEqual(intents, [
    { kind: "connect", backendId: "kimi-code" },
    { kind: "enable", backendId: "kimi-code" },
    { kind: "disable", backendId: "kimi-code" },
    { kind: "reconnect", backendId: "kimi-code" },
    { kind: "models", backendId: "kimi-code" },
    { kind: "logout", backendId: "kimi-code" },
    { kind: "status" },
  ]);
});

test("provider status renders kimi as preview on its own realm without private data", async () => {
  const output: string[] = [];
  const context = {
    config: structuredClone(DEFAULT_CONFIG),
    providerCommands: {
      async execute() {
        return {
          kind: "status",
          providers: [{
            backendId: "openrouter",
            displayName: "OpenRouter",
            availability: "connectable",
            configuration: "enabled",
            maturity: "stable",
            billingRealm: "openrouter-payg",
            accountFingerprintSuffix: "…c0ffee",
            headline: "ready",
            health: {
              credential: "valid",
              connectivity: "connected",
              spend: "unknown",
              runtime: "not-applicable",
            },
            isDefault: false,
          }, {
            backendId: "kimi-code",
            displayName: "Kimi Code",
            availability: "connectable",
            configuration: "enabled",
            maturity: "preview",
            billingRealm: "kimi-code-membership-provider-managed-overage",
            accountFingerprintSuffix: "…feedface",
            headline: "ready",
            health: {
              credential: "valid",
              connectivity: "connected",
              spend: "unknown",
              runtime: "not-applicable",
            },
            isDefault: true,
          }],
          crossEnabled: false,
        };
      },
    },
    out: {
      text: (value: string) => output.push(value),
      error: (value: string) => output.push(value),
    },
  } as unknown as CommandContext;

  await handleSlashCommand("/provider status", context);
  const rendered = output.join("\n");
  const kimiLine = output.find((line) => line.includes("Kimi Code"));

  assert.ok(kimiLine, "status must render the kimi provider entry");
  assert.match(kimiLine, /Kimi Code.*Preview.*enabled.*ready.*kimi-code-membership-provider-managed-overage.*Standard/s);
  assert.match(kimiLine, /credential=valid.*connectivity=connected.*spend=unknown.*runtime=not-applicable/s);
  assert.equal(kimiLine.toLowerCase().includes("openrouter"), false);
  assert.match(rendered, /OpenRouter.*enabled.*ready.*openrouter-payg/s);
  assert.doesNotMatch(rendered, /feedface|c0ffee|…|acct_|@|quota/i);
  assert.doesNotMatch(rendered, /\d/);
});

test("kimi provider models render the kimi catalog and a kimi-specific empty message", async () => {
  const output: string[] = [];
  let empty = false;
  const context = {
    config: structuredClone(DEFAULT_CONFIG),
    providerCommands: {
      async execute() {
        return {
          kind: "models",
          backendId: "kimi-code",
          models: empty ? [] : [
            { requestedModelId: "k3", canonicalModelId: "k3", displayName: "Kimi K3" },
            { requestedModelId: "kimi-for-coding", canonicalModelId: "kimi-for-coding", displayName: "Kimi K2.7 Code" },
          ],
        };
      },
    },
    out: {
      text: (value: string) => output.push(value),
      error: (value: string) => output.push(value),
    },
  } as unknown as CommandContext;

  await handleSlashCommand("/provider models kimi-code", context);
  assert.match(output.join("\n"), /Kimi K3 · k3 · k3/);
  assert.match(output.join("\n"), /Kimi K2\.7 Code · kimi-for-coding · kimi-for-coding/);

  output.length = 0;
  empty = true;
  await handleSlashCommand("/provider models kimi-code", context);
  assert.deepEqual(output, ["Keine nutzbaren Kimi-Code-Modelle verfügbar."]);
});

test("a kimi reconnect result is never relabeled as openrouter", async () => {
  const output: string[] = [];
  const context = {
    config: structuredClone(DEFAULT_CONFIG),
    providerCommands: {
      async execute() {
        return {
          kind: "reconnected",
          backendId: "kimi-code",
          headline: "ready",
          generation: 3,
        };
      },
    },
    out: {
      text: (value: string) => output.push(value),
      error: (value: string) => output.push(value),
    },
  } as unknown as CommandContext;

  await handleSlashCommand("/provider reconnect kimi-code", context);

  assert.deepEqual(output, ["Kimi Code · ready · Generation 3"]);
});

test("a valid environment key remains process-only during startup validation", async () => {
  const key = `${KEY_PREFIX}environment-process-only-123`;
  const service = lifecycleService(key, "environment");
  const credentials = lifecycleCredentials();
  const output: string[] = [];

  await promptForValidKey(service, credentials.store, {
    text: (value) => output.push(value),
    error: (value) => output.push(value),
  });

  assert.equal(service.keyOrigin, "environment");
  assert.equal(service.requireKey(), key);
  assert.equal(credentials.current(), null);
  assert.equal(credentials.calls.includes("set"), false);
});

test("plain startup keeps a saved key loaded when connection, permission, or credit is unavailable", async (t) => {
  const key = `${KEY_PREFIX}plain-reconnectable-key-123`;
  const fixtures = [
    {
      name: "offline",
      fetchImpl: async () => {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ENETUNREACH" },
        });
      },
    },
    {
      name: "permission 403",
      fetchImpl: async () => new Response(JSON.stringify({
        error: { message: "forbidden" },
      }), { status: 403, headers: { "content-type": "application/json" } }),
    },
    {
      name: "insufficient key limit",
      fetchImpl: async () => new Response(JSON.stringify({
        data: {
          label: "no remaining limit",
          is_free_tier: false,
          is_management_key: false,
          usage: 1,
          limit: 1,
          limit_remaining: 0,
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const service = new OpenRouterService(
        key,
        undefined,
        { inference: "keychain" },
        {
          clock: { sleep: async () => undefined },
          fetchImpl: fixture.fetchImpl,
        },
      );
      const credentials = lifecycleCredentials(key);
      const output: string[] = [];

      const balance = await promptForValidKey(service, credentials.store, {
        text: (value) => output.push(value),
        error: (value) => output.push(value),
      });

      assert.equal(balance, null);
      assert.equal(service.requireKey(), key);
      assert.equal(credentials.current(), key);
      assert.equal(credentials.calls.includes("delete"), false);
      assert.match(output.join("\n"), /geladen|unverändert|reconnect/i);
    });
  }
});

test("key save is the explicit validated transition from environment to keychain", async () => {
  const key = `${KEY_PREFIX}explicit-save-key-123456`;
  const service = lifecycleService(key, "environment");
  const credentials = lifecycleCredentials();
  const { context } = lifecycleContext(service, credentials.store);

  await handleSlashCommand("/key save", context);

  assert.equal(credentials.current(), key);
  assert.equal(service.keyOrigin, "keychain");
  assert.equal(service.runtimeState.inferenceValidity, "valid");
});

test("key save failure keeps the active process-only key unchanged and retryable", async () => {
  const key = `${KEY_PREFIX}save-failure-key-123456`;
  const service = lifecycleService(key, "environment");
  const credentials = lifecycleCredentials();
  credentials.failSet.value = true;
  const { context } = lifecycleContext(service, credentials.store);

  await assert.rejects(handleSlashCommand("/key save", context), /keychain unavailable/);
  assert.equal(service.requireKey(), key);
  assert.equal(service.keyOrigin, "environment");
  assert.equal(credentials.current(), null);
});

test("key forget asks exactly once and a decline mutates neither persistence nor memory", async () => {
  const key = `${KEY_PREFIX}forget-decline-key-12345`;
  const service = lifecycleService(key, "keychain");
  const credentials = lifecycleCredentials(key);
  let confirmations = 0;
  const { context } = lifecycleContext(service, credentials.store, {
    confirmCredentialForget: async () => {
      confirmations += 1;
      return false;
    },
  } as Partial<CommandContext>);

  await handleSlashCommand("/key forget", context);

  assert.equal(confirmations, 1);
  assert.equal(credentials.calls.includes("delete"), false);
  assert.equal(credentials.current(), key);
  assert.equal(service.requireKey(), key);
});

test("accepted key forget deletes persistence before memory and stays retryable on failure", async () => {
  const key = `${KEY_PREFIX}forget-retry-key-123456`;
  const service = lifecycleService(key, "keychain");
  const credentials = lifecycleCredentials(key);
  credentials.failDelete.value = true;
  let confirmations = 0;
  let activeDuringDelete = false;
  const originalDelete = credentials.store.delete.bind(credentials.store);
  credentials.store.delete = async (kind) => {
    activeDuringDelete = service.hasKey;
    return originalDelete(kind);
  };
  const { context } = lifecycleContext(service, credentials.store, {
    confirmCredentialForget: async () => {
      confirmations += 1;
      return true;
    },
  } as Partial<CommandContext>);

  await assert.rejects(handleSlashCommand("/key forget", context), /delete failure/);
  assert.equal(confirmations, 1);
  assert.equal(activeDuringDelete, true);
  assert.equal(service.requireKey(), key);
  assert.equal(credentials.current(), key);

  credentials.failDelete.value = false;
  await handleSlashCommand("/key forget", context);
  assert.equal(confirmations, 2, "one confirmation for each explicit retry");
  assert.equal(credentials.current(), null);
  assert.equal(service.hasKey, false);
});

test("key replace keeps the old key when process-only fallback is declined", async () => {
  const previous = `${KEY_PREFIX}replace-previous-key-123`;
  const candidate = `${KEY_PREFIX}replace-candidate-key-456`;
  const service = lifecycleService(previous, "keychain");
  const credentials = lifecycleCredentials(previous);
  credentials.failSet.value = true;
  let confirmations = 0;
  const { context } = lifecycleContext(service, credentials.store, {
    readCredentialSecret: async () => candidate,
    confirmProcessOnlyCredential: async () => {
      confirmations += 1;
      return false;
    },
  } as Partial<CommandContext>);

  await handleSlashCommand("/key replace", context);

  assert.equal(confirmations, 1);
  assert.equal(service.requireKey(), previous);
  assert.equal(service.keyOrigin, "keychain");
  assert.equal(credentials.current(), previous);
});

test("key replace may use a validated candidate process-only after explicit consent", async () => {
  const previous = `${KEY_PREFIX}replace-old-key-123456`;
  const candidate = `${KEY_PREFIX}replace-process-key-456`;
  const service = lifecycleService(previous, "keychain");
  const credentials = lifecycleCredentials(previous);
  credentials.failSet.value = true;
  let confirmations = 0;
  const { context } = lifecycleContext(service, credentials.store, {
    readCredentialSecret: async () => candidate,
    confirmProcessOnlyCredential: async () => {
      confirmations += 1;
      return true;
    },
  } as Partial<CommandContext>);

  await handleSlashCommand("/key replace", context);

  assert.equal(confirmations, 1);
  assert.equal(service.requireKey(), candidate);
  assert.equal(service.keyOrigin, "interactive");
  assert.equal(credentials.current(), previous);
});

test("an unsafe keychain rollback never offers or activates process-only use", async () => {
  const previous = `${KEY_PREFIX}unsafe-rollback-old-key-123`;
  const candidate = `${KEY_PREFIX}unsafe-rollback-candidate-456`;
  const service = lifecycleService(previous, "keychain");
  const credentials = lifecycleCredentials(previous);
  credentials.store.set = async () => {
    throw Object.assign(
      new CredentialStoreError("Schlüsselbund-Zustand ist unbekannt."),
      { persistenceState: "unknown" as const },
    );
  };
  let confirmations = 0;
  const { context } = lifecycleContext(service, credentials.store, {
    readCredentialSecret: async () => candidate,
    confirmProcessOnlyCredential: async () => {
      confirmations += 1;
      return true;
    },
  } as Partial<CommandContext>);

  await assert.rejects(handleSlashCommand("/key replace", context), /unbekannt/i);

  assert.equal(confirmations, 0);
  assert.equal(service.requireKey(), previous);
  assert.equal(service.keyOrigin, "keychain");
});

test("a rejected replacement candidate never reaches persistence or process-only consent", async () => {
  const previous = `${KEY_PREFIX}rejected-old-key-12345`;
  const candidate = `${KEY_PREFIX}rejected-candidate-key-456`;
  const credentials = lifecycleCredentials(previous);
  let confirmations = 0;
  const service = new OpenRouterService(
    previous,
    undefined,
    { inference: "keychain" },
    {
      fetchImpl: async (_url, init) => {
        const authorization = (init.headers as Record<string, string>).Authorization;
        return authorization === `Bearer ${candidate}`
          ? new Response(JSON.stringify({ error: { message: "candidate rejected" } }), {
              status: 401,
              headers: { "content-type": "application/json" },
            })
          : new Response(JSON.stringify({ data: {} }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
      },
    },
  );
  const { context } = lifecycleContext(service, credentials.store, {
    readCredentialSecret: async () => candidate,
    confirmProcessOnlyCredential: async () => {
      confirmations += 1;
      return true;
    },
  } as Partial<CommandContext>);

  let candidateError: unknown;
  try {
    await handleSlashCommand("/key replace", context);
  } catch (error) {
    candidateError = error;
  }
  assert.ok(candidateError instanceof Error);
  assert.match(candidateError.message, /abgelehnt|401/);
  assert.equal(
    shouldReplaceCredential(candidateError, service),
    false,
    "a candidate rejection must not trigger the outer startup/replacement flow",
  );
  assert.equal(confirmations, 0);
  assert.equal(credentials.calls.includes("set"), false);
  assert.equal(credentials.current(), previous);
  assert.equal(service.requireKey(), previous);
});

test("key status reports an offline active key as reconnectable without deleting or throwing", async () => {
  const key = `${KEY_PREFIX}offline-status-key-123456`;
  const service = new OpenRouterService(
    key,
    undefined,
    { inference: "keychain" },
    {
      clock: { sleep: async () => undefined },
      fetchImpl: async () => {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ENETUNREACH" },
        });
      },
    },
  );
  const credentials = lifecycleCredentials(key);
  const { context, output } = lifecycleContext(service, credentials.store);

  await handleSlashCommand("/key status", context);

  assert.equal(service.requireKey(), key);
  assert.equal(credentials.current(), key);
  assert.equal(service.runtimeState.connectivity, "disconnected");
  assert.match(output.join("\n"), /getrennt|offline/i);
  assert.match(output.join("\n"), /reconnect/i);
});

test("management replace uses the same explicit process-only fallback contract", async () => {
  const inference = `${KEY_PREFIX}management-flow-inference-123`;
  const previous = `${KEY_PREFIX}management-flow-previous-456`;
  const candidate = `${KEY_PREFIX}management-flow-candidate-789`;
  const service = new OpenRouterService(
    inference,
    previous,
    { inference: "keychain", management: "keychain" },
    {
      fetchImpl: async () => new Response(JSON.stringify({
        data: { total_credits: 20, total_usage: 5 },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    },
  );
  const credentials = lifecycleCredentials(previous);
  credentials.failSet.value = true;
  let confirmations = 0;
  const { context } = lifecycleContext(service, credentials.store, {
    readCredentialSecret: async () => candidate,
    confirmProcessOnlyCredential: async (kind) => {
      assert.equal(kind, "management");
      confirmations += 1;
      return true;
    },
  } as Partial<CommandContext>);

  await handleSlashCommand("/key management replace", context);

  assert.equal(confirmations, 1);
  assert.equal(service.requireManagementKey(), candidate);
  assert.equal(service.managementKeyOrigin, "interactive");
  assert.equal(service.runtimeState.managementValidity, "valid");
  assert.equal(credentials.current(), previous);
});

test("direct /diff streams through the hardened Git event path without duplicating the final diff", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "routercode-command-diff-"));
  try {
    await run("git", ["init", "-q"], { cwd: workspace });
  } catch {
    t.skip("git ist nicht installiert");
    return;
  }
  await writeFile(join(workspace, "tracked.txt"), "before\n", "utf8");
  await run("git", ["add", "tracked.txt"], { cwd: workspace });
  await run("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=RouterCode Test", "commit", "-qm", "fixture"], { cwd: workspace });
  await writeFile(join(workspace, "tracked.txt"), "after\n", "utf8");
  const events: AgentRunEvent[] = [];
  const output: string[] = [];
  const context = {
    workspace,
    onRunEvent: (event: AgentRunEvent) => events.push(event),
    out: { text: (value: string) => output.push(value), error: (value: string) => output.push(value) },
  } as unknown as CommandContext;

  await handleSlashCommand("/diff", context);

  assert.deepEqual(events.map((event) => event.type), ["process-start", "process-output", "process-end"]);
  const processEvents = events as Array<AgentRunEvent & { id: string; name: string }>;
  assert.equal(new Set(processEvents.map((event) => event.id)).size, 1);
  assert.ok(processEvents.every((event) => event.name === "git_diff"));
  assert.deepEqual(output, [], "the streamed diff must not be printed a second time as a final tail");
});

test("direct /verify now forwards the live process lifecycle to the active surface", { skip: process.platform === "win32" ? "needs a POSIX shell" : false }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "routercode-command-verify-"));
  const events: AgentRunEvent[] = [];
  const config = structuredClone(DEFAULT_CONFIG);
  config.verify.commands = ["printf verify-live"];
  const context = {
    workspace,
    config,
    agent: { guard: { root: workspace } },
    onRunEvent: (event: AgentRunEvent) => events.push(event),
    out: { text: () => undefined, error: () => undefined },
  } as unknown as CommandContext;

  await handleSlashCommand("/verify now", context);

  assert.deepEqual(events.map((event) => event.type), ["process-start", "process-output", "process-end"]);
  const processEvents = events as Array<AgentRunEvent & { id: string; name: string }>;
  assert.equal(new Set(processEvents.map((event) => event.id)).size, 1);
  assert.ok(processEvents.every((event) => event.name === "verify"));
});

test("direct /verify now reports a signal termination without calling it cancellation", { skip: process.platform === "win32" ? "needs a POSIX shell" : false }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "routercode-command-verify-signal-"));
  const events: AgentRunEvent[] = [];
  const output: string[] = [];
  const config = structuredClone(DEFAULT_CONFIG);
  config.verify.commands = ["kill -TERM $$"];
  const context = {
    workspace,
    config,
    agent: { guard: { root: workspace } },
    onRunEvent: (event: AgentRunEvent) => events.push(event),
    out: {
      text: (value: string) => output.push(value),
      error: (...values: string[]) => output.push(...values),
    },
  } as unknown as CommandContext;

  await handleSlashCommand("/verify now", context);

  const end = events.find((event) => event.type === "process-end");
  assert.equal(end?.type === "process-end" ? end.signal : undefined, "SIGTERM");
  assert.match(output.join("\n"), /SIGTERM/);
  assert.doesNotMatch(output.join("\n"), /abgebrochen/i);
});

test("/verify rounds accepts zero, renders repair semantics, and rejects values above two", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "routercode-command-verify-rounds-"));
  const output: string[] = [];
  const config = structuredClone(DEFAULT_CONFIG);
  const context = {
    workspace,
    config,
    configPath: join(workspace, "config.json"),
    agent: { guard: { root: workspace } },
    out: {
      text: (value: string) => output.push(value),
      error: (value: string) => output.push(value),
    },
  } as unknown as CommandContext;

  await handleSlashCommand("/verify rounds 0", context);
  assert.equal(context.config.verify.maxRepairRounds, 0);
  await handleSlashCommand("/verify", context);
  assert.ok(output.some((line) => /0 Reparaturrunde/.test(line)), output.join("\n"));
  await assert.rejects(handleSlashCommand("/verify rounds 3", context), /zwischen 0 und 2/);

  const saved = JSON.parse(await readFile(context.configPath!, "utf8")) as {
    verify: Record<string, unknown>;
  };
  assert.equal(saved.verify.maxRepairRounds, 0);
  assert.equal("maxRounds" in saved.verify, false);
});

test("chat open proves a foreign exact route before config, session, agent, or current-file mutation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "routercode-command-foreign-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "project");
  const appHome = join(root, ".orcode");
  const currentRoute = {
    version: 1 as const,
    backendId: "openrouter" as const,
    accountFingerprint: "acct_command_current_111111",
    billingRealm: "openrouter-payg" as const,
    requestedModelId: "vendor/command-current",
    canonicalModelId: "vendor/command-current",
    resolutionState: "resolved" as const,
  };
  const foreignRoute = {
    ...currentRoute,
    accountFingerprint: "acct_command_foreign_222222",
    requestedModelId: "vendor/command-foreign",
    canonicalModelId: "vendor/command-foreign",
  };
  const current = SessionStore.create(workspace, appHome, "Command current");
  current.setPreferences(currentRoute.requestedModelId, { mode: "auto" }, currentRoute);
  await current.save();
  const currentBytes = await readFile(current.path, "utf8");
  const historical = SessionStore.create(workspace, appHome, "Command foreign");
  historical.setPreferences(foreignRoute.requestedModelId, { mode: "auto" }, foreignRoute);
  await historical.save();
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = currentRoute.requestedModelId;
  const configBefore = structuredClone(config);
  const selections: unknown[] = [];
  const transitions: string[] = [];
  const rebound: string[] = [];
  const context = {
    workspace,
    config,
    configPath: join(appHome, "config.json"),
    session: current,
    agent: { setSession(next: SessionStore) { rebound.push(next.data.id); } },
    providerRoutes: {
      currentSessionRoute() { return structuredClone(currentRoute); },
      async selectSessionRoute(route: unknown) {
        selections.push(structuredClone(route));
        throw Object.assign(new Error("foreign command route requires setup"), {
          code: "provider-setup-required",
        });
      },
      async transitionModel(modelId: string) { transitions.push(modelId); },
    },
    providerRouteSurface: "plain",
    out: { text() {}, error() {} },
  } as unknown as CommandContext;

  await assert.rejects(
    handleSlashCommand(`/chat open ${historical.data.id}`, context),
    (error: unknown) => Boolean(
      error && typeof error === "object" && "code" in error
      && error.code === "provider-setup-required"
    ),
  );

  assert.deepEqual(selections, [foreignRoute]);
  assert.deepEqual(transitions, []);
  assert.equal(context.session, current);
  assert.deepEqual(context.config, configBefore);
  assert.deepEqual(rebound, []);
  assert.equal(await readFile(current.path, "utf8"), currentBytes);
});

test("chat, search, session, and checkpoint commands never render unknown Kimi cost as zero", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "routercode-command-unknown-cost-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "project");
  const appHome = join(root, ".orcode");
  const session = SessionStore.create(workspace, appHome, "Kimi unknown");
  session.addTurn("user", "needle unknown provider cost");
  session.addCost("main", 0, "unknown");
  session.createCheckpoint("Kimi checkpoint");
  await session.save();
  const output: string[] = [];
  const context = {
    workspace,
    session,
    config: structuredClone(DEFAULT_CONFIG),
    out: {
      text: (value: string) => output.push(value),
      error: (value: string) => output.push(value),
    },
  } as unknown as CommandContext;

  for (const command of ["/cost", "/budget", "/chat list", "/chat search needle", "/checkpoint list"]) {
    output.length = 0;
    await handleSlashCommand(command, context);
    const rendered = output.join("\n");
    assert.match(rendered, /providerverwaltet|unbekannt/i, command);
    assert.doesNotMatch(rendered, /kostenlos|\$0(?:\.0+)?\b|0(?:,0+)?\s*\$/i, command);
  }
});

test("chat deletion asks exactly once; decline changes nothing and accept deletes the selected chat", async () => {
  const root = await mkdtemp(join(tmpdir(), "routercode-command-delete-"));
  const workspace = join(root, "project");
  const appHome = join(root, ".orcode");
  const active = SessionStore.create(workspace, appHome, "Aktiv");
  const target = SessionStore.create(workspace, appHome, "Löschziel");
  await active.save();
  await target.save();
  const output: string[] = [];
  const confirmations: Array<{ title: string; details: string }> = [];
  let accepted = false;
  const context = {
    workspace,
    session: active,
    agent: { setSession: () => undefined },
    out: { text: (value: string) => output.push(value), error: (value: string) => output.push(value) },
    confirmChatDeletion: async (title: string, details: string) => {
      confirmations.push({ title, details });
      return accepted;
    },
  } as unknown as CommandContext;

  await handleSlashCommand(`/chat delete ${target.data.id}`, context);
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0]!.details, new RegExp(target.data.id));
  assert.match(await readFile(target.path, "utf8"), /Löschziel/);
  assert.equal((await SessionStore.list(workspace, appHome)).length, 2);

  accepted = true;
  await handleSlashCommand(`/chat delete ${target.data.id}`, context);
  assert.equal(confirmations.length, 2, "each delete attempt has one and only one confirmation");
  await assert.rejects(readFile(target.path, "utf8"), /ENOENT/);
  assert.deepEqual((await SessionStore.list(workspace, appHome)).map((chat) => chat.id), [active.data.id]);
  assert.ok(output.some((line) => /endgültig gelöscht/.test(line)));
});

test("accepting deletion of the active chat rebinds before autosave can resurrect it", async () => {
  const root = await mkdtemp(join(tmpdir(), "routercode-command-active-delete-"));
  const workspace = join(root, "project");
  const appHome = join(root, ".orcode");
  const active = SessionStore.create(workspace, appHome, "Aktiv löschen");
  await active.save();
  const oldId = active.data.id;
  const rebound: string[] = [];
  const context = {
    workspace,
    session: active,
    config: structuredClone(DEFAULT_CONFIG),
    configPath: join(appHome, "config.json"),
    agent: { setSession: (session: SessionStore) => rebound.push(session.data.id) },
    out: { text: () => undefined, error: () => undefined },
    confirmChatDeletion: async () => true,
  } as unknown as CommandContext;

  await handleSlashCommand(`/chat delete ${oldId}`, context);
  await context.session.save();

  assert.notEqual(context.session.data.id, oldId);
  assert.deepEqual(rebound, [context.session.data.id]);
  assert.equal((await SessionStore.list(workspace, appHome)).some((chat) => chat.id === oldId), false);
});

test("failed managed-backup cleanup keeps the active transcript bound and a retry cannot resurrect it", async () => {
  const root = await mkdtemp(join(tmpdir(), "routercode-command-backup-retry-"));
  const workspace = join(root, "project");
  const appHome = join(root, ".orcode");
  const active = SessionStore.create(workspace, appHome, "Backup-Retry");
  await active.save();
  const oldId = active.data.id;
  const checksum = "d".repeat(64);
  const backupPath = join(appHome, "migration-backups", `routercode-${checksum.slice(0, 16)}`);
  const outsideEmpty = join(root, "outside-empty");
  await mkdir(join(appHome, "migration-backups"), { recursive: true });
  await mkdir(outsideEmpty);
  await symlink(outsideEmpty, backupPath);
  await mkdir(join(appHome, "migrations"), { recursive: true });
  await writeFile(migrationManifestPath(appHome), JSON.stringify({
    version: 1,
    phase: "complete",
    sourcePath: join(root, ".routercode"),
    sourceChecksum: checksum,
    stagingPath: join(appHome, ".migration-staging", checksum),
    backupPath,
    chatIdMap: {},
    destinationPaths: [],
    isolated: [],
    complete: true,
    startedAt: "2026-08-22T11:59:00.000Z",
    completedAt: "2026-08-22T12:00:00.000Z",
  }));
  const rebound: string[] = [];
  const errors: string[] = [];
  const context = {
    workspace,
    session: active,
    config: structuredClone(DEFAULT_CONFIG),
    configPath: join(appHome, "config.json"),
    agent: { setSession: (session: SessionStore) => rebound.push(session.data.id) },
    out: { text: () => undefined, error: (value: string) => errors.push(value) },
    confirmChatDeletion: async () => true,
  } as unknown as CommandContext;

  await handleSlashCommand(`/chat delete ${oldId}`, context);

  assert.equal(context.session.data.id, oldId, "a failed cleanup keeps the active binding");
  assert.deepEqual(rebound, []);
  assert.match(await readFile(active.path, "utf8"), /Backup-Retry/, "the transcript remains the retry anchor");
  assert.ok(errors.some((value) => /nicht vollständig gelöscht/.test(value)));

  await rm(backupPath);
  await mkdir(backupPath);
  await handleSlashCommand(`/chat delete ${oldId}`, context);
  await context.session.save();

  assert.notEqual(context.session.data.id, oldId);
  assert.deepEqual(rebound, [context.session.data.id]);
  assert.equal((await SessionStore.list(workspace, appHome)).some((chat) => chat.id === oldId), false);
  await assert.rejects(stat(backupPath), /ENOENT/);
});

test("a managed-backup inspection failure retains the active transcript and retry cannot resurrect it", async () => {
  const root = await mkdtemp(join(tmpdir(), "routercode-command-backup-inspection-retry-"));
  const workspace = join(root, "project");
  const appHome = join(root, ".orcode");
  const active = SessionStore.create(workspace, appHome, "Inspection-Retry");
  await active.save();
  const oldId = active.data.id;
  const checksum = "a".repeat(64);
  const backupPath = join(appHome, "migration-backups", `routercode-${checksum.slice(0, 16)}`);
  await mkdir(join(appHome, "migration-backups"), { recursive: true });
  await writeFile(backupPath, "not-a-directory");
  await mkdir(join(appHome, "migrations"), { recursive: true });
  await writeFile(migrationManifestPath(appHome), JSON.stringify({
    version: 1,
    phase: "complete",
    sourcePath: join(root, ".routercode"),
    sourceChecksum: checksum,
    stagingPath: join(appHome, ".migration-staging", checksum),
    backupPath,
    chatIdMap: {},
    destinationPaths: [],
    isolated: [],
    complete: true,
    startedAt: "2026-08-22T11:59:00.000Z",
    completedAt: "2026-08-22T12:00:00.000Z",
  }));
  const rebound: string[] = [];
  const errors: Array<{ message: string; details: string }> = [];
  const context = {
    workspace,
    session: active,
    config: structuredClone(DEFAULT_CONFIG),
    configPath: join(appHome, "config.json"),
    agent: { setSession: (session: SessionStore) => rebound.push(session.data.id) },
    out: {
      text: () => undefined,
      error: (message: string, details: string) => errors.push({ message, details }),
    },
    confirmChatDeletion: async () => true,
  } as unknown as CommandContext;

  await handleSlashCommand(`/chat delete ${oldId}`, context);

  assert.equal(context.session.data.id, oldId, "inspection failure keeps the active binding");
  assert.deepEqual(rebound, []);
  assert.match(await readFile(active.path, "utf8"), /Inspection-Retry/);
  assert.equal(await readFile(backupPath, "utf8"), "not-a-directory", "the backup remains retryable");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /nicht vollständig gelöscht/);
  assert.ok(errors[0]!.details.includes(backupPath));
  assert.match(errors[0]!.details, /ENOTDIR/);

  await rm(backupPath);
  await mkdir(backupPath);
  await handleSlashCommand(`/chat delete ${oldId}`, context);
  await context.session.save();

  assert.notEqual(context.session.data.id, oldId);
  assert.deepEqual(rebound, [context.session.data.id]);
  assert.equal((await SessionStore.list(workspace, appHome)).some((chat) => chat.id === oldId), false);
  await assert.rejects(stat(backupPath), /ENOENT/);
});

function roleModel(
  overrides: Partial<ModelInfo> & Pick<ModelInfo, "id">,
): ModelInfo {
  const { id, ...rest } = overrides;
  return {
    id,
    name: id,
    description: "synthetic role fixture",
    contextLength: 32_000,
    promptPrice: 0,
    completionPrice: 0,
    supportedParameters: ["tools"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    ...rest,
  };
}

function roleCommandContext(
  root: string,
  listModels: (...args: unknown[]) => Promise<ModelInfo[]>,
): {
  context: CommandContext;
  output: string[];
  preferences: string[];
  sessionSaves: { count: number };
} {
  const output: string[] = [];
  const preferences: string[] = [];
  const sessionSaves = { count: 0 };
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = "provider/initial-main";
  config.compressorModel = "provider/initial-compressor";
  return {
    context: {
      config,
      configPath: join(root, "config.json"),
      openRouter: { listModels },
      session: {
        setPreferences: (modelId: string) => preferences.push(modelId),
        save: async () => {
          sessionSaves.count += 1;
        },
      },
      out: {
        text: (value: string) => output.push(value),
        error: (value: string) => output.push(value),
      },
    } as unknown as CommandContext,
    output,
    preferences,
    sessionSaves,
  };
}

test("slash main catalogue lists only complete main-role candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-main-list-"));
  const calls: unknown[][] = [];
  const catalog = [
    roleModel({ id: "provider/complete" }),
    roleModel({ id: "provider/no-tools", supportedParameters: [] }),
    roleModel({ id: "provider/no-text-input", inputModalities: ["image"] }),
    roleModel({ id: "provider/no-text-output", outputModalities: ["image"] }),
    roleModel({
      id: "openrouter/auto",
      supportedParameters: [],
      inputModalities: [],
      outputModalities: [],
    }),
  ];
  const { context, output } = roleCommandContext(root, async (...args) => {
    calls.push(args);
    return catalog;
  });

  await handleSlashCommand("/models", context);

  const rendered = output.join("\n");
  assert.match(rendered, /provider\/complete/);
  assert.match(rendered, /openrouter\/auto/);
  assert.doesNotMatch(rendered, /provider\/no-tools/);
  assert.doesNotMatch(rendered, /provider\/no-text-input/);
  assert.doesNotMatch(rendered, /provider\/no-text-output/);
  assert.equal(calls[0]?.[1], false, "role filtering must see the unfiltered catalogue");
});

test("slash exact and current main selection reject a found incompatible model before mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-main-reject-"));
  const incompatible = roleModel({
    id: "provider/no-tools",
    supportedParameters: [],
  });
  const fixture = roleCommandContext(root, async () => [incompatible]);

  await assert.rejects(
    handleSlashCommand("/model provider/no-tools", fixture.context),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "ModelCapabilityError" &&
      /provider\/no-tools/.test(error.message),
  );
  assert.equal(fixture.context.config.mainModel, "provider/initial-main");
  assert.deepEqual(fixture.preferences, []);
  assert.equal(fixture.sessionSaves.count, 0);

  fixture.context.config.mainModel = "provider/no-tools";
  await assert.rejects(
    handleSlashCommand("/model current", fixture.context),
    (error: unknown) =>
      error instanceof Error && error.name === "ModelCapabilityError",
  );
  assert.equal(fixture.context.config.mainModel, "provider/no-tools");
  assert.deepEqual(fixture.preferences, []);
  assert.equal(fixture.sessionSaves.count, 0);
});

test("slash model catalogue failures keep their original retryable error identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-main-network-"));
  const unavailable = new Error("synthetic catalogue unavailable");
  const fixture = roleCommandContext(root, async () => {
    throw unavailable;
  });

  await assert.rejects(
    handleSlashCommand("/model provider/complete", fixture.context),
    (error: unknown) => error === unavailable,
  );
  assert.equal(fixture.context.config.mainModel, "provider/initial-main");
  assert.deepEqual(fixture.preferences, []);
  assert.equal(fixture.sessionSaves.count, 0);
});

test("openrouter auto is a catalogue-independent main-only selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-main-auto-"));
  const fixture = roleCommandContext(root, async () => {
    throw new Error("the auto exception must not query the catalogue");
  });

  await handleSlashCommand("/model openrouter/auto", fixture.context);

  assert.equal(fixture.context.config.mainModel, "openrouter/auto");
  assert.deepEqual(fixture.preferences, ["openrouter/auto"]);
  assert.equal(fixture.sessionSaves.count, 1);
});

test("slash fallback addition rejects incompatible main routes before config mutation", async (t) => {
  const incompatible = [
    roleModel({ id: "provider/no-tools-fallback", supportedParameters: [] }),
    roleModel({ id: "provider/no-text-fallback", outputModalities: ["image"] }),
  ];

  for (const model of incompatible) {
    await t.test(model.id, async () => {
      const root = await mkdtemp(join(tmpdir(), "orcode-fallback-role-"));
      const fixture = roleCommandContext(root, async (search) =>
        search === model.id ? [model] : []
      );
      fixture.context.config.fallbackModels = ["provider/last-known-good"];

      await assert.rejects(
        handleSlashCommand(`/fallback +${model.id}`, fixture.context),
        (error: unknown) =>
          error instanceof Error &&
          error.name === "ModelCapabilityError" &&
          error.message.includes(model.id),
      );

      assert.deepEqual(
        fixture.context.config.fallbackModels,
        ["provider/last-known-good"],
      );
      await assert.rejects(stat(join(root, "config.json")), /ENOENT/);
    });
  }
});

test("slash fallback addition preserves catalogue outages before config mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-fallback-outage-"));
  const unavailable = new Error("synthetic fallback catalogue offline");
  const fixture = roleCommandContext(root, async () => {
    throw unavailable;
  });
  fixture.context.config.fallbackModels = ["provider/last-known-good"];

  await assert.rejects(
    handleSlashCommand("/fallback +provider/candidate", fixture.context),
    (error: unknown) => error === unavailable,
  );

  assert.deepEqual(
    fixture.context.config.fallbackModels,
    ["provider/last-known-good"],
  );
  await assert.rejects(stat(join(root, "config.json")), /ENOENT/);
});

test("slash compressor selection requires text output but no text input or tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-compressor-role-"));
  const imageToText = roleModel({
    id: "provider/image-to-text",
    supportedParameters: [],
    inputModalities: ["image"],
    outputModalities: ["text"],
  });
  const imageOnly = roleModel({
    id: "provider/image-only",
    outputModalities: ["image"],
  });
  const fixture = roleCommandContext(root, async (search) =>
    search === imageToText.id ? [imageToText] : [imageOnly],
  );

  await handleSlashCommand(`/compress model ${imageToText.id}`, fixture.context);
  assert.equal(fixture.context.config.compressorModel, imageToText.id);

  await assert.rejects(
    handleSlashCommand(`/compress model ${imageOnly.id}`, fixture.context),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "ModelCapabilityError" &&
      /provider\/image-only/.test(error.message),
  );
  assert.equal(
    fixture.context.config.compressorModel,
    imageToText.id,
    "the rejected value must not replace the last compatible compressor",
  );
});
