import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import browserConfig from "../vitest.browser.config.js";

interface GuiPackage {
  readonly devDependencies: Record<string, string>;
}

const guiPackage = JSON.parse(readFileSync(
  fileURLToPath(new URL("../package.json", import.meta.url)),
  "utf8",
)) as GuiPackage;

it("pins the patched Browser Mode stack exactly", () => {
  expect(guiPackage.devDependencies.vitest).toBe("3.2.7");
  expect(guiPackage.devDependencies["@vitest/browser"]).toBe("3.2.7");
  expect(guiPackage.devDependencies.playwright).toBe("1.55.1");
  expect(browserConfig.test?.browser).toMatchObject({
    instances: [{ browser: "chromium" }],
  });
});
