/**
 * V12: --field is the border colour of text inputs, selects and textareas. WCAG 1.4.11 asks 3:1 for the
 * boundary of a control against what it sits on: the input's own background AND the surrounding surface.
 * This reads the real stylesheet so the numbers cannot drift from what ships.
 */
import fs from "node:fs";
import path from "node:path";

const css = fs.readFileSync(path.join(__dirname, "..", "app", "globals.css"), "utf8");
const live = css.replace(/\/\*[\s\S]*?\*\//g, ""); // what the browser actually sees

const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function block(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) return "";
  return source.slice(start, source.indexOf("}", start));
}
function token(blockText: string, name: string): string | null {
  const re = new RegExp(String.raw`${name}:\s*(#[0-9a-fA-F]{6})\b`);
  return blockText.match(re)?.[1] ?? null;
}

describe("--field border token (V12)", () => {
  const light = token(block(live, ":root"), "--field");
  const dark = token(block(live, ".dark"), "--field");

  it("is declared in the light and the dark block", () => {
    expect(light).toMatch(/^#[0-9a-f]{6}$/i);
    expect(dark).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("meets 3:1 on the input background and every light surface", () => {
    const root = block(live, ":root");
    const admin = block(live, ".surface-admin");
    const surfaces = [
      "#ffffff", // the input's own background (bg-white)
      token(root, "--paper"),
      token(root, "--canvas"),
      token(root, "--sunken"),
      token(admin, "--canvas"),
      token(admin, "--sunken"),
    ];
    expect(surfaces.every(Boolean)).toBe(true);
    for (const bg of surfaces as string[]) {
      expect(ratio(light as string, bg)).toBeGreaterThanOrEqual(3);
    }
  });

  it("meets 3:1 on every dark surface in the prepared dark palette", () => {
    // The dark palette is still commented out in globals.css (class="dark" is not applied anywhere yet).
    const prepared = block(css.slice(css.indexOf("Dark mode variables")), ".dark");
    const surfaces = ["--paper", "--canvas", "--sunken"].map((n) => token(prepared, n));
    expect(surfaces.every(Boolean)).toBe(true);
    for (const bg of surfaces as string[]) {
      expect(ratio(dark as string, bg)).toBeGreaterThanOrEqual(3);
    }
  });

  it("clears 3:1 with margin on white, not a bare 3.0", () => {
    expect(ratio(light as string, "#ffffff")).toBeGreaterThan(3.2);
  });
});
