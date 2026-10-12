import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const core = fileURLToPath(new URL("../src", import.meta.url));
// Use a locally installed browser when the Playwright download is unavailable.
const browserPath = process.env.ORCODE_TEST_BROWSER_PATH;

export default defineConfig({
  resolve: { alias: { "@core": core } },
  test: {
    include: ["browser-tests/**/*.browser.test.ts"],
    browser: {
      enabled: true,
      provider: "playwright",
      instances: [{
        browser: "chromium",
        ...(browserPath ? { launch: { executablePath: browserPath } } : {}),
      }],
    },
  },
});
