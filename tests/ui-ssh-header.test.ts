/**
 * The SSH-target header segment (src/ui/render-frame.ts, src/ui/dashboard-frame.ts):
 * it must show up whenever a target is active, in caps, and it must be the
 * last segment the priority fitter drops — see the spec's "dauerhaft im
 * Kopfbereich sichtbar" requirement.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardFrame, type DashboardState } from "../src/ui/dashboard-frame.js";
import { buildFrame } from "../src/ui/render-frame.js";
import { lineWidth, plainText } from "../src/ui/spans.js";
import { createTheme } from "../src/ui/theme.js";

const theme = createTheme({ level: 0 });

function baseState(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    workspace: "/home/user/projekt/routercode",
    model: "sonnet-4.5",
    approval: "ask",
    compressor: "auto",
    compressorModel: "haiku",
    reasoning: "auto",
    balance: "$12.00",
    sessionCost: "$0.31",
    maxCost: "$5.00",
    maxSteps: 40,
    keyStatus: "Umgebungsvariable",
    ...overrides,
  };
}

test("no active SSH target: the header shows no SSH segment", () => {
  const frame = buildDashboardFrame({
    width: 100,
    height: 24,
    theme,
    state: baseState(),
    blocks: [],
    mode: "input",
    input: "",
    cursor: 0,
    status: "",
  });
  const header = plainText(frame.lines[0]!);
  assert.doesNotMatch(header, /SSH:/);
});

test("an active SSH target shows up in the header, in caps, once /ssh <alias> is set", () => {
  const frame = buildDashboardFrame({
    width: 100,
    height: 24,
    theme,
    state: baseState({ sshHost: "vps" }),
    blocks: [],
    mode: "input",
    input: "",
    cursor: 0,
    status: "",
  });
  const header = plainText(frame.lines[0]!);
  assert.match(header, /SSH: VPS/);
});

test("the SSH segment survives longer than the approval mode and model when the terminal is narrow", () => {
  // Priority 110 for the SSH segment vs. 100 for the model and 95 for the
  // approval mode (render-frame.ts's headerSegments): at a width where
  // something has to give, the SSH segment must be the last one standing.
  for (const width of [90, 70, 55, 45, 40]) {
    const frame = buildFrame({
      width,
      height: 24,
      theme,
      blocks: [],
      inputText: "",
      inputCursor: 0,
      header: {
        workspace: "/home/user/projekt/routercode-with-a-fairly-long-name",
        model: "some/very-long-model-id-that-eats-space",
        approvalMode: "auto-edit",
        costUsd: 1.2345,
        sshHost: "produktionsserver",
      },
    });
    const header = plainText(frame.lines[0]!);
    assert.match(header, /SSH:PRODUKTIONSSERVER|SSH: PRODUKTIONSSERVER/, `width ${width}: ${header}`);
  }
});

test("buildFrame keeps every line within the requested width even with the SSH segment present", () => {
  const frame = buildFrame({
    width: 50,
    height: 24,
    theme,
    blocks: [],
    inputText: "",
    inputCursor: 0,
    header: {
      workspace: "/home/user/projekt/routercode",
      model: "sonnet-4.5",
      approvalMode: "ask",
      costUsd: 0.31,
      sshHost: "vps",
    },
  });
  for (const line of frame.lines) {
    assert.ok(lineWidth(line) <= 50, `Zeile zu breit: ${plainText(line)}`);
  }
});
