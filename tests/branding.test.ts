import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ROUTE_CORE_WORDMARK,
  resolveGlyphMode,
  routeCoreCompact,
  routeCoreLarge,
  themeForGlyphPreference,
} from "../src/branding.js";
import { COMMAND_TREE } from "../src/command-catalog.js";

const UNICODE_LARGE = [
  " ╲",
  "   ╲      ──────○",
  "     ❯    ─────────●",
  "   ╱      ──────○",
  " ╱",
  "       ORCODE",
] as const;

const ASCII_LARGE = [
  " \\",
  "   \\      ------o",
  "     >    ---------*",
  "   /      ------o",
  " /",
  "       ORCODE",
] as const;

test("Route-Core-Marke behält die geprüften Unicode- und ASCII-Geometrien", () => {
  assert.deepEqual(routeCoreLarge("unicode"), UNICODE_LARGE);
  assert.deepEqual(routeCoreLarge("ascii"), ASCII_LARGE);
  assert.equal(routeCoreCompact("unicode"), "❯─●");
  assert.equal(routeCoreCompact("ascii"), ">-*");
  assert.equal(ROUTE_CORE_WORDMARK, "ORCODE");
});

test("Route-Core-Snapshots sind für Aufrufer unveränderlich", () => {
  const unicode = routeCoreLarge("unicode");
  assert.equal(Object.isFrozen(unicode), true);
  assert.throws(() => (unicode as unknown as string[]).push("fremde Geometrie"), TypeError);
  assert.deepEqual(routeCoreLarge("unicode"), UNICODE_LARGE);
});

test("ASCII-Umgebungsvariablen haben Vorrang vor gespeicherten Glyphen", () => {
  assert.equal(resolveGlyphMode("unicode", { ORCODE_ASCII: "1" }), "ascii");
  assert.equal(resolveGlyphMode("unicode", { ROUTERCODE_ASCII: "1" }), "ascii");
  assert.equal(resolveGlyphMode("ascii", {}), "ascii");
  assert.equal(resolveGlyphMode("unicode", {}), "unicode");
});

test("automatische Glyphenwahl prüft LC_ALL vor LANG und nur C/POSIX", () => {
  assert.equal(resolveGlyphMode("auto", { LANG: "C.UTF-8", LC_ALL: "POSIX" }), "ascii");
  assert.equal(resolveGlyphMode("auto", { LC_ALL: "C", LANG: "de_DE.UTF-8" }), "ascii");
  assert.equal(resolveGlyphMode("auto", { LC_ALL: "C.UTF-8", LANG: "C" }), "unicode");
  assert.equal(resolveGlyphMode("auto", { LANG: "POSIX" }), "ascii");
  assert.equal(resolveGlyphMode("auto", {}), "unicode");
});

// F6 theme-accessor dedupe: `commandTheme` (commands.ts), `#theme`
// (agent.ts) and `cliTheme` (cli.ts) each used to reimplement this exact
// resolve-then-build body; it now lives here, next to `resolveGlyphMode`,
// as the one place a `GlyphMode` preference turns into a `Theme`.
test("themeForGlyphPreference resolves the preference and builds a matching theme", () => {
  const unicode = themeForGlyphPreference("unicode", {});
  assert.equal(unicode.ascii, false);
  assert.equal(unicode.glyph("ellipsis"), "…");

  const ascii = themeForGlyphPreference("ascii", {});
  assert.equal(ascii.ascii, true);
  assert.equal(ascii.glyph("ellipsis"), ".");

  // "auto" defers to resolveGlyphMode's own env-driven detection.
  const autoForced = themeForGlyphPreference("auto", { ORCODE_ASCII: "1" });
  assert.equal(autoForced.ascii, true);
});

test("NO_COLOR verändert weder Auflösung noch Klartextgeometrie", () => {
  const withoutNoColor = resolveGlyphMode("auto", { LANG: "de_DE.UTF-8" });
  const withNoColor = resolveGlyphMode("auto", { LANG: "de_DE.UTF-8", NO_COLOR: "1" } as {
    LANG: string;
    NO_COLOR: string;
  });
  assert.equal(withNoColor, withoutNoColor);
  assert.deepEqual(routeCoreLarge(withNoColor), routeCoreLarge(withoutNoColor));
});

test("Route-Core-SVG ist eigenständig und zeigt offenen Kern, zwei Endpunkte und Pfad-Wortmarke", async () => {
  const svg = await readFile(new URL("../assets/route-core.svg", import.meta.url), "utf8");
  const bundled = await readFile(new URL("../gui/src/assets/route-core.svg", import.meta.url), "utf8");
  assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /viewBox="0 0 460 130"/);
  assert.match(svg, /width="460" height="130"/);
  const paths = svg.match(/<path\b[^>]*\/>/g) ?? [];
  const circles = svg.match(/<circle\b[^>]*\/>/g) ?? [];
  assert.equal(paths.length, 3);
  assert.equal(circles.length, 2);
  assert.match(svg, /<path\b[^>]*data-route-core="open-hexagon"[^>]*\/>/);
  const corePath = svg.match(/<path\b[^>]*data-route-core="open-hexagon"[^>]*d="([^"]+)"[^>]*\/>/)?.[1] ?? "";
  assert.doesNotMatch(corePath, /[zZ]/);
  assert.equal((svg.match(/data-route-endpoint=/g) ?? []).length, 2);
  assert.equal((svg.match(/data-endpoint-style="filled"/g) ?? []).length, 1);
  assert.equal((svg.match(/data-endpoint-style="outline"/g) ?? []).length, 1);
  assert.match(svg, /<g\b[^>]*data-wordmark="ORCODE"[^>]*aria-label="ORCODE"[^>]*>[\s\S]*?<path\b[^>]*class="wordmark"[^>]*\/>[\s\S]*?<\/g>/);
  assert.match(svg, /@media \(prefers-color-scheme: light\)/);
  assert.doesNotMatch(svg, /(?:href|<image|<script|<text|<rect|<use|data-prompt|data:|@import|url\()/i);
  assert.equal(bundled, svg);
});

test("README begins with the canonical asset and documents the guided Settings boundary", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  assert.match(readme, /^!\[Route Core logo\]\(assets\/route-core\.svg\)\n\n# orcode/u);
  assert.match(readme, /## Guided full-screen settings/u);
  for (const category of [
    "Models", "Accounts", "Approvals & Costs", "Tools", "Appearance",
  ]) assert.match(readme, new RegExp(category, "u"));
  // V4-B: `More settings` is gone (every row of a category is visible in one
  // scrollable list), and `above`/`below` gave way to the product-wide
  // `N of M` counter — the README must document what the surface now does.
  for (const behavior of ["tab bar", "Appearance", "Page Up", "N of M", "40×8"]) {
    assert.match(readme, new RegExp(behavior, "u"));
  }
  for (const term of ["same terminal", "saved immediately", "owner-only", "ORCODE_ASCII", "ROUTERCODE_ASCII", "NO_COLOR"]) {
    assert.match(readme, new RegExp(term, "u"));
  }
  const unreleased = changelog.slice(changelog.indexOf("## [Unreleased]"), changelog.indexOf("## [0.7.0]"));
  assert.match(unreleased, /guided full-screen `\/settings`/u);
  assert.match(unreleased, /Route Core/u);
  assert.match(unreleased, /owner-only/u);
});

// FIX-15 addendum: this assertion used to carry its own hand-typed copy of
// the group list, so when the palette renamed three groups the README prose
// and this pin went stale TOGETHER and kept agreeing with each other — the
// test passed 10/10 while `/help` rendered different names. A pin that can
// only be wrong in lockstep with the thing it pins protects nothing. It
// reads the LIVE tree now, so a future rename fails here until the README
// prose is updated with it.
test("README documents the approved command-menu groups", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const groups = COMMAND_TREE.map((node) => node.name);
  assert.equal(groups.length, 6, "the prose below says 'six task groups'");
  const sentence = `${groups.slice(0, -1).join(", ")}, and ${groups.at(-1)}`;
  // The prose wraps, so any run of whitespace stands in for the single
  // spaces between the names.
  assert.match(
    readme,
    new RegExp(
      `six task groups: ${sentence
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/ /g, "\\s+")}`,
      "u",
    ),
  );
});

test("README documents real on-demand Cross without implying ordinary prompts fan out", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /## Real Cross/u);
  assert.match(readme, /coding model/u);
  assert.match(readme, /review model/u);
  assert.match(readme, /\/collab cross run/u);
  assert.match(readme, /\/cross run/u);
  assert.match(readme, /models.*swap.*status.*stop/su);
  assert.match(readme, /on-demand/u);
  assert.match(readme, /ordinary prompts remain single-model/iu);
});
