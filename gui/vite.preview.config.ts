import { fileURLToPath } from "node:url";
import { mergeConfig } from "vite";
import base from "./vite.config.js";

export default mergeConfig(base, {
  build: {
    outDir: "preview-dist",
    rollupOptions: { input: fileURLToPath(new URL("./workbench-preview.html", import.meta.url)) },
  },
});
