import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  lstat,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertLocalFileSystem,
  assertCodexHomePolicy,
  assertOwnerOnlyProfileTree,
  createCodexHome,
  generateCodexHomeId,
  parseCodexHomeId,
  requireOwnedLocalDirectory,
  type CodexHomeBindingV1,
  type LocalFileSystemProbe,
  type CodexProfileRuntime,
  type OwnedDirectoryFileSystem,
  type ProfileTreeFileSystem,
} from "../src/codex-profile.js";
import {
  assertNoPrivateProviderStateLeaves,
  credentialBindingForConnection,
  migrateProviderSetupStateV2ToV3,
  requireKeychainCredentialPointer,
  validateProviderSetupState,
  type ProviderConnectionStateV3,
  type ProviderSetupStateV2,
  type ProviderSetupStateV3,
} from "../src/provider-state.js";

const homeId = parseCodexHomeId("codex-0123456789abcdef0123456789abcdef");

function v2Fixture(): ProviderSetupStateV2 {
  return {
    schemaVersion: 2,
    revision: 7,
    lifecycle: "configured",
    connections: [{
      id: "openrouter-personal",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialSlot: "v1:inference:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0711",
      accountFingerprint: "acct_openrouter_personal",
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: {
      version: 1,
      backendId: "openrouter",
      accountFingerprint: "acct_openrouter_personal",
      billingRealm: "openrouter-payg",
      requestedModelId: "openai/gpt-5",
      canonicalModelId: "openai/gpt-5",
      resolutionState: "resolved",
    },
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
}

function v3Connection(
  overrides: Partial<ProviderConnectionStateV3> = {},
): ProviderConnectionStateV3 {
  return {
    id: "codex-personal",
    backendId: "codex",
    enabled: false,
    maturity: "preview",
    credentialBinding: { kind: "provider-runtime", homeId },
    accountFingerprint: "acct_codex_personal",
    accountFingerprintState: "verified",
    billingRealm: "chatgpt-account-provider-managed-limits",
    lastHealth: null,
    ...overrides,
  };
}

function v3State(connection: ProviderConnectionStateV3): ProviderSetupStateV3 {
  return {
    schemaVersion: 3,
    revision: 0,
    lifecycle: "configured",
    connections: [connection],
    defaultRoute: null,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
}

function privateStringLeaves(value: unknown): string[] {
  const leaves: string[] = [];
  const publicBindingKeys = new Set(["accountLabel", "credentialStore"]);
  const visit = (candidate: unknown, key: string | null): void => {
    if (typeof candidate === "string") {
      if (key === null || !publicBindingKeys.has(key)) leaves.push(candidate);
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((entry) => visit(entry, null));
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;
    for (const [childKey, entry] of Object.entries(candidate)) visit(entry, childKey);
  };
  visit(value, null);
  return leaves;
}

test("persists only an opaque binding for a canonical owner-only Codex home", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-codex-profile-"));
  try {
    const homeId = parseCodexHomeId("codex-0123456789abcdef0123456789abcdef");
    const profile = await createCodexHome({
      appHome,
      homeId,
      accountLabel: "Persoenlich",
    });

    assert.equal(
      profile.codexHome,
      join(await realpath(appHome), "providers", "codex", homeId),
    );
    assert.deepEqual(profile.binding, {
      version: 1,
      homeId,
      accountLabel: "Persoenlich",
      credentialStore: "file",
    });
    assert.equal(JSON.stringify(profile.binding).includes(appHome), false);
    assert.equal((await stat(profile.codexHome)).mode & 0o077, 0);
    assert.equal(
      await readFile(join(profile.codexHome, "config.toml"), "utf8"),
      'cli_auth_credentials_store = "file"\n',
    );
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("uses canonical 128-bit home IDs and never derives a path from the account label", async () => {
  assert.throws(() => parseCodexHomeId("codex-0123456789ABCDEF0123456789ABCDEF"), /canonical/i);
  assert.throws(() => parseCodexHomeId("codex-0123456789abcdef"), /canonical/i);
  assert.throws(() => parseCodexHomeId("../codex-0123456789abcdef0123456789abcdef"), /canonical/i);
  const generated = new Set(Array.from({ length: 32 }, () => generateCodexHomeId()));
  assert.equal(generated.size, 32);
  for (const generatedId of generated) {
    assert.match(generatedId, /^codex-[0-9a-f]{32}$/);
  }

  const appHome = await mkdtemp(join(tmpdir(), "orcode-codex-profile-label-"));
  try {
    const profile = await createCodexHome({
      appHome,
      homeId,
      accountLabel: "../../label-must-stay-metadata",
    });
    assert.equal(profile.codexHome, join(await realpath(appHome), "providers", "codex", homeId));
    assert.equal(profile.binding.accountLabel, "../../label-must-stay-metadata");
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("migrates V2 keychain pointers to V3 without changing route identity", () => {
  const legacy = v2Fixture();
  const migrated = migrateProviderSetupStateV2ToV3(legacy);

  assert.deepEqual(migrated.connections[0]?.credentialBinding, {
    kind: "orcode-keychain",
    pointer: legacy.connections[0]?.credentialSlot,
  });
  assert.deepEqual(
    credentialBindingForConnection(migrated.connections[0]!),
    migrated.connections[0]?.credentialBinding,
  );
  assert.equal(
    requireKeychainCredentialPointer(migrated.connections[0]!),
    legacy.connections[0]?.credentialSlot,
  );
  assert.deepEqual(migrated.defaultRoute, legacy.defaultRoute);
  assert.deepEqual(validateProviderSetupState(migrated), migrated);
  assert.deepEqual(migrateProviderSetupStateV2ToV3(migrated), migrated);

  const globalCodexLegacy: ProviderSetupStateV2 = {
    ...legacy,
    connections: [{
      ...legacy.connections[0]!,
      id: "global-codex-must-not-migrate",
      backendId: "codex",
      maturity: "preview",
      billingRealm: "chatgpt-account-provider-managed-limits",
      accountFingerprint: "acct_codex_global_legacy",
    }],
    defaultRoute: null,
  };
  assert.throws(
    () => migrateProviderSetupStateV2ToV3(globalCodexLegacy),
    /global Codex credential cannot be migrated/i,
  );
});

test("has no optional credentialSlot fallback after the atomic V3 migration", () => {
  const runtimeBound = v3Connection();
  assert.deepEqual(
    credentialBindingForConnection(runtimeBound),
    runtimeBound.credentialBinding,
  );
  assert.throws(
    () => requireKeychainCredentialPointer(runtimeBound),
    /provider-runtime has no keychain pointer/i,
  );
  const legacyFieldOnly = {
    ...v3State(runtimeBound),
    connections: [{
      ...runtimeBound,
      credentialBinding: undefined,
      credentialSlot: "v1:inference:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0711",
    }],
  };
  assert.deepEqual(validateProviderSetupState(legacyFieldOnly), { kind: "corrupt" });
  assert.deepEqual(validateProviderSetupState(v3State(v3Connection({
    credentialBinding: {
      kind: "orcode-keychain",
      pointer: "v1:inference:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0711",
    },
  }))), { kind: "corrupt" });
  assert.deepEqual(validateProviderSetupState(v3State(v3Connection({
    backendId: "openrouter",
    maturity: "stable",
    billingRealm: "openrouter-payg",
  }))), { kind: "corrupt" });
});

test("recursively rejects every private V3 binding and path leaf from public output", () => {
  const keychainBinding = {
    kind: "orcode-keychain",
    pointer: "keychain-pointer-canary",
  } as const;
  const runtimeBinding = { kind: "provider-runtime", homeId } as const;
  const bindingFixture: CodexHomeBindingV1 = {
    version: 1,
    homeId,
    accountLabel: "private-account-label-canary",
    credentialStore: "file",
  };
  const runtimeFixture: CodexProfileRuntime = {
    binding: bindingFixture,
    codexHome: "/private/provider-home-canary",
  };
  const privateCanaries = [
    { credentialSlot: "keychain-pointer-canary" },
    { credentialBinding: runtimeBinding },
    { CredentialBinding: runtimeBinding },
    { credentialBinding: keychainBinding },
    { pointer: "keychain-pointer-canary" },
    { homeId },
    { codexHome: "/private/provider-home-canary" },
    { arbitraryLeaf: `/Users/private/.orcode/providers/codex/${homeId}` },
    bindingFixture,
    runtimeFixture,
    runtimeBinding,
    keychainBinding,
  ];
  for (const canary of privateCanaries) {
    assert.throws(
      () => assertNoPrivateProviderStateLeaves({ outer: [{ inner: canary }] }),
      /private provider state/i,
    );
  }
  const privateLeaves = new Set([
    ...privateStringLeaves(bindingFixture),
    ...privateStringLeaves(runtimeFixture),
    ...privateStringLeaves(runtimeBinding),
    ...privateStringLeaves(keychainBinding),
  ]);
  assert.deepEqual([...privateLeaves].sort(), [
    "/private/provider-home-canary",
    "codex-0123456789abcdef0123456789abcdef",
    "keychain-pointer-canary",
    "orcode-keychain",
    "provider-runtime",
  ]);
  for (const leaf of privateLeaves) {
    assert.throws(
      () => assertNoPrivateProviderStateLeaves({ outer: [{ arbitraryLeaf: leaf }] }),
      /private provider state/i,
    );
  }
});

test("rejects an existing broad profile directory without repairing its permissions", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-codex-profile-broad-"));
  const codexHome = join(appHome, "providers", "codex", homeId);
  try {
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await chmod(codexHome, 0o755);

    await assert.rejects(
      createCodexHome({ appHome, homeId, accountLabel: "Persoenlich" }),
      /permissions must be owner-only/i,
    );
    assert.equal((await stat(codexHome)).mode & 0o077, 0o055);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("rejects an owned directory swapped while its canonical path is resolved", async () => {
  const lexical = await mkdtemp(join(tmpdir(), "orcode-codex-profile-root-swap-"));
  const parked = `${lexical}-parked`;
  const outside = `${lexical}-outside`;
  await mkdir(outside, { mode: 0o700 });
  let swapped = false;
  const swappingFileSystem: OwnedDirectoryFileSystem = {
    lstat: (path) => lstat(path, { bigint: true }),
    realpath: async (path) => {
      if (path === lexical && !swapped) {
        swapped = true;
        await rename(lexical, parked);
        await symlink(outside, lexical);
      }
      return realpath(path);
    },
    openDirectory: (path) => open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    ),
  };

  try {
    await assert.rejects(
      requireOwnedLocalDirectory(lexical, "Orcode app home", swappingFileSystem),
      /changed during validation/i,
    );
    assert.equal(swapped, true);
  } finally {
    await unlink(lexical).catch(() => undefined);
    await rm(parked, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("rejects Darwin NFS, SMB, and WebDAV mounts and accepts a verified local APFS mount", async () => {
  for (const fileSystemType of ["nfs", "smbfs", "webdav"]) {
    const probe: LocalFileSystemProbe = {
      platform: "darwin",
      statFsType: async () => 0n,
      inspectDarwinMount: async () => ({ fileSystemType, local: false }),
    };
    await assert.rejects(
      assertLocalFileSystem("/private/profile", "Codex profile home", probe),
      /network filesystem/i,
    );
  }

  await assert.doesNotReject(assertLocalFileSystem("/private/profile", "Codex profile home", {
    platform: "darwin",
    statFsType: async () => 0n,
    inspectDarwinMount: async () => ({ fileSystemType: "apfs", local: true }),
  }));
  await assert.rejects(
    assertLocalFileSystem("/private/profile", "Codex profile home", {
      platform: "darwin",
      statFsType: async () => 0n,
      inspectDarwinMount: async () => null,
    }),
    /cannot establish.*local filesystem/i,
  );

  if (process.platform === "darwin") {
    const localDirectory = await mkdtemp(join(tmpdir(), "orcode-codex-profile-apfs-smoke-"));
    try {
      await assert.doesNotReject(
        assertLocalFileSystem(localDirectory, "Local APFS profile smoke"),
      );
    } finally {
      await rm(localDirectory, { recursive: true, force: true });
    }
  }
});

test("rejects hard-linked App Server auth metadata without opening the auth file", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-codex-profile-auth-link-"));
  try {
    const profile = await createCodexHome({ appHome, homeId, accountLabel: "Persoenlich" });
    const authPath = join(profile.codexHome, "auth.json");
    await writeFile(authPath, "AUTH_BYTES_MUST_NOT_BE_READ", { mode: 0o600 });
    await link(authPath, join(appHome, "auth-link-canary"));

    await assert.rejects(assertCodexHomePolicy(profile.codexHome), /hard-linked/i);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("rejects App Server auth metadata swapped to a symlink after its first lstat", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-codex-profile-auth-swap-"));
  try {
    const profile = await createCodexHome({ appHome, homeId, accountLabel: "Persoenlich" });
    const authPath = join(profile.codexHome, "auth.json");
    const parked = join(appHome, "parked-auth.json");
    const outside = join(appHome, "outside-auth.json");
    await writeFile(authPath, "ORIGINAL_AUTH_BYTES", { mode: 0o600 });
    await writeFile(outside, "OUTSIDE_AUTH_BYTES", { mode: 0o600 });

    let swapped = false;
    const swappingFileSystem: ProfileTreeFileSystem = {
      lstat: async (path) => {
        const metadata = await lstat(path, { bigint: true });
        if (path === authPath && !swapped) {
          swapped = true;
          await rename(authPath, parked);
          await symlink(outside, authPath);
        }
        return metadata;
      },
      readdir,
      openDirectory: (path) => open(
        path,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      ),
    };

    await assert.rejects(
      assertOwnerOnlyProfileTree(profile.codexHome, swappingFileSystem),
      /changed during validation|symlink/i,
    );
    assert.equal(swapped, true);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("rejects a profile entry added after the directory entry set is captured", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-codex-profile-entry-swap-"));
  try {
    const profile = await createCodexHome({ appHome, homeId, accountLabel: "Persoenlich" });
    const lateEntry = join(profile.codexHome, "late-auth.json");
    let added = false;
    const changingFileSystem: ProfileTreeFileSystem = {
      lstat: (path) => lstat(path, { bigint: true }),
      readdir: async (path) => {
        const entries = await readdir(path);
        if (path === profile.codexHome && !added) {
          added = true;
          await writeFile(lateEntry, "LATE_AUTH_BYTES", { mode: 0o600 });
        }
        return entries;
      },
      openDirectory: (path) => open(
        path,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      ),
    };

    await assert.rejects(
      assertOwnerOnlyProfileTree(profile.codexHome, changingFileSystem),
      /entries changed during validation/i,
    );
    assert.equal(added, true);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("rejects a directory swapped to a symlink while the recursive tree is being read", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-codex-profile-swap-"));
  try {
    const profile = await createCodexHome({ appHome, homeId, accountLabel: "Persoenlich" });
    const nested = join(profile.codexHome, "session-data");
    const parked = join(appHome, "parked-session-data");
    const outside = join(appHome, "outside-session-data");
    await mkdir(nested, { mode: 0o700 });
    await writeFile(join(nested, "inside.json"), "{}", { mode: 0o600 });
    await mkdir(outside, { mode: 0o700 });
    await writeFile(join(outside, "outside.json"), "{}", { mode: 0o600 });

    let swapped = false;
    const swappingFileSystem: ProfileTreeFileSystem = {
      lstat: (path) => lstat(path, { bigint: true }),
      readdir: async (path) => {
        if (path === nested && !swapped) {
          swapped = true;
          await rename(nested, parked);
          await symlink(outside, nested);
        }
        return readdir(path);
      },
      openDirectory: (path) => open(
        path,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      ),
    };

    await assert.rejects(
      assertOwnerOnlyProfileTree(profile.codexHome, swappingFileSystem),
      /changed during validation|symlink/i,
    );
    assert.equal(swapped, true);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("rejects a checked child directory swapped while a later sibling is inspected", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-codex-profile-late-child-swap-"));
  try {
    const profile = await createCodexHome({ appHome, homeId, accountLabel: "Persoenlich" });
    const nested = join(profile.codexHome, "a-nested");
    const parked = join(appHome, "parked-nested");
    const outside = join(appHome, "outside-nested");
    const trigger = join(profile.codexHome, "z-trigger.json");
    await mkdir(nested, { mode: 0o700 });
    await writeFile(join(nested, "inside.json"), "{}", { mode: 0o600 });
    await mkdir(outside, { mode: 0o700 });
    await writeFile(join(outside, "outside.json"), "{}", { mode: 0o600 });
    await writeFile(trigger, "{}", { mode: 0o600 });

    let swapped = false;
    const swappingFileSystem: ProfileTreeFileSystem = {
      lstat: async (path) => {
        const metadata = await lstat(path, { bigint: true });
        if (path === trigger && !swapped) {
          swapped = true;
          await rename(nested, parked);
          await symlink(outside, nested);
        }
        return metadata;
      },
      readdir: async (path) => (await readdir(path)).sort(),
      openDirectory: (path) => open(
        path,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      ),
    };

    await assert.rejects(
      assertOwnerOnlyProfileTree(profile.codexHome, swappingFileSystem),
      /changed during validation|symlink/i,
    );
    assert.equal(swapped, true);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("rejects a checked two-level descendant swapped while a root sibling is inspected", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-codex-profile-deep-child-swap-"));
  try {
    const profile = await createCodexHome({ appHome, homeId, accountLabel: "Persoenlich" });
    const parent = join(profile.codexHome, "a-parent");
    const deep = join(parent, "a-deep");
    const parked = join(appHome, "parked-deep");
    const outside = join(appHome, "outside-deep");
    const trigger = join(profile.codexHome, "z-trigger.json");
    await mkdir(deep, { recursive: true, mode: 0o700 });
    await writeFile(join(deep, "inside.json"), "{}", { mode: 0o600 });
    await mkdir(outside, { mode: 0o700 });
    await writeFile(join(outside, "outside.json"), "{}", { mode: 0o600 });
    await writeFile(trigger, "{}", { mode: 0o600 });

    let swapped = false;
    const swappingFileSystem: ProfileTreeFileSystem = {
      lstat: async (path) => {
        const metadata = await lstat(path, { bigint: true });
        if (path === trigger && !swapped) {
          swapped = true;
          await rename(deep, parked);
          await symlink(outside, deep);
        }
        return metadata;
      },
      readdir: async (path) => (await readdir(path)).sort(),
      openDirectory: (path) => open(
        path,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      ),
    };

    await assert.rejects(
      assertOwnerOnlyProfileTree(profile.codexHome, swappingFileSystem),
      /changed during validation|symlink/i,
    );
    assert.equal(swapped, true);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("rejects a checked two-level descendant chmodded while a root sibling is inspected", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-codex-profile-deep-mode-swap-"));
  try {
    const profile = await createCodexHome({ appHome, homeId, accountLabel: "Persoenlich" });
    const parent = join(profile.codexHome, "a-parent");
    const deep = join(parent, "a-deep");
    const trigger = join(profile.codexHome, "z-trigger.json");
    await mkdir(deep, { recursive: true, mode: 0o700 });
    await writeFile(join(deep, "inside.json"), "{}", { mode: 0o600 });
    await writeFile(trigger, "{}", { mode: 0o600 });

    let changed = false;
    const changingFileSystem: ProfileTreeFileSystem = {
      lstat: async (path) => {
        const metadata = await lstat(path, { bigint: true });
        if (path === trigger && !changed) {
          changed = true;
          await chmod(deep, 0o755);
        }
        return metadata;
      },
      readdir: async (path) => (await readdir(path)).sort(),
      openDirectory: (path) => open(
        path,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      ),
    };

    await assert.rejects(
      assertOwnerOnlyProfileTree(profile.codexHome, changingFileSystem),
      /changed during validation/i,
    );
    assert.equal(changed, true);
    assert.equal((await stat(deep)).mode & 0o777, 0o755);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("rejects a symlink added to a checked two-level descendant while a root sibling is inspected", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-codex-profile-deep-entry-swap-"));
  try {
    const profile = await createCodexHome({ appHome, homeId, accountLabel: "Persoenlich" });
    const deep = join(profile.codexHome, "a-parent", "a-deep");
    const lateEntry = join(deep, "late-auth.json");
    const outside = join(appHome, "outside-auth.json");
    const trigger = join(profile.codexHome, "z-trigger.json");
    await mkdir(deep, { recursive: true, mode: 0o700 });
    await writeFile(join(deep, "inside.json"), "{}", { mode: 0o600 });
    await writeFile(outside, "{}", { mode: 0o600 });
    await writeFile(trigger, "{}", { mode: 0o600 });

    let added = false;
    const changingFileSystem: ProfileTreeFileSystem = {
      lstat: async (path) => {
        const metadata = await lstat(path, { bigint: true });
        if (path === trigger && !added) {
          added = true;
          await symlink(outside, lateEntry);
        }
        return metadata;
      },
      readdir: async (path) => (await readdir(path)).sort(),
      openDirectory: (path) => open(
        path,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      ),
    };

    await assert.rejects(
      assertOwnerOnlyProfileTree(profile.codexHome, changingFileSystem),
      /entries changed during validation|symlink/i,
    );
    assert.equal(added, true);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("revalidates checked two-level descendant entry sets for regular additions and removals", async (t) => {
  for (const mutation of ["add", "remove"] as const) {
    await t.test(mutation, async () => {
      const appHome = await mkdtemp(join(tmpdir(), `orcode-codex-profile-deep-entry-${mutation}-`));
      try {
        const profile = await createCodexHome({ appHome, homeId, accountLabel: "Persoenlich" });
        const deep = join(profile.codexHome, "a-parent", "a-deep");
        const inside = join(deep, "inside.json");
        const lateEntry = join(deep, "late.json");
        const trigger = join(profile.codexHome, "z-trigger.json");
        await mkdir(deep, { recursive: true, mode: 0o700 });
        await writeFile(inside, "{}", { mode: 0o600 });
        await writeFile(trigger, "{}", { mode: 0o600 });

        let changed = false;
        const changingFileSystem: ProfileTreeFileSystem = {
          lstat: async (path) => {
            const metadata = await lstat(path, { bigint: true });
            if (path === trigger && !changed) {
              changed = true;
              if (mutation === "add") {
                await writeFile(lateEntry, "{}", { mode: 0o600 });
              } else {
                await unlink(inside);
              }
            }
            return metadata;
          },
          readdir: async (path) => (await readdir(path)).sort(),
          openDirectory: (path) => open(
            path,
            fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
          ),
        };

        await assert.rejects(
          assertOwnerOnlyProfileTree(profile.codexHome, changingFileSystem),
          /entries changed during validation/i,
        );
        assert.equal(changed, true);
      } finally {
        await rm(appHome, { recursive: true, force: true });
      }
    });
  }
});

test("rejects symlinked or broadly readable App Server auth metadata without reading it", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-codex-profile-auth-policy-"));
  try {
    const profile = await createCodexHome({ appHome, homeId, accountLabel: "Persoenlich" });
    const authPath = join(profile.codexHome, "auth.json");
    const outside = join(appHome, "outside-auth-canary");
    await writeFile(outside, "AUTH_BYTES_MUST_NOT_BE_READ", { mode: 0o600 });
    await symlink(outside, authPath);
    await assert.rejects(assertCodexHomePolicy(profile.codexHome), /symlink/i);

    await unlink(authPath);
    await writeFile(authPath, "AUTH_BYTES_MUST_NOT_BE_READ", { mode: 0o644 });
    await chmod(authPath, 0o644);
    await assert.rejects(assertCodexHomePolicy(profile.codexHome), /permissions must be owner-only/i);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("rejects a Codex home whose providers ancestor aliases a safe external tree", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-codex-profile-parent-link-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "orcode-codex-profile-parent-outside-"));
  const providersPath = join(appHome, "providers");
  const outsideProviders = join(outsideRoot, "providers");
  const outsideHome = join(outsideProviders, "codex", homeId);
  const lexicalHome = join(providersPath, "codex", homeId);
  try {
    await mkdir(outsideHome, { recursive: true, mode: 0o700 });
    await writeFile(
      join(outsideHome, "config.toml"),
      'cli_auth_credentials_store = "file"\n',
      { mode: 0o600 },
    );
    await symlink(outsideProviders, providersPath);

    await assert.rejects(
      assertCodexHomePolicy(lexicalHome),
      /canonical Orcode app home|real directory|symlink|changed during validation/i,
    );
  } finally {
    await rm(appHome, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("rejects an app-home identity replaced after the complete profile policy", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-codex-profile-final-parent-swap-"));
  const canonicalAppHome = await realpath(appHome);
  const parked = `${canonicalAppHome}-parked`;
  try {
    const profile = await createCodexHome({ appHome, homeId, accountLabel: "Persoenlich" });
    let homeOpened = false;
    let swapped = false;
    const swappingFileSystem: OwnedDirectoryFileSystem = {
      lstat: async (path) => {
        const metadata = await lstat(path, { bigint: true });
        if (path === canonicalAppHome && homeOpened && !swapped) {
          swapped = true;
          await rename(canonicalAppHome, parked);
          await mkdir(canonicalAppHome, { mode: 0o700 });
        }
        return metadata;
      },
      realpath,
      openDirectory: async (path) => {
        const handle = await open(
          path,
          fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
        );
        if (path === profile.codexHome) homeOpened = true;
        return handle;
      },
    };

    await assert.rejects(
      assertCodexHomePolicy(profile.codexHome, swappingFileSystem),
      /changed during validation/i,
    );
    assert.equal(swapped, true);
  } finally {
    await rm(appHome, { recursive: true, force: true });
    await rm(parked, { recursive: true, force: true });
  }
});

test("rejects a global CODEX_HOME alias before creating the profile tree", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-codex-profile-global-alias-"));
  const candidate = join(appHome, "providers", "codex", homeId);
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = candidate;
  try {
    await assert.rejects(
      createCodexHome({ appHome, homeId, accountLabel: "Persoenlich" }),
      /global home/i,
    );
    await assert.rejects(stat(join(appHome, "providers")), { code: "ENOENT" });
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(appHome, { recursive: true, force: true });
  }
});
