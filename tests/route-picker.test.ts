import assert from "node:assert/strict";
import test from "node:test";

import type { RouteIdentityV1 } from "../src/backends.js";
import type { DesktopCapabilitySnapshot, DesktopRouteCandidate } from "../src/desktop-contracts.js";
import {
  createRoutePickerAuthority,
  proveActivatedRoutePickerSelection,
  validateResolvedRoutePickerPair,
} from "../src/route-picker.js";
import * as routePickerModule from "../src/route-picker.js";

test("null, unknown, duplicated, disabled, and non-runnable selections never resolve", () => {
  const fixture = pickerFixture();
  assert.throws(() => fixture.authority.resolve({ role: "main" }, null as never), /selection|route/i);
  assert.throws(() => fixture.authority.resolve({ role: "main" }, {
    handle: "unknown", revision: 7, generation: 4,
  }), /selection|route/i);

  fixture.setSnapshot(snapshot({ candidates: [candidate("source-a"), candidate("source-a")] }));
  assert.throws(() => fixture.authority.view({ role: "main" }), /route picker is unavailable/i);

  fixture.setSnapshot(snapshot({ candidates: [candidate("disabled", { disabled: true }), candidate("stopped", { runnable: false })] }));
  const view = fixture.authority.view({ role: "main" });
  const readsBeforeRefusal = fixture.captureReads;
  for (const row of view.candidates) {
    assert.throws(() => fixture.authority.resolve({ role: "main" }, {
      handle: row.handle, revision: view.revision, generation: view.generation,
    }), /unavailable|route/i);
  }
  assert.equal(fixture.captureReads, readsBeforeRefusal + view.candidates.length, "each refusal uses one atomic capture");
});

test("revision, generation, authority instance, request filter, and live public/private agreement are mandatory", () => {
  const fixture = pickerFixture();
  const view = fixture.authority.view({ role: "main", connectionId: "account-a" });
  const selected = view.candidates[0]!;
  assert.throws(() => fixture.authority.resolve({ role: "main", connectionId: "account-a" }, {
    handle: selected.handle, revision: 6, generation: 4,
  }), /stale/i);
  assert.throws(() => fixture.authority.resolve({ role: "main", connectionId: "account-a" }, {
    handle: selected.handle, revision: 7, generation: 3,
  }), /stale/i);

  const second = pickerFixture({ snapshot: fixture.snapshot(), bindings: fixture.bindings });
  assert.throws(() => second.authority.resolve({ role: "main", connectionId: "account-a" }, {
    handle: selected.handle, revision: 7, generation: 4,
  }), /selection|route/i);
  assert.throws(() => fixture.authority.resolve({ role: "main", connectionId: "account-b" }, {
    handle: selected.handle, revision: 7, generation: 4,
  }), /selection|route/i);

  fixture.setSnapshot(snapshot({ candidates: [candidate("source-a", { canonicalModelId: "vendor/tampered" })] }));
  assert.throws(() => fixture.authority.resolve({ role: "main", connectionId: "account-a" }, {
    handle: selected.handle, revision: 7, generation: 4,
  }), /mismatch|route/i);
});

test("same-epoch capability revocation is rejected before core returns a resolved selection", () => {
  const fixture = pickerFixture({ snapshot: snapshot({ candidates: [
    candidate("source-a", { capabilities: ["text", "tools"] }),
  ] }) });
  const view = fixture.authority.view({ role: "lead" });
  const selected = view.candidates[0]!;

  fixture.setSnapshot(snapshot({ candidates: [
    candidate("source-a", { capabilities: ["text"] }),
  ] }));

  assert.throws(() => fixture.authority.resolve({ role: "lead" }, {
    handle: selected.handle, revision: view.revision, generation: view.generation,
  }), /current route|selection|unavailable/i);
});

test("confirmed no-tools choices stay compressor-only across role views and replayed handles", () => {
  const fixture = pickerFixture({
    snapshot: snapshot({ candidates: [candidate("source-a", { capabilities: ["text"] })] }),
    codingIneligibleHandles: new Set(["source-a"]),
  });
  const compressor = fixture.authority.view({ role: "compressor" });
  const selection = {
    handle: compressor.candidates[0]!.handle,
    revision: compressor.revision,
    generation: compressor.generation,
  };
  assert.equal(compressor.candidates[0]!.runnable, true);
  for (const role of ["main", "lead", "challenger", "executor"] as const) {
    const coding = fixture.authority.view({ role });
    assert.equal(coding.candidates[0]!.runnable, false, role);
    assert.equal(coding.candidates[0]!.disabled?.code, "model-not-runnable", role);
    assert.throws(() => fixture.authority.resolve({ role }, selection), /unavailable/, role);
  }
  assert.equal(fixture.authority.resolve({ role: "compressor" }, selection).candidate.runnable, true);
  assert.doesNotMatch(JSON.stringify(compressor), /codingIneligible|source-a/);
});

test("late same-epoch no-tools proof blocks a previously shown coding handle without blocking compression", () => {
  const ineligible = new Set<string>();
  const fixture = pickerFixture({
    snapshot: snapshot({ candidates: [candidate("source-a", { capabilities: ["text"] })] }),
    codingIneligibleHandles: ineligible,
  });
  const initial = fixture.authority.view({ role: "main" });
  assert.equal(initial.candidates[0]!.runnable, true, "unknown cold metadata does not revoke the active route");
  const selection = { handle: initial.candidates[0]!.handle, revision: initial.revision, generation: initial.generation };
  ineligible.add("source-a");
  assert.throws(() => fixture.authority.resolve({ role: "main" }, selection), /unavailable/);
  assert.equal(fixture.authority.resolve({ role: "compressor" }, selection).candidate.runnable, true);
});

test("same-epoch consent metadata is exact while capability order is semantic and resolves current truth", () => {
  const original: DesktopRouteCandidate = {
    ...candidate("source-a", { capabilities: ["text", "tools", "reasoning"] }),
    cost: { kind: "known", label: "0,01 EUR", source: "provider" },
    dataPolicy: { kind: "known", label: "EU-Verarbeitung", source: "provider" },
  };
  const drifts: readonly [string, (candidate: DesktopRouteCandidate) => DesktopRouteCandidate][] = [
    ["account label", (value) => ({ ...value, accountLabel: "Anderes Konto" })],
    ["display name", (value) => ({ ...value, displayName: "Anderes Modell" })],
    ["reasoning", (value) => ({ ...value, reasoning: "unsupported" })],
    ["capabilities", (value) => ({ ...value, capabilities: ["text", "tools"] })],
    ["cost label", (value) => ({ ...value, cost: { kind: "known", label: "0,02 EUR", source: "provider" } })],
    ["cost source", (value) => ({ ...value, cost: { kind: "known", label: "0,01 EUR", source: "subscription" } })],
    ["data-policy label", (value) => ({ ...value, dataPolicy: { kind: "known", label: "US-Verarbeitung", source: "provider" } })],
    ["data-policy source", (value) => ({ ...value, dataPolicy: { kind: "known", label: "EU-Verarbeitung", source: "owner-config" } })],
  ];

  for (const [name, drift] of drifts) {
    const fixture = pickerFixture({ snapshot: snapshot({ candidates: [original] }) });
    const view = fixture.authority.view({ role: "lead" });
    fixture.setSnapshot(snapshot({ candidates: [drift(original)] }));
    assert.throws(() => fixture.authority.resolve({ role: "lead" }, {
      handle: view.candidates[0]!.handle, revision: view.revision, generation: view.generation,
    }), /current route|selection|unavailable/i, name);
  }

  const reordered = pickerFixture({ snapshot: snapshot({ candidates: [original] }) });
  const view = reordered.authority.view({ role: "lead" });
  reordered.setSnapshot(snapshot({ candidates: [{
    ...original, capabilities: ["reasoning", "tools", "text"],
  }] }));
  const resolved = reordered.authority.resolve({ role: "lead" }, {
    handle: view.candidates[0]!.handle, revision: view.revision, generation: view.generation,
  });
  assert.equal(resolved.candidate.handle, view.candidates[0]!.handle);
  assert.deepEqual(resolved.candidate.capabilities, ["reasoning", "tools", "text"]);
});

test("handles stay stable only inside one exact epoch and resolve two same-model accounts exactly", () => {
  const fixture = pickerFixture();
  const first = fixture.authority.view({ role: "lead" });
  const same = fixture.authority.view({ role: "lead" });
  assert.deepEqual(same.candidates.map((row) => row.handle), first.candidates.map((row) => row.handle));
  assert.notEqual(first.candidates[0]?.handle, first.candidates[1]?.handle);

  const resolved = first.candidates.map((row) => fixture.authority.resolve({ role: "lead" }, {
    handle: row.handle, revision: first.revision, generation: first.generation,
  }));
  assert.deepEqual(resolved.map((entry) => entry.connectionId), ["account-a", "account-b"]);
  assert.deepEqual(resolved.map((entry) => entry.route.accountFingerprint), ["private-a", "private-b"]);
  assert.equal(resolved.every((entry) => entry.route.canonicalModelId === "vendor/shared"), true);

  fixture.setSnapshot(snapshot({ revision: 8 }));
  const revised = fixture.authority.view({ role: "lead" });
  assert.notEqual(revised.candidates[0]?.handle, first.candidates[0]?.handle);
  assert.throws(() => fixture.authority.resolve({ role: "lead" }, {
    handle: first.candidates[0]!.handle, revision: 8, generation: 4,
  }), /selection|route/i);

  fixture.setSnapshot(snapshot({ revision: 8, generation: 5 }));
  const regenerated = fixture.authority.view({ role: "lead" });
  assert.notEqual(regenerated.candidates[0]?.handle, revised.candidates[0]?.handle);
});

test("same-epoch binding drift retires the old handle and returned views are mutation-isolated", () => {
  const fixture = pickerFixture();
  const first = fixture.authority.view({ role: "main" });
  const old = first.candidates[0]!;
  assert.throws(() => (old.capabilities as string[]).push("private-canary"), TypeError);
  const unchanged = fixture.authority.view({ role: "main" });
  assert.deepEqual(unchanged.candidates[0]?.capabilities, ["text"]);

  fixture.setBinding("source-a", { connectionId: "account-a", route: {
    ...privateRoute("private-a"), requestedModelId: "vendor/rebound", canonicalModelId: "vendor/rebound",
  } });
  fixture.setSnapshot(snapshot({ candidates: [
    candidate("source-a", { canonicalModelId: "vendor/rebound" }),
    candidate("source-b", { connectionId: "account-b", accountLabel: "Konto B" }),
  ] }));
  const rebound = fixture.authority.view({ role: "main" });
  assert.notEqual(rebound.candidates[0]?.handle, old.handle);
  assert.throws(() => fixture.authority.resolve({ role: "main" }, {
    handle: old.handle, revision: first.revision, generation: first.generation,
  }), /selection|route/i);
});

test("public route-picker views are allowlisted and never serialize private route material", () => {
  const fixture = pickerFixture();
  const view = fixture.authority.view({ role: "executor" });
  assert.deepEqual(Object.keys(view).sort(), ["candidates", "generation", "revision"]);
  assert.deepEqual(Object.keys(view.candidates[0]!).sort(), [
    "accountLabel", "canonicalModelId", "capabilities", "connectionId", "cost", "dataPolicy",
    "displayName", "handle", "providerId", "providerLabel", "reasoning", "runnable",
  ]);
  assert.doesNotMatch(JSON.stringify(view), /private-|billingRealm|accountFingerprint|credential|adapter|routeIdentity/i);
  assert.doesNotMatch(JSON.stringify(view), /source-a|source-b|bindings|capture|publicBySource/i);
});

test("the shared picker carries the owning safe provider label without deriving its provider id", () => {
  const source = snapshot();
  const fixture = pickerFixture({
    snapshot: {
      ...source,
      providers: source.providers.map((provider) => ({
        ...provider,
        providerLabel: "Sicherer Anbietername",
      })),
    },
  });

  const view = fixture.authority.view({ role: "lead" });
  assert.deepEqual(view.candidates.map((candidate) => candidate.providerLabel), [
    "Sicherer Anbietername",
    "Sicherer Anbietername",
  ]);
  assert.equal(view.candidates.some((candidate) => candidate.providerLabel === candidate.providerId), false);
  assert.equal(
    fixture.snapshot().providers.flatMap((provider) => provider.routes)
      .some((candidate) => Object.hasOwn(candidate, "providerLabel")),
    false,
    "the picker-only presentation must not widen the canonical Foundation route DTO",
  );
});

test("paired roles reject only the exact same private route", () => {
  const fixture = pickerFixture();
  const view = fixture.authority.view({ role: "lead" });
  const first = fixture.authority.resolve({ role: "lead" }, {
    handle: view.candidates[0]!.handle, revision: view.revision, generation: view.generation,
  });
  const second = fixture.authority.resolve({ role: "challenger" }, {
    handle: view.candidates[1]!.handle, revision: view.revision, generation: view.generation,
  });
  assert.doesNotThrow(() => validateResolvedRoutePickerPair(first, second));
  assert.throws(() => validateResolvedRoutePickerPair(first, { ...second, route: structuredClone(first.route) }), /different|distinct/i);
});

test("two public rows backed by one exact private route are rejected as ambiguous", () => {
  const fixture = pickerFixture();
  fixture.setBinding("source-b", { connectionId: "account-a", route: privateRoute("private-a") });
  fixture.setSnapshot(snapshot({ candidates: [
    candidate("source-a"), candidate("source-b", { connectionId: "account-a" }),
  ] }));
  assert.throws(() => fixture.authority.view({ role: "main" }), /route picker is unavailable/i);
});

test("retired handles stay retired across same-epoch A to B to A binding drift", () => {
  const fixture = pickerFixture();
  const initial = fixture.authority.view({ role: "main" });
  const old = initial.candidates[0]!;
  fixture.setBinding("source-a", { connectionId: "account-a", route: privateRouteFor("private-a", "vendor/b") });
  fixture.setSnapshot(snapshot({ candidates: [candidate("source-a", { canonicalModelId: "vendor/b" })] }));
  const middle = fixture.authority.view({ role: "main" });
  fixture.setBinding("source-a", { connectionId: "account-a", route: privateRoute("private-a") });
  fixture.setSnapshot(snapshot({ candidates: [candidate("source-a")] }));
  const returned = fixture.authority.view({ role: "main" });
  assert.notEqual(middle.candidates[0]?.handle, old.handle);
  assert.notEqual(returned.candidates[0]?.handle, old.handle);
  assert.throws(() => fixture.authority.resolve({ role: "main" }, {
    handle: old.handle, revision: initial.revision, generation: initial.generation,
  }), /selection|route/i);
});

test("a duplicate private route introduced after view rejects at resolve time", () => {
  const fixture = pickerFixture();
  const view = fixture.authority.view({ role: "main" });
  fixture.setBinding("source-b", { connectionId: "account-a", route: privateRoute("private-a") });
  fixture.setSnapshot(snapshot({ candidates: [candidate("source-a"), candidate("source-b", { connectionId: "account-a" })] }));
  assert.throws(() => fixture.authority.resolve({ role: "main" }, {
    handle: view.candidates[0]!.handle, revision: view.revision, generation: view.generation,
  }), /duplicate|ambiguous/i);
});

test("roles are closed before source reads and every role replays the text constraint", () => {
  const fixture = pickerFixture();
  const reads = fixture.snapshotReads;
  assert.throws(() => fixture.authority.view({ role: "voice" as never }), /role/i);
  assert.equal(fixture.snapshotReads, reads);
  assert.throws(() => fixture.authority.resolve({ role: "voice" as never }, {
    handle: "anything", revision: 7, generation: 4,
  }), /role/i);
  assert.equal(fixture.snapshotReads, reads);

  for (const role of ["main", "compressor", "lead", "challenger", "executor"] as const) {
    const local = pickerFixture();
    const view = local.authority.view({ role });
    local.setSnapshot(snapshot({ candidates: [candidate("source-a", { capabilities: [] })] }));
    assert.throws(() => local.authority.resolve({ role }, {
      handle: view.candidates[0]!.handle, revision: view.revision, generation: view.generation,
    }), /role|unavailable|route/i);
  }
});

test("core projection uses one captured snapshot and joins public handles by source handle", () => {
  const fixture = pickerFixture();
  const captured = snapshot({ candidates: [candidate("source-a"), candidate("source-b", { connectionId: "account-b" })] });
  fixture.setSnapshot(snapshot({ generation: 99, candidates: [candidate("source-b", { connectionId: "account-b" }), candidate("source-a")] }));
  const reads = fixture.snapshotReads;
  const projectCoreRoutePickerView = (routePickerModule as unknown as {
    projectCoreRoutePickerView: (
      authority: ReturnType<typeof pickerFixture>["authority"],
      request: { role: "main" },
      capture: { snapshot: DesktopCapabilitySnapshot; bindings: ReadonlyMap<string, { connectionId: string; route: RouteIdentityV1 }> },
    ) => { view: { generation: number; candidates: readonly DesktopRouteCandidate[] }; handleForSource(handle: string): string | undefined };
  }).projectCoreRoutePickerView;
  const projected = projectCoreRoutePickerView(fixture.authority, { role: "main" }, {
    snapshot: captured,
    bindings: new Map([...fixture.bindings].filter(([handle]) => handle === "source-a" || handle === "source-b")),
  });
  assert.equal(fixture.snapshotReads, reads);
  assert.equal(projected.view.generation, 4);
  assert.deepEqual(captured.providers[0]!.routes.map((row) => projected.handleForSource(row.handle)),
    projected.view.candidates.map((row) => row.handle));
});

test("public candidates are rebuilt field by field and source failures are fixed and silent", () => {
  const privateCanary = "ROUTE_PICKER_PRIVATE_CANARY";
  const dirty = {
    ...candidate("source-a"), route: privateCanary, accountFingerprint: privateCanary,
    credentialPointer: privateCanary, adapter: privateCanary,
    cost: { kind: "unknown", label: "Kosten unbekannt", privateCanary },
    dataPolicy: { kind: "unknown", label: "Datenrichtlinie unbekannt", privateCanary },
  } as unknown as DesktopRouteCandidate;
  const fixture = pickerFixture({ snapshot: snapshot({ candidates: [dirty] }) });
  const view = fixture.authority.view({ role: "main" });
  const resolved = fixture.authority.resolve({ role: "main" }, {
    handle: view.candidates[0]!.handle, revision: view.revision, generation: view.generation,
  });
  assert.doesNotMatch(JSON.stringify([view, resolved.candidate]), new RegExp(privateCanary));
  assert.deepEqual(Object.keys(view.candidates[0]!).sort(), [
    "accountLabel", "canonicalModelId", "capabilities", "connectionId", "cost", "dataPolicy",
    "displayName", "handle", "providerId", "providerLabel", "reasoning", "runnable",
  ]);
  assert.deepEqual(Object.keys(view.candidates[0]!.cost!).sort(), ["kind", "label"]);
  assert.deepEqual(Object.keys(view.candidates[0]!.dataPolicy!).sort(), ["kind", "label"]);

  const captured: string[] = [];
  const throwing = createRoutePickerAuthority({
    capture() { throw new Error(privateCanary); },
  });
  const bindingThrowing = createRoutePickerAuthority({
    capture() { return { snapshot: snapshot({ candidates: [candidate("source-a")] }), get bindings(): ReadonlyMap<string, never> { throw new Error(privateCanary); } }; },
  });
  for (const operation of [
    () => throwing.view({ role: "main" }),
    () => throwing.resolve({ role: "main" }, { handle: "x", revision: 1, generation: 1 }),
    () => bindingThrowing.view({ role: "main" }),
  ]) {
    assert.throws(operation, (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      captured.push(message);
      return /route picker/i.test(message) && !message.includes(privateCanary);
    });
  }
  assert.doesNotMatch(JSON.stringify(captured), new RegExp(privateCanary));
});

test("one bulk capture prevents reentrant later-row reads from changing an earlier binding", () => {
  let calls = 0;
  const bindings = new Map([
    ["source-a", { connectionId: "account-a", route: privateRoute("private-a") }],
    ["source-b", { connectionId: "account-b", route: privateRoute("private-b") }],
  ]);
  const authority = createRoutePickerAuthority({
    capture() {
      calls += 1;
      return { snapshot: snapshot(), bindings };
    },
  });
  const view = authority.view({ role: "main" });
  assert.equal(calls, 1);
  bindings.set("source-a", { connectionId: "account-a", route: privateRoute("changed-after-capture") });
  assert.throws(() => authority.resolve({ role: "main" }, {
    handle: view.candidates[0]!.handle, revision: view.revision, generation: view.generation,
  }), /binding|match|route/i);
  assert.equal(calls, 2);
});

test("same-epoch disappearance permanently retires a handle and re-add mints a fresh one", () => {
  const fixture = pickerFixture();
  const first = fixture.authority.view({ role: "main" }).candidates[0]!.handle;
  fixture.setSnapshot(snapshot({ candidates: [] }));
  fixture.authority.view({ role: "main" });
  fixture.setSnapshot(snapshot({ candidates: [candidate("source-a")] }));
  const secondView = fixture.authority.view({ role: "main" });
  assert.notEqual(secondView.candidates[0]!.handle, first);
  assert.throws(() => fixture.authority.resolve({ role: "main" }, {
    handle: first, revision: secondView.revision, generation: secondView.generation,
  }), /unavailable|selection/i);
  for (let index = 0; index < 20; index += 1) {
    fixture.setSnapshot(snapshot({ candidates: [candidate(index % 2 ? "source-a" : "source-b", {
      connectionId: index % 2 ? "account-a" : "account-b",
    })] }));
    assert.equal(fixture.authority.view({ role: "main" }).candidates.length, 1);
  }
});

test("lazy snapshot, candidate, binding and route getters collapse to one fixed silent error", () => {
  const canary = "LAZY_PRIVATE_CANARY";
  const sinks: string[] = [];
  const operations = [
    () => createRoutePickerAuthority({ capture: () => ({
      get snapshot(): DesktopCapabilitySnapshot { throw new Error(canary); }, bindings: new Map(),
    }) }).view({ role: "main" }),
    () => createRoutePickerAuthority({ capture: () => ({
      snapshot: snapshot({ candidates: [Object.defineProperty(candidate("source-a"), "providerId", {
        get() { throw new Error(canary); },
      })] }), bindings: new Map(),
    }) }).view({ role: "main" }),
    () => createRoutePickerAuthority({ capture: () => ({
      snapshot: snapshot(), bindings: new Map([["source-a", Object.defineProperty({
        connectionId: "account-a", route: privateRoute("private-a"),
      }, "route", { get() { throw new Error(canary); } })]]),
    }) }).view({ role: "main" }),
  ];
  for (const operation of operations) assert.throws(operation, (error: unknown) => {
    const rendered = error instanceof Error ? `${error.message}${error.cause ?? ""}${error.stack ?? ""}` : String(error);
    sinks.push(rendered);
    return /route picker is unavailable/i.test(rendered) && !rendered.includes(canary);
  });
  assert.doesNotMatch(JSON.stringify(sinks), new RegExp(canary));
});

test("a late invalid capture cannot partially rotate authority handles", () => {
  const fixture = pickerFixture();
  const before = fixture.authority.view({ role: "main" });
  const original = fixture.bindings.get("source-a")!;
  fixture.setBinding("source-a", { connectionId: "account-a", route: privateRoute("transient") });
  fixture.setSnapshot(snapshot({ candidates: [candidate("source-a"), candidate("source-a")] }));
  assert.throws(() => fixture.authority.view({ role: "main" }), /route picker is unavailable/i);
  fixture.setBinding("source-a", original);
  fixture.setSnapshot(snapshot());
  assert.equal(fixture.authority.view({ role: "main" }).candidates[0]!.handle, before.candidates[0]!.handle);
});

test("request filtering preserves a present row but genuine removal retires it", () => {
  const fixture = pickerFixture();
  const initial = fixture.authority.view({ role: "main" });
  const b = initial.candidates.find((row) => row.connectionId === "account-b")!.handle;
  fixture.authority.view({ role: "main", connectionId: "account-a" });
  assert.equal(fixture.authority.view({ role: "main", connectionId: "account-b" }).candidates[0]!.handle, b);
  fixture.setSnapshot(snapshot({ candidates: [candidate("source-a")] }));
  fixture.authority.view({ role: "main" });
  fixture.setSnapshot(snapshot());
  assert.notEqual(fixture.authority.view({ role: "main", connectionId: "account-b" }).candidates[0]!.handle, b);
});

test("view and resolve reject an extra filtered binding without mutating prior handles", () => {
  const fixture = pickerFixture();
  const before = fixture.authority.view({ role: "main" });
  fixture.bindings.set("ghost-filtered", { connectionId: "other", route: privateRoute("ghost") });
  fixture.setIncludeExtraBindings(true);
  assert.throws(() => fixture.authority.view({ role: "main", connectionId: "account-a" }), /route picker is unavailable/i);
  assert.throws(() => fixture.authority.resolve({ role: "main", connectionId: "account-a" }, {
    handle: before.candidates[0]!.handle, revision: before.revision, generation: before.generation,
  }), /route picker is unavailable/i);
  fixture.bindings.delete("ghost-filtered");
  fixture.setIncludeExtraBindings(false);
  assert.equal(fixture.authority.view({ role: "main" }).candidates[0]!.handle, before.candidates[0]!.handle);
});

test("core projection commits no partial rotation when a late nested field throws", () => {
  const fixture = pickerFixture();
  const before = fixture.authority.view({ role: "main" });
  const poisoned = candidate("source-b", { connectionId: "account-b" });
  Object.defineProperty(poisoned.cost, "label", { get() { throw new Error("LATE_PRIVATE_CANARY"); } });
  const project = (routePickerModule as unknown as { projectCoreRoutePickerView: Function }).projectCoreRoutePickerView;
  assert.throws(() => project(fixture.authority, { role: "main" }, {
    snapshot: snapshot({ candidates: [candidate("source-a", { canonicalModelId: "vendor/changed" }), poisoned] }),
    bindings: new Map([...fixture.bindings].filter(([handle]) => handle === "source-a" || handle === "source-b")),
  }), /route picker is unavailable/i);
  assert.equal(fixture.authority.view({ role: "main" }).candidates[0]!.handle, before.candidates[0]!.handle);
});

test("post-inner proof waits for its supplied rebound capture and rejects a competing exact commit", async () => {
  const fixture = pickerFixture();
  const before = fixture.authority.view({ role: "main" });
  const selected = fixture.authority.resolve({ role: "main" }, {
    handle: before.candidates[0]!.handle, revision: before.revision, generation: before.generation,
  });
  let release!: (capture: unknown) => void;
  const rebound = new Promise((resolve) => { release = resolve; });
  const pending = proveActivatedRoutePickerSelection(fixture.authority, selected, {
    routeHandle: "source-a", revision: 8, generation: 5,
  }, () => rebound as never);
  release({
    snapshot: snapshot({ revision: 9, generation: 6, candidates: [candidate("source-b", { connectionId: "account-b" })] }),
    bindings: new Map([["source-b", fixture.bindings.get("source-b")!]]),
  });
  await assert.rejects(pending, /route|selection|setup|unavailable/i);
});

test("resolve eagerly rejects a lazy filtered-out row without changing the selected handle", () => {
  const fixture = pickerFixture();
  const before = fixture.authority.view({ role: "main" });
  const selected = before.candidates.find((row) => row.connectionId === "account-a")!;
  const poisoned = candidate("source-b", { connectionId: "account-b" });
  Object.defineProperty(poisoned, "displayName", { get() { throw new Error("FILTERED_PRIVATE_CANARY"); } });
  fixture.setSnapshot(snapshot({ candidates: [candidate("source-a"), poisoned] }));
  assert.throws(() => fixture.authority.resolve({ role: "main", connectionId: "account-a" }, {
    handle: selected.handle, revision: before.revision, generation: before.generation,
  }), (error: unknown) => {
    const rendered = error instanceof Error ? `${error.message}${error.cause ?? ""}${error.stack ?? ""}` : String(error);
    return /route picker is unavailable/i.test(rendered) && !rendered.includes("FILTERED_PRIVATE_CANARY");
  });
  fixture.setSnapshot(snapshot());
  assert.equal(fixture.authority.view({ role: "main" }).candidates[0]!.handle, selected.handle);
});

test("filtered binding A to B to A drift retires the original handle permanently", () => {
  const fixture = pickerFixture();
  const original = fixture.authority.view({ role: "main" }).candidates[0]!.handle;
  fixture.setBinding("source-a", { connectionId: "account-a", route: privateRoute("drift-b") });
  fixture.authority.view({ role: "main", connectionId: "account-b" });
  fixture.setBinding("source-a", { connectionId: "account-a", route: privateRoute("private-a") });
  fixture.authority.view({ role: "main", connectionId: "account-b" });
  const rebound = fixture.authority.view({ role: "main", connectionId: "account-a" });
  assert.notEqual(rebound.candidates[0]!.handle, original);
  assert.throws(() => fixture.authority.resolve({ role: "main" }, {
    handle: original, revision: rebound.revision, generation: rebound.generation,
  }), /unavailable|selection/i);
});

test("core resolve rejects an invalid role before touching a poisoned capture", () => {
  const fixture = pickerFixture();
  const view = fixture.authority.view({ role: "main" });
  let reads = 0;
  const resolve = (routePickerModule as unknown as { resolveCoreRoutePickerSelection: Function }).resolveCoreRoutePickerSelection;
  assert.throws(() => resolve(fixture.authority, { role: "voice" }, {
    handle: view.candidates[0]!.handle, revision: view.revision, generation: view.generation,
  }, { get snapshot() { reads += 1; throw new Error("PRIVATE"); }, bindings: new Map() }), /role/i);
  assert.equal(reads, 0);
});

test("a successful filtered resolve retires drift in another present row", () => {
  const fixture = pickerFixture();
  const initial = fixture.authority.view({ role: "main" });
  const a = initial.candidates.find((row) => row.connectionId === "account-a")!;
  const oldB = initial.candidates.find((row) => row.connectionId === "account-b")!.handle;
  fixture.setBinding("source-b", { connectionId: "account-b", route: privateRoute("drift-b") });
  assert.equal(fixture.authority.resolve({ role: "main", connectionId: "account-a" }, {
    handle: a.handle, revision: initial.revision, generation: initial.generation,
  }).connectionId, "account-a");
  fixture.setBinding("source-b", { connectionId: "account-b", route: privateRoute("private-b") });
  const rebound = fixture.authority.view({ role: "main", connectionId: "account-b" });
  assert.notEqual(rebound.candidates[0]!.handle, oldB);
  assert.throws(() => fixture.authority.resolve({ role: "main" }, {
    handle: oldB, revision: rebound.revision, generation: rebound.generation,
  }), /unavailable|selection/i);
});

test("the same filtered lazy poison stays silent and state-neutral through view and resolve", () => {
  const canary = "FILTERED_SHARED_LAZY_CANARY";
  const sink: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => { sink.push(values.map(String).join(" ")); };
  try {
    for (const operation of ["view", "resolve"] as const) {
      const fixture = pickerFixture();
      const baseline = fixture.authority.view({ role: "main" });
      const poisoned = candidate("source-b", { connectionId: "account-b" });
      Object.defineProperty(poisoned.dataPolicy, "label", { get() { throw new Error(canary); } });
      fixture.setSnapshot(snapshot({ candidates: [candidate("source-a"), poisoned] }));
      const invoke = operation === "view"
        ? () => fixture.authority.view({ role: "main", connectionId: "account-a" })
        : () => fixture.authority.resolve({ role: "main", connectionId: "account-a" }, {
          handle: baseline.candidates[0]!.handle, revision: baseline.revision, generation: baseline.generation,
        });
      assert.throws(invoke, (error: unknown) => {
        const rendered = error instanceof Error
          ? `${error.message}${String(error.cause ?? "")}${String(error.stack ?? "")}` : String(error);
        return /route picker is unavailable/i.test(rendered) && !rendered.includes(canary);
      });
      fixture.setSnapshot(snapshot());
      assert.deepEqual(fixture.authority.view({ role: "main" }).candidates.map((row) => row.handle),
        baseline.candidates.map((row) => row.handle));
    }
  } finally {
    console.error = originalError;
  }
  assert.doesNotMatch(JSON.stringify(sink), new RegExp(canary));
});

test("twenty remove and drift retirements mint unique handles and never resurrect any prior handle", () => {
  const fixture = pickerFixture({ snapshot: snapshot({ candidates: [candidate("source-a")] }) });
  const minted: string[] = [];
  let live = fixture.authority.view({ role: "main" });
  minted.push(live.candidates[0]!.handle);
  for (let index = 1; index < 20; index += 1) {
    if (index % 2 === 0) {
      fixture.setSnapshot(snapshot({ candidates: [] }));
      const empty = fixture.authority.view({ role: "main" });
      for (const retired of minted) assert.throws(() => fixture.authority.resolve({ role: "main" }, {
        handle: retired, revision: empty.revision, generation: empty.generation,
      }), /unavailable|selection/i);
    } else {
      fixture.setBinding("source-a", { connectionId: "account-a", route: privateRoute(`drift-${index}`) });
    }
    fixture.setSnapshot(snapshot({ candidates: [candidate("source-a")] }));
    live = fixture.authority.view({ role: "main" });
    const next = live.candidates[0]!.handle;
    assert.equal(minted.includes(next), false);
    for (const retired of minted) assert.throws(() => fixture.authority.resolve({ role: "main" }, {
      handle: retired, revision: live.revision, generation: live.generation,
    }), /unavailable|selection/i);
    minted.push(next);
  }
  assert.equal(new Set(minted).size, 20);
  assert.equal(fixture.authority.resolve({ role: "main" }, {
    handle: live.candidates[0]!.handle, revision: live.revision, generation: live.generation,
  }).selection.handle, live.candidates[0]!.handle);
  for (const retired of minted.slice(0, -1)) assert.throws(() => fixture.authority.resolve({ role: "main" }, {
    handle: retired, revision: live.revision, generation: live.generation,
  }), /unavailable|selection/i);
});

function pickerFixture(options: {
  snapshot?: DesktopCapabilitySnapshot;
  bindings?: ReadonlyMap<string, { readonly connectionId: string; readonly route: RouteIdentityV1 }>;
  codingIneligibleHandles?: ReadonlySet<string>;
} = {}) {
  let current = options.snapshot ?? snapshot();
  let snapshotReads = 0;
  let includeExtraBindings = false;
  const bindings = new Map(options.bindings ?? [
    ["source-a", { connectionId: "account-a", route: privateRoute("private-a") }],
    ["source-b", { connectionId: "account-b", route: privateRoute("private-b") }],
    ["disabled", { connectionId: "account-a", route: privateRoute("private-disabled") }],
    ["stopped", { connectionId: "account-a", route: privateRoute("private-stopped") }],
  ]);
  const authority = createRoutePickerAuthority({
    capture: () => {
      snapshotReads += 1;
      if (includeExtraBindings) return { snapshot: current, bindings };
      const handles = new Set(current.providers.flatMap((provider) => provider.routes.map((route) => route.handle)));
      return {
        snapshot: current,
        bindings: new Map([...bindings].filter(([handle]) => handles.has(handle))),
        codingIneligibleHandles: options.codingIneligibleHandles,
      };
    },
  });
  return {
    authority, bindings,
    snapshot: () => current,
    setSnapshot: (next: DesktopCapabilitySnapshot) => { current = next; },
    setBinding: (handle: string, binding: { readonly connectionId: string; readonly route: RouteIdentityV1 }) => { bindings.set(handle, binding); },
    setIncludeExtraBindings: (value: boolean) => { includeExtraBindings = value; },
    get captureReads() { return snapshotReads; },
    get snapshotReads() { return snapshotReads; },
  };
}

function snapshot(options: { revision?: number; generation?: number; candidates?: readonly DesktopRouteCandidate[] } = {}): DesktopCapabilitySnapshot {
  const candidates = options.candidates ?? [candidate("source-a"), candidate("source-b", { connectionId: "account-b", accountLabel: "Konto B" })];
  return {
    schemaVersion: 1, revision: options.revision ?? 7, generation: options.generation ?? 4,
    routeRunnable: false, activeRoute: null,
    providers: [{
      providerId: "openrouter", providerLabel: "OpenRouter",
      connectionId: null, accountLabel: null, state: "ready",
      setupMethods: ["openrouter-owner-connect"], multiProfile: { enabled: true }, routes: candidates,
    }],
    undoAvailable: false, appearance: { showLargeLogo: true, showHeaderMark: true },
  };
}

function candidate(handle: string, options: {
  connectionId?: string;
  accountLabel?: string;
  canonicalModelId?: string;
  capabilities?: readonly ("text" | "image-input" | "tools" | "reasoning")[];
  runnable?: boolean;
  disabled?: boolean;
} = {}): DesktopRouteCandidate {
  return {
    handle, providerId: "openrouter", connectionId: options.connectionId ?? "account-a",
    accountLabel: options.accountLabel ?? "Konto A",
    canonicalModelId: options.canonicalModelId ?? "vendor/shared", displayName: "Shared",
    reasoning: "supported", capabilities: options.capabilities ?? ["text"],
    cost: { kind: "unknown", label: "Kosten unbekannt" },
    dataPolicy: { kind: "unknown", label: "Datenrichtlinie unbekannt" },
    runnable: options.runnable ?? true,
    ...(options.disabled ? { disabled: { code: "route-stale", label: "Nicht verfügbar", recoveryLabel: "Aktualisieren" } } : {}),
  };
}

function privateRoute(accountFingerprint: string): RouteIdentityV1 {
  return privateRouteFor(accountFingerprint, "vendor/shared");
}

function privateRouteFor(accountFingerprint: string, model: string): RouteIdentityV1 {
  return {
    version: 1, backendId: "openrouter", accountFingerprint,
    billingRealm: "openrouter-payg", requestedModelId: model,
    canonicalModelId: model, resolutionState: "resolved",
  };
}
