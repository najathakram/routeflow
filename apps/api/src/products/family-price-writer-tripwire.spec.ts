import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

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
const WRITE_METHODS = ["create", "update", "upsert", "createMany", "updateMany"];
const UPDATE_METHODS = ["update", "upsert", "updateMany"];

/** File -> symbols family-price.ts exports that the file must call (the routing proof). */
const ROUTED: Record<string, string[]> = {
  "products/products.service.ts": ["applyFamilyPriceBeforeUpdate", "familyPricesForNewVariant"],
  "inventory/inventory.service.ts": ["familyPricesForNewVariant"],
};

/** File -> why a direct column write there can never reach a governed (variant or recipe) row. */
const EXEMPT: Record<string, string> = {
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

function balanced(text: string, openIdx: number): string {
  let depth = 1;
  let i = openIdx + 1;
  while (i < text.length && depth > 0) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    i++;
  }
  return text.slice(openIdx, i);
}

function callBlocks(text: string, receiver: string, methods: string[]): string[] {
  const out: string[] = [];
  for (const method of methods) {
    const needle = `.${receiver}.${method}(`;
    let from = 0;
    for (;;) {
      const idx = text.indexOf(needle, from);
      if (idx === -1) break;
      out.push(balanced(text, idx + needle.length - 1));
      from = idx + needle.length;
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
      "inventory/inventory.service.ts",
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
