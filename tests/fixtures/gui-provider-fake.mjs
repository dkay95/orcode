#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Builds one injected fake-provider child around the established GUI harness.
 * The transformed harness still imports the requested real dist/gui-server.js;
 * only its route authority/catalog facts and provider counters are replaced.
 */
export function createGuiProviderFake({ generation, routes, requests }) {
  if (routes.length !== 2) throw new Error("exactly two fake routes are required");
  return Object.freeze({
    generation,
    routes,
    requests,
    childEnvironment(guiModuleUrl, forceExternal = false) {
      return {
        ORCODE_GUI_SERVER_MODULE: guiModuleUrl,
        ORCODE_GUI_FAKE_GENERATION: String(generation),
        ORCODE_GUI_FAKE_ROUTES: JSON.stringify(routes),
        ORCODE_GUI_FAKE_EXTERNAL: forceExternal ? "1" : "0",
      };
    },
  });
}

async function main() {
  const guiModuleUrl = process.env.ORCODE_GUI_SERVER_MODULE;
  if (!guiModuleUrl) throw new Error("ORCODE_GUI_SERVER_MODULE is missing");
  // Freshness/module existence is proven before either fake dispatch branch.
  await import(guiModuleUrl);
  const routes = JSON.parse(process.env.ORCODE_GUI_FAKE_ROUTES ?? "[]");
  const generation = Number(process.env.ORCODE_GUI_FAKE_GENERATION ?? 0);
  const childCounters = { authority: 0, localFake: 0, external: 0 };
  let dispatchCallbacks = 0;
  const providerDispatch = async (target, run) => {
    const host = new URL(target).hostname;
    if (host !== "127.0.0.1" && host !== "localhost") {
      childCounters.external += 1;
      throw new Error("external provider I/O is forbidden before dispatch");
    }
    childCounters.localFake += 1;
    dispatchCallbacks += 1;
    return run();
  };
  globalThis.__orcodeGuiFakeDispatch = providerDispatch;
  globalThis.__orcodeGuiFakeAuthority = () => { childCounters.authority += 1; };
  if (process.env.ORCODE_GUI_FAKE_EXTERNAL === "1") {
    try { await providerDispatch("https://provider.invalid/v1", async () => { dispatchCallbacks += 1; }); }
    catch (error) { process.stderr.write(`ORCODE_GUI_FAKE_RESULT:${JSON.stringify({ generation, counters: childCounters, dispatchCallbacks, error: error.message })}\n`); }
    return;
  }
  if (routes.length !== 2) throw new Error("two injected routes are required");

  const basePath = join(dirname(fileURLToPath(import.meta.url)), "gui-server-harness.mjs");
  let source = await readFile(basePath, "utf8");
  source = source
    .replace('let crossWorkersStarted = 0;', 'let crossWorkersStarted = 0;\nconst fakePrompts = [];')
    .replace('const scenario = process.argv[2] ?? "default";', 'const scenario = "cross-preflight";')
    .replace('const MODEL_ID = "vendor/gui-main";', `const MODEL_ID = ${JSON.stringify(routes[0].canonicalModelId)};`)
    .replace('const ALT_MODEL_ID = "vendor/gui-alternate";', `const ALT_MODEL_ID = ${JSON.stringify(routes[1].canonicalModelId)};`)
    .replaceAll('"GUI Main"', '"GPT-5.4 Codex"')
    .replace('displayName: scenario.startsWith("cross") ? "GPT-5.4 Codex" : "GUI Alternate",',
      'displayName: scenario.startsWith("cross") ? "Kimi K3" : "GUI Alternate",')
    .replace('accountLabel: "Persönliches OpenRouter",',
      'accountLabel: handle === "alternate-target" ? "Kimi Privat" : "Codex Privat",')
    .replace('const readyDesktopSnapshot = (revision = 1, generation = 1,', `const readyDesktopSnapshot = (revision = 1, generation = ${generation},`)
    .replaceAll('generation: 1,', `generation: ${generation},`)
    .replace('capture() {\n    routePickerCaptureCalls += 1;', 'capture() {\n    routePickerCaptureCalls += 1;\n    globalThis.__orcodeGuiFakeAuthority();')
    .replace(
      'crossWorkersStarted += 1;\n      const child = spawn(',
      'crossWorkersStarted += 1;\n      fakePrompts.push(_prompt);\n      await globalThis.__orcodeGuiFakeDispatch("http://127.0.0.1/fake-provider", async () => undefined);\n      if (crossWorkersStarted < 4) return { text: "ANSWER:\\nfixture\\n\\nREASONING:\\nfixture", outcome: "completed", costKnowledge: "known", costUsd: 0, mainCostUsd: 0, compressorCostUsd: 0 };\n      const child = spawn(',
    )
    .replace('scenario,\n    exitCode:', 'scenario,\n    fakeGenerationSeen: desktopSnapshot.generation,\n    exitCode:')
    .replace('crossWorkersStarted,\n    crossWorkersAborted,', 'crossWorkersStarted,\n    fakePrompts,\n    crossWorkersAborted,');

  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk, ...args) => {
    const text = String(chunk);
    if (!text.startsWith("ORCODE_GUI_RESULT:")) return originalWrite(chunk, ...args);
    const result = JSON.parse(text.slice("ORCODE_GUI_RESULT:".length));
    const injected = {
      ...result,
      injectedRoutes: routes,
      counters: childCounters,
      dispatchCallbacks,
      singleModelFallbacks: result.agentCalls,
    };
    return originalWrite(`ORCODE_GUI_FAKE_RESULT:${JSON.stringify(injected)}\n`, ...args);
  });
  process.argv[2] = "cross-preflight";
  await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
}
