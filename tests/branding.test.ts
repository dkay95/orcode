import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ROUTE_CORE_WORDMARK,
  resolveGlyphMode,
  routeCoreCompact,
  routeCoreLarge,
} from "../src/branding.js";

const UNICODE_LARGE = [
  "    ╭────────╮         ●",
  "  ╱            ╲      ╱",
  " ╱      ◇       ├────┤",
  "  ╲            ╱      ╲",
  "    ╰────────╯         ○",
  "          ORCODE",
] as const;

const ASCII_LARGE = [
  "    /--------\\         *",
  "  /            \\      /",
  " <       o       +----+",
  "  \\            /      \\",
  "    \\--------/         o",
  "          ORCODE",
] as const;

test("Route-Core-Marke behält die geprüften Unicode- und ASCII-Geometrien", () => {
  assert.deepEqual(routeCoreLarge("unicode"), UNICODE_LARGE);
  assert.deepEqual(routeCoreLarge("ascii"), ASCII_LARGE);
  assert.equal(routeCoreCompact("unicode"), "⬡─┤●○");
  assert.equal(routeCoreCompact("ascii"), "<>-+*o");
  assert.equal(ROUTE_CORE_WORDMARK, "ORCODE");
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

test("NO_COLOR verändert weder Auflösung noch Klartextgeometrie", () => {
  const withoutNoColor = resolveGlyphMode("auto", { LANG: "de_DE.UTF-8" });
  const withNoColor = resolveGlyphMode("auto", { LANG: "de_DE.UTF-8", NO_COLOR: "1" } as {
    LANG: string;
    NO_COLOR: string;
  });
  assert.equal(withNoColor, withoutNoColor);
  assert.deepEqual(routeCoreLarge(withNoColor), routeCoreLarge(withoutNoColor));
});

test("Route-Core-SVG ist eigenständig und verbindet den Ast mit beiden Endpunkten", async () => {
  const svg = await readFile(new URL("../assets/route-core.svg", import.meta.url), "utf8");
  assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /viewBox="0 0 48 48"/);
  assert.match(svg, /<path d="M9 14h13l6 10-6 10H9L3 24l6-10Z"/);
  assert.match(svg, /<path d="M25 24h4m0 0 3-6m-3 6 3 6"/);
  assert.match(svg, /<circle cx="35" cy="14" r="5" fill="currentColor"\/>/);
  assert.match(svg, /<circle cx="35" cy="34" r="5" fill="none" stroke="currentColor" stroke-width="3"\/>/);
  assert.doesNotMatch(svg, /(?:href|<style|font-|<image|<script|data:)/i);
});
