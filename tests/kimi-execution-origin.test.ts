import assert from "node:assert/strict";
import test from "node:test";

import {
  desktopNativeKimiExecutionOrigin,
  isDesktopKimiRuntimeCapability,
  terminalLocalKimiExecutionOrigin,
  visitKimiExecutionOrigin,
  type LocalInteractiveOwnerAuthority,
} from "../src/kimi-execution-origin.js";
import { KimiDesktopPermitReader } from "../src/kimi-desktop-permit.js";
import {
  NativeSidecarChannel,
  decodeActionFrame,
  encodeControlFrame,
  type NativeSidecarTransport,
} from "../src/native-sidecar-channel.js";
import {
  KIMI_CHAT_COMPLETIONS_URL,
  createKimiResponsesFetcher,
} from "../src/kimi-responses-bridge.js";
import type { ProviderCredentialAuthorityLike } from "../src/provider-authority.js";

function reader(): KimiDesktopPermitReader {
  const transport: NativeSidecarTransport = {
    async writeAction() {},
    async readControl() { return null; },
    close() {},
  };
  return new KimiDesktopPermitReader(new NativeSidecarChannel(transport));
}

test("terminal-local keeps the verified owner flow and never touches the native reader", async () => {
  let ownerChecks = 0;
  let desktopCalls = 0;
  const ownerAuthority: LocalInteractiveOwnerAuthority = {
    kind: "local-interactive-owner",
    async assertCurrent() { ownerChecks += 1; },
  };
  const origin = terminalLocalKimiExecutionOrigin(ownerAuthority);
  const result = await visitKimiExecutionOrigin(origin, {
    async terminal(owner) {
      await owner.assertCurrent();
      return "terminal";
    },
    async desktop() {
      desktopCalls += 1;
      return "desktop";
    },
  });
  assert.equal(result, "terminal");
  assert.equal(ownerChecks, 1);
  assert.equal(desktopCalls, 0);
});

test("desktop-native cannot be constructed without a live permit reader", () => {
  assert.throws(() => desktopNativeKimiExecutionOrigin(null as never), /reader/i);
  const closed = reader();
  closed.close("eof");
  assert.throws(() => desktopNativeKimiExecutionOrigin(closed), /reader|closed/i);

  const live = reader();
  const origin = desktopNativeKimiExecutionOrigin(live);
  assert.equal(origin.kind, "desktop-native");
  live.close("end");
});

test("a forged structural desktop capability never becomes runtime authority", () => {
  assert.equal(isDesktopKimiRuntimeCapability({ kind: "desktop-kimi-runtime-capability", permitReader: reader(), childPid: process.pid, generation: 1, now: Date.now, emitRequirement() {} }), false);
});

test("forged desktop turn capability is rejected before requirement credential authority and provider fetch", async () => {
  let credentialAuthorityCalls = 0;
  let providerCalls = 0;
  const controls: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  const transport: NativeSidecarTransport = {
    async writeAction(frame) {
      const action = decodeActionFrame(frame);
      controls.push(encodeControlFrame({
        kind: "denied",
        requestId: action.requestId,
        sessionId: action.sessionId,
        childPid: action.childPid,
        revision: action.revision,
        generation: action.generation,
        deadlineAt: action.deadlineAt,
      }));
      wake?.();
      wake = null;
    },
    async readControl() {
      if (controls.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
      return controls.shift() ?? null;
    },
    close() { wake?.(); wake = null; },
  };
  const permitReader = new KimiDesktopPermitReader(
    new NativeSidecarChannel(transport),
    () => 1_775_000_000_000,
  );
  let requirements = 0;
  const credentialAuthority: ProviderCredentialAuthorityLike = {
    async withCredential() {
      credentialAuthorityCalls += 1;
      return { kind: "absent" };
    },
  };
  const fetcher = createKimiResponsesFetcher({
    fetch: async () => {
      providerCalls += 1;
      return new Response(null, { status: 500 });
    },
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => 1_775_000_000_000,
    route: {
      version: 1,
      backendId: "kimi-code",
      accountFingerprint: "account-1",
      billingRealm: "kimi-code-membership-provider-managed-overage",
      requestedModelId: "k3",
      canonicalModelId: "k3",
      resolutionState: "resolved",
    },
    binding: {
      version: 1,
      stateRevision: 4,
      generation: 9,
      connectionId: "connection-1",
      backendId: "kimi-code",
      accountFingerprint: "account-1",
      billingRealm: "kimi-code-membership-provider-managed-overage",
      canonicalModelId: "k3",
    },
    credentialAuthority,
    createRequestDeadlineAt: () => 1_775_000_060_000,
    executionOrigin: desktopNativeKimiExecutionOrigin(permitReader),
    desktopKimiCapability: {
      kind: "desktop-kimi-runtime-capability",
      permitReader,
      childPid: 4242,
      generation: 9,
      now: () => 1_775_000_000_000,
      emitRequirement(requirement) {
        requirements += 1;
        assert.deepEqual(requirement, {
          kind: "kimi-turn",
          revision: 4,
          generation: 9,
          purposeCode: "send-turn",
        });
      },
    },
    createDesktopTurnContext: () => ({
      sessionId: "session-1",
      childPid: 4242,
      runId: "run-1",
      scope: {
        signal: new AbortController().signal,
        assertCurrent() {},
      },
    }),
  });

  await assert.rejects(fetcher(new Request("https://orcode-kimi-sdk.invalid/responses", {
    method: "POST",
    body: JSON.stringify({
      input: "hello",
      model: "k3",
      service_tier: "auto",
      store: false,
      stream: true,
      tools: [],
    }),
  })));
  assert.equal(credentialAuthorityCalls, 0);
  assert.equal(providerCalls, 0);
  assert.equal(requirements, 0);
  permitReader.close("end");
});

test("a forged changed-digest capability fails before reader credential authority and provider fetch", async () => {
  let credentialAuthorityCalls = 0;
  let providerCalls = 0;
  const controls: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  const transport: NativeSidecarTransport = {
    async writeAction(frame) {
      const action = decodeActionFrame(frame);
      if (action.kind === "revoke") return;
      assert.equal(action.kind, "kimi-turn");
      controls.push(encodeControlFrame({
        kind: "permit",
        request: { ...action, requestDigest: "0".repeat(64) as typeof action.requestDigest },
        nonce: "changed_digest_permit_1",
      }));
      wake?.();
      wake = null;
    },
    async readControl() {
      if (controls.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
      return controls.shift() ?? null;
    },
    close() { wake?.(); wake = null; },
  };
  const permitReader = new KimiDesktopPermitReader(
    new NativeSidecarChannel(transport),
    () => 1_775_000_000_000,
  );
  const fetcher = createKimiResponsesFetcher({
    fetch: async () => {
      providerCalls += 1;
      return new Response(null, { status: 500 });
    },
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => 1_775_000_000_000,
    route: {
      version: 1,
      backendId: "kimi-code",
      accountFingerprint: "account-changed-digest",
      billingRealm: "kimi-code-membership-provider-managed-overage",
      requestedModelId: "k3",
      canonicalModelId: "k3",
      resolutionState: "resolved",
    },
    binding: {
      version: 1,
      stateRevision: 5,
      generation: 10,
      connectionId: "connection-changed-digest",
      backendId: "kimi-code",
      accountFingerprint: "account-changed-digest",
      billingRealm: "kimi-code-membership-provider-managed-overage",
      canonicalModelId: "k3",
    },
    credentialAuthority: {
      async withCredential() {
        credentialAuthorityCalls += 1;
        return { kind: "absent" };
      },
    },
    createRequestDeadlineAt: () => 1_775_000_060_000,
    executionOrigin: desktopNativeKimiExecutionOrigin(permitReader),
    desktopKimiCapability: {
      kind: "desktop-kimi-runtime-capability",
      permitReader,
      childPid: 4243,
      generation: 10,
      now: () => 1_775_000_000_000,
      emitRequirement() {},
    },
    createDesktopTurnContext: () => ({
      sessionId: "session-changed-digest",
      childPid: 4243,
      runId: "run-changed-digest",
      scope: {
        signal: new AbortController().signal,
        assertCurrent() {},
      },
    }),
  });

  await assert.rejects(fetcher(new Request("https://orcode-kimi-sdk.invalid/responses", {
    method: "POST",
    body: JSON.stringify({
      input: "hello",
      model: "k3",
      service_tier: "auto",
      store: false,
      stream: true,
      tools: [],
    }),
  })));
  assert.equal(credentialAuthorityCalls, 0);
  assert.equal(providerCalls, 0);
  assert.equal(permitReader.isOpen, true);
});

test("terminal-local rechecks current ownership immediately before credential access", async () => {
  let ownerChecks = 0;
  let credentialAuthorityCalls = 0;
  let providerCalls = 0;
  const credentialAuthority: ProviderCredentialAuthorityLike = {
    async withCredential(_request, use) {
      credentialAuthorityCalls += 1;
      assert.equal(ownerChecks, 2, "the second owner check must be adjacent to credential access");
      return {
        kind: "available",
        value: await use("terminal-kimi-secret", {
          source: "saved",
          binding: {
            version: 2,
            stateRevision: 4,
            connectionId: "connection-terminal",
            backendId: "kimi-code",
            enabled: true,
            credentialPointer: {
              kind: "versioned",
              slot: { version: 1, kind: "kimi-code", id: "11111111-1111-4111-8111-111111111111" },
            },
            accountFingerprint: "account-terminal",
            billingRealm: "kimi-code-membership-provider-managed-overage",
            isDefault: true,
          },
          candidatePermit: { version: 1 },
          async publishIfCurrent(publish) { publish(); },
        }),
      };
    },
  };
  const fetcher = createKimiResponsesFetcher({
    fetch: async () => {
      providerCalls += 1;
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => 1_775_000_000_000,
    route: {
      version: 1,
      backendId: "kimi-code",
      accountFingerprint: "account-terminal",
      billingRealm: "kimi-code-membership-provider-managed-overage",
      requestedModelId: "k3",
      canonicalModelId: "k3",
      resolutionState: "resolved",
    },
    binding: {
      version: 1,
      stateRevision: 4,
      generation: 9,
      connectionId: "connection-terminal",
      backendId: "kimi-code",
      accountFingerprint: "account-terminal",
      billingRealm: "kimi-code-membership-provider-managed-overage",
      canonicalModelId: "k3",
    },
    credentialAuthority,
    createRequestDeadlineAt: () => 1_775_000_060_000,
    executionOrigin: terminalLocalKimiExecutionOrigin({
      kind: "local-interactive-owner",
      async assertCurrent() { ownerChecks += 1; },
    }),
  });

  const response = await fetcher(new Request("https://orcode-kimi-sdk.invalid/responses", {
    method: "POST",
    body: JSON.stringify({
      input: "hello",
      model: "k3",
      service_tier: "auto",
      store: false,
      stream: true,
      tools: [],
    }),
  }));
  assert.equal(response.status, 200);
  assert.equal(ownerChecks, 2);
  assert.equal(credentialAuthorityCalls, 1);
  assert.equal(providerCalls, 1);
});
