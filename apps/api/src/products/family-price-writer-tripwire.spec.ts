import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { WRITE_METHODS, callBlocks, opaqueProductWrites } from "./tripwire-scan";

/**
 * #2717 M2 test 23 (SA-574 Q2, SA-E95, L-223): the family owns its variants' prices only if EVERY
 * writer of the five columns `getTierPrice` reads (`pricePerUnit`, `priceTier2..5`) is either routed
 * through products/family-price.ts or exempt with a written reason. A NEW writer that is in neither
 * list fails here instead of silently bypassing the authority.
 *
 * Three scans:
 *   1. apps/api/src   — `.product.(create|update|upsert|createMany|updateMany)(` blocks naming a column;
 *   2. apps/api/src   — `.products.(create|update)(` (ProductsService callers) naming a column;
 *   3. apps/api/scripts + prisma — any UPDATE-style writer: raw `UPDATE "Product" SET <col>` or a
 *      `.product.(update|updateMany|upsert)(` naming a column. Inserts (seed scripts) are not updates.
 */
const API_ROOT = join(__dirname, "..", "..");
const SRC_ROOT = join(API_ROOT, "src");

const COLUMNS = ["pricePerUnit", "priceTier2", "priceTier3", "priceTier4", "priceTier5"];
const UPDATE_METHODS = ["update", "upsert", "updateMany"];

/** File -> symbols family-price.ts exports that the file must call (the routing proof). */
const ROUTED: Record<string, string[]> = {
  "products/products.service.ts": ["applyFamilyPriceBeforeUpdate", "familyPricesForNewVariant"],
  "inventory/inventory.service.ts": ["familyPricesForNewVariant"],
};

/** File -> why a direct column write there can never reach a governed (variant or recipe) row. */
const EXEMPT: Record<string, string> = {
  "inventory/testing/order-stock-world.ts":
    "Test-only seeding fixture of the B284 order-stock DB specs (inventory/testing, imported only by *.db.spec.ts): it creates throwaway Product, Customer and User rows in `qa-*` tenants, never a governed variant or recipe row and never a live tenant.",
  "inventory/testing/count-db-harness.ts":
    "Test-only seeding helper of the SA-767 count DB specs (inventory/testing, collected only by *.db.spec.ts): it createMany's throwaway Product rows (name, pricePerUnit, a variable data array) into `qa-sa767-*` tenants, never a governed variant or recipe row and never a live tenant.",
  "products/product-families.service.ts":
    "WS8 families: createFamily mints brand-new rows and, by plan, ignores the mixed_packs mode (the variant price is the " +
    "caller's unless copyFamilyPrice is set); updateVariants refuses a price EDIT 409 FAMILY_PRICE_AUTHORITY while mixed_packs is on, " +
    "and an added variant takes all five family columns read under the family row lock (familyPricesForNewVariant).",
  "import/import.service.ts":
    "Zoho import creates a brand-new STANDALONE product (no parentProductId): nothing to inherit.",
  "import/variant-resolution.service.ts":
    "completeSetup updates a detailsIncomplete row; only createBrandNew sets that flag, and it " +
    "creates a standalone product. createVariant goes through ProductsService.create (routed).",
};

/** ProductsService callers that pass column values: ProductsService.create is the routed writer. */
const PRODUCTS_CALLER_EXEMPT: Record<string, string> = {
  "import/variant-resolution.service.ts":
    "createVariant/createBrandNew call ProductsService.create, which applies the family price.",
  "import/migration.service.ts":
    "commit PRODUCT calls ProductsService.create with no parentProductId (a standalone row).",
};

/** Scripts/prisma files allowed to UPDATE price columns, with a reason. */
const SCRIPT_UPDATE_ALLOW: Record<string, string> = {
  "prisma/seed.ts":
    "Seeds its own standalone dummy catalog into the approved test tenant only (assertTestTenant); " +
    "it never runs against a live tenant and creates no variants.",
};

function listFiles(dir: string, exts: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "migrations") continue;
      out.push(...listFiles(full, exts));
    } else if (exts.test(entry) && !/\.spec\.ts$|\.d\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function namesColumn(block: string): boolean {
  return COLUMNS.some((c) => new RegExp(`(^|[\\s{,])${c}\\s*:`, "m").test(block));
}

/** Raw `UPDATE "Product" SET ... <column>` statements (template literal or plain string). */
export function rawProductPriceUpdates(text: string): string[] {
  const hits: string[] = [];
  const re = /UPDATE\s+"?Product"?\s+SET\b[^;`]*/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (COLUMNS.some((c) => m![0].includes(c))) hits.push(m[0]);
  }
  return hits;
}

const rel = (root: string, file: string) => relative(root, file).split("\\").join("/");

describe("scanner self-test (non-vacuous)", () => {
  it("sees a raw UPDATE of a price column and ignores one of another column", () => {
    expect(
      rawProductPriceUpdates('UPDATE "Product" SET "priceTier3" = $1 WHERE id = $2'),
    ).toHaveLength(1);
    expect(
      rawProductPriceUpdates('UPDATE "Product" SET "imageKeys" = $1 WHERE id = $2'),
    ).toHaveLength(0);
  });

  it("sees a .product.update block naming a column", () => {
    const text = "await tx.product.update({ where: { id }, data: { priceTier2: x } });";
    const blocks = callBlocks(text, "product", UPDATE_METHODS);
    expect(blocks).toHaveLength(1);
    expect(namesColumn(blocks[0])).toBe(true);
  });
});

describe("family price writer tripwire: apps/api/src (Q2 i, L-223)", () => {
  const files = listFiles(SRC_ROOT, /\.ts$/);
  const flagged = new Map<string, number>();
  const productsCallers = new Map<string, number>();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const direct = callBlocks(text, "product", WRITE_METHODS).filter(namesColumn).length;
    if (direct > 0) flagged.set(rel(SRC_ROOT, file), direct);
    const viaService = callBlocks(text, "products", ["create", "update"]).filter(
      namesColumn,
    ).length;
    if (viaService > 0) productsCallers.set(rel(SRC_ROOT, file), viaService);
  }

  it("finds the known direct writers (the scan is not vacuous)", () => {
    for (const known of [
      "products/products.service.ts",
      "import/import.service.ts",
      "import/variant-resolution.service.ts",
    ]) {
      expect(flagged.has(known)).toBe(true);
    }
  });

  it("every file that writes a price column directly is routed or exempt-with-reason", () => {
    const offenders = [...flagged.keys()].filter((f) => !(f in ROUTED) && !(f in EXEMPT));
    expect(offenders).toEqual([]);
  });

  it("every routed file calls the family-price symbols it is listed for", () => {
    for (const [file, symbols] of Object.entries(ROUTED)) {
      const text = readFileSync(join(SRC_ROOT, file), "utf8");
      expect(text).toMatch(/from "\.\.?\/(products\/)?family-price"/);
      for (const symbol of symbols) expect(text).toContain(symbol);
    }
  });

  it("every exemption carries a reason and still names a writer (a stale row fails)", () => {
    for (const [file, reason] of Object.entries(EXEMPT)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(flagged.has(file)).toBe(true);
    }
  });

  it("every ProductsService caller that passes a price column is exempt-with-reason", () => {
    const offenders = [...productsCallers.keys()].filter((f) => !(f in PRODUCTS_CALLER_EXEMPT));
    expect(offenders).toEqual([]);
    for (const [file, reason] of Object.entries(PRODUCTS_CALLER_EXEMPT)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(productsCallers.has(file)).toBe(true);
    }
  });
});

describe("family price writer tripwire: scripts and prisma (Q2 ii)", () => {
  const files = [
    ...listFiles(join(API_ROOT, "scripts"), /\.(ts|js|mjs|cjs)$/),
    ...listFiles(join(API_ROOT, "prisma"), /\.(ts|js|mjs|cjs)$/),
  ];
  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const raw = rawProductPriceUpdates(text).length;
    const orm = callBlocks(text, "product", UPDATE_METHODS).filter(namesColumn).length;
    if (raw + orm > 0) offenders.push(rel(API_ROOT, file));
  }

  it("scans a non-trivial script tree", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("no script UPDATEs a price column unless allow-listed with a reason", () => {
    expect(offenders.filter((f) => !(f in SCRIPT_UPDATE_ALLOW))).toEqual([]);
  });

  it("every allow-listed script has a reason and still writes (a stale row fails)", () => {
    for (const [file, reason] of Object.entries(SCRIPT_UPDATE_ALLOW)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(offenders).toContain(file);
    }
  });
});

/**
 * SA-584 fold (lead): the column scans above only see a price column NAMED in an object literal. A
 * write whose `data` is a variable or carries a spread (`data,`, `data: someVar`, `{ ...dto }`) can
 * carry a price column the scan never sees. Every such write is either listed here by file with a
 * reason it can never carry a price column onto a governed row, or the tripwire fails.
 */
/**
 * File (relative to apps/api/src) -> the EXACT number of variable/spread product writes it may hold,
 * with why none of them can carry a price column onto a governed row. A NEW opaque writer in an
 * allow-listed file changes the count and fails (SA-587 lead LOW: per count, not per file).
 */
export const OPAQUE_DATA_ALLOW: Record<string, { count: number; reason: string }> = {
  "inventory/testing/count-db-harness.ts": {
    count: 1,
    reason:
      "Test-only seeding helper of the SA-767 count DB specs (inventory/testing, collected only by *.db.spec.ts): it createMany's throwaway Product rows (name, pricePerUnit, a variable data array) into `qa-sa767-*` tenants, never a governed variant or recipe row and never a live tenant.",
  },
  "inventory/inventory.service.ts": {
    count: 3,
    reason:
      "createVariantRowInTx spreads `priceColumns`: the family's own five columns re-read under its " +
      "row lock (familyPricesForNewVariant) with the mode on, the parent's as before with it off; the " +
      "cost-basis write with a ternary `data` names only cost columns.",
  },
  "products/product-families.service.ts": {
    count: 3,
    reason:
      "WS8 families: variantData/variantPatch build the row from the request's own named fields only (name, codes, " +
      "unitsPerBox, price, cost); price edits are refused while mixed_packs is on (see updateVariants).",
  },
  "products/product-code-release.ts": {
    count: 2,
    reason:
      "releaseLive / restoreProductCodes build `data` from the three code columns and their retired* " +
      "twins only (sku, barcode, unitSku); no price, tier or family column is ever named.",
  },
  "products/family-price.ts": {
    count: 2,
    reason:
      "propagateFamilyPrice IS the authority writer: it copies the family's own five columns " +
      "(pickPriceColumns) onto its variants and its non-override recipe products.",
  },
  "products/products.service.ts": {
    count: 2,
    reason:
      "update() writes `data` after applyFamilyPriceBeforeUpdate rewrote it (a governed row's price " +
      "columns replaced by the family's or stripped); the ROUTED table above pins that call.",
  },
};

/** Files whose opaque-write count is not exactly the allow-listed number (or that are not listed at all). */
export function opaqueCountViolations(
  found: Map<string, number>,
  allow: Record<string, { count: number; reason: string }>,
): string[] {
  const out: string[] = [];
  for (const [file, n] of found) {
    if (!(file in allow)) out.push(`${file}: ${n} (not allow-listed)`);
    else if (allow[file].count !== n) out.push(`${file}: found ${n}, allowed ${allow[file].count}`);
  }
  for (const [file, { count }] of Object.entries(allow)) {
    if (!found.has(file)) out.push(`${file}: allow-listed ${count} but none found (stale)`);
  }
  return out;
}

describe("family price writer tripwire: variable and spread data (SA-584 fold)", () => {
  it("sees a spread, a shorthand and a variable data argument, and ignores a literal", () => {
    expect(
      opaqueProductWrites("await tx.product.update({ where: { id }, data: { ...dto } });"),
    ).toHaveLength(1);
    expect(opaqueProductWrites("await tx.product.update({ where: { id }, data });")).toHaveLength(
      1,
    );
    expect(
      opaqueProductWrites("await tx.product.update({ where: { id }, data, select });"),
    ).toHaveLength(1);
    expect(
      opaqueProductWrites("await tx.product.update({ where: { id }, data: patch });"),
    ).toHaveLength(1);
    expect(
      opaqueProductWrites("await tx.products.create({ data: { name, ...rest } });"),
    ).toHaveLength(1);
    expect(
      opaqueProductWrites("await tx.product.createMany({ data: rows.map(toRow) });"),
    ).toHaveLength(1);
    expect(
      opaqueProductWrites("await tx.product.update({ where: { id }, data: { currentStock: 1 } });"),
    ).toHaveLength(0);
    expect(
      opaqueProductWrites(
        "await tx.product.update({ where: { id }, data: { a: 1, ...(x ? { b: 2 } : {}) } });",
      ),
    ).toHaveLength(0);
    expect(
      opaqueProductWrites("await tx.product.create({ data: { name: 'x', unit: 'ea' } });"),
    ).toHaveLength(0);
  });

  const files = listFiles(SRC_ROOT, /\.ts$/);
  const opaque = new Map<string, number>();
  for (const file of files) {
    const n = opaqueProductWrites(readFileSync(file, "utf8")).length;
    if (n > 0) opaque.set(rel(SRC_ROOT, file), n);
  }

  it("the allow-list matches the found opaque writers exactly, per file and per count", () => {
    expect(opaqueCountViolations(opaque, OPAQUE_DATA_ALLOW)).toEqual([]);
  });

  it("every allow-listed file carries a reason", () => {
    for (const { reason } of Object.values(OPAQUE_DATA_ALLOW)) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it("the count check is not vacuous: one extra writer in an allow-listed file, a new file, and a stale row all fail", () => {
    const allow = { "a.ts": { count: 2, reason: "x".repeat(30) } };
    expect(opaqueCountViolations(new Map([["a.ts", 2]]), allow)).toEqual([]);
    expect(opaqueCountViolations(new Map([["a.ts", 3]]), allow)).toHaveLength(1);
    expect(opaqueCountViolations(new Map([["a.ts", 1]]), allow)).toHaveLength(1);
    expect(
      opaqueCountViolations(
        new Map([
          ["a.ts", 2],
          ["b.ts", 1],
        ]),
        allow,
      ),
    ).toHaveLength(1);
    expect(opaqueCountViolations(new Map(), allow)).toHaveLength(1);
  });
});
