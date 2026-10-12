import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * `@core` is a deliberately NARROW seam: the frontend imports the repo's
 * dependency-free pure formatters (`src/utils.ts` — no imports at all, so
 * nothing node-shaped follows it into the bundle) so a chat row's wording
 * has exactly one source. Anything with a dependency stays behind the pipe.
 */
const core = fileURLToPath(new URL("../src", import.meta.url));

export default defineConfig({
  clearScreen: false,
  resolve: { alias: { "@core": core } },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    // The Rust watcher owns `src-tauri`, and `.devhome` is a live app home
    // the engine writes into — a reload on every session write would make
    // the dev loop unusable.
    watch: { ignored: ["**/src-tauri/**", "**/.devhome/**"] },
    fs: { allow: ["./", core] },
  },
  build: {
    // The WebView is WKWebView on the minimum macOS this app supports.
    target: "safari16",
    sourcemap: true,
    emptyOutDir: true,
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
});
