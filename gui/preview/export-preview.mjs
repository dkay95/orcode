// Mechanical export of the built demo: one offline HTML, no source/account data.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const built = fileURLToPath(new URL("../preview-dist/", import.meta.url));
const target = resolve(process.argv[2] ?? resolve(built, "standalone.html"));
const html = await readFile(resolve(built, "workbench-preview.html"), "utf8");
const cssName = html.match(/href="\/assets\/([^"]+\.css)"/)?.[1];
const jsName = html.match(/src="\/assets\/([^"]+\.js)"/)?.[1];
if (!cssName || !jsName) throw new Error("Build the workbench preview first.");
const assets = resolve(built, "assets");
const data = new Map();
async function asset(filename) {
  if (basename(filename) !== filename) throw new Error("Unexpected asset path.");
  if (!data.has(filename)) {
    const mime = filename.endsWith(".woff2") ? "font/woff2"
      : filename.endsWith(".svg") ? "image/svg+xml" : null;
    if (!mime) throw new Error("Unexpected inline asset type.");
    data.set(filename, `data:${mime};base64,${(await readFile(resolve(assets, filename))).toString("base64")}`);
  }
  return data.get(filename);
}
let css = await readFile(resolve(assets, cssName), "utf8");
let js = await readFile(resolve(assets, jsName), "utf8");
for (const match of [...css.matchAll(/url\(\/assets\/([^)]*)\)/g)]) {
  css = css.replace(match[0], `url("${await asset(match[1])}")`);
}
for (const match of [...js.matchAll(/"\/assets\/([^"]+\.svg)"/g)]) {
  js = js.replace(match[0], JSON.stringify(await asset(match[1])));
}
const standalone = html
  .replace(/<script type="module"[^>]*src="\/assets\/[^\"]+"[^>]*><\/script>/,
    () => `<script type="module">${js.replaceAll("</script", "<\\/script")}</script>`)
  .replace(/<link rel="stylesheet"[^>]*href="\/assets\/[^\"]+"[^>]*>/,
    () => `<style>${css}</style>`);
if (standalone.includes('src="/assets/') || standalone.includes('href="/assets/')) {
  throw new Error("Preview still contains external bundle dependencies.");
}
await mkdir(dirname(target), { recursive: true });
await writeFile(target, standalone);
console.log(`Standalone design preview: ${target}`);
