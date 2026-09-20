import * as fs from "fs";
import * as path from "path";

/**
 * One choke point for the opt-out pin (owner ruling, Lane R): `ProductCategoryLabel
 * .parentProductIdAtWrite` is written ONLY by the label write side, and never by anything that
 * moves a variant. If products.service (reparenting), an import, a seed or a script started touching
 * it, an opt-out approved against one parent could ride along to another. Same idea as
 * `no-bare-cron.spec.ts`: fail the build when a second reference appears — anywhere in the repo's
 * source, scripts and packages, not just apps/api/src.
 */
const REPO = path.resolve(__dirname, "../../../..");
const SCAN_ROOTS = [
  "apps/api/src",
  "apps/api/scripts",
  "apps/api/prisma",
  "apps/web",
  "apps/mobile",
  "packages",
  "scripts",
];
const ALLOWED = [
  "apps/api/src/product-categories/",
  "apps/api/src/product-labels/",
  "apps/api/src/selling-restrictions/",
  "apps/api/prisma/schema/", // the column's declaration
  "apps/api/prisma/migrations/", // the migration that adds it
];
const EXT = /\.(ts|tsx|js|jsx|mjs|cjs|sql|prisma)$/;
const SKIP_DIR = new Set(["node_modules", ".next", "dist", "build", ".expo", ".turbo", "coverage"]);

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (EXT.test(e.name)) out.push(full);
  }
  return out;
}

describe("ProductCategoryLabel.parentProductIdAtWrite has a single writer", () => {
  const files = SCAN_ROOTS.flatMap((r) => walk(path.join(REPO, r)));
  const rel = (f: string) => path.relative(REPO, f).split(path.sep).join("/");

  it("scans a real tree (a scan that finds nothing must fail, not pass)", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.map(rel)).toContain(
      "apps/api/src/product-categories/product-labels-admin.service.ts",
    );
  });

  it("is referenced only from the label modules, its schema and its migration", () => {
    const offenders = files
      .map(rel)
      .filter((f) => !ALLOWED.some((a) => f.startsWith(a)))
      .filter((f) =>
        fs.readFileSync(path.join(REPO, f), "utf8").includes("parentProductIdAtWrite"),
      );
    expect(offenders).toEqual([]);
  });

  it("within the write side, exactly one non-test file references it: the label service", () => {
    const writers = files
      .map(rel)
      .filter((f) => f.startsWith("apps/api/src/product-categories/"))
      .filter((f) => !f.endsWith(".spec.ts") && !f.includes("/testing/"))
      .filter((f) =>
        fs.readFileSync(path.join(REPO, f), "utf8").includes("parentProductIdAtWrite"),
      );
    expect(writers).toEqual(["apps/api/src/product-categories/product-labels-admin.service.ts"]);
  });
});
