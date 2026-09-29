import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { productDataLiterals } from "./tripwire-scan";

/**
 * SA-587a (#2717 M2 fold, I6): `Product.trackedCategoryId` / `trackedSubcategoryId` may not change
 * while the product sits in a DRAFT/ACTIVE recipe. Two writers were found by hand (the product edit and
 * the bulk assign/unassign); this tripwire makes a THIRD one fail the build until it is listed with
 * the guard it runs. A "writer" is, in a non-spec file under apps/api/{src,scripts,prisma}:
 *   - a `data: { ... }` literal of a `.product|.products` write naming either key;
 *   - an assignment `data.trackedCategoryId = ...` / `data.trackedSubcategoryId = ...`;
 *   - a raw `UPDATE "Product" SET ... "trackedCategoryId" | "trackedSubcategoryId"`.
 * Allow-list: file (relative to apps/api) -> EXACT writer count, the guard the file must contain, and
 * why the writers it holds are safe.
 */
const API_ROOT = join(__dirname, "..", "..");
const KEYS = ["trackedCategoryId", "trackedSubcategoryId"];

export const ALLOW: Record<string, { count: number; guard: string; reason: string }> = {
  "src/products/products.service.ts": {
    count: 2,
    guard: "lockAndAssertRecipeGuards",
    reason:
      "create() writes the category of a brand-new row (no recipe can hold it yet); update() runs " +
      "lockAndAssertRecipeGuards in-tx before it writes (409 RECIPE_CATEGORY_LOCKED).",
  },
  "src/tracked-categories/tracked-categories.service.ts": {
    count: 2,
    guard: "assertNoOpenRecipe",
    reason:
      "assignProducts and unassignProducts each run in one transaction: lockProductsForCategoryWrite " +
      "(house order), then assertNoOpenRecipe on the rows that would move, before any write.",
  },
  "src/inventory/inventory.service.ts": {
    count: 1,
    guard: "familyPricesForNewVariant",
    reason:
      "createVariantRowInTx copies the parent's category onto a brand-new variant row; a row that " +
      "does not exist yet is in no recipe.",
  },
  "scripts/backfill-tobacco-category.mjs": {
    count: 1,
    guard: "isTobacco",
    reason:
      "Operator-run one-time reconcile of isTobacco vs the Tobacco type (dry-run by default; never " +
      "part of the app). UNGUARDED against open recipes: listed so a change is deliberate (SA-587a).",
  },
};

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (["node_modules", "migrations", "dist"].includes(entry)) continue;
      out.push(...listFiles(full));
    } else if (/\.(ts|js|mjs|cjs)$/.test(entry) && !/\.spec\.ts$|\.d\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const keyed = (s: string) => KEYS.some((k) => new RegExp(`(^|[\\s{,])${k}\\s*[:,}]`, "m").test(s));

export function trackedCategoryWriters(text: string): number {
  let n = productDataLiterals(text).filter(keyed).length;
  n += (text.match(/\bdata\.(trackedCategoryId|trackedSubcategoryId)\s*=(?!=)/g) ?? []).length;
  const raw = /UPDATE\s+"?Product"?\s+SET\b[^;`]*/gi;
  let m: RegExpExecArray | null;
  while ((m = raw.exec(text))) if (KEYS.some((k) => m![0].includes(k))) n++;
  return n;
}

export function writerViolations(
  found: Map<string, number>,
  allow: Record<string, { count: number; guard: string; reason: string }>,
): string[] {
  const out: string[] = [];
  for (const [file, n] of found) {
    if (!(file in allow)) out.push(`${file}: ${n} (not allow-listed)`);
    else if (allow[file].count !== n) out.push(`${file}: found ${n}, allowed ${allow[file].count}`);
  }
  for (const file of Object.keys(allow)) {
    if (!found.has(file)) out.push(`${file}: allow-listed but no writer found (stale)`);
  }
  return out;
}

describe("tracked-category writer tripwire (SA-587a, I6)", () => {
  it("sees a literal, an assignment and a raw UPDATE, and ignores reads", () => {
    expect(
      trackedCategoryWriters(
        "await tx.product.updateMany({ where: {}, data: { trackedCategoryId: id } });",
      ),
    ).toBe(1);
    expect(trackedCategoryWriters("data.trackedSubcategoryId = null;")).toBe(1);
    expect(
      trackedCategoryWriters('UPDATE "Product" SET "trackedCategoryId" = $1 WHERE id = $2'),
    ).toBe(1);
    expect(
      trackedCategoryWriters("await tx.product.findMany({ where: { trackedCategoryId: id } });"),
    ).toBe(0);
    expect(
      trackedCategoryWriters(
        "await tx.product.update({ where: { id }, data: { currentStock: 1 } });",
      ),
    ).toBe(0);
    expect(trackedCategoryWriters("if (data.trackedCategoryId == null) {}")).toBe(0);
  });

  it("the count check bites: a new writer, one more in a listed file, and a stale row all fail", () => {
    const allow = { "a.ts": { count: 1, guard: "g", reason: "r".repeat(30) } };
    expect(writerViolations(new Map([["a.ts", 1]]), allow)).toEqual([]);
    expect(writerViolations(new Map([["a.ts", 2]]), allow)).toHaveLength(1);
    expect(writerViolations(new Map([["b.ts", 1]]), allow)).toHaveLength(2);
  });

  const files = [
    ...listFiles(join(API_ROOT, "src")),
    ...listFiles(join(API_ROOT, "scripts")),
    ...listFiles(join(API_ROOT, "prisma")),
  ];
  const rel = (f: string) => relative(API_ROOT, f).split("\\").join("/");
  const found = new Map<string, number>();
  for (const f of files) {
    const n = trackedCategoryWriters(readFileSync(f, "utf8"));
    if (n > 0) found.set(rel(f), n);
  }

  it("scans a non-trivial tree and finds the two known writers", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(found.has("src/products/products.service.ts")).toBe(true);
    expect(found.has("src/tracked-categories/tracked-categories.service.ts")).toBe(true);
  });

  it("every writer file is allow-listed with its exact count", () => {
    expect(writerViolations(found, ALLOW)).toEqual([]);
  });

  it("every allow-listed file names the guard it runs and a reason", () => {
    for (const [file, { guard, reason }] of Object.entries(ALLOW)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(readFileSync(join(API_ROOT, file), "utf8")).toContain(guard);
    }
  });
});
