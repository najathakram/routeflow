import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { callBlocks, productDataLiterals, WRITE_METHODS } from "./tripwire-scan";
import {
  NORMALISER_CALL,
  nameWrites,
  prismaNameWrites,
  rawSqlNameWrites,
  stripComments,
  summarise,
} from "./variant-name-census-scan";

/**
 * B1 (SA ruling) STRUCTURAL census: a variant stores its BARE label, and `product-variant-name.ts` is the ONE normaliser.
 * Every non-spec source file that WRITES a variant's name / variantName must call it (the call counts are pinned), route
 * through a service that does, or sit on the reasoned ALLOWED list. A new writer on none of the lists is red, so it cannot
 * quietly re-open the "Acme - Acme - Classic" corruption.
 *
 * A "writer file" is any non-spec file under src/ that has: (1) a `product|products` write call (create / update / upsert /
 * createMany / updateMany) whose block names `variantName` or `parentProductId`; (2) a `data.variantName =` assignment; or (3) a
 * `variantName:` object key that is not a type annotation or a `true` select flag.
 */
const SRC = join(__dirname, "..");
const API = join(SRC, "..");
const strip = stripComments;

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (
      /\.ts$/.test(n) &&
      !/\.(spec|test|fake-tx)\.ts$|\.d\.ts$/.test(n) &&
      !/fixtures/.test(n)
    )
      out.push(f);
  }
  return out;
}

/** Files that call the normaliser directly: the EXACT call count is pinned. */
const GUARDED: Record<string, { calls: number; why: string }> = {
  "products/products.service.ts": {
    calls: 2,
    why: "create() and update() strip dto.name / dto.variantName before the name guard and the uniqueness check; bulkAssignParent, make-variant, link-existing, the web save, the mobile edit and the import create/update all reach one of the two",
  },
  "products/product-families.service.ts": {
    calls: 3,
    why: "createFamily (the grid's variants), updateVariants add rows and update (rename) rows; variantData / variantPatch only ever see the stripped rows",
  },
  "inventory/inventory.service.ts": {
    calls: 2,
    why: "the stock split's new variant: the collision check and the created row (name and variantName) both use the bare label",
  },
};

/** Files that write ONLY through ProductsService.create / update (which are GUARDED above). */
const ROUTED: Record<string, string> = {
  "import/variant-resolution.service.ts":
    "createVariant hands the variant to ProductsService.create (the import and scan 'new variant' choice); it writes no variant label of its own",
};

/** Files that match the scan but never write a variant label, each with the reason. */
const ALLOWED: Record<string, string> = {
  "buyer/buyer-catalog-where.ts": "a search filter on variantName (read)",
  "common/safe-text-cell.ts": "the field-label map for the formula-lead refusal copy",
  "common/text-cell-guards.ts": "the formula-lead guard: reads the candidate name, writes nothing",
  "customers/customer-order-suggestions.service.ts":
    "response mapper: copies variantName out (read)",
  "documents/receipt-model.ts": "response mapper: copies variantName out (read)",
  "documents/receipt.service.ts": "a select of variantName (read)",
  "orders/orders.service.ts": "a select of variantName (read)",
  "product-labels/product-labels.service.ts": "a select of variantName (read)",
  "products/dto/bulk-assign-parent.dto.ts": "the request DTO (validated, then handed to update())",
  "products/family-price.ts":
    "propagates PRICE columns to a family's variants (where: parentProductId); writes no name",
};

describe("B1 variant-name writer census", () => {
  const files = walk(SRC).map((f) => ({
    rel: relative(SRC, f).split("\\").join("/"),
    text: strip(readFileSync(f, "utf8")),
  }));

  const isWriterFile = (text: string): boolean => {
    for (const receiver of ["product", "products"]) {
      for (const b of callBlocks(text, receiver, WRITE_METHODS)) {
        if (/variantName|parentProductId/.test(b)) return true;
      }
    }
    return (
      /\bdata\.variantName\s*=(?!=)/.test(text) ||
      /\bvariantName\s*:\s*(?!true\b|string\b|boolean\b|null\b)/.test(text)
    );
  };

  const writerFiles = files.filter((f) => isWriterFile(f.text));
  const known = new Set([...Object.keys(GUARDED), ...Object.keys(ROUTED), ...Object.keys(ALLOWED)]);

  it("every variant-name writer file is on a list: a new one must call the normaliser or be reasoned", () => {
    const unlisted = writerFiles.map((f) => f.rel).filter((r) => !known.has(r));
    expect(unlisted).toEqual([]);
  });

  it("no list row is stale: each listed file still matches the scan", () => {
    const matched = new Set(writerFiles.map((f) => f.rel));
    expect([...known].filter((r) => !matched.has(r))).toEqual([]);
  });

  it.each(Object.entries(GUARDED))(
    "%s calls the ONE normaliser the pinned number of times",
    (rel, row) => {
      const text = files.find((f) => f.rel === rel)!.text;
      expect(text.match(new RegExp(NORMALISER_CALL.source, "g"))?.length ?? 0).toBe(row.calls);
      expect(text).toMatch(/from "(?:\.\.\/products\/|\.\/)product-variant-name"/);
    },
  );

  it.each(Object.entries(ROUTED))("%s writes only through ProductsService", (rel) => {
    const text = files.find((f) => f.rel === rel)!.text;
    expect(text).toMatch(/this\.products\.create\(/);
    // no raw product write of its own that names a variant label
    for (const receiver of ["product"]) {
      for (const b of callBlocks(text, receiver, WRITE_METHODS)) {
        expect(b).not.toMatch(/variantName|parentProductId/);
      }
    }
    expect(productDataLiterals(text).filter((d) => /\b(?:name|variantName)\s*:/.test(d))).toEqual(
      [],
    );
  });

  it.each(Object.keys(ALLOWED))("%s writes no name / variantName of its own", (rel) => {
    const text = files.find((f) => f.rel === rel)!.text;
    expect(productDataLiterals(text).filter((d) => /\b(?:name|variantName)\s*:/.test(d))).toEqual(
      [],
    );
    expect(text).not.toMatch(/\bdata\.(?:variantName|name)\s*=(?!=)/);
  });
});

/**
 * R1 / R2 (SA): the census above is per FILE; this one is per WRITE BLOCK, across `src/` AND `scripts/`, Prisma calls AND
 * raw SQL. A block is one statement that can store a product's `name` / `variantName` (see `variant-name-census-scan.ts`):
 * a `.product.create | update | upsert | createMany | updateMany` whose data literal names the column, spreads a value or is a
 * variable (so it CAN carry one), or a raw `UPDATE "Product" SET name = ...` / `INSERT INTO "Product" (name, ...)`.
 *
 * Each file's blocks are pinned EXACTLY as `"<function>:<op>"`, with a trailing `+` when the ONE normaliser is called earlier
 * in that function. A block with no `+` must be explained in the file's `why`. A new, moved or removed block, a new file
 * with a name writer, or a raw-SQL name write is red until the table accounts for it.
 */
type BlockPin = {
  blocks: Record<string, number>;
  why: string;
  /** every block's data literal names neither parentProductId nor variantName: it can only make a STANDALONE product */
  standalone?: true;
};

const BLOCKS: Record<string, BlockPin> = {
  "src/products/products.service.ts": {
    blocks: { "create:create+": 1, "update:update+": 1, "importFromZoho:create": 1 },
    why: "create() and update() call bareVariantNames first (the web save, mobile edit, make-variant, link-existing, bulkAssignParent and every importer reach them); importFromZoho creates a standalone product (no parentProductId, no variantName)",
  },
  "src/products/product-families.service.ts": {
    blocks: {
      "createFamily:create+": 2,
      "updateVariants:create+": 1,
      "updateVariants:update+": 1,
    },
    why: "the family row and its variants (createFamily), added and renamed rows (updateVariants): bareRowNames runs before each function builds its rows",
  },
  "src/inventory/inventory.service.ts": {
    blocks: {
      "createVariantRowInTx:create+": 1,
      "recordPurchase:update": 1,
      "setCostBasisInTx:update": 1,
    },
    why: "the stock split's new variant is built from bareVariantLabel; recordPurchase / setCostBasisInTx write a cost-update variable (averageCost / standardCost columns only)",
  },
  "src/products/family-price.ts": {
    blocks: { "propagateFamilyPrice:updateMany": 2 },
    why: "propagates the five PRICE columns to a family's variants (data is a built price patch); writes no name",
  },
  "src/products/product-code-release.ts": {
    blocks: { "releaseLive:update": 1, "restoreProductCodes:update": 1 },
    why: "nulls / restores sku, barcode and unitSku (data is a built code patch); writes no name",
  },
  "src/import/import.service.ts": {
    blocks: { "importInventory:create": 1 },
    why: "the Zoho inventory import creates a STANDALONE product (no parentProductId); a later reparent goes through update()",
    standalone: true,
  },
  "src/inventory/testing/count-db-harness.ts": {
    blocks: { "afterAll:createMany": 1 },
    why: "test harness: seeds standalone 'Widget' products for the inventory count db specs",
    standalone: true,
  },
  "scripts/e2e-seed.js": {
    blocks: { "ensureCommerceFixtures:upsert": 1, "ensureUnitsFixture:upsert": 2 },
    why: "seeds standalone e2e fixture products",
    standalone: true,
  },
  "scripts/reset-and-seed.ts": {
    blocks: { "main:create": 12 },
    why: "local-dev reseed of standalone products",
    standalone: true,
  },
  "scripts/reset-seed.js": {
    blocks: { "main:create": 1 },
    why: "local-dev reseed of a standalone product",
    standalone: true,
  },
  "scripts/sales-facts-timing.ts": {
    blocks: { "main:createMany": 1 },
    why: "timing harness seed of standalone synthetic products",
    standalone: true,
  },
  "scripts/seed-marketing-screenshot-products.js": {
    blocks: { "seedProducts:create": 1, "seedProducts:update": 1 },
    why: "marketing screenshot seed of standalone products",
    standalone: true,
  },
  "scripts/seed-test-catalog.js": {
    blocks: { "main:create": 1, "main:update": 1 },
    why: "test-tenant catalog seed of standalone products",
    standalone: true,
  },
  "scripts/demo-seed.js": {
    blocks: { "copyProducts:update": 1, "copyProducts:createMany": 1 },
    why: "copies a source tenant's STORED name / variantName verbatim (rows are already bare) and re-links the parent; it composes nothing",
  },
};

function walkAll(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === "dist") continue;
    const f = join(dir, n);
    if (statSync(f).isDirectory()) walkAll(f, out);
    else if (/\.(ts|js|mjs|cjs)$/.test(n) && !/\.(spec|test|fake-tx)\.|\.d\.ts$/.test(n))
      out.push(f);
  }
  return out;
}

describe("B1 variant-name write-block census (R1 per block, R2 raw SQL + name-only writers, src + scripts)", () => {
  const scanned = ["src", "scripts"]
    .flatMap((d) => walkAll(join(API, d)))
    .map((f) => {
      const text = strip(readFileSync(f, "utf8"));
      return { rel: relative(API, f).split("\\").join("/"), text, blocks: nameWrites(text) };
    })
    .filter((f) => f.blocks.length > 0);

  it("every file with a name-writing block is pinned, and no pinned file is stale", () => {
    expect(scanned.map((f) => f.rel).sort()).toEqual(Object.keys(BLOCKS).sort());
  });

  it.each(Object.entries(BLOCKS))("%s: the blocks are exactly the pinned ones", (rel, pin) => {
    const found = summarise(scanned.find((f) => f.rel === rel)?.blocks ?? []);
    expect(found.byFn).toEqual(pin.blocks);
    expect(found.blocks).toBe(Object.values(pin.blocks).reduce((a, b) => a + b, 0));
    expect(found.normalised).toBe(
      Object.entries(pin.blocks)
        .filter(([k]) => k.endsWith("+"))
        .reduce((a, [, n]) => a + n, 0),
    );
    // an unnormalised block needs its reason on the row
    if (found.normalised < found.blocks) expect(pin.why.length).toBeGreaterThan(20);
  });

  it.each(Object.entries(BLOCKS).filter(([, p]) => p.standalone))(
    "%s: no block names a parent or a variant label (standalone products only)",
    (rel) => {
      for (const b of scanned.find((f) => f.rel === rel)!.blocks) {
        expect(b.data).not.toMatch(/parentProductId|variantName/);
      }
    },
  );

  it("no raw SQL writes a product name today (R2): a new one must go through the normaliser or be pinned", () => {
    expect(scanned.flatMap((f) => f.blocks).filter((b) => b.kind === "raw")).toEqual([]);
  });

  it("every GUARDED file has at least one normalised block", () => {
    for (const rel of Object.keys(GUARDED)) {
      const f = scanned.find((s) => s.rel === `src/${rel}`)!;
      expect(f.blocks.some((b) => b.normalised)).toBe(true);
    }
  });
});

describe("variant-name-census-scan: detection (fixtures)", () => {
  const prisma = (s: string) =>
    prismaNameWrites(s).map((b) => `${b.fn}:${b.op}:${b.why}${b.normalised ? "+" : ""}`);

  it("finds a name-only rename, an upsert, a createMany, a spread and a data variable; ignores other columns", () => {
    const src = `
  async rename(id: string, name: string) {
    return this.prisma.product.update({ where: { id }, data: { name } });
  }
  async stock(id: string) {
    return this.prisma.product.update({ where: { id }, data: { currentStock: 1, category: "x" } });
  }
  async seed() {
    await this.prisma.product.upsert({ where: { id: "1" }, create: { name: "A" }, update: { price: 1 } });
    await this.prisma.product.createMany({ data: [{ name: "A" }] });
    await this.prisma.product.create({ data: { ...dto } });
    await this.prisma.product.updateMany({ where: {}, data: patch });
    await this.prisma.product.update({ where: { name: "A" }, data: { isActive: false } });
  }`;
    expect(prisma(src)).toEqual([
      "rename:update:key",
      "seed:upsert:key",
      "seed:createMany:key",
      "seed:create:spread",
      "seed:updateMany:opaque",
    ]);
  });

  it("marks a block normalised only when the normaliser is called earlier in the SAME function", () => {
    const src = `
  async a(dto: D) {
    bareRowNames(dto.rows, "x");
    await this.prisma.product.create({ data: { name: dto.rows[0].name } });
  }
  async b(dto: D) {
    await this.prisma.product.create({ data: { name: dto.name } });
  }
  async c(dto: D) {
    await this.prisma.product.create({ data: { name: dto.name } });
    bareVariantLabel(dto.name, "x");
  }`;
    expect(prisma(src)).toEqual(["a:create:key+", "b:create:key", "c:create:key"]);
  });

  it("finds raw SQL name writes ($executeRaw, pg client .query, plain template) and ignores other columns and WHERE name", () => {
    const sql = (s: string) => rawSqlNameWrites(stripComments(s)).map((b) => b.op);
    expect(sql('await tx.$executeRaw`UPDATE "Product" SET name = ${n} WHERE id = ${id}`;')).toEqual(
      ["UPDATE"],
    );
    expect(
      sql(
        'await c.query(`UPDATE "Product" SET "variantName" = $1, "updatedAt" = now() WHERE id = $2`, [v, id]);',
      ),
    ).toEqual(["UPDATE"]);
    expect(
      sql(
        'await db.$executeRawUnsafe(`UPDATE "Product" AS p SET sku = x.sku, name = x.name FROM (VALUES (1)) x WHERE p.id = x.id`);',
      ),
    ).toEqual(["UPDATE"]);
    expect(
      sql(
        'await c.query(`INSERT INTO "Product" (id, "tenantId", name, sku) VALUES ($1,$2,$3,$4)`);',
      ),
    ).toEqual(["INSERT"]);
    expect(sql('await c.query(`UPDATE "Product" SET category = $1 WHERE name = $2`);')).toEqual([]);
    expect(sql('await c.query(`UPDATE "Product" SET "stockLevel" = 0 WHERE id = $1`);')).toEqual(
      [],
    );
    expect(sql('// UPDATE "Product" SET name = 1\nconst x = 1;')).toEqual([]);
  });
});
