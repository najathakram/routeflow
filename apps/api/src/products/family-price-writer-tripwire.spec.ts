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
export type DataArg = "literal" | "spread" | "opaque" | "none";

export function dataArgKind(block: string): DataArg {
  const m = /(^|[\s{,(])data\b\s*([:,}])/m.exec(block);
  if (!m) return "none";
  if (m[2] !== ":") return "opaque";
  const rest = block.slice(m.index + m[0].length).trimStart();
  if (rest.startsWith("{") || rest.startsWith("[")) {
    const open = rest[0];
    const inner = balancedGeneric(rest, 0, open, open === "{" ? "}" : "]");
    // `...(cond ? { k: v } : {})` spreads a literal built in place; `...dto` / `...rest` spreads a value
    // the scan cannot see into.
    return /\.\.\.\s*[A-Za-z_$]/.test(inner) ? "spread" : "literal";
  }
  return "opaque";
}

function balancedGeneric(text: string, openIdx: number, open: string, close: string): string {
  let depth = 1;
  let i = openIdx + 1;
  while (i < text.length && depth > 0) {
    if (text[i] === open) depth++;
    else if (text[i] === close) depth--;
    i++;
  }
  return text.slice(openIdx, i);
}

/** Every product write call block whose data argument is a variable or contains a spread. */
export function opaqueProductWrites(text: string): string[] {
  const out: string[] = [];
  for (const receiver of ["product", "products"]) {
    const methods = receiver === "product" ? WRITE_METHODS : ["create", "update"];
    for (const block of callBlocks(text, receiver, methods)) {
      const kind = dataArgKind(block);
      if (kind === "opaque" || kind === "spread") out.push(block);
    }
  }
  return out;
}

/** File (relative to apps/api/src) -> why its variable/spread `data` can never carry a price column onto a governed row. */
const OPAQUE_DATA_ALLOW: Record<string, string> = {
  "inventory/inventory.service.ts":
    "createVariantRowInTx spreads `priceColumns`: the family's own five columns re-read under its " +
    "row lock (familyPricesForNewVariant) with the mode on, the parent's as before with it off; the " +
    "cost-basis write with a ternary `data` names only cost columns.",
  "products/family-price.ts":
    "propagateFamilyPrice IS the authority writer: it copies the family's own five columns " +
    "(pickPriceColumns) onto its variants and its non-override recipe products.",
  "products/products.service.ts":
    "update() writes `data` after applyFamilyPriceBeforeUpdate rewrote it (a governed row's price " +
    "columns replaced by the family's or stripped); the ROUTED table above pins that call.",
};

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

  it("every file with a variable/spread product write is allow-listed with a reason", () => {
    const offenders = [...opaque.keys()].filter((f) => !(f in OPAQUE_DATA_ALLOW));
    expect(offenders).toEqual([]);
  });

  it("every allow-listed file has a reason and still has such a write (a stale row fails)", () => {
    for (const [file, reason] of Object.entries(OPAQUE_DATA_ALLOW)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(opaque.has(file)).toBe(true);
    }
  });
});
