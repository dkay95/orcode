// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { routeCoreBrand } from "../src/brand.js";

function parseSvg(source: string): Document {
  return new DOMParser().parseFromString(source, "image/svg+xml");
}

function sha256(source: Buffer): string {
  return createHash("sha256").update(source).digest("hex");
}

function luminance(hex: string): number {
  const channels = hex.match(/[0-9a-f]{2}/gi)?.map((part) => Number.parseInt(part, 16) / 255) ?? [];
  const [red = 0, green = 0, blue = 0] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(left: string, right: string): number {
  const [light, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

function declaredColor(css: string, selector: string, property: "fill" | "stroke"): string {
  const rule = css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  const color = rule.match(new RegExp(`${property}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
  if (!color) throw new Error(`No ${property} color declared for ${selector}`);
  return color;
}

describe("Route Core", () => {
  it("uses only the approved open core, two endpoints, and path wordmark", () => {
    const source = readFileSync(resolve(process.cwd(), "../assets/route-core.svg"), "utf8");
    const svg = parseSvg(source);
    expect(svg.querySelector("parsererror")).toBeNull();
    expect(svg.querySelectorAll('[data-route-endpoint]')).toHaveLength(2);
    expect(svg.querySelectorAll('[data-endpoint-style="filled"]')).toHaveLength(1);
    expect(svg.querySelectorAll('[data-endpoint-style="outline"]')).toHaveLength(1);

    const filled = svg.querySelector('[data-endpoint-style="filled"]')!;
    const outline = svg.querySelector('[data-endpoint-style="outline"]')!;
    expect(Number(filled.getAttribute("cy"))).toBeLessThan(Number(outline.getAttribute("cy")));

    const core = svg.querySelector('[data-route-core="open-hexagon"]');
    expect(core).not.toBeNull();
    const path = core?.getAttribute("d") ?? "";
    expect(path).not.toMatch(/[zZ]/);
    const points = [...path.matchAll(/[ML]\s*([\d.]+)[ ,]+([\d.]+)/gi)];
    expect(Number(points.at(-1)?.[2]) - Number(points[0]?.[2])).toBeGreaterThan(0);

    expect(svg.querySelector('[data-wordmark="ORCODE"][aria-label="ORCODE"] path')).not.toBeNull();
    expect(svg.querySelectorAll("text,script,image,foreignObject,use")).toHaveLength(0);
    expect(svg.querySelectorAll("rect,[data-prompt]")).toHaveLength(0);
    expect(svg.querySelectorAll("circle")).toHaveLength(2);
    expect(svg.querySelectorAll("[href],[src]")).toHaveLength(0);
    expect(svg.querySelector("title")?.textContent).toContain("ORCODE");
    expect(svg.querySelector("desc")?.textContent).toContain("Route Core");
    expect(svg.documentElement.textContent ?? "").not.toContain("❯─●");

    const styles = svg.querySelectorAll("style");
    expect(styles).toHaveLength(1);
    const css = styles[0]?.textContent ?? "";
    expect(css).toMatch(/prefers-color-scheme:\s*light/);
    expect(css).not.toMatch(/@import|url\(|javascript:|behavior:|expression\(/i);
    expect(css).not.toMatch(/animation|font(?:-family)?\s*:/i);
  });

  it("keeps graphite, warm-text, and amber marks legible in dark and light", () => {
    const source = readFileSync(resolve(process.cwd(), "../assets/route-core.svg"), "utf8");
    const css = parseSvg(source).querySelector("style")?.textContent ?? "";
    const light = css.match(/@media\s*\(prefers-color-scheme:\s*light\)\s*\{([\s\S]*)\}\s*$/)?.[1] ?? "";
    const darkWordmark = declaredColor(css, ".core,.wordmark", "stroke");
    const darkCore = declaredColor(css, ".core,.wordmark", "stroke");
    const darkFilled = declaredColor(css, ".endpoint-filled", "fill");
    const lightWordmark = declaredColor(light, ".core,.wordmark", "stroke");
    const lightCore = declaredColor(light, ".core,.wordmark", "stroke");
    const lightFilled = declaredColor(light, ".endpoint-filled", "fill");
    expect(contrast("#141210", darkWordmark)).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#141210", darkCore)).toBeGreaterThanOrEqual(3);
    expect(contrast("#141210", darkFilled)).toBeGreaterThanOrEqual(3);
    expect(contrast("#ece5da", lightWordmark)).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#ece5da", lightCore)).toBeGreaterThanOrEqual(3);
    expect(contrast("#ece5da", lightFilled)).toBeGreaterThanOrEqual(3);
  });

  it("copies the audited source byte-for-byte before it is bundled", () => {
    const bundled = resolve(process.cwd(), "src/assets/route-core.svg");
    expect(existsSync(bundled)).toBe(true);
    if (!existsSync(bundled)) return;
    expect(sha256(readFileSync(resolve(process.cwd(), "../assets/route-core.svg"))))
      .toBe(sha256(readFileSync(bundled)));
  });

  it("uses a fixed dark-shell asset that cannot repaint itself dark-on-dark", () => {
    const canonical = parseSvg(readFileSync(resolve(process.cwd(), "../assets/route-core.svg"), "utf8"));
    const desktop = parseSvg(readFileSync(resolve(process.cwd(), "src/assets/route-core-dark.svg"), "utf8"));
    expect(desktop.querySelector("parsererror")).toBeNull();
    const css = desktop.querySelector("style")?.textContent ?? "";
    expect(css).not.toMatch(/prefers-color-scheme|@media/i);
    expect(contrast("#141210", declaredColor(css, ".core,.wordmark", "stroke"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#141210", declaredColor(css, ".endpoint-filled", "fill"))).toBeGreaterThanOrEqual(3);

    canonical.querySelector("style")?.remove();
    desktop.querySelector("style")?.remove();
    expect(desktop.documentElement.outerHTML).toBe(canonical.documentElement.outerHTML);
  });

  it("renders exactly one accessible bundled image in every approved placement", () => {
    for (const place of ["empty", "chat-header", "settings-header"] as const) {
      const brand = routeCoreBrand(place);
      const images = brand.querySelectorAll<HTMLImageElement>('img[data-brand="route-core"]');
      expect(images).toHaveLength(1);
      expect(images[0]?.src).toMatch(/route-core-dark.*\.svg/);
      expect(images[0]?.alt).toBe("ORCODE Route Core");
      expect(brand.textContent?.trim()).toBe("");
    }
  });
});
