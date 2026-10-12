import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

const core = fileURLToPath(new URL("../src", import.meta.url));

export default defineConfig({
  resolve: { alias: { "@core": core } },
  test: {
    exclude: [...configDefaults.exclude, "browser-tests/**"],
  },
});
