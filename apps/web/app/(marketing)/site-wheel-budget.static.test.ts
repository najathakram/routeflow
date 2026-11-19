/**
 * @jest-environment node
 */
// T13 (R13), a guard that passes today: the rebrand must not make the public site heavier or pull in
// anything new.
import * as fs from "fs";
import * as path from "path";

const SITE_ROOT = path.resolve(__dirname, "../../public/site");

/** The house cap for public/site (CLAUDE.md "Heavy files policy"; scripts/push-guard.mjs SIZE_CAP_BYTES). */
const SITE_CAP_BYTES = 5 * 1024 * 1024;
/** The wheel script was 76,135 bytes at the plan's base (5fc866853); the rework removes the label code, so it must not grow past this. */
const WHEEL_CAP_BYTES = 80_000;
/** GSAP 3.15 core, ScrollTrigger and SplitText: the only vendor files the site may carry. */
const VENDOR_FILES = ["ScrollTrigger.min.js", "SplitText.min.js", "gsap.min.js"];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

describe("T13 public site weight and policy", () => {
  const files = walk(SITE_ROOT);
  const pages = files.filter((f) => f.endsWith(".html"));

  it("finds the site", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(pages.length).toBe(10);
  });

  it("public/site stays under the 5 MB house cap", () => {
    const total = files.reduce((n, f) => n + fs.statSync(f).size, 0);
    expect(total).toBeLessThanOrEqual(SITE_CAP_BYTES);
  });

  it("the wheel script does not grow", () => {
    expect(fs.statSync(path.join(SITE_ROOT, "graphics/rf-wheel-up.js")).size).toBeLessThanOrEqual(
      WHEEL_CAP_BYTES,
    );
  });

  it("no vendor file is added", () => {
    expect(fs.readdirSync(path.join(SITE_ROOT, "js/vendor")).sort()).toEqual(VENDOR_FILES);
  });

  it("every script and stylesheet on every page is served from /site/", () => {
    const refs = pages.flatMap((f) => {
      const html = fs.readFileSync(f, "utf8");
      return [
        ...[...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]),
        ...[...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]),
      ];
    });
    expect(refs.length).toBeGreaterThan(20);
    expect(refs.filter((r) => !r.startsWith("/site/"))).toEqual([]);
  });
});
