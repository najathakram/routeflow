#!/usr/bin/env node
/**
 * P-64: fill the `test` tenant with 5,000 dummy products so screens can be timed at a real catalog size.
 *
 * LOCAL ONLY. Unlike apps/api/scripts/seed-test-catalog.js this script has NO prod path and NO override
 * flag: a database that is not provably local (see apps/api/scripts/lib/local-db-target.cjs) is refused,
 * as is NODE_ENV=production. Additive: upsert on (tenantId, sku), `update` touches definitional fields
 * only (never stock or cost), nothing is deleted, the tenant must already exist (`npm run local:seed`).
 *
 * Usage (repo root, local compose DB up):
 *   node scripts/local-env.mjs --db -- "node scripts/perf/seed-catalog-5k.mjs"
 * Env: DATABASE_URL (read from env, never hardcoded), COUNT (default 5000).
 *
 * Shape: 100 FAMILY parents with 4 VARIANT children each (500 rows), the rest STANDARD; every third row
 * is boxed (24 per box), the others loose. Every name starts with "Acme ". Prices are built in whole cents.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const { assertTestTenant } = require("../lib/test-tenants.cjs");
const { localConnectionConfig } = require("../../apps/api/scripts/lib/local-db-target.cjs");

export const DEFAULT_COUNT = 5000;
const FAMILIES = 100;
const VARIANTS_PER_FAMILY = 4;
const CATEGORIES = [
  "Beverages",
  "Snacks",
  "Candy",
  "Household",
  "Paper",
  "Frozen",
  "Dairy",
  "Pantry",
];

/** Refuse anything that is not a provably local database. Throws before any client is created. */
export function assertSafeTarget(env) {
  if (env.NODE_ENV === "production") {
    throw new Error("Refusing to seed with NODE_ENV=production. This script is local-only.");
  }
  const cfg = localConnectionConfig(env.DATABASE_URL);
  if (cfg === null) {
    let host = "(missing or unparseable DATABASE_URL)";
    try {
      host = new URL(env.DATABASE_URL ?? "").hostname || host;
    } catch {
      /* keep the placeholder */
    }
    throw new Error(
      `Refusing to seed the non-local database at ${host}. This script is local-only.`,
    );
  }
  return undefined;
}

export function assertSeedTenant(slug) {
  return assertTestTenant(slug, "seed-catalog-5k");
}

const pad = (n, w) => String(n).padStart(w, "0");
const cents = (c) => Math.round(c) / 100;

/** Pure builder: the same n always gives the same rows. Parents come before their variants. */
export function buildCatalog(n = DEFAULT_COUNT) {
  const rows = [];
  const families = Math.min(FAMILIES, Math.floor(n / (VARIANTS_PER_FAMILY + 1)));
  let i = 0;
  const base = (idx, extra) => {
    const boxed = idx % 3 === 0;
    const priceCents = 199 + ((idx * 37) % 4800);
    return {
      category: CATEGORIES[idx % CATEGORIES.length],
      unit: boxed ? "case" : "each",
      pricePerUnit: cents(priceCents),
      priceTier2: cents(Math.round(priceCents * 0.95)),
      unitsPerBox: boxed ? 24 : null,
      currentStock: (idx * 7) % 120,
      reorderPoint: 10,
      kind: "STANDARD",
      parentSku: null,
      variantName: null,
      ...extra,
    };
  };
  for (let f = 0; f < families; f++) {
    const parentSku = `ACME5K-F${pad(f + 1, 3)}`;
    rows.push(
      base(i, {
        sku: parentSku,
        name: `Acme Family ${pad(f + 1, 3)}`,
        kind: "FAMILY",
        currentStock: 0,
      }),
    );
    i++;
    for (let v = 0; v < VARIANTS_PER_FAMILY; v++) {
      rows.push(
        base(i, {
          sku: `${parentSku}-V${v + 1}`,
          name: `Acme Family ${pad(f + 1, 3)} Variant ${v + 1}`,
          kind: "VARIANT",
          parentSku,
          variantName: `Variant ${v + 1}`,
        }),
      );
      i++;
    }
  }
  while (rows.length < n) {
    rows.push(base(i, { sku: `ACME5K-${pad(i, 5)}`, name: `Acme Item ${pad(i, 5)}` }));
    i++;
  }
  return rows;
}

/** Real client: dials the vetted local fields, never the raw URL. Loaded lazily so tests need no Prisma. */
export function createPrismaClient(env) {
  const apiRequire = createRequire(new URL("../../apps/api/package.json", import.meta.url));
  const { PrismaClient } = apiRequire("@prisma/client");
  const { PrismaPg } = apiRequire("@prisma/adapter-pg");
  const { Pool } = apiRequire("pg");
  const pool = new Pool(localConnectionConfig(env.DATABASE_URL));
  return new PrismaClient({ adapter: new PrismaPg(pool) });
}

export async function seedCatalog({
  env = process.env,
  slug = "test",
  count = DEFAULT_COUNT,
  createClient,
} = {}) {
  assertSafeTarget(env);
  assertSeedTenant(slug);
  const prisma = (createClient ?? createPrismaClient)(env);
  try {
    const tenant = await prisma.tenant.findUnique({ where: { slug }, select: { id: true } });
    if (!tenant) throw new Error(`Tenant "${slug}" not found. Run \`npm run local:seed\` first.`);
    const tenantId = tenant.id;
    const idBySku = new Map();
    const rows = buildCatalog(count);
    for (const r of rows) {
      const { parentSku, kind, ...fields } = r;
      const definitional = {
        name: fields.name,
        description: `${fields.category} (perf seed)`,
        category: fields.category,
        unit: fields.unit,
        pricePerUnit: fields.pricePerUnit,
        priceTier2: fields.priceTier2,
        unitsPerBox: fields.unitsPerBox,
        reorderPoint: fields.reorderPoint,
        variantName: fields.variantName,
        kind,
        parentProductId: parentSku ? idBySku.get(parentSku) : null,
        isActive: true,
      };
      const saved = await prisma.product.upsert({
        where: { tenantId_sku: { tenantId, sku: fields.sku } },
        update: definitional,
        create: { tenantId, sku: fields.sku, currentStock: fields.currentStock, ...definitional },
        select: { id: true },
      });
      idBySku.set(fields.sku, saved.id);
    }
    return { total: rows.length, tenantId };
  } finally {
    await prisma.$disconnect?.();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const started = Date.now();
  const count = Number(process.env.COUNT ?? DEFAULT_COUNT);
  seedCatalog({ count })
    .then((r) =>
      console.log(
        `seeded ${r.total} products on "test" in ${((Date.now() - started) / 1000).toFixed(1)}s`,
      ),
    )
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
