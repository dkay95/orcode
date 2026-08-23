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
