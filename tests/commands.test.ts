import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { SpendUnavailableError, assertSpendAvailable } from "../src/agent.js";
import {
  CLEAR_CHAT_CONFIRM_DETAILS,
  handleSlashCommand,
  audioInputModelCandidates,
  kimiCrossDisarmNoticeForPreference,
  panelModelCandidates,
  pickSelectableModelRoute,
  recheckConnectionHint,
  renderHelpLines,
  resolveModelSelectionConfigPath,
  promptForValidKey,
  shouldReplaceCredential,
  validateAndActivateInferenceKey,
  validateAndActivateManagementKey,
  type CommandContext,
  type CommandOutput,
  type ProviderCommandIntent,
  type ProviderCommandIntentPort,
  type ProviderCommandResult,
} from "../src/commands.js";
import { OpenRouterHttpError, OpenRouterService } from "../src/openrouter.js";
import type { CredentialStoreLike } from "../src/credentials.js";
import { CredentialStoreError } from "../src/credentials.js";
import { SessionStore } from "../src/session.js";
import { CONFIG_PATH, DEFAULT_CONFIG } from "../src/config.js";
import { parseCodexHomeId } from "../src/codex-profile.js";
import { migrationManifestPath } from "../src/storage.js";
import type { AgentRunEvent, ModelInfo } from "../src/types.js";
import type { SelectableModelRoute } from "../src/model-route-catalog.js";
import { ApprovalManager } from "../src/approval.js";
import { RuleStore } from "../src/rules.js";
import { WorkspaceGuard, reRootWorkspace as reRootWorkspaceCore } from "../src/workspace.js";
import type { PlainListIo } from "../src/ui/list-plain.js";
import { createTheme } from "../src/ui/theme.js";
import { abbreviateHome } from "../src/ui/workbench.js";
import { WORKBENCH_QUICK_ACTIONS } from "../src/tui.js";

const run = promisify(execFile);

test("/config omits the complete private provider binding tree", async () => {
  const output: string[] = [];
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = {
    schemaVersion: 3,
    revision: 1,
    lifecycle: "configured",
    connections: [{
      id: "codex-private-canary",
      backendId: "codex",
      enabled: false,
      maturity: "preview",
      credentialBinding: {
        kind: "provider-runtime",
        homeId: parseCodexHomeId("codex-0123456789abcdef0123456789abcdef"),
      },
      accountFingerprint: "acct_codex_private_canary",
      accountFingerprintState: "verified",
      billingRealm: "chatgpt-account-provider-managed-limits",
      lastHealth: null,
    }],
    defaultRoute: null,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const context = {
    configPath: "/private/config-path-canary",
    config,
    out: {
      text(value: string) { output.push(value); },
      error(value: string) { output.push(value); },
    },
  } as unknown as CommandContext;

  await handleSlashCommand("/config", context);

  assert.equal(output.length, 2);
  assert.match(output[0]!, /config-path-canary/);
  assert.doesNotMatch(
    output[1]!,
    /providerSetup|credentialBinding|provider-runtime|homeId|codex-0123456789abcdef0123456789abcdef|acct_codex_private_canary/,
  );
});

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
  assert.match(noCredits.message, /exhausted/);
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
    ...suppliesSecret(candidate),
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
    /invalid|control|whitespace/i,
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
      ...suppliesSecret(`bad\u001b[31m${"x".repeat(30)}`),
    } as Partial<CommandContext>);

    await assert.rejects(
      handleSlashCommand(command, context),
      /invalid|control|whitespace/i,
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

/**
 * The inverted secret seam (`CommandContext.withCredentialSecret`): a surface
 * hands the captured key to `use` and answers with the entry verdict only —
 * it is never asked to return the key.
 */
function suppliesSecret(secret: string): Pick<CommandContext, "withCredentialSecret"> {
  return {
    withCredentialSecret: async (_kind, use) => {
      await use(secret);
      return "used";
    },
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
        // FIX-14 ticket 15: the hint half of `error(value, hint)` is real
        // output — `createPlainCommandOutput` prints it — so the double
        // captures it. It used to be dropped, which let an assertion about
        // what the user is told pass on text the user could not see.
        error: (value: string, hint?: string) => {
          output.push(value);
          if (hint) output.push(hint);
        },
      },
      ...overrides,
    } as unknown as CommandContext,
    output,
  };
}

test("setup-required routes do not block legacy OpenRouter key repair, balance, or models", async () => {
  const credentials = lifecycleCredentials();
  const openRouter = lifecycleService(`${KEY_PREFIX}no-route-openrouter-fixture`);
  const routeGate = {
    currentSessionRoute() {
      throw Object.assign(new Error("setup required"), {
        code: "provider-setup-required",
      });
    },
  };
  const key = lifecycleContext(openRouter, credentials.store, {
    providerRoutes: routeGate,
  } as unknown as Partial<CommandContext>);
  await assert.doesNotReject(handleSlashCommand("/key status", key.context));
  assert.match(key.output.join("\n"), /Key|OpenRouter|Umgebung|gültig|ungeprüft/i);

  const balance = lifecycleContext(openRouter, credentials.store, {
    providerRoutes: routeGate,
  } as unknown as Partial<CommandContext>);
  await assert.doesNotReject(handleSlashCommand("/balance", balance.context));
  assert.match(balance.output.join("\n"), /99|Limit|Guthaben|USD/i);

  const models = lifecycleContext(openRouter, credentials.store, {
    providerRoutes: routeGate,
  } as unknown as Partial<CommandContext>);
  await assert.doesNotReject(handleSlashCommand("/models", models.context));
  assert.match(models.output.join("\n"), /Tool-capable models|No matching tool-capable models/i);
});

test("slash help renders every shared catalog command name and catalog aliases dispatch (D5: the V3 palette optic drops the old usage-argument dump — a bare command name is the one row format, exactly like the palette's own rows)", async () => {
  const catalogModule = await import("../src/command-catalog.js") as unknown as {
    COMMAND_CATALOG: ReadonlyArray<{ name: string; description: string }>;
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
  // A new catalog command needs no /help edit of its own (one source of
  // truth): every leaf's bare `/name` appears somewhere in the render.
  for (const entry of catalogModule.COMMAND_CATALOG) {
    assert.ok(help.includes(`/${entry.name}`), `help is missing /${entry.name}`);
  }
  assert.equal(await handleSlashCommand("/q", context), "exit");
});

test("slash help renders the canonical /settings guidance exactly once", async () => {
  const output: string[] = [];
  const context = {
    out: {
      text: (value: string) => output.push(value),
      error: (value: string) => output.push(value),
    },
  } as unknown as CommandContext;

  assert.equal(await handleSlashCommand("/help", context), "continue");
  const settingsLines = output.filter((line) => /^\s*\/settings(?:\s|$)/.test(line));
  assert.equal(settingsLines.length, 1);
  // A prefix match, not the full phrase: `printHelp` reads the live
  // `process.stdout.columns` (exactly like `printPanelResult` does), so a
  // real narrow terminal running this suite interactively could legitimately
  // ellipsize the tail of a long description — never its start (the 40-col
  // floor contract, pinned exactly below via `renderHelpLines` at an
  // explicit width). Matching the prefix keeps this test about "the
  // guidance is there once", not about a terminal width nobody here controls.
  assert.match(settingsLines[0]!, /Open guided/);
});

test("slash help groups the catalog in the V3 palette optic: a `─ <Group>` rule per top-level group, then a closing muted hint line — never a hand-maintained list", async () => {
  const output: string[] = [];
  const context = {
    out: {
      text: (value: string) => output.push(value),
      error: (value: string) => output.push(value),
    },
  } as unknown as CommandContext;

  assert.equal(await handleSlashCommand("/help", context), "continue");
  const theme = createTheme();
  const divider = theme.glyph("divider");
  const groupRules = output.filter((line) => line.startsWith(`${divider} `));
  // Every COMMAND_TREE top-level branch (Models, Chat, Workspace, Accounts,
  // Approvals & Costs, System) gets exactly one rule, in tree order — then FIX-4's `─ Shortcuts`
  // section with one rule per keymap context — plus the closing hint rule.
  // Neither a group heading nor the hint line ever goes through the per-row
  // description budget, so — unlike a command row's own text — this is exact
  // regardless of the real terminal's width.
  assert.deepEqual(groupRules, [
    `${divider} Models`,
    `${divider} Chat`,
    `${divider} Workspace`,
    `${divider} Accounts`,
    `${divider} Approvals & Costs`,
    `${divider} System`,
    `${divider} Shortcuts`,
    `${divider} Composer`,
    `${divider} Palette`,
    `${divider} During a run`,
    `${divider} Lists & pickers`,
    // V4-B: the Settings surface's own keys are in the one table now, so
    // `/help` teaches them like every other screen's.
    `${divider} Settings`,
    `${divider} /name runs a command${theme.glyph("separator")}the / palette searches everything`,
  ]);
});

test("slash help rows: the `/name` column never shrinks, but at the 40-column floor a long description ellipsizes into whatever room is left — never the other way round", () => {
  const theme = createTheme();
  // Directly against the pure renderer (`renderHelpLines`), exactly like
  // `ui/panel-view.ts`'s `renderPanel` is tested (`tests/panel.test.ts`) —
  // pinned at an explicit width instead of `printHelp`'s live
  // `process.stdout.columns`, so this is deterministic on any machine.
  const asText = (lines: readonly { spans: readonly { text: string }[] }[]): readonly string[] =>
    lines.map((line) => line.spans.map((entry) => entry.text).join(""));

  const wide = asText(renderHelpLines(theme, 100));
  const modelRowWide = wide.find((line) => line.trimStart().startsWith("/model "));
  // The name column is padded to the catalog's widest `/name`
  // (`/cross models`, 13 columns — FIX-15 retired the `collab` umbrella that
  // used to make `/collab cross models` the widest at 20) plus a 2-column
  // indent and a 2-column gap — global across every group, not per group, so
  // the whole screen reads as one aligned table.
  assert.equal(modelRowWide, "  /model         Search, choose, or show the main model");

  // 40 mirrors `HELP_MIN_WIDTH`, `commands.ts`'s own floor constant (not
  // exported — `renderHelpLines` already clamps up to it internally, so
  // passing anything at or below 40 exercises the same floor).
  const narrow = asText(renderHelpLines(theme, 40));
  const modelRowNarrow = narrow.find((line) => line.trimStart().startsWith("/model "));
  assert.ok(modelRowNarrow, "the /model row must still render at the 40-column floor");
  // The name column is byte-identical at every width — only the description
  // after it may ever change.
  assert.equal(modelRowNarrow, "  /model         Search, choose, or sho…");
  assert.ok(modelRowNarrow!.startsWith("  /model         "));
  assert.notEqual(modelRowNarrow, modelRowWide, "a 13-column-wide name column leaves only 23 columns for the description at the 40-column floor, so it must have visibly shortened");
  assert.ok(modelRowNarrow!.endsWith(theme.glyph("ellipsis")), "the shortened description ends with the theme's own ellipsis glyph, never a raw literal");
  // The catalog's longest name (`/cross models`, 13 columns) never truncates
  // either, even though it alone sets the whole table's name column — only
  // its description ever vanishes.
  const longestRowNarrow = narrow.find((line) => line.trimStart().startsWith("/cross models"));
  assert.equal(longestRowNarrow, "  /cross models  Open Cross focused on …");
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
    "Sort: Default (price/availability) · Data sharing: deny · Provider fallbacks: on",
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
    "Sort: Default (price/availability) · Data sharing: deny · Provider fallbacks: on",
  );
  const saved = JSON.parse(await readFile(context.configPath!, "utf8")) as {
    provider: Record<string, unknown>;
  };
  assert.deepEqual(saved.provider, { dataCollection: "deny" });
});

// FIX-15 (command-IA, ratified): the audit found `/provider allow|deny`
// colliding with `/allow` — one word, two unrelated meanings. The canonical
// spelling is `data allow|deny`, which is what the usage line names; the bare
// forms keep parsing so no muscle memory breaks. `login` joins `logout` as a
// door onto the connect action, never as a second connect path.
test("/provider data allow|deny is the canonical spelling, the bare forms still parse, and /provider login is connect", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const intents: Array<Record<string, unknown>> = [];
  const context = {
    config,
    providerCommands: {
      async execute(intent: Record<string, unknown>) {
        intents.push(intent);
        return { kind: "unchanged", backendId: "openrouter", reason: "pure-domain-double" };
      },
    },
    out: { text: () => undefined, error: () => undefined },
  } as unknown as CommandContext;

  await handleSlashCommand("/provider data allow", context);
  assert.equal(config.provider.dataCollection, "allow");
  await handleSlashCommand("/provider data deny", context);
  assert.equal(config.provider.dataCollection, "deny");
  // The bare compatibility forms reach the very same setting.
  await handleSlashCommand("/provider allow", context);
  assert.equal(config.provider.dataCollection, "allow");
  await handleSlashCommand("/provider deny", context);
  assert.equal(config.provider.dataCollection, "deny");
  await assert.rejects(handleSlashCommand("/provider data maybe", context), (error: unknown) =>
    error instanceof Error && error.message === "/provider data allows: allow or deny");

  // `login` produces the connect intent itself — not a lookalike of it.
  await handleSlashCommand("/provider login openrouter", context);
  await handleSlashCommand("/provider connect openrouter", context);
  assert.deepEqual(intents, [
    { kind: "connect", backendId: "openrouter" },
    { kind: "connect", backendId: "openrouter" },
  ]);

  await assert.rejects(handleSlashCommand("/provider fallbacks maybe", context), (error: unknown) =>
    error instanceof Error && error.message === "/provider fallbacks allows: on or off");
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
              displayName: "Anthropic / Claude subscription",
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
  assert.match(rendered, /OpenRouter · active route[\s\S]*Billing: API Pay-as-you-go/);
  assert.match(rendered, /Key stored · connection ok · credit unknown/);
  // FIX-12: the role label read "coming soon" — the only role here that
  // named a future rather than the present, for a backend the registry
  // forbids an adapter and nobody is building.
  assert.match(rendered, /Anthropic \/ Claude subscription · not a direct backend/);
  assert.doesNotMatch(rendered, /coming soon/i);
  assert.match(rendered, /Cross: off/);
  assert.match(rendered, /vendor\/model/);
  // Privacy contract: the fingerprint suffix supplied by the port must never
  // reach the rendered status output.
  assert.doesNotMatch(rendered, /…c0ffee/);
  assert.doesNotMatch(rendered, /creator|credentialSlot|credentialBinding|pointer|homeId|codexHome|account-id|\/Users\//i);
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
          displayName: "Anthropic / Claude subscription",
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
  const confirmations: Array<{ title: string; message: string }> = [];
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
    // FIX-14 ticket 6: one confirm seam. The operation and the provider name
    // are IN the title now (the fullscreen wording, which survived), so the
    // question itself carries what this test used to receive as arguments.
    confirm: async (request: { title: string; consequence?: string }) => {
      confirmations.push({ title: request.title, message: request.consequence ?? "" });
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

  // FIX-15 usage line: `data allow|deny` replaces the bare `allow`/`deny`
  // tokens that collided with `/allow`, `fallbacks on|off` matches what the
  // parser has always accepted, and `login` joins `logout` as a door. The
  // refusal quotes the catalog's own usage, so this literal also pins that
  // the two can no longer drift apart.
  const expected = "Usage: /provider [setup|connect|login|logout|enable|disable|disconnect|reconnect|status|models|sort|only|ignore|clear] | data allow|deny | fallbacks on|off";
  for (const command of ["/provider con openrouter", "/provider STATUSS", "/provider setup-now"]) {
    await assert.rejects(handleSlashCommand(command, context), (error: unknown) =>
      error instanceof Error && error.message === expected
    );
  }
  assert.deepEqual(calls, []);
});

// FIX-15: `/reconnect` is retired as a command of its own. Reconnecting an
// account is `/provider reconnect <provider>`; a second top-level door onto
// the same mechanism is the defect the command-IA audit named. The token is a
// SHIM — one line naming the new home, then the surviving command runs. It
// must never grow a second reconnect implementation behind it.
test("the retired /reconnect names its new home once and then runs /provider reconnect openrouter", async () => {
  const intents: Array<Record<string, unknown>> = [];
  const output: string[] = [];
  const context = {
    config: structuredClone(DEFAULT_CONFIG),
    providerCommands: {
      async execute(intent: Record<string, unknown>) {
        intents.push(intent);
        return { kind: "unchanged", backendId: "openrouter", reason: "pure-domain-double" };
      },
    },
    out: {
      text: (value: string) => output.push(value),
      error: (value: string) => output.push(value),
    },
  } as unknown as CommandContext;

  assert.equal(await handleSlashCommand("/reconnect", context), "continue");
  assert.deepEqual(intents, [{ kind: "reconnect", backendId: "openrouter" }]);
  const notices = output.filter((line) => line.includes("/provider reconnect openrouter"));
  assert.equal(notices.length, 1, "the new home is named exactly once, not on every line");
  assert.match(notices[0]!, /\/reconnect is now \/provider reconnect openrouter/);
});

// FIX-15 fix round 1 (F2a): `/provider reconnect openrouter` resolves
// credentials through ProviderCredentialAuthority, whose permit sources are
// strictly saved-or-environment. A key accepted interactively lives in this
// process's memory only and is invisible there — so recommending that command
// in exactly that state was advice that could not work. One shared sentence,
// so the two call sites cannot drift apart again.
test("the recheck hint names /key save for a process-only key, and the reconnect path otherwise", () => {
  const processOnly = recheckConnectionHint("interactive");
  assert.match(processOnly, /\/key save/);
  assert.match(processOnly, /session's memory only/);
  assert.doesNotMatch(
    processOnly.replace(/cannot see it[^.]*/, ""),
    /Check it again with/,
    "it must not also offer the advice it just said cannot work",
  );

  for (const origin of ["keychain", "environment", "none"] as const) {
    const hint = recheckConnectionHint(origin);
    assert.match(hint, /\/provider reconnect openrouter/, origin);
    assert.doesNotMatch(hint, /\/key save/, origin);
  }
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

test("Nano-GPT account commands preserve their provider and never dispatch OpenRouter", async () => {
  const intents: Array<Record<string, unknown>> = [];
  const output: string[] = [];
  const context = {
    config: structuredClone(DEFAULT_CONFIG),
    providerCommands: {
      async execute(intent: Record<string, unknown>) {
        intents.push(intent);
        return { kind: "unchanged", backendId: "nano-gpt", reason: "fixture" };
      },
    },
    out: { text: (value: string) => output.push(value), error: (value: string) => output.push(value) },
  } as unknown as CommandContext;
  const actions = ["connect", "enable", "disable", "disconnect", "reconnect", "models", "logout"];
  for (const action of actions) await handleSlashCommand(`/provider ${action} nano-gpt`, context);
  assert.deepEqual(intents, actions.map((kind) => ({ kind, backendId: "nano-gpt" })));
  assert.match(output.join("\n"), /Nano-GPT/);
  assert.doesNotMatch(output.join("\n"), /OpenRouter/);
});

test("Nano-GPT /models uses its own filtered catalog, not the OpenRouter service", async () => {
  const intents: unknown[] = [];
  const output: string[] = [];
  const context = {
    providerRoutes: { currentSessionRoute: () => ({ backendId: "nano-gpt" }) },
    providerCommands: {
      async execute(intent: unknown) {
        intents.push(intent);
        return { kind: "models", backendId: "nano-gpt", models: [
          { requestedModelId: "vendor/manual", canonicalModelId: "vendor/manual", displayName: "Manual model" },
        ] };
      },
    },
    openRouter: { listModels() { throw new Error("wrong provider called"); } },
    out: { text: (value: string) => output.push(value), error: (value: string) => output.push(value) },
  } as unknown as CommandContext;
  await handleSlashCommand("/models manual", context);
  assert.deepEqual(intents, [{ kind: "models", backendId: "nano-gpt" }]);
  assert.deepEqual(output, ["Manual model · vendor/manual · vendor/manual"]);
});

test("Nano-GPT refuses OpenRouter-only paid extras without touching that provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-nanogpt-command-"));
  const context = {
    configPath: join(root, "config.json"),
    config: structuredClone(DEFAULT_CONFIG),
    providerRoutes: { currentSessionRoute: () => ({ backendId: "nano-gpt" }) },
    out: { text() {}, error() {} },
  } as unknown as CommandContext;
  await assert.rejects(handleSlashCommand("/web on", context), /Nano-GPT/);
  await assert.rejects(handleSlashCommand("/fallback vendor/other", context), /Nano-GPT/);
});

/**
 * Targeted privacy canaries for rendered provider status. Each canary names one
 * class of private or fabricated data that must never reach the chat surface,
 * while legitimate model names such as "K3", "K3 256K" or "K2.7" stay allowed.
 */
const PRIVATE_STATUS_CANARIES: ReadonlyArray<{ name: string; pattern: RegExp; samples: readonly string[] }> = [
  {
    name: "fabricated $0 or numeric quota",
    pattern: /\$\s*\d|\b\d+[.,]\d{2}\s*(?:USD|EUR|\$|€)?\b|\b\d+\s*(?:USD|EUR|credits?|tokens?|requests?)\b|\b\d+\s*%/i,
    samples: ["$0", "0.00 USD", "0 credits", "12 requests", "40 %"],
  },
  {
    name: "raw quota label",
    pattern: /\bquota\b|\bkontingent\b|\bremaining\b|\bbalance\b|\bguthaben\b|(?<!extra )\busage\b/i,
    samples: ["quota: none", "Guthaben", "remaining"],
  },
  {
    name: "account id",
    pattern: /\bacct_\w+|\baccount[-_ ]?id\b|\buser[-_]?\w*id\b/i,
    samples: ["acct_kimi_primary", "account-id", "user_id"],
  },
  {
    name: "email address",
    pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/,
    samples: ["person@example.com"],
  },
  {
    name: "key or fingerprint fragment",
    pattern: /…|\bsk-[\w-]+|\bc0ffee\b|\bfeedface\b|fingerprint|\b[0-9a-f]{8,}\b/i,
    samples: ["…feedface", "sk-or-v1-abc", "c0ffee", "deadbeef01", "fingerprint"],
  },
];

test("private status canaries fire on private samples and stay silent on kimi model names", () => {
  const legitimate = [
    "Kimi K3 · k3 · k3",
    "Kimi K3 256K · k3-256k · k3-256k",
    "Kimi K2.7 Code · kimi-for-coding · kimi-for-coding",
    "Kimi K2.7 Code HighSpeed · kimi-for-coding-highspeed · kimi-for-coding-highspeed",
    // The humanized bullet-format lines the new /provider status renderer
    // actually produces (F4, V3 audit principle 4) — no raw enums left to
    // check, but the canaries must still stay silent on this real prose.
    "Kimi Code · active route",
    "Billing: Subscription · provider-managed · Extra usage may be billable",
    "Model: Kimi K3 (k3)",
    "OpenRouter · configured",
    "Key stored · connection ok · credit available",
    "Billing: API Pay-as-you-go",
  ];
  for (const canary of PRIVATE_STATUS_CANARIES) {
    for (const sample of canary.samples) {
      assert.match(sample, canary.pattern, `${canary.name} canary must fire on ${sample}`);
    }
    for (const line of legitimate) {
      assert.doesNotMatch(line, canary.pattern, `${canary.name} canary must allow ${line}`);
    }
  }
});

test("a kimi setup or connect result is fully typed and rendered under its own name", async () => {
  const intents: ProviderCommandIntent[] = [];
  const output: string[] = [];
  let backendId: "openrouter" | "kimi-code" = "kimi-code";
  const port: ProviderCommandIntentPort = {
    async execute(intent): Promise<ProviderCommandResult> {
      intents.push(intent);
      return { kind: "setup", backendId, outcome: "ready" };
    },
  };
  const context = {
    config: structuredClone(DEFAULT_CONFIG),
    providerCommands: port,
    out: {
      text: (value: string) => output.push(value),
      error: (value: string) => output.push(value),
    },
  } as unknown as CommandContext;

  await handleSlashCommand("/provider connect kimi-code", context);
  assert.deepEqual(intents, [{ kind: "connect", backendId: "kimi-code" }]);
  assert.deepEqual(output, ["Kimi Code · Provider setup: ready"]);

  output.length = 0;
  backendId = "openrouter";
  await handleSlashCommand("/provider connect openrouter", context);
  assert.deepEqual(output, ["Provider setup: ready"]);
});

test("unapproved kimi disconnect is rejected with the exact usage and zero port calls", async () => {
  const intents: ProviderCommandIntent[] = [];
  const output: string[] = [];
  const port: ProviderCommandIntentPort = {
    async execute(intent): Promise<ProviderCommandResult> {
      intents.push(intent);
      return { kind: "unchanged", backendId: "openrouter", reason: "pure-domain-double" };
    },
  };
  const context = {
    config: structuredClone(DEFAULT_CONFIG),
    providerCommands: port,
    out: {
      text: (value: string) => output.push(value),
      error: (value: string) => output.push(value),
    },
  } as unknown as CommandContext;
  // FIX-15 usage line: `data allow|deny` replaces the bare `allow`/`deny`
  // tokens that collided with `/allow`, `fallbacks on|off` matches what the
  // parser has always accepted, and `login` joins `logout` as a door. The
  // refusal quotes the catalog's own usage, so this literal also pins that
  // the two can no longer drift apart.
  const expected = "Usage: /provider [setup|connect|login|logout|enable|disable|disconnect|reconnect|status|models|sort|only|ignore|clear] | data allow|deny | fallbacks on|off";

  for (const command of ["/provider disconnect kimi-code", "/provider disconnect KIMI-CODE"]) {
    await assert.rejects(handleSlashCommand(command, context), (error: unknown) =>
      error instanceof Error && error.message === expected
    );
  }
  assert.deepEqual(intents, []);
  assert.deepEqual(output, []);

  await handleSlashCommand("/provider disconnect openrouter", context);
  assert.deepEqual(intents, [{ kind: "disconnect", backendId: "openrouter" }]);
});

test("provider status renders the humanized bullet format per provider, kimi under its own name, without private data or raw enums", async () => {
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
            selectedModel: null,
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
            selectedModel: {
              requestedModelId: "k3",
              canonicalModelId: "k3",
              displayName: "Kimi K3",
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
  const theme = createTheme();
  const bullet = theme.glyph("toolHead");
  const foot = theme.glyph("blockFoot");
  const ok = theme.glyph("ok");

  const openrouterHeadIndex = output.findIndex((line) => line.includes("OpenRouter"));
  const kimiHeadIndex = output.findIndex((line) => line.includes("Kimi Code"));
  assert.ok(openrouterHeadIndex >= 0, "status must render the openrouter provider entry");
  assert.ok(kimiHeadIndex >= 0, "status must render the kimi provider entry");
  assert.notEqual(openrouterHeadIndex, kimiHeadIndex);

  // OpenRouter is not the default route here ("configured", not "active
  // route"); the fixture's health is otherwise identical to kimi's.
  assert.equal(output[openrouterHeadIndex], `${bullet} OpenRouter · configured`);
  assert.equal(output[openrouterHeadIndex + 1], `  ${foot} ${ok} Key stored · connection ok · credit unknown`);
  assert.equal(output[openrouterHeadIndex + 2], "    Billing: API Pay-as-you-go");

  // Kimi is the default route ("active route"); its provider-managed
  // overage realm keeps the billable caveat, and its selected model gets
  // its own line — all still rendered under its own name, never relabeled.
  assert.equal(output[kimiHeadIndex], `${bullet} Kimi Code · active route`);
  assert.equal(output[kimiHeadIndex + 1], `  ${foot} ${ok} Key stored · connection ok · credit unknown`);
  assert.equal(output[kimiHeadIndex + 2], "    Billing: Subscription · provider-managed · Extra usage may be billable");
  assert.equal(output[kimiHeadIndex + 3], "    Model: Kimi K3 (k3)");
  assert.equal(output[kimiHeadIndex]!.toLowerCase().includes("openrouter"), false);
  assert.equal(output[openrouterHeadIndex]!.toLowerCase().includes("kimi"), false);

  // The sweep this status rendering exists to pass (V3 audit principle 4):
  // none of the old raw `field=value` chains, internal counters, or bare
  // billing-realm enum values survive into the rendered copy.
  const rawTokens = [
    "credential=", "connectivity=", "spend=", "runtime=",
    "openrouter-payg", "kimi-code-membership-provider-managed-overage",
    "Generation ", "Limits=", "Model=",
  ];
  for (const token of rawTokens) {
    assert.equal(rendered.includes(token), false, `status leaked raw token "${token}"`);
  }
  for (const canary of PRIVATE_STATUS_CANARIES) {
    assert.doesNotMatch(rendered, canary.pattern, `status leaked ${canary.name}`);
  }
});

/** Builds one `ProviderCommandStatusEntry`-shaped fixture, only overriding what a given test cares about. */
function statusEntryFixture(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    backendId: "openrouter",
    displayName: "OpenRouter",
    availability: "connectable",
    configuration: "enabled",
    maturity: "stable",
    billingRealm: "openrouter-payg",
    accountFingerprintSuffix: null,
    headline: "ready",
    health: { credential: "valid", connectivity: "connected", spend: "available", runtime: "not-applicable" },
    selectedModel: null,
    isDefault: false,
    ...overrides,
  };
}

async function runProviderStatus(
  providers: readonly Record<string, unknown>[],
  /** D6: lets balance-thread tests inject `readCachedBalance`/a custom `config` without duplicating the whole harness. */
  overrides: Record<string, unknown> = {},
): Promise<string[]> {
  const output: string[] = [];
  const context = {
    config: structuredClone(DEFAULT_CONFIG),
    providerCommands: {
      async execute() {
        return { kind: "status", providers, crossEnabled: false };
      },
    },
    out: {
      text: (value: string) => output.push(value),
      error: (value: string) => output.push(value),
    },
    ...overrides,
  } as unknown as CommandContext;
  await handleSlashCommand("/provider status", context);
  return output;
}

test("provider status healthy frame matches the V3 binding mockup verbatim, with no fabricated balance (the honesty ruling's 'no-balance' case)", async () => {
  const output = await runProviderStatus([
    statusEntryFixture({ isDefault: true }),
  ]);
  const theme = createTheme();

  assert.deepEqual(output, [
    `${theme.glyph("toolHead")} OpenRouter · active route`,
    `  ${theme.glyph("blockFoot")} ${theme.glyph("ok")} Key stored · connection ok · credit available`,
    "    Billing: API Pay-as-you-go",
    "Cross: off",
  ]);
  // /provider status's data path is a synchronous local read (Controller
  // ruling 10 forbids wiring a new balance fetch into it) — so no balance
  // is ever known here, and the honest behavior is to never show one.
  assert.equal(output.some((line) => line.includes("$")), false);
  assert.equal(output.some((line) => /\bbalance\b/i.test(line)), false);
});

test("provider status failure frame renders one concrete ✗ reason chosen by the same precedence as the headline, never a raw enum", async () => {
  const output = await runProviderStatus([
    statusEntryFixture({
      headline: "login-required",
      health: { credential: "login-required", connectivity: "connected", spend: "unknown", runtime: "not-applicable" },
    }),
  ]);
  const theme = createTheme();

  assert.deepEqual(output, [
    `${theme.glyph("toolHead")} OpenRouter · configured`,
    `  ${theme.glyph("blockFoot")} ${theme.glyph("failed")} No key stored`,
    "    Billing: API Pay-as-you-go",
    "Cross: off",
  ]);
});

test("provider status keeps never-connected, disabled, and connected-but-unchecked apart (FIX-10 M4 + F1) — no stored-state claim without a stored connection", async () => {
  const output = await runProviderStatus([
    // Never connected: no stored connection exists — must NOT claim
    // "disabled" (or the old "standby"); the role label agrees with the
    // ✗ "Not connected" fact right under it.
    statusEntryFixture({
      displayName: "OpenRouter", configuration: "not-connected", headline: null, health: null, isDefault: false,
    }),
    statusEntryFixture({
      backendId: "kimi-code", displayName: "Kimi Code", billingRealm: "kimi-code-membership-provider-managed-overage",
      configuration: "enabled", headline: null, health: null, isDefault: false,
    }),
  ]);
  const theme = createTheme();

  assert.deepEqual(output, [
    `${theme.glyph("toolHead")} OpenRouter · not connected`,
    `  ${theme.glyph("blockFoot")} ${theme.glyph("failed")} Not connected`,
    "    Billing: API Pay-as-you-go",
    `${theme.glyph("toolHead")} Kimi Code · configured`,
    `  ${theme.glyph("blockFoot")} ${theme.glyph("failed")} Not checked`,
    "    Billing: Subscription · provider-managed · Extra usage may be billable",
    // FIX-14 ticket 13: NO invitation here. This case has a stored, enabled
    // Kimi Code connection that simply has not been probed yet, so "No
    // providers connected" was a false claim printed directly under a row
    // reading "Kimi Code · configured". The line keys on connection
    // existence now, not on `health === null` ("never probed"), which is a
    // different fact — see the fresh-install case below, where it does
    // appear.
    "Cross: off",
  ]);
});

test("FIX-14 ticket 13: the D5 invitation appears exactly when NO connectable provider has a stored connection", async () => {
  const theme = createTheme();
  const invitation = `No providers connected ${theme.glyph("emdash")} /provider connect adds one.`;

  // Fresh install: nothing stored anywhere. The invitation is the whole truth.
  const fresh = await runProviderStatus([
    statusEntryFixture({ displayName: "OpenRouter", configuration: "not-connected", headline: null, health: null, isDefault: false }),
    statusEntryFixture({ backendId: "kimi-code", displayName: "Kimi Code", billingRealm: "kimi-code-membership-provider-managed-overage", configuration: "not-connected", headline: null, health: null, isDefault: false }),
  ]);
  assert.ok(fresh.includes(invitation), fresh.join("\n"));

  // A stored connection the user turned OFF is still a stored connection —
  // and `/provider enable`, not `/provider connect`, is what that state
  // needs, so the invitation must not appear.
  const disabled = await runProviderStatus([
    statusEntryFixture({ displayName: "OpenRouter", configuration: "disabled", headline: null, health: null, isDefault: false }),
  ]);
  assert.equal(disabled.includes(invitation), false, disabled.join("\n"));

  // A stored, enabled, never-probed connection: likewise not "nothing
  // connected". This is the exact state the pre-fix `health === null` key
  // got wrong.
  const unprobed = await runProviderStatus([
    statusEntryFixture({ displayName: "OpenRouter", configuration: "enabled", headline: null, health: null, isDefault: false }),
  ]);
  assert.equal(unprobed.includes(invitation), false, unprobed.join("\n"));
});

test("provider status renders 'disabled' ONLY for a stored connection the user turned off (FIX-10 F1), with 'Not checked' as its unprobed fact", async () => {
  const output = await runProviderStatus([
    statusEntryFixture({
      displayName: "OpenRouter", configuration: "disabled", headline: null, health: null, isDefault: false,
    }),
  ]);
  const theme = createTheme();

  assert.equal(output[0], `${theme.glyph("toolHead")} OpenRouter · disabled`);
  // A stored connection exists — "Not connected" would be false here.
  assert.equal(output[1], `  ${theme.glyph("blockFoot")} ${theme.glyph("failed")} Not checked`);
});

// ---------------------------------------------------------------------------
// D6 (the cost thread): threading the dashboard's already-cached BalanceInfo
// into CommandContext so /provider status can show the F4 mockup's
// `Balance $X.XX` segment honestly, plus the low-balance warn sentence.
// ---------------------------------------------------------------------------

function cachedBalance(remaining: number): { key: Record<string, never>; credits: { totalCredits: number; totalUsage: number; remaining: number } } {
  return { key: {}, credits: { totalCredits: remaining + 10, totalUsage: 10, remaining } };
}

test("provider status shows a real Balance figure once a cached balance is threaded in via readCachedBalance", async () => {
  const output = await runProviderStatus(
    [statusEntryFixture({ isDefault: true })],
    { readCachedBalance: () => cachedBalance(14.76) },
  );
  assert.equal(
    output.find((line) => line.includes("Billing:")),
    "    Billing: API Pay-as-you-go · Balance ~$14.760",
  );
});

test("provider status omits the Balance segment when no cache exists — readCachedBalance unset, returning null, or a creditsless BalanceInfo", async () => {
  for (const overrides of [
    {},
    { readCachedBalance: () => null },
    { readCachedBalance: () => ({ key: {}, creditsUnavailableReason: "network error" }) },
  ]) {
    const output = await runProviderStatus([statusEntryFixture({ isDefault: true })], overrides);
    assert.equal(
      output.find((line) => line.includes("Billing:")),
      "    Billing: API Pay-as-you-go",
    );
  }
});

test("provider status never appends a Balance figure to a non-OpenRouter billing realm, even with a cached balance present", async () => {
  const output = await runProviderStatus(
    [statusEntryFixture({
      backendId: "kimi-code",
      displayName: "Kimi Code",
      billingRealm: "kimi-code-membership-provider-managed-overage",
      isDefault: true,
    })],
    { readCachedBalance: () => cachedBalance(1) },
  );
  assert.equal(
    output.find((line) => line.includes("Billing:")),
    "    Billing: Subscription · provider-managed · Extra usage may be billable",
  );
});

test("provider status appends the low-balance sentence when the cached balance is below the configured threshold", async () => {
  const config = { ...structuredClone(DEFAULT_CONFIG), lowBalanceThresholdUsd: 2 };
  const output = await runProviderStatus(
    [statusEntryFixture({ isDefault: true })],
    { config, readCachedBalance: () => cachedBalance(1) },
  );
  assert.ok(output.includes("    Balance low — below your $2.000 threshold."));
});

test("provider status omits the low-balance sentence once the cached balance is at or above the threshold", async () => {
  const config = { ...structuredClone(DEFAULT_CONFIG), lowBalanceThresholdUsd: 2 };
  const output = await runProviderStatus(
    [statusEntryFixture({ isDefault: true })],
    { config, readCachedBalance: () => cachedBalance(2) },
  );
  assert.equal(
    output.find((line) => line.includes("Billing:")),
    "    Billing: API Pay-as-you-go · Balance ~$2.000",
  );
  assert.equal(output.some((line) => /low/i.test(line)), false);
});

test("a 0 threshold disables the low-balance warn entirely — the Balance figure still shows plainly (visibility only, never blocking)", async () => {
  const config = { ...structuredClone(DEFAULT_CONFIG), lowBalanceThresholdUsd: 0 };
  const output = await runProviderStatus(
    [statusEntryFixture({ isDefault: true })],
    { config, readCachedBalance: () => cachedBalance(0.01) },
  );
  assert.equal(
    output.find((line) => line.includes("Billing:")),
    "    Billing: API Pay-as-you-go · Balance ~$0.010",
  );
  assert.equal(output.some((line) => /low/i.test(line)), false);
});

test("provider status omits the no-providers invitation once at least one provider has ever been probed, even if that probe failed", async () => {
  const output = await runProviderStatus([
    statusEntryFixture({
      displayName: "OpenRouter", configuration: "not-connected", headline: null, health: null, isDefault: false,
    }),
    statusEntryFixture({
      backendId: "kimi-code", displayName: "Kimi Code", billingRealm: "kimi-code-membership-provider-managed-overage",
      configuration: "enabled", headline: "login-required",
      health: { credential: "login-required", connectivity: "connected", spend: "unknown", runtime: "not-applicable" },
      isDefault: false,
    }),
  ]);
  assert.equal(output.some((line) => line.includes("No providers connected")), false);
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
  assert.deepEqual(output, ["No usable Kimi Code models available."]);
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

  // The internal `generation` retry-round counter (V3 audit principle 4)
  // never reaches user copy — only the headline does.
  assert.deepEqual(output, ["Kimi Code · ready"]);
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
    confirm: async () => {
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
    confirm: async () => {
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
    ...suppliesSecret(candidate),
    confirm: async () => {
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
    ...suppliesSecret(candidate),
    confirm: async () => {
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
    ...suppliesSecret(candidate),
    confirm: async () => {
      confirmations += 1;
      return true;
    },
  } as Partial<CommandContext>);

  await assert.rejects(handleSlashCommand("/key replace", context), /unbekannt/i);

  assert.equal(confirmations, 0);
  assert.equal(service.requireKey(), previous);
  assert.equal(service.keyOrigin, "keychain");
});

test("the credential-secret seam takes a consumer and answers with a verdict — never with the key", async () => {
  // Compile-time half of the claim: the seam's answer type cannot hold a
  // secret. Widen it back to `string | null` and this `@ts-expect-error`
  // becomes an unused directive, which is itself a tsc failure.
  type CredentialSecretAnswer = Awaited<
    ReturnType<NonNullable<CommandContext["withCredentialSecret"]>>
  >;
  // @ts-expect-error a raw provider key is not an entry verdict
  const notAnAnswer: CredentialSecretAnswer = `${KEY_PREFIX}never-an-answer-1234`;
  assert.equal(typeof notAnAnswer, "string");

  // Runtime half: the key exists only inside the consumer the seam is given.
  const previous = `${KEY_PREFIX}seam-previous-key-12345`;
  const candidate = `${KEY_PREFIX}seam-candidate-key-4567`;
  const service = lifecycleService(previous, "keychain");
  const credentials = lifecycleCredentials(previous);
  let consumed = 0;
  const used = lifecycleContext(service, credentials.store, {
    withCredentialSecret: async (kind, use) => {
      assert.equal(kind, "inference");
      await use(candidate);
      consumed += 1;
      return "used";
    },
  } as Partial<CommandContext>);

  await handleSlashCommand("/key replace", used.context);

  assert.equal(consumed, 1);
  assert.equal(credentials.current(), candidate);
  assert.equal(service.requireKey(), candidate);
  assert.equal(used.output.join("\n").includes(candidate), false, "no surface echoes the key");

  // A cancelled entry never calls the consumer, and says the same sentence
  // the returning seam's `null` used to produce.
  const cancelledCredentials = lifecycleCredentials(previous);
  const cancelled = lifecycleContext(
    lifecycleService(previous, "keychain"),
    cancelledCredentials.store,
    {
      withCredentialSecret: async () => "cancelled",
    } as Partial<CommandContext>,
  );

  await handleSlashCommand("/key replace", cancelled.context);

  assert.deepEqual(cancelled.output, ["Key entry cancelled; active key unchanged."]);
  assert.equal(cancelledCredentials.calls.includes("set"), false);
  assert.equal(cancelledCredentials.current(), previous);
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
    ...suppliesSecret(candidate),
    confirm: async () => {
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
  assert.match(output.join("\n"), /disconnected|offline/i);
  // FIX-14 ticket 15: the reconnect advice comes from `recheckConnectionHint`
  // — the one sentence that branches on where the key actually lives — and
  // no longer from an unbranched suffix on the `Connection:` state label.
  // A keychain key can genuinely use `/provider reconnect openrouter`.
  assert.match(output.join("\n"), /\/provider reconnect openrouter/);
  assert.equal(
    output.some((line) => line.startsWith("Connection: disconnected ")),
    false,
    "the state label states the state and gives no advice",
  );
});

test("FIX-14 ticket 15: an interactive (process-only) key is never told to run /provider reconnect openrouter", async () => {
  const key = `${KEY_PREFIX}offline-interactive-key-1234`;
  const service = new OpenRouterService(
    key,
    undefined,
    { inference: "interactive" },
    {
      clock: { sleep: async () => undefined },
      fetchImpl: async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENETUNREACH" } });
      },
    },
  );
  const credentials = lifecycleCredentials(key);
  const { context, output } = lifecycleContext(service, credentials.store);

  await handleSlashCommand("/key status", context);

  const text = output.join("\n");
  // The command that cannot see this key is named only to say it cannot.
  assert.match(text, /\/key save/);
  assert.match(text, /cannot see it/);
  assert.doesNotMatch(text, /Check it again with/);
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
    ...suppliesSecret(candidate),
    confirm: async (request: { title: string }) => {
      // FIX-14 ticket 6: the credential kind is IN the question now, not a
      // separate port argument — one seam, and the copy says which key.
      assert.match(request.title, /management key/);
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
  assert.ok(output.some((line) => /0 retries after a failed check/.test(line)), output.join("\n"));
  await assert.rejects(handleSlashCommand("/verify rounds 3", context), /between 0 and 2/);

  const saved = JSON.parse(await readFile(context.configPath!, "utf8")) as {
    verify: Record<string, unknown>;
  };
  assert.equal(saved.verify.maxRepairRounds, 0);
  assert.equal("maxRounds" in saved.verify, false);
});

// F5 pin (V3 audit principle 3): `/verify on` used to print a bare
// `chalk.green(...)` line; it now resolves its `Theme` through
// `commandTheme` and passes `theme.color("ok")` in its place. At this test
// process's level (no FORCE_COLOR/NO_COLOR, no TTY — see
// `tests/ui-theme.test.ts`'s subprocess-based parity test for why level
// can't be flipped reliably in-process, and `tests/approval.test.ts`'s
// `riskLabel` pin for a deterministic colored-level check), `ok` is
// identity, so the exact same plain text must survive the migration —
// content identical, nothing corrupted by the styling source change.
test("/verify on's confirmation line survives the chalk-to-theme migration byte for byte (F5 pin)", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "routercode-command-verify-theme-pin-"));
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

  await handleSlashCommand("/verify on", context);

  assert.deepEqual(output, ["Verify: on-edit"]);
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

test("chat open preserves an explicitly cleared provider identity instead of adopting the current default", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "routercode-command-cleared-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "project");
  const appHome = join(root, ".orcode");
  const currentRoute = {
    version: 1 as const,
    backendId: "openrouter" as const,
    accountFingerprint: "acct_command_current_cleared_111111",
    billingRealm: "openrouter-payg" as const,
    requestedModelId: "openrouter/auto",
    canonicalModelId: "openrouter/auto",
    resolutionState: "resolved" as const,
  };
  const clearedRoute = {
    version: 1 as const,
    backendId: "kimi-code" as const,
    accountFingerprint: "acct_command_kimi_cleared_222222",
    billingRealm: "kimi-code-membership-provider-managed-overage" as const,
    requestedModelId: "k3",
    canonicalModelId: "k3",
    resolutionState: "resolved" as const,
  };
  const current = SessionStore.create(workspace, appHome, "Command current default");
  current.setPreferences(currentRoute.requestedModelId, { mode: "auto" }, currentRoute);
  await current.save();
  const historical = SessionStore.create(workspace, appHome, "Command cleared Kimi");
  historical.setPreferences(clearedRoute.requestedModelId, { mode: "auto" }, clearedRoute);
  await historical.save();
  assert.equal(await historical.clearRouteIfExact(clearedRoute), true);

  const transitions: string[] = [];
  const adopted: string[] = [];
  const context = {
    workspace,
    config: { ...structuredClone(DEFAULT_CONFIG), mainModel: currentRoute.requestedModelId },
    configPath: join(appHome, "config.json"),
    session: current,
    agent: { setSession() {} },
    providerRoutes: {
      currentSessionRoute() { return structuredClone(currentRoute); },
      async transitionModel(modelId: string) { transitions.push(modelId); },
      adoptSession(next: SessionStore) { adopted.push(next.data.id); },
    },
    providerRouteSurface: "plain",
    out: { text() {}, error() {} },
  } as unknown as CommandContext;

  await handleSlashCommand(`/chat open ${historical.data.id}`, context);

  assert.deepEqual(transitions, []);
  assert.deepEqual(adopted, [historical.data.id]);
  assert.equal(context.session.data.id, historical.data.id);
  assert.equal(context.session.data.model, "k3");
  assert.equal(context.session.data.route, undefined);
  assert.equal(context.session.data.routeCleared, true);
  const reopened = await SessionStore.openById(workspace, historical.data.id, appHome);
  assert.equal(reopened.data.model, "k3");
  assert.equal(reopened.data.route, undefined);
  assert.equal(reopened.data.routeCleared, true);
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
    assert.match(rendered, /provider-managed|unknown/i, command);
    assert.doesNotMatch(rendered, /kostenlos|\$0(?:\.0+)?\b|0(?:,0+)?\s*\$/i, command);
  }
});

test("D5 invitation grammar: /chat list, /chat search, /history, /checkpoint list, and /verify now each name the one next action on a workspace with nothing in it yet", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-d5-empty-states-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "project");
  const appHome = join(root, ".orcode");
  // Deliberately never saved, and never given a turn or a checkpoint: /chat
  // list and /chat search see zero saved chats, /history sees zero turns,
  // /checkpoint list sees zero checkpoints — the fresh-workspace case.
  const session = SessionStore.create(workspace, appHome, "Fresh");
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
  const theme = createTheme();
  const emdash = theme.glyph("emdash");

  output.length = 0;
  await handleSlashCommand("/chat list", context);
  assert.deepEqual(output, [`No saved chats in this folder yet ${emdash} /new starts one.`]);

  output.length = 0;
  await handleSlashCommand("/chat search needle", context);
  assert.deepEqual(output, [`No chats matched "needle" ${emdash} /chat list shows them all.`]);

  output.length = 0;
  await handleSlashCommand("/history", context);
  assert.deepEqual(output, [`No chat history yet ${emdash} type below to start one.`]);

  output.length = 0;
  await handleSlashCommand("/checkpoint list", context);
  assert.deepEqual(output, [`No checkpoints in this chat ${emdash} /checkpoint new [name] creates one.`]);

  output.length = 0;
  await handleSlashCommand("/verify now", context);
  assert.deepEqual(output, [`No verify commands configured ${emdash} /verify <command> adds one.`]);
});

test("FIX-10 H5 (F5/F6 coverage): the one shared /clear consequence body ends by disclosing that today's budget tracking survives", () => {
  // One exported constant feeds BOTH /clear confirms (plain clearSession
  // and the fullscreen confirmAction in cli.ts) — the import graph makes
  // drift a compile error, and this pin makes the sentence itself load-bearing.
  // FIX-9 at merge: its vocabulary sweep owns the body's nouns (chat
  // history / folder); FIX-10's load-bearing final sentence survives intact.
  assert.equal(
    CLEAR_CHAT_CONFIRM_DETAILS,
    "The stored chat history and cost statistics for this folder will be deleted. Today's budget tracking is kept.",
  );
});

test("FIX-10 F3: /chat list and /chat search rows use the one shared message-count spelling (cap-marker capable), never 'N message(s)'", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-f3-chat-rows-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "project");
  const appHome = join(root, ".orcode");
  const saved = SessionStore.create(workspace, appHome, "Needle chat");
  saved.addTurn("user", "needle one");
  saved.addTurn("assistant", "needle two");
  await saved.save();
  const output: string[] = [];
  const context = {
    workspace,
    session: saved,
    config: structuredClone(DEFAULT_CONFIG),
    out: {
      text: (value: string) => output.push(value),
      error: (value: string) => output.push(value),
    },
  } as unknown as CommandContext;

  output.length = 0;
  await handleSlashCommand("/chat list", context);
  assert.ok(output.some((line) => line.includes("2 messages ·")), output.join("\n"));
  assert.ok(!output.some((line) => line.includes("message(s)")), output.join("\n"));

  output.length = 0;
  await handleSlashCommand("/chat search needle", context);
  assert.ok(output.some((line) => line.includes("2 messages ·")), output.join("\n"));
  assert.ok(!output.some((line) => line.includes("message(s)")), output.join("\n"));
});

test("D8e: /new's plain-mode confirmation is exactly one line — no title, no message count, no session id", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-d8e-new-plain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "project");
  const appHome = join(root, ".orcode");
  const previous = SessionStore.create(workspace, appHome, "Previous chat");
  previous.addTurn("user", "hello");
  await previous.save();
  const output: string[] = [];
  const context = {
    workspace,
    session: previous,
    config: structuredClone(DEFAULT_CONFIG),
    configPath: join(appHome, "config.json"),
    agent: { setSession: () => undefined },
    out: {
      text: (value: string) => output.push(value),
      error: (value: string) => output.push(value),
    },
  } as unknown as CommandContext;

  await handleSlashCommand("/new", context);

  // The exact D8e contract: this one line, nothing else — no title (a
  // custom `/new My Title` collapses to the same line), no "0 message(s)",
  // and (see the sweep below) never the fresh session's own id.
  assert.deepEqual(output, ["New chat started."]);
  assert.equal(context.session.data.turns.length, 0);
  assert.notEqual(context.session.data.id, previous.data.id);

  output.length = 0;
  await handleSlashCommand("/new A Custom Title", context);
  assert.deepEqual(output, ["New chat started."]);
});

test("D8e: a switch-confirmation into an existing chat keeps title and a humanized message count, never the raw session id", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-d8e-switch-existing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "project");
  const appHome = join(root, ".orcode");
  const current = SessionStore.create(workspace, appHome, "Current");
  await current.save();
  const target = SessionStore.create(workspace, appHome, "Target chat");
  target.addTurn("user", "one");
  target.addTurn("assistant", "two");
  target.addTurn("user", "three");
  await target.save();
  const output: string[] = [];
  const context = {
    workspace,
    session: current,
    config: structuredClone(DEFAULT_CONFIG),
    configPath: join(appHome, "config.json"),
    agent: { setSession: () => undefined },
    out: {
      text: (value: string) => output.push(value),
      error: (value: string) => output.push(value),
    },
  } as unknown as CommandContext;

  await handleSlashCommand(`/chat open ${target.data.id}`, context);

  assert.deepEqual(output, ["Chat: Target chat · 3 messages"]);
});

test("D8e: no /chat or /new confirmation leaks a raw session id (grep-style guard over real command output)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-d8e-uuid-sweep-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "project");
  const appHome = join(root, ".orcode");
  const other = SessionStore.create(workspace, appHome, "Other chat");
  other.addTurn("user", "hi");
  await other.save();
  const session = SessionStore.create(workspace, appHome, "Renamable");
  await session.save();
  const output: string[] = [];
  const context = {
    workspace,
    session,
    config: structuredClone(DEFAULT_CONFIG),
    configPath: join(appHome, "config.json"),
    agent: { setSession: () => undefined },
    out: {
      text: (value: string) => output.push(value),
      error: (value: string) => output.push(value),
    },
  } as unknown as CommandContext;
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  await handleSlashCommand("/new", context);
  await handleSlashCommand(`/chat open ${other.data.id}`, context);
  await handleSlashCommand("/chat rename Renamed", context);
  await handleSlashCommand("/chat current", context);
  await handleSlashCommand("/chat fork", context);

  for (const line of output) {
    assert.doesNotMatch(line, uuidPattern, line);
    assert.doesNotMatch(line, /\bmessage\(s\)\b/, line);
  }
  assert.ok(output.length > 0);
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
    confirm: async (request: { title: string; consequence?: string }) => {
      confirmations.push({ title: request.title, details: request.consequence ?? "" });
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
  assert.ok(output.some((line) => /permanently deleted/i.test(line)));
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
    confirm: async () => true,
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
    confirm: async () => true,
  } as unknown as CommandContext;

  await handleSlashCommand(`/chat delete ${oldId}`, context);

  assert.equal(context.session.data.id, oldId, "a failed cleanup keeps the active binding");
  assert.deepEqual(rebound, []);
  assert.match(await readFile(active.path, "utf8"), /Backup-Retry/, "the transcript remains the retry anchor");
  assert.ok(errors.some((value) => /could not be fully deleted/.test(value)));

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
    confirm: async () => true,
  } as unknown as CommandContext;

  await handleSlashCommand(`/chat delete ${oldId}`, context);

  assert.equal(context.session.data.id, oldId, "inspection failure keeps the active binding");
  assert.deepEqual(rebound, []);
  assert.match(await readFile(active.path, "utf8"), /Inspection-Retry/);
  assert.equal(await readFile(backupPath, "utf8"), "not-a-directory", "the backup remains retryable");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /could not be fully deleted/);
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

test("bare Kimi /model opens the shared provider route picker instead of printing provider IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-shared-model-picker-"));
  const output: string[] = [];
  const selected: SelectableModelRoute = {
    route: {
      version: 1,
      backendId: "kimi-code",
      accountFingerprint: "acct_kimi_picker",
      billingRealm: "kimi-code-membership-provider-managed-overage",
      requestedModelId: "k3",
      canonicalModelId: "k3",
      resolutionState: "resolved",
    },
    providerLabel: "Kimi Code",
    model: {
      id: "k3",
      name: "Kimi K3",
      contextLength: 0,
      reasoning: { mandatory: false, supportedEfforts: null, supportsMaxTokens: false },
      price: { kind: "unknown" },
    },
    supportsTools: true,
    supportsReasoning: true,
    selected: false,
  };
  const calls: string[] = [];
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = "k3-256k";
  const context = {
    config,
    configPath: join(root, "config.json"),
    openRouter: { listModels: async () => { throw new Error("OpenRouter must not be used"); } },
    session: {
      setPreferences: () => calls.push("session"),
      save: async () => calls.push("session-save"),
    },
    providerRoutes: {
      currentSessionRoute: () => ({ ...selected.route, requestedModelId: "k3-256k", canonicalModelId: "k3-256k" }),
      listSelectableModelRoutes: async (query: string) => {
        calls.push(`catalog:${query}`);
        return [selected];
      },
      transitionSessionRoute: async () => { throw new Error("cancel must not transition"); },
      readModelPreferenceAuthority: () => ({
        route: { ...selected.route, requestedModelId: "k3-256k", canonicalModelId: "k3-256k" },
        providerRevision: 7,
        connectionId: "kimi-picker-current",
      }),
      prepareSettingsModelPublication: () => ({ publish() { throw new Error("cancel must not publish"); } }),
      transitionModel: async () => { throw new Error("legacy transition must not be used"); },
    },
    modelRoutePicker: {
      pickModelRoute: async (input: { role: string; preserveDraft: boolean }) => {
        assert.equal(input.role, "main");
        assert.equal(input.preserveDraft, true);
        calls.push("picker");
        return null;
      },
    },
    out: { text: (value: string) => output.push(value), error: (value: string) => output.push(value) },
  } as unknown as CommandContext;

  await handleSlashCommand("/model", context);

  assert.deepEqual(calls, ["picker"]);
  assert.equal(context.config.mainModel, "k3-256k");
  assert.doesNotMatch(output.join("\n"), /Kimi K3.*k3/u);
});

test("typed /model never silently chooses the first matching provider account", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-shared-model-ambiguous-"));
  const firstRoute = {
    version: 1 as const,
    backendId: "openrouter" as const,
    accountFingerprint: "acct_openrouter_first",
    billingRealm: "openrouter-payg" as const,
    requestedModelId: "vendor/shared",
    canonicalModelId: "vendor/shared",
    resolutionState: "resolved" as const,
  };
  const row = (accountFingerprint: string): SelectableModelRoute => ({
    route: { ...firstRoute, accountFingerprint },
    providerLabel: "OpenRouter",
    model: {
      id: "vendor/shared",
      name: "Shared",
      contextLength: 16_000,
      reasoning: undefined,
      price: { kind: "unknown" },
    },
    supportsTools: true,
    supportsReasoning: false,
    selected: accountFingerprint === firstRoute.accountFingerprint,
  });
  const context = {
    config: { ...structuredClone(DEFAULT_CONFIG), mainModel: "vendor/shared" },
    configPath: join(root, "config.json"),
    openRouter: { listModels: async () => [] },
    session: {},
    providerRoutes: {
      currentSessionRoute: () => firstRoute,
      listSelectableModelRoutes: async () => [
        row(firstRoute.accountFingerprint),
        row("acct_openrouter_second"),
      ],
      transitionSessionRoute: async () => { throw new Error("ambiguous input must not transition"); },
      readModelPreferenceAuthority: () => ({ route: firstRoute, providerRevision: 7, connectionId: "first" }),
      prepareSettingsModelPublication: () => ({ publish() { throw new Error("ambiguous input must not publish"); } }),
      transitionModel: async () => { throw new Error("legacy transition must not be used"); },
    },
    out: { text() {}, error() {} },
  } as unknown as CommandContext;

  await assert.rejects(
    handleSlashCommand("/model vendor/shared", context),
    /mehreren|eindeutig|ambiguous/iu,
  );
  assert.equal(context.config.mainModel, "vendor/shared");
});

test("plain shared model picker preserves catalog order and highlights the exact active route", async () => {
  const first = {
    version: 1 as const,
    backendId: "openrouter" as const,
    accountFingerprint: "acct_plain_first",
    billingRealm: "openrouter-payg" as const,
    requestedModelId: "vendor/first",
    canonicalModelId: "vendor/first",
    resolutionState: "resolved" as const,
  };
  const current = {
    ...first,
    accountFingerprint: "acct_plain_current",
    requestedModelId: "vendor/current",
    canonicalModelId: "vendor/current",
  };
  const row = (route: typeof first): SelectableModelRoute => ({
    route,
    providerLabel: "OpenRouter",
    model: {
      id: route.requestedModelId,
      name: route.requestedModelId,
      contextLength: 1,
      reasoning: undefined,
      price: { kind: "unknown" },
    },
    supportsTools: true,
    supportsReasoning: false,
    selected: route.accountFingerprint === current.accountFingerprint,
  });
  const routes = Object.freeze([row(first), row(current)]);
  const selected = await pickSelectableModelRoute(routes, current, "Choose the main model", (async (config: {
    readonly initialValue?: SelectableModelRoute;
    readonly choices: (
      query: string,
    ) => Promise<readonly { value: SelectableModelRoute }[]> | readonly { value: SelectableModelRoute }[];
  }) => {
    assert.equal(config.initialValue, routes[1]);
    assert.deepEqual((await config.choices("")).map(({ value }) => value), routes);
    return config.initialValue!;
  }) as never);

  assert.equal(selected, routes[1]);
  assert.deepEqual(
    routes.map(({ route }) => route.requestedModelId),
    ["vendor/first", "vendor/current"],
  );
});

test("FIX-14 ticket 9: the caller's title reaches the plain route picker's screen, never a hardcoded 'Search models'", async () => {
  const seen: string[] = [];
  const pick = (async (config: { readonly title: string }) => {
    seen.push(config.title);
    return null;
  }) as never;
  const route = {
    providerLabel: "Vendor",
    route: { backendId: "openrouter", requestedModelId: "vendor/x", canonicalModelId: "vendor/x" },
    model: { name: "X", contextLength: 1, reasoning: undefined, price: { kind: "unknown" } },
    supportsTools: true,
    supportsReasoning: false,
    selected: false,
  } as unknown as SelectableModelRoute;

  for (const title of ["Choose the main model", "Cross · Review model · read-only", "Disambiguate vendor/x"]) {
    await pickSelectableModelRoute([route], null, title, pick);
  }
  assert.deepEqual(seen, [
    "Choose the main model",
    "Cross · Review model · read-only",
    "Disambiguate vendor/x",
  ]);
});

// Phase F3 (information-dense pickers), ruling 1: the plain-mode route
// picker's row composes the same binding `<provider> · <price> · <ctx>`
// shape as the fullscreen picker (`createTerminalModelRoutePicker`,
// `tui.ts`) — updated from the old "Cost known"/"Cost unknown/provider-
// managed" placeholder, which predates the binding mockup.
test("plain shared model picker's row shows real per-token pricing, honestly", async () => {
  const route: SelectableModelRoute = {
    route: {
      version: 1,
      backendId: "openrouter",
      accountFingerprint: "acct_priced",
      billingRealm: "openrouter-payg",
      requestedModelId: "anthropic/claude-sonnet-4-6",
      canonicalModelId: "anthropic/claude-sonnet-4-6",
      resolutionState: "resolved",
    },
    providerLabel: "Anthropic",
    model: {
      id: "anthropic/claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      contextLength: 200_000,
      reasoning: undefined,
      price: { kind: "known", promptUsdPerToken: 0.000003, completionUsdPerToken: 0.000015 },
    },
    supportsTools: true,
    supportsReasoning: true,
    selected: true,
  };
  let seenDescription = "";
  await pickSelectableModelRoute([route], route.route, "Choose the main model", (async (config: {
    readonly choices: (query: string) => Promise<readonly { description: string }[]> | readonly { description: string }[];
  }) => {
    const [choice] = await config.choices("");
    seenDescription = choice!.description;
    return null;
  }) as never);
  assert.equal(seenDescription, "Anthropic · $3/M in · $15/M out · 200K");
});

test("plain shared model picker's row shows 'subscription' for a provider-managed route, never a fabricated price", async () => {
  const route: SelectableModelRoute = {
    route: {
      version: 1,
      backendId: "kimi-code",
      accountFingerprint: "acct_kimi_plain",
      billingRealm: "kimi-code-membership-provider-managed-overage",
      requestedModelId: "k3",
      canonicalModelId: "k3",
      resolutionState: "resolved",
    },
    providerLabel: "Kimi Code",
    model: {
      id: "k3",
      name: "Kimi K3",
      contextLength: 256_000,
      reasoning: undefined,
      price: { kind: "unknown" },
    },
    supportsTools: true,
    supportsReasoning: true,
    selected: true,
  };
  let seenDescription = "";
  await pickSelectableModelRoute([route], route.route, "Choose the main model", (async (config: {
    readonly choices: (query: string) => Promise<readonly { description: string }[]> | readonly { description: string }[];
  }) => {
    const [choice] = await config.choices("");
    seenDescription = choice!.description;
    return null;
  }) as never);
  assert.equal(seenDescription, "Kimi Code · subscription · 256K");
});

test("provider-aware model selection uses the canonical config path when the command context omits it", () => {
  assert.equal(resolveModelSelectionConfigPath({}), CONFIG_PATH);
  assert.equal(
    resolveModelSelectionConfigPath({ configPath: "/tmp/orcode-explicit-config.json" }),
    "/tmp/orcode-explicit-config.json",
  );
});

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

test("D5: /models <query> with zero matches names the recovery action; with no query at all it states the honest fact instead of inventing one", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-models-empty-"));
  const theme = createTheme();

  const searched = roleCommandContext(root, async () => []);
  await handleSlashCommand("/models zzz-nichts-passt", searched.context);
  assert.deepEqual(searched.output, [
    `No tool-capable models matched "zzz-nichts-passt" ${theme.glyph("emdash")} /models with no search shows them all.`,
  ]);

  const unsearched = roleCommandContext(root, async () => []);
  await handleSlashCommand("/models", unsearched.context);
  assert.deepEqual(unsearched.output, [
    `No tool-capable models found ${theme.glyph("emdash")} check the provider connection with /provider status.`,
  ]);
});

test("D5: /models <query> on a Kimi Code backend mirrors the OpenRouter path — zero matches names the recovery action; a genuinely empty catalog stays a plain fact", async () => {
  const theme = createTheme();
  const kimiCatalog = [
    { requestedModelId: "k3", canonicalModelId: "k3", displayName: "Kimi K3" },
    { requestedModelId: "kimi-for-coding", canonicalModelId: "kimi-for-coding", displayName: "Kimi K2.7 Code" },
  ];
  const kimiContext = (models: typeof kimiCatalog): { context: CommandContext; output: string[] } => {
    const output: string[] = [];
    return {
      output,
      context: {
        providerRoutes: { currentSessionRoute: () => ({ backendId: "kimi-code" }) },
        providerCommands: {
          async execute() {
            return { kind: "models", backendId: "kimi-code", models };
          },
        },
        out: {
          text: (value: string) => output.push(value),
          error: (value: string) => output.push(value),
        },
      } as unknown as CommandContext,
    };
  };

  const searched = kimiContext(kimiCatalog);
  await handleSlashCommand("/models zzz-nichts-passt", searched.context);
  assert.deepEqual(searched.output, [
    `No Kimi Code models matched "zzz-nichts-passt" ${theme.glyph("emdash")} /models with no search shows them all.`,
  ]);

  const unsearched = kimiContext([]);
  await handleSlashCommand("/models", unsearched.context);
  assert.deepEqual(unsearched.output, ["No usable Kimi Code models available."]);
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

test("Settings panel and audio roles use distinct exact capability filters", () => {
  const textPanel = roleModel({
    id: "provider/text-panel",
    supportedParameters: [],
    inputModalities: ["text"],
    outputModalities: ["text"],
  });
  const outputOnly = roleModel({
    id: "provider/output-only",
    supportedParameters: [],
    inputModalities: ["image"],
    outputModalities: ["text"],
  });
  const audioText = roleModel({
    id: "provider/audio-text",
    supportedParameters: [],
    inputModalities: ["audio"],
    outputModalities: ["text"],
  });
  const audioImage = roleModel({
    id: "provider/audio-image",
    supportedParameters: [],
    inputModalities: ["audio"],
    outputModalities: ["image"],
  });

  assert.deepEqual(panelModelCandidates([textPanel, outputOnly, audioText]), [textPanel]);
  assert.deepEqual(audioInputModelCandidates([textPanel, audioText, audioImage]), [audioText]);
});

test("/think confirmation names the exact main model id it wrote, not only the effort", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-think-model-id-"));
  const fixture = roleCommandContext(root, async () => []);

  await handleSlashCommand("/think high", fixture.context);

  const confirmation = fixture.output.find((line) => line.includes("Thinking"));
  assert.ok(confirmation, fixture.output.join("\n"));
  assert.match(confirmation!, /provider\/initial-main/, "must name the model id it wrote, main-targeted");
  assert.match(confirmation!, /high/);
  assert.deepEqual(fixture.preferences, ["provider/initial-main"], "/think stays main-targeted");
});

interface FolderCommandFixture {
  root: string;
  workspaceA: string;
  appHome: string;
  session: SessionStore;
  lines: Array<{ level: "text" | "error"; value: string; hint?: string }>;
  context: CommandContext & {
    workspace: string;
    localRuntime: { guard: WorkspaceGuard; setSession(): void; resetConversationMemory(): void };
    crossRunActive: () => boolean;
    confirm?: CommandContext["confirm"];
    promptFolderPath?: CommandContext["promptFolderPath"];
  };
}

/**
 * `context.reRootWorkspace` delegates to the real `reRootWorkspace` core
 * (`workspace.ts`) — the exact function `runCli` wires — so `/folder`
 * exercises the real mechanics here, not a hand-rolled stand-in.
 */
async function folderCommandFixture(prefix: string): Promise<FolderCommandFixture> {
  const root = await mkdtemp(join(tmpdir(), `orcode-${prefix}-`));
  const workspaceA = join(root, "workspace-a");
  await mkdir(workspaceA, { recursive: true });
  const appHome = join(root, ".orcode");
  const session = SessionStore.create(workspaceA, appHome, "Current chat");
  session.addTurn("user", "hi");
  await session.save();
  const ruleStore = await RuleStore.load(appHome);
  const approvals = new ApprovalManager("ask");
  approvals.setRuleStore(ruleStore, workspaceA);
  const lines: FolderCommandFixture["lines"] = [];
  const out: CommandOutput = {
    text(value) { lines.push({ level: "text", value }); },
    error(value, hint) { lines.push({ level: "error", value, hint }); },
  };
  const context = {
    config: structuredClone(DEFAULT_CONFIG),
    approvals,
    openRouter: new OpenRouterService(undefined),
    session,
    agent: null,
    workspace: workspaceA,
    credentials: {
      location: "test",
      async get() { return null; },
      async set() {},
      async delete() { return false; },
      async has() { return false; },
    } as CredentialStoreLike,
    out,
    ruleStore,
    configPath: join(appHome, "config.json"),
    localRuntime: {
      guard: await WorkspaceGuard.create(workspaceA),
      setSession() {},
      resetConversationMemory() {},
    },
    crossRunActive: () => false,
    async reRootWorkspace(newWorkspace: string) {
      return reRootWorkspaceCore(
        {
          setWorkspace: (value) => { context.workspace = value; },
          setGuard: (value) => { context.localRuntime.guard = value; },
          approvals: context.approvals,
          ruleStore: context.ruleStore,
          crossRunActive: context.crossRunActive,
        },
        newWorkspace,
      );
    },
  } as unknown as FolderCommandFixture["context"];
  return { root, workspaceA, appHome, session, lines, context };
}

test("/folder open re-roots into an existing folder (Phase F1b): guard moves, a fresh chat opens there", async () => {
  const { workspaceA, appHome, lines, context } = await folderCommandFixture("folder-open");
  const workspaceB = join(workspaceA, "..", "workspace-b");
  await mkdir(workspaceB, { recursive: true });

  await handleSlashCommand(`/folder open ${workspaceB}`, context);

  assert.equal(context.workspace, workspaceB);
  assert.equal(context.localRuntime.guard.root, workspaceB);
  assert.equal(context.session.appHome, appHome);
  assert.equal(context.session.data.workspace, workspaceB);
  assert.ok(lines.some((line) => line.level === "text" && /Folder switched/.test(line.value)));
});

test("/folder new confirms, creates the directory, and re-roots (Phase F1b)", async () => {
  const { workspaceA, lines, context } = await folderCommandFixture("folder-new-confirm");
  const created = join(workspaceA, "..", "brand-new-project");
  let confirmedPath: string | undefined;
  // FIX-14 ticket 6: the exact absolute path is the confirm's CONSEQUENCE
  // now — plain mode used to inline it in the title, fullscreen already put
  // it here, and one shape survived.
  context.confirm = async (request) => {
    confirmedPath = request.consequence;
    return true;
  };

  await handleSlashCommand(`/folder new ${created}`, context);

  assert.equal(confirmedPath, created, "the confirm must show the exact absolute path before creating anything");
  const info = await stat(created);
  assert.ok(info.isDirectory());
  assert.equal(context.workspace, created);
  assert.equal(context.localRuntime.guard.root, created);
  assert.equal(context.session.data.workspace, created);
});

test("/folder new creates nothing and switches nothing when the confirm is declined", async () => {
  const { workspaceA, context } = await folderCommandFixture("folder-new-declined");
  const declined = join(workspaceA, "..", "declined-project");
  context.confirm = async () => false;

  await handleSlashCommand(`/folder new ${declined}`, context);

  await assert.rejects(stat(declined));
  assert.equal(context.workspace, workspaceA, "declining must never touch workspace state");
});

test("/folder open reports a clear error for a folder that does not exist, and never switches", async () => {
  const { workspaceA, context } = await folderCommandFixture("folder-open-missing");
  const missing = join(workspaceA, "..", "never-existed");

  await assert.rejects(handleSlashCommand(`/folder open ${missing}`, context), /does not exist/);
  assert.equal(context.workspace, workspaceA);
});

test("/folder new refuses a path that already exists, pointing at /folder open instead", async () => {
  const { workspaceA, context } = await folderCommandFixture("folder-new-exists");
  const existing = join(workspaceA, "..", "already-there");
  await mkdir(existing, { recursive: true });

  await assert.rejects(handleSlashCommand(`/folder new ${existing}`, context), /already exists/);
  assert.equal(context.workspace, workspaceA);
});

// ---------------------------------------------------------------------------
// FIX-8 (keyboard audit K7/F2.2) — bare `/folder` is a real flow, not a
// usage error. `open`/`new` above are unchanged: they only pre-fill the path
// and pin the expectation, and every test above them still passes verbatim.
// ---------------------------------------------------------------------------

test("FIX-8: bare /folder asks for a path and opens an existing folder — the F1b re-root, reached with no subcommand", async () => {
  const { workspaceA, appHome, lines, context } = await folderCommandFixture("folder-bare-open");
  const workspaceB = join(workspaceA, "..", "workspace-b-bare");
  await mkdir(workspaceB, { recursive: true });
  let confirmedCreate = false;
  context.confirm = async () => { confirmedCreate = true; return true; };
  context.promptFolderPath = async () => workspaceB;

  await handleSlashCommand("/folder", context);

  assert.equal(confirmedCreate, false, "an existing folder opens; it must never reach the create confirm");
  assert.equal(context.workspace, workspaceB);
  assert.equal(context.localRuntime.guard.root, workspaceB);
  assert.equal(context.session.appHome, appHome);
  assert.equal(context.session.data.workspace, workspaceB);
  assert.ok(
    lines.some((line) => line.level === "text" && /Folder switched/.test(line.value)),
    "the re-root must announce itself with FIX-9's one folder vocabulary",
  );
  assert.ok(
    !lines.some((line) => line.level === "error"),
    `the pre-FIX-8 defect was that this returned an error: ${JSON.stringify(lines)}`,
  );
});

test("FIX-8: a path bare /folder cannot find goes through the existing create-confirm flow, then re-roots", async () => {
  const { workspaceA, context } = await folderCommandFixture("folder-bare-create");
  const created = join(workspaceA, "..", "bare-new-project");
  let confirmedPath: string | undefined;
  context.confirm = async (request) => {
    confirmedPath = request.consequence;
    return true;
  };
  context.promptFolderPath = async () => created;

  await handleSlashCommand("/folder", context);

  assert.equal(confirmedPath, created, "the D4 confirm must show the exact absolute path before creating anything");
  assert.ok((await stat(created)).isDirectory());
  assert.equal(context.workspace, created);
  assert.equal(context.localRuntime.guard.root, created);
  assert.equal(context.session.data.workspace, created);
});

test("FIX-8: cancelling bare /folder's path prompt mutates nothing and says so — no error, no create, no switch", async () => {
  const { workspaceA, session, lines, context } = await folderCommandFixture("folder-bare-cancel");
  let confirmReached = false;
  context.confirm = async () => { confirmReached = true; return true; };
  // `ui.readPath` resolves null for Esc, Ctrl+C, and a shutdown alike.
  context.promptFolderPath = async () => null;

  await handleSlashCommand("/folder", context);

  assert.equal(confirmReached, false, "a cancelled prompt must never reach the create confirm");
  assert.equal(context.workspace, workspaceA);
  assert.equal(context.localRuntime.guard.root, workspaceA);
  assert.equal(context.session, session, "the chat must not be replaced");
  assert.ok(lines.some((line) => line.level === "text" && /Folder unchanged/.test(line.value)));
  assert.ok(
    !lines.some((line) => line.level === "error"),
    `an honest cancel is not an error: ${JSON.stringify(lines)}`,
  );
});

test("FIX-8 end-to-end: the hub's Folder quick action submits a command that lands in the path prompt and re-roots", async () => {
  const { workspaceA, lines, context } = await folderCommandFixture("folder-quick-action");
  const workspaceB = join(workspaceA, "..", "workspace-b-quick");
  await mkdir(workspaceB, { recursive: true });
  // The exact string the hub row types into the composer and submits
  // (`#runQuickAction`, tui.ts) — bound to the row itself, never re-typed.
  const folderAction = WORKBENCH_QUICK_ACTIONS.find((entry) => entry.label === "Folder");
  assert.ok(folderAction, "the hub must still carry a Folder quick action");
  let asked: { label: string; description: string } | undefined;
  context.promptFolderPath = async (request) => {
    asked = request;
    return workspaceB;
  };

  await handleSlashCommand(folderAction!.command, context);

  assert.ok(asked, "the quick action must land in the path prompt, not a usage error");
  assert.ok(
    asked!.description.includes(abbreviateHome(workspaceA, homedir())),
    `the prompt must show the folder it is changing away from: ${asked!.description}`,
  );
  assert.match(asked!.description, /~/, "the copy must name ~ expansion — there is no path completion yet");
  assert.equal(context.workspace, workspaceB);
  assert.ok(
    lines.some((line) => line.level === "text" && /Folder switched/.test(line.value)),
    "the re-root must announce itself with FIX-9's one folder vocabulary",
  );
  assert.ok(
    !lines.some((line) => line.level === "error"),
    `one of the four first-screen actions must not return an error: ${JSON.stringify(lines)}`,
  );
});

test("/folder is blocked while a Cross run is active — the boundary applies to /folder too", async () => {
  const { workspaceA, lines, context } = await folderCommandFixture("folder-run-active");
  context.crossRunActive = () => true;
  const workspaceB = join(workspaceA, "..", "workspace-b-busy");
  await mkdir(workspaceB, { recursive: true });

  await handleSlashCommand(`/folder open ${workspaceB}`, context);

  assert.equal(context.workspace, workspaceA, "an active Cross run must block the switch outright");
  assert.ok(lines.some((line) => line.level === "error" && /Cross is already running/.test(line.value)));
});

// ---------------------------------------------------------------------------
// Phase 10 — /cross off and the Kimi route-switch disarm hook
// ---------------------------------------------------------------------------

function crossModeTestRoute(model: string): RouteIdentityV1Fixture {
  return {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: `acct-${model}`,
    billingRealm: "openrouter-payg",
    requestedModelId: model,
    canonicalModelId: model,
    resolutionState: "resolved",
  };
}

interface RouteIdentityV1Fixture {
  version: 1;
  backendId: "openrouter" | "kimi-code";
  accountFingerprint: string;
  billingRealm: string;
  requestedModelId: string;
  canonicalModelId: string;
  resolutionState: "resolved";
}

test("/cross off disarms an armed chat immediately, with no confirmation", async () => {
  const { context, lines } = await folderCommandFixture("cross-off-armed");
  const lead = crossModeTestRoute("vendor/lead");
  const challenger = crossModeTestRoute("vendor/challenger");
  context.session.armCrossMode({ lead: lead as never, challenger: challenger as never });
  await context.session.save();

  await handleSlashCommand("/cross off", context);

  assert.equal(context.session.data.crossMode, undefined);
  assert.ok(
    lines.some((line) => line.level === "text" && line.value === "Cross mode off — next message runs single-model."),
    lines.map((line) => line.value).join("\n"),
  );
});

test("/cross off also clears a PENDING one-shot (fix round 1, owner's final ruling) — not just persistent keep-active mode", async () => {
  const { context } = await folderCommandFixture("cross-off-pending-oneshot");
  const lead = crossModeTestRoute("vendor/lead");
  const challenger = crossModeTestRoute("vendor/challenger");
  context.session.armCrossMode({ lead: lead as never, challenger: challenger as never, oneShot: true });
  await context.session.save();

  await handleSlashCommand("/cross off", context);

  assert.equal(context.session.data.crossMode, undefined, "a pending one-shot must be fully disarmed by /cross off too");
});

test("/cross off's disarm survives a reload", async () => {
  const { context, workspaceA, appHome } = await folderCommandFixture("cross-off-persist");
  const lead = crossModeTestRoute("vendor/lead");
  const challenger = crossModeTestRoute("vendor/challenger");
  context.session.armCrossMode({ lead: lead as never, challenger: challenger as never });
  await context.session.save();

  await handleSlashCommand("/cross off", context);

  const reopened = await SessionStore.openById(workspaceA, context.session.data.id, appHome);
  assert.equal(reopened.data.crossMode, undefined);
});

test("/cross off on an already-disarmed chat reports it without needing the Cross runtime port at all", async () => {
  const { context, lines } = await folderCommandFixture("cross-off-already");

  // No `context.cross` was ever wired by this fixture — /cross off must not
  // need it for the already-off case (requireCrossCommandPort would throw).
  await handleSlashCommand("/cross off", context);

  assert.ok(lines.some((line) => line.level === "text" && line.value === "Cross mode is already off."));
});

test("/cross off is allowed even while a Cross run is active (the run-active allowlist includes it)", async () => {
  const { context } = await folderCommandFixture("cross-off-run-active");
  const lead = crossModeTestRoute("vendor/lead");
  const challenger = crossModeTestRoute("vendor/challenger");
  context.session.armCrossMode({ lead: lead as never, challenger: challenger as never });
  await context.session.save();
  context.crossRunActive = () => true;

  await handleSlashCommand("/cross off", context);

  assert.equal(context.session.data.crossMode, undefined, "off must take effect even mid-run");
});

test("Kimi preference notice is derived purely from the exact armed snapshot", () => {
  const openrouterRoute = crossModeTestRoute("vendor/main");
  const otherOpenrouterRoute = crossModeTestRoute("vendor/other-main");
  const kimiRoute: RouteIdentityV1Fixture = {
    version: 1,
    backendId: "kimi-code",
    accountFingerprint: "acct-kimi",
    billingRealm: "kimi-code-membership-provider-managed-overage",
    requestedModelId: "k3",
    canonicalModelId: "k3",
    resolutionState: "resolved",
  };

  // Armed, switching TO Kimi: returns the exact honest notice without a
  // second mutation or save seam.
  {
    const crossMode: unknown = { lead: openrouterRoute, challenger: openrouterRoute };
    const snapshot = { crossMode };
    const notice = kimiCrossDisarmNoticeForPreference(snapshot, kimiRoute as never);
    assert.equal(
      notice,
      "Cross mode off — Kimi Code routes do not support Cross; next message runs single-model.",
    );
    assert.deepEqual(snapshot.crossMode, crossMode);
  }

  // Armed, switching to a DIFFERENT OpenRouter model (not Kimi): no-op —
  // the main model can change freely without touching the armed pair.
  {
    const crossMode: unknown = { lead: openrouterRoute, challenger: openrouterRoute };
    const notice = kimiCrossDisarmNoticeForPreference({ crossMode }, otherOpenrouterRoute as never);
    assert.equal(notice, null);
    assert.deepEqual(crossMode, { lead: openrouterRoute, challenger: openrouterRoute });
  }

  // Not armed at all, switching to Kimi: nothing to disarm, no-op.
  {
    const notice = kimiCrossDisarmNoticeForPreference({ crossMode: undefined }, kimiRoute as never);
    assert.equal(notice, null);
  }
});

test("/folder never carries approval rules across a re-root", async () => {
  const { workspaceA, context } = await folderCommandFixture("folder-rules-boundary");
  const subject = { kind: "selected-path" as const, path: join(workspaceA, "secret.txt") };
  await context.ruleStore.remember({ workspace: workspaceA, tool: "write_file", subject, decision: "allow" });
  let prompted = 0;
  context.approvals.setPromptHandler(async () => {
    prompted += 1;
    return { accepted: false };
  });
  await assert.doesNotReject(context.approvals.authorize({
    name: "write_file", risk: "edit", summary: "write secret.txt", subject, rememberable: true,
  }));
  assert.equal(prompted, 0);

  const workspaceB = join(workspaceA, "..", "workspace-b-rules");
  await mkdir(workspaceB, { recursive: true });
  await handleSlashCommand(`/folder open ${workspaceB}`, context);

  await assert.rejects(context.approvals.authorize({
    name: "write_file", risk: "edit", summary: "write secret.txt", subject, rememberable: true,
  }));
  assert.equal(prompted, 1, "the same subject/tool must ask again once rooted in a different workspace");
});

// ---------------------------------------------------------------------------
// Fix round 1, IMPORTANT 3: composed end-to-end coverage of the plain bare
// /chats picker, driven with fake TTY-shaped io through a real foreign pick.
// ---------------------------------------------------------------------------

class FakeChatInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  setRawMode(value: boolean): this {
    this.isRaw = value;
    return this;
  }
  resume(): this { return this; }
  pause(): this { return this; }
}

class FakeChatOutput extends EventEmitter {
  isTTY = true;
  columns = 100;
  output = "";
  write(value: string): boolean {
    this.output += value;
    return true;
  }
}

function pressChatKey(stdin: FakeChatInput, name: string, character = ""): void {
  stdin.emit("keypress", character, { name, ctrl: false, meta: false });
}

/** Flushes pending microtasks (`pickFromListPlain`'s own `resolveChoices` await included). */
async function flushChatPicker(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Waits until the picker has actually attached its keypress listener.
 * `chatCommand`'s bare branch awaits real disk I/O (`listChatsAcrossWorkspaces`)
 * *before* ever calling `pickFromListPlain` — a single microtask flush is not
 * enough to guarantee the picker exists yet, and a keypress fired too early
 * lands on a still-unattached emitter and is lost outright.
 */
async function waitForChatPickerReady(stdin: FakeChatInput, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (stdin.listenerCount("keypress") === 0) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the bare /chats picker to attach its keypress listener");
    }
    await flushChatPicker();
  }
}

interface BareChatPickerFixture {
  root: string;
  workspaceA: string;
  workspaceB: string;
  appHome: string;
  current: SessionStore;
  foreign: SessionStore;
  stdin: FakeChatInput;
  stdout: FakeChatOutput;
  context: CommandContext & {
    workspace: string;
    localRuntime: { guard: WorkspaceGuard; setSession(): void; resetConversationMemory(): void };
    crossRunActive: () => boolean;
  };
}

/**
 * Two real workspaces sharing one app-home, wired with a fake TTY-shaped
 * `PlainListIo` (`context.chatPickerIo`) so the bare `/chats` picker's real
 * interactive engine (`pickFromListPlain`) can be driven with real keypresses
 * — the "hard requirement" composed test the plan's PTY-smoke item asks for,
 * on the plain-mode surface that has no fullscreen `TerminalUi` to attach a
 * real-TTY-shaped harness to instead.
 */
async function bareChatPickerFixture(prefix: string): Promise<BareChatPickerFixture> {
  const root = await mkdtemp(join(tmpdir(), `orcode-${prefix}-`));
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  await mkdir(workspaceA, { recursive: true });
  await mkdir(workspaceB, { recursive: true });
  const appHome = join(root, ".orcode");
  const current = SessionStore.create(workspaceA, appHome, "Current chat");
  current.addTurn("user", "current turn");
  await current.save();
  const foreign = SessionStore.create(workspaceB, appHome, "Foreign chat");
  foreign.addTurn("user", "foreign turn");
  await foreign.save();
  const ruleStore = await RuleStore.load(appHome);
  const approvals = new ApprovalManager("ask");
  approvals.setRuleStore(ruleStore, workspaceA);
  const stdin = new FakeChatInput();
  const stdout = new FakeChatOutput();
  const io: PlainListIo = {
    input: stdin as unknown as PlainListIo["input"],
    output: stdout as unknown as PlainListIo["output"],
  };
  const lines: Array<{ level: "text" | "error"; value: string }> = [];
  const out: CommandOutput = {
    text(value) { lines.push({ level: "text", value }); },
    error(value) { lines.push({ level: "error", value }); },
  };
  const context = {
    config: structuredClone(DEFAULT_CONFIG),
    approvals,
    openRouter: new OpenRouterService(undefined),
    session: current,
    agent: null,
    workspace: workspaceA,
    credentials: {
      location: "test",
      async get() { return null; },
      async set() {},
      async delete() { return false; },
      async has() { return false; },
    } as CredentialStoreLike,
    out,
    ruleStore,
    configPath: join(appHome, "config.json"),
    localRuntime: {
      guard: await WorkspaceGuard.create(workspaceA),
      setSession() {},
      resetConversationMemory() {},
    },
    crossRunActive: () => false,
    chatPickerIo: io,
    async reRootWorkspace(newWorkspace: string) {
      return reRootWorkspaceCore(
        {
          setWorkspace: (value) => { context.workspace = value; },
          setGuard: (value) => { context.localRuntime.guard = value; },
          approvals: context.approvals,
          ruleStore: context.ruleStore,
          crossRunActive: context.crossRunActive,
        },
        newWorkspace,
      );
    },
  } as unknown as BareChatPickerFixture["context"];
  return { root, workspaceA, workspaceB, appHome, current, foreign, stdin, stdout, context };
}

test("composed end-to-end: the plain bare /chats picker re-roots into a foreign chat's folder (Fix round 1, IMPORTANT 3)", async () => {
  const { workspaceA, workspaceB, foreign, stdin, context } = await bareChatPickerFixture("bare-chats-e2e");

  // A confirmed subject-specific approval in workspace A: some tool remains
  // silently allowed there until the runtime actually moves away from it.
  const subject = { kind: "selected-path" as const, path: join(workspaceA, "secret.txt") };
  await context.ruleStore.remember({ workspace: workspaceA, tool: "write_file", subject, decision: "allow" });
  let prompted = 0;
  context.approvals.setPromptHandler(async () => {
    prompted += 1;
    return { accepted: false };
  });
  await assert.doesNotReject(context.approvals.authorize({
    name: "write_file", risk: "edit", summary: "write secret.txt", subject, rememberable: true,
  }));
  assert.equal(prompted, 0);

  const finished = handleSlashCommand("/chats", context);
  await waitForChatPickerReady(stdin);
  // Layout: [0] New Chat, [1] "Current folder" heading (skipped), [2] Current
  // chat, [3] "Other folders" heading (skipped), [4] Foreign chat — two Down
  // presses land squarely on it, proving the real stepSelectableListIndex
  // navigation (not a mocked picker) skips both headings in one step each.
  pressChatKey(stdin, "down");
  pressChatKey(stdin, "down");
  await flushChatPicker();
  pressChatKey(stdin, "return");
  await finished;

  assert.equal(context.workspace, workspaceB, "the policy root must move to the foreign folder");
  assert.equal(context.localRuntime.guard.root, workspaceB, "the WorkspaceGuard must be re-created against the foreign folder");
  assert.equal(context.session.data.id, foreign.data.id);

  // Boundaries: approval rules never travel across a re-root — the exact
  // same subject/tool must now ask again under workspace B.
  await assert.rejects(context.approvals.authorize({
    name: "write_file", risk: "edit", summary: "write secret.txt", subject, rememberable: true,
  }));
  assert.equal(prompted, 1, "the rule must not apply once the runtime is rooted in a different workspace");
});

/** A chat file recorded under the wrong hash directory — Controller ruling 5's corruption/tamper signal. */
async function writeUnverifiedChat(appHome: string, id: string, title: string): Promise<void> {
  const foreignHashDir = join(appHome, "chats", "0123456789abcdef");
  await mkdir(foreignHashDir, { recursive: true });
  await writeFile(
    join(foreignHashDir, `${id}.json`),
    JSON.stringify({
      version: 2,
      id,
      title,
      workspace: "/some/other/path/entirely",
      summary: "",
      turns: [],
      costs: { mainUsd: 0, compressorUsd: 0, voiceUsd: 0, totalUsd: 0 },
      revision: 0,
      checkpoints: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
    "utf8",
  );
}

test("Fix round 1, MINOR 7 (plain): an unverified chat's row reads 'unknown folder', and picking it never re-roots", async () => {
  // A minimal, deterministic fixture: only the current chat plus one
  // unverified one — no separate valid-foreign chat to complicate the
  // navigation math.
  const root = await mkdtemp(join(tmpdir(), "orcode-bare-chats-unverified-"));
  const workspaceA = join(root, "workspace-a");
  await mkdir(workspaceA, { recursive: true });
  const appHome = join(root, ".orcode");
  const current = SessionStore.create(workspaceA, appHome, "Current chat");
  current.addTurn("user", "current turn");
  await current.save();
  await writeUnverifiedChat(appHome, "chat-corrupt-0000001", "Corrupt chat");
  const ruleStore = await RuleStore.load(appHome);
  const approvals = new ApprovalManager("ask");
  approvals.setRuleStore(ruleStore, workspaceA);
  const stdin = new FakeChatInput();
  const stdout = new FakeChatOutput();
  const io: PlainListIo = {
    input: stdin as unknown as PlainListIo["input"],
    output: stdout as unknown as PlainListIo["output"],
  };
  const lines: Array<{ level: "text" | "error"; value: string }> = [];
  const out: CommandOutput = {
    text(value) { lines.push({ level: "text", value }); },
    error(value) { lines.push({ level: "error", value }); },
  };
  const context = {
    config: structuredClone(DEFAULT_CONFIG),
    approvals,
    openRouter: new OpenRouterService(undefined),
    session: current,
    agent: null,
    workspace: workspaceA,
    credentials: {
      location: "test",
      async get() { return null; },
      async set() {},
      async delete() { return false; },
      async has() { return false; },
    } as CredentialStoreLike,
    out,
    ruleStore,
    configPath: join(appHome, "config.json"),
    localRuntime: { guard: await WorkspaceGuard.create(workspaceA), setSession() {}, resetConversationMemory() {} },
    crossRunActive: () => false,
    chatPickerIo: io,
  } as unknown as CommandContext;

  const finished = handleSlashCommand("/chats", context);
  await waitForChatPickerReady(stdin);
  // Layout: [0] New Chat, [1] "Current folder" heading (skipped), [2] Current
  // chat, [3] "Other folders" heading (skipped), [4] Corrupt chat.
  pressChatKey(stdin, "down");
  pressChatKey(stdin, "down");
  await flushChatPicker();
  assert.match(stdout.output, /unknown folder/, "the unverified chat's row must read 'unknown folder', honestly");
  pressChatKey(stdin, "return");
  await finished;

  assert.equal(context.workspace, workspaceA, "an unverified chat can never re-root — there is no folder to trust");
  assert.ok(lines.some((line) => line.level === "error" && /has no folder orcode can trust/.test(line.value)));
});

/**
 * FIX-20, finding 7: every `/new` used to write a permanent chat file the
 * moment it was created, so pressing it repeatedly left one dead "New Chat"
 * on disk per press. `SessionStore.create()` is lazy by design and both
 * interactive loops' exit-time saves already honour that through
 * `isUntouched`; `replaceSession`'s eager save was the one place that did
 * not. The existing ghost filter is a display guard — it hides them from
 * listings, it does not stop them accumulating.
 */
test("/new persists nothing until the chat is actually touched, and repeated /new leaves no ghosts", async () => {
  const root = await mkdtemp(join(tmpdir(), "routercode-new-ghost-"));
  const workspace = join(root, "project");
  const appHome = join(root, ".orcode");
  const start = SessionStore.create(workspace, appHome);
  await start.save();
  const output: string[] = [];
  const context = {
    workspace,
    session: start,
    config: { ...DEFAULT_CONFIG },
    configPath: join(root, "config.json"),
    agent: { setSession: () => undefined },
    out: { text: (value: string) => output.push(value), error: (value: string) => output.push(value) },
  } as unknown as CommandContext;

  try {
    for (let index = 0; index < 3; index += 1) {
      await handleSlashCommand("/new", context);
    }
    assert.deepEqual(
      (await SessionStore.list(workspace, appHome)).map((chat) => chat.id),
      [start.data.id],
      "three untouched /new chats must not leave three files behind",
    );
    assert.ok(output.some((line) => /New chat started/.test(line)), output.join("\n"));

    // The moment the chat has real content, it persists in full — the
    // laziness is a delay, never a loss.
    context.session.addTurn("user", "now it has something in it");
    await context.session.save();
    assert.equal(
      (await SessionStore.list(workspace, appHome)).length,
      2,
      "a touched chat is written like any other",
    );

    // A deliberately named chat is not untouched, so it persists at once.
    await handleSlashCommand("/new Release notes", context);
    assert.ok(
      (await SessionStore.list(workspace, appHome)).some((chat) => chat.title === "Release notes"),
      "an explicitly titled /new is a deliberate act and is written immediately",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
