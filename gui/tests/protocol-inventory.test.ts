import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ASK_KINDS, EVENT_NAMES, PROTOCOL_VERSION, REQUEST_TYPES, parseFrame } from "../src/protocol.js";

/**
 * The drift guard.
 *
 * `src/gui-protocol.ts` is the protocol's one definition, and this file
 * cannot import it (its type graph reaches into the core, which has no
 * business in a WebView). So the real file is READ, and a new request type,
 * event or ask kind that the frontend has not been told about fails here
 * rather than at a window that quietly ignores it.
 */
const source = readFileSync(
  fileURLToPath(new URL("../../src/gui-protocol.ts", import.meta.url)),
  "utf8",
);
const windowSource = readFileSync(
  fileURLToPath(new URL("../src/protocol.ts", import.meta.url)),
  "utf8",
);
const desktopContractSource = readFileSync(
  fileURLToPath(new URL("../../src/desktop-contracts.ts", import.meta.url)),
  "utf8",
);

const EXPECTED_REQUEST_TYPES = [
  "hello-ack", "submit", "cancel", "interject", "end-thinking", "command", "catalog.level", "catalog.search",
  "chats.list", "chat.open", "chat.new", "chat.delete", "status.get", "cost.forecast", "settings.open",
  "settings.dispatch", "desktop.snapshot.get", "official-cli.action", "local-run.action", "execution-policy.set", "project.open", "onboarding.dispatch", "settings.close", "answer", "shutdown",
];

const EXPECTED_EVENT_NAMES = [
  "run", "assistant", "status", "transcript", "suggestions", "context-percent", "attachments", "draft",
  "command-output", "cross", "settings.view", "settings.closed", "desktop.snapshot", "local-run.state", "onboarding.view",
  "activity", "native-local-action-required", "setup.present", "chat.opened", "chat.reset", "notice", "fatal",
];

const GUI_TEST_DIRECTORY = fileURLToPath(new URL(".", import.meta.url));
const CURRENT_VERSION_FIXTURES = readdirSync(GUI_TEST_DIRECTORY)
  .filter((name) => name.endsWith(".test.ts") && name !== "protocol-inventory.test.ts")
  .map((name) => new URL(`./${name}`, import.meta.url))
  .map((url) => fileURLToPath(url))
  .concat(
  fileURLToPath(new URL("../../tests/gui-protocol.test.ts", import.meta.url)),
);

function names(constant: string): string[] {
  const match = source.match(new RegExp(`export const ${constant} = Object\\.freeze\\(\\[([\\s\\S]*?)\\] as const\\)`));
  if (!match) throw new Error(`${constant} was not found in src/gui-protocol.ts`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function unionNames(input: string, typeName: string): string[] {
  const match = input.match(new RegExp(`export type ${typeName} =([\\s\\S]*?);`));
  if (!match) throw new Error(`${typeName} was not found`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function interfaceBody(input: string, interfaceName: string): string {
  const match = input.match(new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`${interfaceName} was not found`);
  return match[1];
}

function unionBody(input: string, typeName: string): string {
  const match = input.match(new RegExp(`export type ${typeName} =([\\s\\S]*?);\\nexport `));
  if (!match) throw new Error(`${typeName} was not found`);
  return match[1];
}

describe("the inventory the engine actually speaks", () => {
  it("has the request types this window knows", () => {
    expect(REQUEST_TYPES).toEqual(EXPECTED_REQUEST_TYPES);
    expect(REQUEST_TYPES).toEqual(names("GUI_REQUEST_TYPES"));
  });

  it("has the events this window knows", () => {
    expect(EVENT_NAMES).toEqual(EXPECTED_EVENT_NAMES);
    expect(EVENT_NAMES).toEqual(names("GUI_EVENT_NAMES"));
  });

  it("has the ask kinds this window knows", () => {
    expect(ASK_KINDS).toEqual(names("GUI_ASK_KINDS"));
  });

  it("is the same protocol version", () => {
    const match = source.match(/export const GUI_PROTOCOL_VERSION = (\d+)/);
    expect(match?.[1]).toBe(String(PROTOCOL_VERSION));
  });

  it("keeps every closed Desktop disabled reason identical", () => {
    expect(unionNames(windowSource, "DesktopDisabledReasonCode"))
      .toEqual(unionNames(desktopContractSource, "DesktopDisabledReasonCode"));
  });

  it("keeps the canonical Desktop snapshot, onboarding, and activity names", () => {
    expect(REQUEST_TYPES.filter((name) => name.startsWith("desktop.") || name.startsWith("onboarding.")))
      .toEqual(["desktop.snapshot.get", "onboarding.dispatch"]);
    expect(EVENT_NAMES.filter((name) => name.startsWith("desktop.") || name.startsWith("onboarding.") || name === "activity"))
      .toEqual(["desktop.snapshot", "onboarding.view", "activity"]);
    expect(interfaceBody(windowSource, "DesktopSnapshotEvent"))
      .toMatch(/readonly snapshot: DesktopCapabilitySnapshot/);
    expect(interfaceBody(windowSource, "DesktopOnboardingViewEvent"))
      .toMatch(/readonly view: DesktopOnboardingView/);
    expect(interfaceBody(windowSource, "DesktopActivityEvent"))
      .toMatch(/readonly activity: DesktopActivity/);
  });

  it("keeps operation-bound onboarding Cancel identical across core and window", () => {
    for (const input of [desktopContractSource, windowSource]) {
      expect(interfaceBody(input, "DesktopOnboardingView"))
        .toMatch(/readonly operationHandle\?: string/);
      expect(unionBody(input, "DesktopOnboardingIntent"))
        .toMatch(/kind: "cancel"[^}]*operationHandle\?: string/);
    }
  });

  it("keeps all five ordinary Settings editor presentations closed and free of Registry authority", () => {
    for (const input of [desktopContractSource, windowSource]) {
      expect(unionNames(input, "DesktopSettingsEditorKind"))
        .toEqual(["choice", "number", "text", "confirm", "invoke"]);
      const presentation = unionBody(input, "DesktopSettingsEditorPresentation");
      expect(presentation).toMatch(/DesktopSettingsChoiceEditorPresentation/);
      expect(presentation).toMatch(/DesktopSettingsNumberEditorPresentation/);
      expect(presentation).toMatch(/DesktopSettingsTextEditorPresentation/);
      expect(presentation).toMatch(/DesktopSettingsConfirmEditorPresentation/);
      expect(presentation).toMatch(/DesktopSettingsInvokeEditorPresentation/);
    }
    const askBody = interfaceBody(source, "GuiSettingsEditorAsk");
    expect(askBody).toMatch(/readonly editor: DesktopSettingsEditorPresentation/);
    expect(askBody).not.toMatch(/SettingsEditorRequest|generation|itemId|categoryId|actionId|validationMessage|candidates/);
  });

  it("keeps native action display-only with no public result, control, permit, or private field", () => {
    const publicNames = [...REQUEST_TYPES, ...EVENT_NAMES, ...ASK_KINDS];
    expect(EVENT_NAMES).toContain("native-local-action-required");
    expect(REQUEST_TYPES).not.toContain("native-local-action-result");
    expect(publicNames.some((name) => /kimi.*(?:result|control|permit)|(?:result|control|permit).*kimi/i.test(name))).toBe(false);
    expect(publicNames.some((name) => /native-local-action-(?:result|control|permit)/i.test(name))).toBe(false);
    for (const body of [
      interfaceBody(desktopContractSource, "NativeLocalActionRequirement"),
      interfaceBody(windowSource, "NativeLocalActionRequirement"),
      interfaceBody(source, "GuiNativeLocalActionRequiredEvent"),
      interfaceBody(windowSource, "NativeLocalActionRequiredEvent"),
    ]) {
      expect(body).not.toMatch(/permit|nonce|secret|rawFd|route|digest|diagnostic/i);
    }
  });

  it("keeps current client fixtures on the canonical protocol version", () => {
    for (const fixture of CURRENT_VERSION_FIXTURES) {
      expect(readFileSync(fixture, "utf8")).not.toMatch(/(?:\bv:\s*\d+\b|"v"\s*:\s*\d+\b)/);
    }
  });
});

describe("a line off the pipe", () => {
  it("is a frame only when it says which kind it is", () => {
    expect(parseFrame(JSON.stringify({ v: PROTOCOL_VERSION, t: "hello", protocol: PROTOCOL_VERSION }))?.t).toBe("hello");
    expect(parseFrame(JSON.stringify({ v: PROTOCOL_VERSION, t: "nonsense" }))).toBeNull();
    expect(parseFrame("")).toBeNull();
  });

  it("does not parse a forged native-action result as a client action", () => {
    expect(parseFrame(JSON.stringify({
      v: PROTOCOL_VERSION,
      t: "native-local-action-result",
      permit: "forged-public-permit",
    }))).toBeNull();
  });

  it("is never content when it is not JSON", () => {
    // The core's own stray stdout writes would arrive exactly like this, and
    // rendering them as chat text is the failure G0's R1 names.
    expect(parseFrame("Thinking about the answer …")).toBeNull();
    expect(parseFrame("[31mred[0m")).toBeNull();
  });
});
