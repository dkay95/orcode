import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  BackendRegistry,
  type BackendModelDescriptor,
  type CandidateProviderState,
  type ProviderCandidate,
  type RouteIdentityV1,
} from "../src/backends.js";
import {
  DEFAULT_CONFIG,
  saveConfig,
  type OrcodeConfigWithBudget,
} from "../src/config.js";
import type {
  CredentialKind,
  CredentialSlotRef,
  VersionedCredentialStoreLike,
} from "../src/credentials.js";
import {
  OPENROUTER_DESCRIPTOR,
  OpenRouterBackendAdapter,
  openRouterAccountFingerprint,
} from "../src/openrouter-backend.js";
import { KimiCodeBackendAdapter } from "../src/kimi-code-backend.js";
import {
  KimiCodeService,
  kimiCodeAccountFingerprint,
} from "../src/kimi-code.js";
import { OpenRouterService } from "../src/openrouter.js";
import {
  ProviderActivationCoordinator,
  type ProviderActivationBoundary,
} from "../src/provider-activation.js";
import { PrivateStore } from "../src/private-store.js";
import {
  ProviderStateStore,
  type ProviderSetupStateV2,
} from "../src/provider-state.js";
import { scanForSecrets } from "../src/redaction.js";
import { SetupOrchestrator, type SetupEvent } from "../src/setup.js";
import {
  runSetupHub,
  type SetupPresentation,
  type SetupSurface,
} from "../src/setup-ui.js";

interface ProviderPtyBuild {
  buildRoot: string;
  moduleRoot: string;
  cleanup(): Promise<void>;
}

interface ProviderPtyHarnessModule {
  buildFreshProviderSetupModules(projectRoot: string): Promise<ProviderPtyBuild>;
  runProviderSetupPtyScenario(options: {
    platform?: string;
    projectRoot: string;
    moduleRoot: string;
    scenario: string;
  }): Promise<{ outputBase64: string }>;
  syntheticProviderCredential(): string;
  syntheticProviderCredentialFragments(): readonly string[];
  containsPrivateHomeForProof(value: string): boolean;
}

interface PrivacyProbes {
  credential: string;
  uniqueCredentialBody: string;
  creatorId: string;
  providerBody: string;
  fragments: readonly string[];
}

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_ROOT = join(PROJECT_ROOT, "tests", "fixtures", "app-home-v0");
const PROVIDER_HARNESS = join(
  PROJECT_ROOT,
  "tests",
  "fixtures",
  "provider-setup-pty-harness.mjs",
);
const HARNESS_MODULE = "./fixtures/provider-setup-pty-harness.mjs";

function probes(credential: string): PrivacyProbes {
  const creatorId = ["creator", "task", "ten", "opaque", "value"].join("-");
  const providerBody = ["provider", "response", "body", "task", "ten", "private"].join("-");
  return {
    credential,
    uniqueCredentialBody: ["task-ten-alpha", "task-ten-beta", "task-ten-gamma"].join("-"),
    creatorId,
    providerBody,
    fragments: Object.freeze([
      credential.slice(0, 24),
      credential.slice(-24),
      credential.slice(10, 34),
      creatorId.slice(0, 18),
      creatorId.slice(-18),
      providerBody.slice(0, 20),
      providerBody.slice(-20),
    ]),
  };
}

function privateHomeForms(): string[] {
  const slash = "/";
  const unixUser = ["", "Users", "private-person", "project"].join(slash);
  const linuxUser = ["", "home", "private-person", "project"].join(slash);
  const rootUser = ["", "root", "project"].join(slash);
  const windowsUser = ["C:", "Users", "private-person", "project"].join("\\");
  const windowsFileUrl = `file:///${windowsUser}`;
  return [
    unixUser,
    linuxUser,
    rootUser,
    windowsUser,
    windowsUser.replaceAll("\\", slash),
    `file://${unixUser}`,
    `file:///${windowsUser.replaceAll("\\", slash)}`,
    JSON.stringify(windowsUser),
    JSON.stringify({ home: windowsUser }),
    JSON.stringify(windowsFileUrl),
  ];
}

function containsPrivateHome(value: string): boolean {
  const usersDirectory = ["Us", "ers"].join("");
  const homeDirectory = ["ho", "me"].join("");
  const rootDirectory = ["ro", "ot"].join("");
  return [
    new RegExp(`(?:^|[^A-Za-z0-9_])(?:file:\\/\\/)?\\/${usersDirectory}\\/[^/\\s]+(?:\\/|\\b)`, "i"),
    new RegExp(`(?:^|[^A-Za-z0-9_])(?:file:\\/\\/)?\\/${homeDirectory}\\/[^/\\s]+(?:\\/|\\b)`, "i"),
    new RegExp(`(?:^|[^A-Za-z0-9_])(?:file:\\/\\/)?\\/${rootDirectory}(?:\\/|\\b)`, "i"),
    new RegExp(`(?:^|[^A-Za-z0-9_])(?:file:\\/\\/\\/)?[A-Za-z]:[\\\\/]+${usersDirectory}[\\\\/]+[^\\\\/\\s]+(?:[\\\\/]+|\\b)`, "i"),
  ].some((pattern) => pattern.test(value));
}

test("serialized Windows private homes fail provider privacy scanning", async () => {
  const harness = await import(HARNESS_MODULE) as ProviderPtyHarnessModule;
  const credential = harness.syntheticProviderCredential();
  const values = probes(credential);
  const dirtySerialized = privateHomeForms().slice(-3);
  assert.equal(dirtySerialized.length, 3);
  for (const dirty of dirtySerialized) {
    assert.equal(containsPrivateHome(dirty), true);
    assert.equal(harness.containsPrivateHomeForProof(dirty), true);
    assert.throws(
      () => assertProviderPrivate(dirty, values),
      /provider-privacy-private-home-detected/,
    );
  }
});

function assertProviderPrivate(value: string, values: PrivacyProbes): void {
  if (scanForSecrets(value).length > 0) {
    throw new Error("provider-privacy-secret-detected");
  }
  if (
    value.includes(values.credential)
    || value.includes(values.uniqueCredentialBody)
    || value.includes(values.creatorId)
    || value.includes(values.providerBody)
    || values.fragments.some((fragment) => value.includes(fragment))
  ) {
    throw new Error("provider-privacy-exact-probe-detected");
  }
  if (containsPrivateHome(value)) {
    throw new Error("provider-privacy-private-home-detected");
  }
}

async function sortedRegularFiles(root: string): Promise<Array<{ path: string; bytes: string }>> {
  const files: Array<{ path: string; bytes: string }> = [];
  async function visit(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        files.push({
          path: relative(root, path).replaceAll("\\", "/"),
          bytes: await readFile(path, "utf8"),
        });
      }
    }
  }
  await visit(root);
  return files;
}

async function sortedRegularFilesIfPresent(
  root: string,
): Promise<Array<{ path: string; bytes: string }>> {
  try {
    return await sortedRegularFiles(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function providerHealth(generation: number) {
  return {
    credential: "valid" as const,
    connectivity: "connected" as const,
    spend: "available" as const,
    runtime: "not-applicable" as const,
    observedAt: 1_000,
    generation,
  };
}

async function crashAndRecoverRealActivation(
  appHome: string,
  values: PrivacyProbes,
): Promise<string> {
  const configPath = join(appHome, "config.json");
  const connectionId = "privacy-openrouter-connection";
  const accountFingerprint = "acct_or_privacy_activation_safe";
  const slot: CredentialSlotRef = Object.freeze({
    version: 1,
    kind: "inference",
    id: "v1:inference:10000000-0000-4000-8000-000000000010",
  });
  const route: RouteIdentityV1 = {
    version: 1,
    backendId: "openrouter",
    accountFingerprint,
    billingRealm: "openrouter-payg",
    requestedModelId: "synthetic/privacy-requested",
    canonicalModelId: "synthetic/privacy-canonical",
    resolutionState: "resolved",
  };
  const model: BackendModelDescriptor = {
    backendId: "openrouter",
    requestedModelId: route.requestedModelId,
    canonicalModelId: route.canonicalModelId!,
    displayName: "Privacy model",
    capabilities: {
      textInput: true,
      textOutput: true,
      tools: true,
      reasoning: true,
    },
  };
  const initialState: ProviderSetupStateV2 = {
    schemaVersion: 2,
    revision: 3,
    lifecycle: "never-configured",
    connections: [],
    defaultRoute: null,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  await saveConfig({
    ...structuredClone(DEFAULT_CONFIG),
    providerSetup: initialState,
  } satisfies OrcodeConfigWithBudget, configPath);

  const slots = new Map<string, string>();
  let reserved = false;
  const credentials: VersionedCredentialStoreLike = {
    location: "privacy-memory-store",
    reserveSlot(kind: CredentialKind) {
      assert.equal(kind, "inference");
      assert.equal(reserved, false);
      reserved = true;
      return slot;
    },
    async writeSlot(ref, secret) {
      assert.equal(ref, slot);
      slots.set(ref.id, secret);
    },
    async readSlot(ref) {
      return slots.get(ref.id) ?? null;
    },
    async deleteSlot(ref) {
      return slots.delete(ref.id);
    },
    async get() {
      return null;
    },
    async set() {},
    async delete() {
      return false;
    },
    async has() {
      return false;
    },
    async getOrCreateAccountHmacKey() {
      return new Uint8Array(32).fill(9);
    },
  };
  let candidateCount = 0;
  const candidates = new Map<string, string>();
  const adapter = {
    backendId: "openrouter" as const,
    async connect(request: {
      candidate: unknown;
      generation: number;
      signal: AbortSignal;
    }): Promise<ProviderCandidate> {
      assert.equal(request.signal.aborted, false);
      if (typeof request.candidate !== "string") {
        throw new Error("privacy-activation-candidate-invalid");
      }
      const candidateId = `privacy-candidate-${++candidateCount}`;
      candidates.set(candidateId, request.candidate);
      return {
        candidateId,
        backendId: "openrouter",
        connectionId,
        accountFingerprint,
        billingRealm: "openrouter-payg",
        health: providerHealth(request.generation),
      };
    },
    async listModels(request: {
      candidateId?: string;
      signal: AbortSignal;
    }): Promise<readonly BackendModelDescriptor[]> {
      assert.equal(request.signal.aborted, false);
      assert.equal(candidates.has(request.candidateId ?? ""), true);
      return [model];
    },
    async activate(request: {
      candidateId: string;
      model: BackendModelDescriptor;
      signal: AbortSignal;
    }): Promise<CandidateProviderState> {
      assert.equal(request.signal.aborted, false);
      assert.equal(candidates.has(request.candidateId), true);
      assert.equal(request.model.canonicalModelId, model.canonicalModelId);
      return {
        candidateId: request.candidateId,
        backendId: "openrouter",
        connectionId,
        accountFingerprint,
        billingRealm: "openrouter-payg",
        route,
      };
    },
    async discardCandidate(candidateId: string) {
      candidates.delete(candidateId);
    },
  };
  const stateStore = new ProviderStateStore(initialState);
  const privateStore = new PrivateStore({ root: appHome });
  let now = 1_000;
  let uuidCounter = 20;
  const makeCoordinator = (crashBoundary: ProviderActivationBoundary | null) =>
    new ProviderActivationCoordinator({
      appHome,
      configPath,
      privateStore,
      credentials,
      adapterResolver: () => adapter,
      stateStore,
      runtimeGuard: {
        async acquire() {
          let held = true;
          return {
            assertHeld() {
              if (!held) throw new Error("privacy-runtime-lease-lost");
            },
            async release() {
              held = false;
            },
          };
        },
      },
      now: () => now,
      createUuid: () => {
        uuidCounter += 1;
        return `10000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
      },
      leaseDurationMs: 100,
      waitForLease: async () => new Promise<void>((resolve) => setImmediate(resolve)),
      onBoundary: crashBoundary
        ? async (boundary) => {
          if (boundary === crashBoundary) {
            throw new Error(`privacy-simulated-crash:${boundary}`);
          }
        }
        : async () => undefined,
    });

  await assert.rejects(
    makeCoordinator("config-readback").activate({
      backendId: "openrouter",
      expectedRevision: initialState.revision,
      candidate: values.credential,
      expectedRequestedModelId: model.requestedModelId,
      selectedCanonicalModelId: model.canonicalModelId,
      generation: 4,
      signal: new AbortController().signal,
      deadlineAt: Number.MAX_SAFE_INTEGER,
      persistence: "persisted",
    }),
    /privacy-simulated-crash:config-readback/,
  );

  const activationRoot = join(appHome, "provider-activation");
  const beforeRecovery = await sortedRegularFiles(activationRoot);
  const manifests = beforeRecovery.filter((artifact) => artifact.path.endsWith("manifest.json"));
  assert.equal(manifests.length, 1, "real activation must leave exactly one recovery manifest");
  const manifestBytes = manifests[0]!.bytes;

  now = 5_000;
  await makeCoordinator(null).recover({
    signal: new AbortController().signal,
    inspectCommitted: true,
  });
  assert.deepEqual(await sortedRegularFilesIfPresent(activationRoot), []);
  return manifestBytes;
}

async function realProviderInspectionCorpus(values: PrivacyProbes): Promise<string> {
  const hmacKey = new Uint8Array(32).fill(7);
  const accountFingerprint = openRouterAccountFingerprint(hmacKey, values.creatorId);
  const slot: CredentialSlotRef = Object.freeze({
    version: 1,
    kind: "inference",
    id: "v1:inference:10000000-0000-4000-8000-000000000030",
  });
  let responseMode: "success" | "failure" = "success";
  const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
  const service = new OpenRouterService(undefined, undefined, {}, {
    now: () => 1_000,
    clock: { sleep: async () => undefined },
    fetchImpl: async (url) => {
      if (url.endsWith("/key")) {
        if (responseMode === "failure") {
          return jsonResponse({ error: { message: values.providerBody } }, 401);
        }
        return jsonResponse({
          data: {
            label: "Privacy fixture",
            is_free_tier: false,
            is_management_key: true,
            creator_user_id: values.creatorId,
            limit: null,
            limit_remaining: null,
            usage: 1,
            usage_daily: 1,
            usage_weekly: 1,
            usage_monthly: 1,
            expires_at: null,
          },
        });
      }
      if (url.endsWith("/credits")) {
        return jsonResponse({ data: { total_credits: 10, total_usage: 2 } });
      }
      throw new Error("privacy-unexpected-openrouter-endpoint");
    },
  });
  const credentials: VersionedCredentialStoreLike = {
    location: "privacy-memory-store",
    reserveSlot() {
      throw new Error("privacy-reserve-forbidden");
    },
    async writeSlot() {
      throw new Error("privacy-write-forbidden");
    },
    async readSlot(ref) {
      return ref.id === slot.id ? values.credential : null;
    },
    async deleteSlot() {
      return false;
    },
    async get() {
      return null;
    },
    async set() {
      throw new Error("privacy-legacy-write-forbidden");
    },
    async delete() {
      return false;
    },
    async has() {
      return false;
    },
    async getOrCreateAccountHmacKey() {
      return new Uint8Array(hmacKey);
    },
  };
  const adapter = new OpenRouterBackendAdapter({
    service,
    credentials,
    credentialAuthority: {
      async withCredential(request, use) {
        if (request.credentialKind === "management") return { kind: "absent" as const };
        const secret = await credentials.readSlot(slot);
        if (!secret) return { kind: "absent" as const };
        return {
          kind: "available" as const,
          value: await use(secret, {
            source: "saved",
            candidatePermit: Object.freeze({ version: 1 as const }),
            async publishIfCurrent(publish) { publish(); },
            binding: {
              version: 2,
              stateRevision: 4,
              connectionId: request.connectionId,
              backendId: "openrouter",
              enabled: true,
              credentialPointer: { kind: "versioned", slot },
              accountFingerprint,
              billingRealm: "openrouter-payg",
              isDefault: true,
            },
          }),
        };
      },
    },
    createConnectionId: () => "privacy-openrouter-connection",
    now: () => 1_000,
  });
  const route: RouteIdentityV1 = {
    version: 1,
    backendId: "openrouter",
    accountFingerprint,
    billingRealm: "openrouter-payg",
    requestedModelId: "synthetic/privacy-runtime-model",
    canonicalModelId: "synthetic/privacy-runtime-model",
    resolutionState: "resolved",
  };
  const stateStore = new ProviderStateStore({
    schemaVersion: 2,
    revision: 4,
    lifecycle: "configured",
    connections: [{
      id: "privacy-openrouter-connection",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialSlot: slot.id,
      accountFingerprint,
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: route,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  });
  const events: SetupEvent[] = [];
  const registry = new BackendRegistry([{ descriptor: OPENROUTER_DESCRIPTOR, adapter }]);
  const orchestrator = new SetupOrchestrator({
    registry,
    stateStore,
    activationCoordinator: {
      async activate() {
        throw new Error("privacy-activation-forbidden");
      },
    },
    emit: (event) => events.push(structuredClone(event)),
  });
  const success = await orchestrator.inspectStartup();
  responseMode = "failure";
  const failure = await orchestrator.reconnect("openrouter");
  const ends = events.filter((event) => event.type === "inspection-end");
  assert.equal(ends.length, 2);
  assert.equal(ends[0]!.accountFingerprint, accountFingerprint);
  assert.equal(ends[1]!.accountFingerprint, accountFingerprint);
  assert.equal(ends[1]!.health.credential, "rejected");
  assert.equal(
    events.some((event) => (
      event.type === "terminal-failure"
      && event.code === "provider-auth-replacement-required"
    )),
    true,
  );

  const presentations: SetupPresentation[] = [];
  let hubAttempt = 0;
  const surface: SetupSurface = {
    async chooseHub() {
      hubAttempt += 1;
      return hubAttempt === 1 ? "openrouter" : null;
    },
    async readSecret() {
      return values.credential;
    },
    async chooseModel() {
      throw new Error("privacy-model-choice-forbidden");
    },
    async confirm() {
      throw new Error("privacy-confirm-forbidden");
    },
    present(event) {
      presentations.push(structuredClone(event));
    },
  };
  const hub = await runSetupHub({
    surface,
    registry,
    orchestrator,
    stateStore,
  });
  assert.deepEqual(hub, { kind: "cancelled", mode: "setup-required" });
  assert.equal(
    presentations.some((event) => (
      event.type === "notice"
      && event.message === "OpenRouter konnte den Zugangsschlüssel nicht bestätigen."
    )),
    true,
  );
  return JSON.stringify({ events, success, failure, presentations, hub });
}

test("provider privacy scanner recursively covers committed fixtures PTY output events journals and temp homes", async (t) => {
  const harness = await import(HARNESS_MODULE) as ProviderPtyHarnessModule;
  const values = probes(harness.syntheticProviderCredential());
  assert.deepEqual(
    values.fragments.slice(0, 3),
    harness.syntheticProviderCredentialFragments(),
  );
  const dirtyPaths = privateHomeForms();
  const dirty = [
    values.credential,
    values.creatorId,
    values.providerBody,
    ...dirtyPaths,
  ].join("\n");

  assert.ok(scanForSecrets(dirty).length > 0, "dirty control must trigger the central scanner");
  for (const privatePath of dirtyPaths) {
    assert.equal(containsPrivateHome(privatePath), true, "dirty path control must trigger");
  }
  assert.throws(
    () => assertProviderPrivate(dirty, values),
    /provider-privacy-(?:secret|exact-probe|private-home)-detected/,
  );
  for (const exactProbe of [
    values.creatorId,
    values.providerBody,
    ...values.fragments.slice(3),
  ]) {
    assert.throws(
      () => assertProviderPrivate(exactProbe, values),
      /provider-privacy-exact-probe-detected/,
    );
  }
  for (const privatePath of dirtyPaths) {
    assert.throws(
      () => assertProviderPrivate(privatePath, values),
      /provider-privacy-private-home-detected/,
    );
  }

  const committed = [
    ...(await sortedRegularFiles(FIXTURE_ROOT)),
    { path: "provider-setup-pty-harness.mjs", bytes: await readFile(PROVIDER_HARNESS, "utf8") },
  ];
  for (const artifact of committed) {
    assertProviderPrivate(`${artifact.path}\n${artifact.bytes}`, values);
  }

  const generatedHome = await mkdtemp(join(tmpdir(), "orcode-provider-privacy-"));
  t.after(() => rm(generatedHome, { recursive: true, force: true }));
  const manifestBytesBeforeRecovery = await crashAndRecoverRealActivation(
    generatedHome,
    values,
  );
  assertProviderPrivate(manifestBytesBeforeRecovery, values);

  const setupEvents = await realProviderInspectionCorpus(values);
  assertProviderPrivate(setupEvents, values);
  await writeFile(join(generatedHome, "setup-events.json"), `${setupEvents}\n`);

  await t.test("real POSIX transcript corpus", {
    skip: process.platform === "win32"
      ? "The privacy corpus stays active; only its real POSIX PTY transcript is skipped."
      : false,
  }, async (subtest) => {
    const build = await harness.buildFreshProviderSetupModules(PROJECT_ROOT);
    subtest.after(() => build.cleanup());
    const pty = await harness.runProviderSetupPtyScenario({
      projectRoot: PROJECT_ROOT,
      moduleRoot: build.moduleRoot,
      scenario: "success",
    });
    const decodedPty = Buffer.from(pty.outputBase64, "base64").toString("utf8");
    assertProviderPrivate(decodedPty, values);
    await writeFile(join(generatedHome, "provider-pty-transcript.txt"), decodedPty);
  });

  const afterRecovery = await sortedRegularFiles(generatedHome);
  for (const artifact of afterRecovery) {
    assertProviderPrivate(`${artifact.path}\n${artifact.bytes}`, values);
  }
});

test("Kimi metadata inspection and candidate state discard provider diagnostics and raw membership keys", async () => {
  const credential = `fixture-kimi-membership-privacy-${"z".repeat(40)}`;
  const values = probes(credential);
  const hmacKey = new Uint8Array(32).fill(13);
  const accountFingerprint = kimiCodeAccountFingerprint(hmacKey, credential);
  const slot: CredentialSlotRef = Object.freeze({
    version: 1,
    kind: "kimi-code",
    id: "v1:kimi-code:10000000-0000-4000-8000-000000000099",
  });
  let responseMode: "failure" | "success" = "failure";
  const calls: string[] = [];
  const service = new KimiCodeService({
    now: () => 1_000,
    fetchImpl: async (url) => {
      calls.push(url);
      if (responseMode === "failure") {
        return new Response(JSON.stringify({
          error: {
            message: "The API Key appears to be invalid or may have expired. Please verify your credentials and try again.",
            type: values.providerBody,
            param: values.creatorId,
            code: null,
          },
        }), {
          status: 401,
          headers: {
            "content-type": "application/json",
            "x-request-id": values.uniqueCredentialBody,
          },
        });
      }
      return new Response(JSON.stringify({
        object: "list",
        data: [{
          id: "kimi-for-coding",
          object: "model",
          created: 1_777_777_777,
          owned_by: "kimi-code",
        }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const adapter = new KimiCodeBackendAdapter({
    service,
    credentials: {
      async getOrCreateAccountHmacKey() { return new Uint8Array(hmacKey); },
    },
    credentialAuthority: {
      async withCredential(request, use) {
        return {
          kind: "available" as const,
          value: await use(credential, {
            source: "saved",
            candidatePermit: Object.freeze({ version: 1 as const }),
            async publishIfCurrent(publish) { publish(); },
            binding: {
              version: 2,
              stateRevision: 4,
              connectionId: request.connectionId,
              backendId: "kimi-code",
              enabled: true,
              credentialPointer: { kind: "versioned", slot },
              accountFingerprint,
              billingRealm: "kimi-code-membership-provider-managed-overage",
              isDefault: true,
            },
          }),
        };
      },
    },
    now: () => 1_000,
    createCandidateId: () => "privacy-kimi-candidate",
    createConnectionId: () => "privacy-kimi-connection",
  });

  const failure = await adapter.inspect({
    connectionId: "privacy-kimi-connection",
    generation: 4,
    deadlineAt: 2_000,
    signal: new AbortController().signal,
    purpose: "startup-inspect",
    environmentEligibility: "forbidden",
  });
  assert.equal(failure.explanationCode, "kimi-code-invalid-response");
  assertProviderPrivate(JSON.stringify(failure), values);

  responseMode = "success";
  const candidate = await adapter.connect({
    connectionId: "privacy-kimi-connection",
    candidate: credential,
    generation: 5,
    deadlineAt: 2_000,
    signal: new AbortController().signal,
  });
  const models = await adapter.listModels({
    candidateId: candidate.candidateId,
    signal: new AbortController().signal,
  });
  const activated = await adapter.activate({
    candidateId: candidate.candidateId,
    model: models[0]!,
    signal: new AbortController().signal,
  });
  assertProviderPrivate(JSON.stringify({ candidate, models, activated }), values);
  assert.deepEqual(calls, calls.map(() => "https://api.kimi.com/coding/v1/models"));
});
