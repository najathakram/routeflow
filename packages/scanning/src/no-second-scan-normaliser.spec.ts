import * as fs from "fs";
import * as path from "path";

/**
 * Ratchet: the scanned-code normaliser (`normalizeScanCode`, `upcEToUpcA`,
 * `pickBestScanMatch`) and the symbology inference (`inferBarcodeSymbology`) live in
 * `@routeflow/scanning` ONLY. api, web and mobile import them; a second definition anywhere
 * else is how the api and mobile copies used to drift. The two old paths
 * (`apps/api/src/common/barcode-normalize.ts`, `apps/mobile/lib/barcode-normalize.ts`) are
 * one-line re-export shims — they re-export, never define, so this walk passes them.
 */
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SCANNING_ROOT = path.join(REPO_ROOT, "packages", "scanning");
const ROOTS = ["apps", "packages", "scripts"].map((d) => path.join(REPO_ROOT, d));
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", ".expo", "coverage", ".turbo"]);

function collect(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collect(full, out);
      continue;
    }
    if (!/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) || /\.d\.ts$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

// M4a-1 (SA-580): `scanUnitKind` (mobile's legacy-column classifier) is DELETED — every caller
// moves to the shared resolver — and `resolveScanLevel` (pricing's M1 lineMode resolver, "unused by
// any scanner") is replaced by `resolveScanSellLevel`. Neither may be defined outside the package.
const NAMES = [
  "normalizeScanCode",
  "upcEToUpcA",
  "pickBestScanMatch",
  "inferBarcodeSymbology",
  "scanUnitKind",
  "resolveScanLevel",
  "resolveScanSellLevel",
  "levelsForScannedCode",
];
const DEFINITION = new RegExp(
  String.raw`(?:function\s+(?:${NAMES.join("|")})\b|(?:const|let|var)\s+(?:${NAMES.join("|")})\s*[=:])`,
);
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const rel = (f: string) => path.relative(REPO_ROOT, f).split(path.sep).join("/");
const FILES = ROOTS.flatMap((r) => collect(r));

describe("no second scan normaliser (M4a-0)", () => {
  it("scanned a real tree (L-202: a walk that finds nothing proves nothing)", () => {
    expect(FILES.length).toBeGreaterThan(0);
    expect(FILES.some((f) => f.startsWith(SCANNING_ROOT))).toBe(true);
    expect(FILES.some((f) => f.includes(`${path.sep}apps${path.sep}api${path.sep}src`))).toBe(true);
    for (const app of ["api", "web", "mobile"]) {
      expect(FILES.some((f) => f.includes(`${path.sep}apps${path.sep}${app}${path.sep}`))).toBe(
        true,
      );
    }
  });

  it("no file outside packages/scanning defines a scan normaliser function", () => {
    const offenders = FILES.filter((f) => !f.startsWith(SCANNING_ROOT + path.sep)).filter((f) =>
      DEFINITION.test(strip(fs.readFileSync(f, "utf8"))),
    );
    expect(offenders.map((f) => rel(f))).toEqual([]);
  });

  it("scanUnitKind and inferBarcodeSymbology have exactly one definition, inside packages/scanning (M4a-1)", () => {
    const only = (name: string) =>
      FILES.filter((f) =>
        new RegExp(String.raw`(?:function\s+${name}\b|(?:const|let|var)\s+${name}\s*[=:])`).test(
          strip(fs.readFileSync(f, "utf8")),
        ),
      ).map((f) => rel(f));
    // inferBarcodeSymbology moved (packages/scanning/src/barcode-symbology.ts); scanUnitKind is
    // deleted outright, replaced by resolveScanSellLevel in packages/scanning/src/scan-level.ts.
    expect(only("inferBarcodeSymbology")).toEqual(["packages/scanning/src/barcode-symbology.ts"]);
    expect(only("scanUnitKind")).toEqual([]);
    expect(only("resolveScanSellLevel")).toEqual(["packages/scanning/src/scan-level.ts"]);
  });

  it("the old api symbology path is gone or a re-export shim, never a second definition", () => {
    const rel = "apps/api/src/common/barcode-symbology.ts";
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) return;
    expect(strip(fs.readFileSync(abs, "utf8")).trim()).toMatch(
      /^export \* from "@routeflow\/scanning";$/,
    );
  });

  it("the two legacy paths are re-export shims of @routeflow/scanning", () => {
    for (const rel of [
      "apps/api/src/common/barcode-normalize.ts",
      "apps/mobile/lib/barcode-normalize.ts",
    ]) {
      const body = strip(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8")).trim();
      expect(body).toMatch(/^export \* from "@routeflow\/scanning";$/);
    }
  });
});

describe("dependency direction (M4a-0)", () => {
  it("packages/pricing never imports @routeflow/scanning (scanning may use pricing, not the reverse)", () => {
    const pricingFiles = collect(path.join(REPO_ROOT, "packages", "pricing"));
    expect(pricingFiles.length).toBeGreaterThan(0);
    const offenders = pricingFiles.filter((f) =>
      fs.readFileSync(f, "utf8").includes("@routeflow/scanning"),
    );
    expect(offenders.map((f) => rel(f))).toEqual([]);
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "packages", "pricing", "package.json"), "utf8"),
    );
    expect(JSON.stringify(pkg)).not.toContain("@routeflow/scanning");
  });
});
