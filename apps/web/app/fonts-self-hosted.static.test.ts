/**
 * #2397 (P1): `next/font/google` downloads fonts from Google at BUILD time, and a failed fetch
 * failed prod web deploys (loader.js:122 "Cannot read properties of null (reading '1')",
 * ETIMEDOUT on Instrument Serif). Every web font is now self-hosted via `next/font/local` from
 * `apps/web/fonts/`, so the build never touches the network for fonts.
 */
import fs from "fs";
import path from "path";

const WEB = path.join(__dirname, "..");

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (["node_modules", ".next", "e2e"].includes(e.name)) return [];
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.(tsx?|jsx?|mjs|cjs)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
  });
}

describe("web fonts are self-hosted (#2397)", () => {
  it("nothing in apps/web imports next/font/google", () => {
    const offenders = ["app", "components", "lib", "hooks"]
      .flatMap((d) => sources(path.join(WEB, d)))
      .filter((f) => /from\s+["']next\/font\/google["']/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(WEB, f));
    expect(offenders).toEqual([]);
  });

  it("the four Ledger/fallback families keep their CSS variables, from local woff2 files", () => {
    const src = fs.readFileSync(path.join(WEB, "app", "fonts.ts"), "utf8");
    for (const v of [
      "--font-spline",
      "--font-spline-mono",
      "--font-inter",
      "--font-instrument-serif",
    ]) {
      expect(src).toContain(`variable: "${v}"`);
    }
    const files = [...src.matchAll(/"\.\.\/fonts\/([^"]+\.woff2)"/g)].map((m) => m[1]);
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const f of files) expect(fs.existsSync(path.join(WEB, "fonts", f))).toBe(true);
  });

  it("the root layout applies every font variable class", () => {
    const layout = fs.readFileSync(path.join(WEB, "app", "layout.tsx"), "utf8");
    for (const name of [
      "splineSans",
      "splineSansMono",
      "inter",
      "instrumentSerif",
      "geistSans",
      "geistMono",
    ]) {
      expect(layout).toContain(`\${${name}.variable}`);
    }
  });
});
