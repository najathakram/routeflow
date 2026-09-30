/**
 * Static guard (fix-round-3 ruling B1) — NO `next/image` under `apps/web/app`
 * or `apps/web/components`.
 *
 * `apps/web` builds with `output: "standalone"` (next.config) and ships no
 * `images` config, so a `next/image` render emits `/_next/image?url=…` requests
 * to an optimizer the production image was never built to serve — the mark and
 * every marketing photo 404 in prod while looking fine in `next dev`.
 *
 * Plain `<img>` with explicit `width`/`height` (and `loading="lazy"` below the
 * fold) is the house form. This walks the tree rather than asserting per file,
 * so a NEW `next/image` import added anywhere fails here.
 *
 * Precedent: `apps/api/src/common/no-bare-cron.spec.ts`.
 */

import * as fs from "fs";
import * as path from "path";

// NOTE (deviation from fix-round-3, reported to the lead): the ruling names
// `apps/web/no-next-image.test.ts`, but `jest.config.js` sets
// `roots: [app, components, lib, hooks]`, so a test at the apps/web root is
// never discovered (`npx jest --listTests` returns it 0 times) — the guard
// would be a silent no-op. Same filename, moved one level into a scanned root.
const WEB_ROOT = path.resolve(__dirname, "..");
const SCANNED_DIRS = ["app", "components"];
const SOURCE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** `import … from "next/image"`, `require("next/image")`, `import("next/image")`. */
const NEXT_IMAGE_IMPORT =
  /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["'`]next\/image(?:["'`]|\/)/;

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      collectSourceFiles(full, out);
      continue;
    }
    if (!SOURCE_EXTS.includes(path.extname(entry.name))) continue;
    // Test files carry `next/image` as DATA (this guard's own pattern probes,
    // a jest.mock factory) and ship to nobody — same carve-out as
    // no-bare-cron.spec.ts's `*.spec.ts` exclusion.
    if (/\.test\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

const FILES = SCANNED_DIRS.flatMap((dir) => collectSourceFiles(path.join(WEB_ROOT, dir)));

describe("no next/image under apps/web — fix-round-3 B1", () => {
  it("finds the source tree it is meant to guard", () => {
    // A silent zero-file walk would make every assertion below vacuously green.
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES).toContain(path.join(WEB_ROOT, "components", "brand", "BrandMark.tsx"));
  });

  it("no file under app/ or components/ imports next/image", () => {
    const offenders = FILES.filter((file) =>
      NEXT_IMAGE_IMPORT.test(fs.readFileSync(file, "utf8")),
    ).map((file) => path.relative(WEB_ROOT, file).split(path.sep).join("/"));

    expect(offenders).toEqual([]);
  });

  it("the pattern it enforces actually matches a next/image import", () => {
    // Guards the guard: a typo'd regex would report zero offenders forever.
    expect(NEXT_IMAGE_IMPORT.test('import Image from "next/image";')).toBe(true);
    expect(NEXT_IMAGE_IMPORT.test("const Image = require('next/image');")).toBe(true);
    expect(NEXT_IMAGE_IMPORT.test('const m = await import("next/image");')).toBe(true);
    // …and does NOT fire on prose mentioning the module.
    expect(NEXT_IMAGE_IMPORT.test("// Deliberately a plain <img>, NOT next/image.")).toBe(false);
  });

  it("BrandMark renders a plain <img>, not next/image", () => {
    const source = fs.readFileSync(
      path.join(WEB_ROOT, "components", "brand", "BrandMark.tsx"),
      "utf8",
    );
    expect(source).toMatch(/<img\b/);
    expect(NEXT_IMAGE_IMPORT.test(source)).toBe(false);
  });
});
