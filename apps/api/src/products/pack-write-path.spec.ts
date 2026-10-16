import * as fs from "fs";
import * as path from "path";
import { PACK_WRITE_PATH_COMPLETE } from "@routeflow/pricing";

/**
 * SA-795 (h), structural pin. Tier rules above 0% and order-unit switches are OFF until every writer of the pack price
 * columns (`Product.pricePerUnit`, `priceTier2-5`, `packAuto`) goes through the one write path (materializePack).
 *
 *   1. A NEW writer outside the write path fails here: use the write path, or add the file to OUTSIDE_WRITERS on purpose.
 *   2. A listed file that no longer writes fails here too, so the list only shrinks as writers move to the write path.
 *   3. `PACK_WRITE_PATH_COMPLETE` may be `true` ONLY when OUTSIDE_WRITERS is empty. The PR that empties it flips the constant.
 *
 * The scan is a text tripwire, not a proof: a non-spec file counts as a writer when it names a column as an object key
 * with a value (not a select flag, type member, orderBy direction or where operator), as a shorthand key or as an
 * assignment target AND it makes a DB write call, or when it has a raw `UPDATE ... SET` on a column.
 */

/** Files that ARE the write path (empty until S9 lands it). */
const WRITE_PATH_FILES: readonly string[] = [];

/** Today's writers outside the write path. Only ever shrinks. */
const OUTSIDE_WRITERS: readonly string[] = [
  "apps/api/prisma/report-variant-tier-drift.ts", // a report; its type members trip the text scan, and it calls $executeRaw inside a READ ONLY transaction
  "apps/api/prisma/seed.ts",
  "apps/api/scripts/DANGER-fresh-data-WIPES-ALL-DATA.js",
  "apps/api/scripts/demo-seed.js",
  "apps/api/scripts/e2e-seed.js",
  "apps/api/scripts/qa-multi-seller.js",
  "apps/api/scripts/reset-and-seed.ts",
  "apps/api/scripts/reset-seed.js",
  "apps/api/scripts/sales-facts-timing.ts",
  "apps/api/scripts/seed-marketing-screenshot-products.js",
  "apps/api/scripts/seed-test-catalog.js",
  "apps/api/scripts/ux-audit-seed.js",
  "apps/api/src/customers/customers.service.ts",
  "apps/api/src/import/import.service.ts",
  "apps/api/src/import/migration.service.ts",
  "apps/api/src/import/variant-resolution.service.ts",
  "apps/api/src/inventory/inventory.service.ts",
  "apps/api/src/inventory/testing/count-db-harness.ts",
  "apps/api/src/invoices/invoice-edit-plan.ts",
  "apps/api/src/invoices/invoice-restriction-lines.ts",
  "apps/api/src/orders/orders.service.ts",
  "apps/api/src/products/family-price.ts",
  "apps/api/src/products/product-families.service.ts",
  "apps/api/src/products/product-units.service.ts",
  "apps/api/src/products/products.service.ts",
  "apps/api/src/promotions/promotions.service.ts",
];

const REPO = path.resolve(__dirname, "../../../..");
const ROOTS = ["apps/api/src", "apps/api/scripts", "apps/api/prisma"];
const KEY = "(?:pricePerUnit|priceTier[2-5]|packAuto)";

let nested = "[^{}]*";
for (let i = 0; i < 4; i++) nested = `(?:[^{}]|\\{${nested}\\})*`;
const DATA_BLOCK = new RegExp(
  `\\b(?:data|create|update|set)\\s*:\\s*\\{${nested}?\\b${KEY}\\b`,
  "s",
);
const ASSIGN = new RegExp(`(?:\\.|\\[\\s*["'])${KEY}["']?\\s*\\]?\\s*[-+*]?=(?!=)`);
const RAW_SQL = new RegExp(`\\bSET\\b[^;\`]{0,400}"?${KEY}"?\\s*=`, "i");
// `pricePerUnit: <value>` that is not a select flag, a type member, an orderBy direction or a where operator.
const KEY_VALUE = new RegExp(
  `\\b${KEY}\\s*:\\s*(?!true\\b|false\\b|["'](?:asc|desc)["']|\\{|(?:number|string|boolean|unknown|any|null|Numeric|Decimal|Prisma\\.Decimal)\\b)`,
);
const SHORTHAND = new RegExp(`[{,]\\s*${KEY}\\s*[,}]`);
const DB_WRITE =
  /\.(?:create|createMany|update|updateMany|upsert)\s*\(|\$executeRaw|INSERT\s+INTO|UPDATE\s+["\w]/;

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

function writesPackColumns(src: string): boolean {
  const code = stripComments(src);
  if (RAW_SQL.test(code)) return true;
  const keyed =
    DATA_BLOCK.test(code) || ASSIGN.test(code) || KEY_VALUE.test(code) || SHORTHAND.test(code);
  return keyed && DB_WRITE.test(code);
}

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "dist") walk(p, out);
    } else if (/\.(ts|js|mjs|cjs)$/.test(e.name) && !/\.(spec|test)\./.test(e.name)) {
      out.push(p);
    }
  }
}

function scan(): string[] {
  const files: string[] = [];
  for (const r of ROOTS) walk(path.join(REPO, r), files);
  return files
    .map((f) => path.relative(REPO, f).split(path.sep).join("/"))
    .filter((rel) => writesPackColumns(fs.readFileSync(path.join(REPO, rel), "utf8")))
    .sort();
}

// ─── F1 (SA-796 R-4): who may call the engine's switch and materialize functions ─────────────────

/** Files outside packages/pricing that may name `materializePack` or `planOrderUnitSwitch`. Empty until S9 lands the write path. */
const USE_ALLOW: readonly string[] = [];
const USE_ROOTS = [
  "apps/api/src",
  "apps/api/scripts",
  "apps/web/app",
  "apps/web/components",
  "apps/web/lib",
  "apps/mobile/app",
  "apps/mobile/components",
  "apps/mobile/lib",
  "apps/api/prisma",
  // every other package (pricing itself is the engine and is not scanned)
  ...fs
    .readdirSync(path.join(REPO, "packages"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "pricing")
    .map((e) => `packages/${e.name}`),
];
const USE_NAMES = /\b(?:materializePack|planOrderUnitSwitch)\b/;
const GUARD_NAMES = /\b(?:assertOrderUnitSwitchAllowed|PACK_WRITE_PATH_COMPLETE)\b/;
const PASSES_FLAG = /\bwritePathComplete\b/;

function walkSources(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!["node_modules", "dist", ".next", ".expo"].includes(e.name)) walkSources(p, out);
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name) && !/\.(spec|test)\./.test(e.name)) {
      out.push(p);
    }
  }
}

describe("SA-796 R-4 (F1): the engine's switch and materialize functions have no caller outside the write path", () => {
  const files: string[] = [];
  for (const r of USE_ROOTS) {
    if (fs.existsSync(path.join(REPO, r))) walkSources(path.join(REPO, r), files);
  }
  const rel = files.map((f) => path.relative(REPO, f).split(path.sep).join("/"));
  const code = (f: string) => stripComments(fs.readFileSync(path.join(REPO, f), "utf8"));
  const users = rel.filter((f) => USE_NAMES.test(code(f)));

  it("scans a real set of files, and the detectors are not vacuous", () => {
    expect(rel).toEqual(expect.arrayContaining(["apps/api/src/products/products.service.ts"]));
    expect(USE_NAMES.test("planOrderUnitSwitch(view, scope, to)")).toBe(true);
    expect(USE_NAMES.test("const x = materializePack(view);")).toBe(true);
    expect(USE_NAMES.test(stripComments("// materializePack"))).toBe(false);
    expect(PASSES_FLAG.test("materializePack(v, r, { writePathComplete: true })")).toBe(true);
  });

  it("a non-spec file that names them must be listed in USE_ALLOW", () => {
    expect(users.filter((f) => !USE_ALLOW.includes(f))).toEqual([]);
  });

  it("a listed file must also name the guard (assertOrderUnitSwitchAllowed or PACK_WRITE_PATH_COMPLETE)", () => {
    expect(USE_ALLOW.filter((f) => !GUARD_NAMES.test(code(f)))).toEqual([]);
  });

  it("no non-spec file passes writePathComplete (only specs may open the gate)", () => {
    expect(rel.filter((f) => PASSES_FLAG.test(code(f)))).toEqual([]);
  });
});

describe("SA-795 (h): writers of the pack price columns", () => {
  const found = scan();
  const outside = found.filter((f) => !WRITE_PATH_FILES.includes(f));

  it("no writer outside the write path other than the listed ones", () => {
    expect(outside.filter((f) => !OUTSIDE_WRITERS.includes(f))).toEqual([]);
  });

  it("every listed writer still writes (the list only shrinks)", () => {
    expect(OUTSIDE_WRITERS.filter((f) => !outside.includes(f))).toEqual([]);
  });

  it("the constant is true only when the list is empty", () => {
    expect(PACK_WRITE_PATH_COMPLETE && OUTSIDE_WRITERS.length > 0).toBe(false);
    // Flipped to true, with the list empty, by the PR that moves the last writer onto the write path.
    expect(PACK_WRITE_PATH_COMPLETE).toBe(false);
  });

  it("the scan does see the known writers (a broken scan would pass vacuously)", () => {
    expect(found).toEqual(
      expect.arrayContaining(["apps/api/src/products/product-units.service.ts"]),
    );
  });
});
