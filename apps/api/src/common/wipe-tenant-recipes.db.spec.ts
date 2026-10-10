/**
 * DB-lane spec (#2717 M2, SA-594) — the tenant fresh-start wipe vs the RESTRICT recipe FKs — real
 * Postgres. Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * `requireLocalDatabaseUrl()` refuses any non-local host.
 *
 * AUTHORED WITHOUT A DATABASE: typechecked, NOT executed here. F2 owns real-PG specs and runs it at
 * the PR sha; do not treat it as passing until that run is posted.
 *
 * Fixture (one throwaway `qa-*` tenant, assertTestTenant-approved) plus a second `qa-*` bystander:
 *   family F, variants V1 + V2 (parentProductId = F), a RECIPE product R;
 *   recipe v1 ACTIVE (activeFor = R) with components V1 x2, V2 x1; recipe v2 DRAFT with V1 x3.
 * `Recipe.productId/familyProductId` and `RecipeComponent.componentProductId` are RESTRICT into
 * Product, so before the fold `product.deleteMany` failed P2003 and the whole transaction rolled back.
 *
 * The real script runs as a child process (`<slug> --local --execute`, slug typed back on stdin) and
 * must exit 0 with zero Recipe / RecipeComponent / Product rows left for the tenant, while the
 * bystander tenant's product is untouched.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, ProductKind, RecipeStatus, TenantClass, TenantStatus } from "@prisma/client";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs") as {
  assertTestTenant: (slug: string, context?: string) => string;
};

const SCRIPT = path.resolve(__dirname, "../../scripts/wipe-tenant-fresh-start.js");

describeDb("wipe-tenant-fresh-start.js deletes a tenant that holds recipes (db)", () => {
  const dbUrl = requireLocalDatabaseUrl();
  const pool = new Pool({ connectionString: dbUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-2717-wipe-${run}`, "wipe-tenant-recipes.db.spec.ts");
  const otherSlug = assertTestTenant(`qa-2717-wipe-other-${run}`, "wipe-tenant-recipes.db.spec.ts");
  let tenantId: string;
  let otherTenantId: string;
  let otherProductId: string;

  const base = { unit: "case", pricePerUnit: 10 };

  beforeAll(async () => {
    tenantId = (
      await prisma.tenant.create({
        data: { slug, name: slug, class: TenantClass.TEST, status: TenantStatus.ACTIVE },
      })
    ).id;
    otherTenantId = (
      await prisma.tenant.create({
        data: {
          slug: otherSlug,
          name: otherSlug,
          class: TenantClass.TEST,
          status: TenantStatus.ACTIVE,
        },
      })
    ).id;
    otherProductId = (
      await prisma.product.create({
        data: { ...base, tenantId: otherTenantId, name: `Bystander ${run}` },
      })
    ).id;

    const family = await prisma.product.create({
      data: { ...base, tenantId, name: `Family ${run}`, kind: ProductKind.FAMILY },
    });
    const v1 = await prisma.product.create({
      data: {
        ...base,
        tenantId,
        name: `V1 ${run}`,
        kind: ProductKind.VARIANT,
        parentProductId: family.id,
      },
    });
    const v2 = await prisma.product.create({
      data: {
        ...base,
        tenantId,
        name: `V2 ${run}`,
        kind: ProductKind.VARIANT,
        parentProductId: family.id,
      },
    });
    const recipeProduct = await prisma.product.create({
      data: { ...base, tenantId, name: `Mix ${run}`, kind: ProductKind.RECIPE },
    });

    const active = await prisma.recipe.create({
      data: {
        tenantId,
        productId: recipeProduct.id,
        familyProductId: family.id,
        version: 1,
        unitsPerPack: 3,
        status: RecipeStatus.ACTIVE,
        activeFor: recipeProduct.id,
        effectiveFrom: new Date(),
      },
    });
    const draft = await prisma.recipe.create({
      data: {
        tenantId,
        productId: recipeProduct.id,
        familyProductId: family.id,
        version: 2,
        unitsPerPack: 3,
        status: RecipeStatus.DRAFT,
      },
    });
    await prisma.recipeComponent.createMany({
      data: [
        { tenantId, recipeId: active.id, componentProductId: v1.id, qty: 2, position: 0 },
        { tenantId, recipeId: active.id, componentProductId: v2.id, qty: 1, position: 1 },
        { tenantId, recipeId: draft.id, componentProductId: v1.id, qty: 3, position: 0 },
      ],
    });
  });

  afterAll(async () => {
    await prisma.recipeComponent.deleteMany({
      where: { tenantId: { in: [tenantId, otherTenantId] } },
    });
    await prisma.recipe.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } });
    await prisma.product.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
    await prisma.$disconnect();
    await pool.end();
  });

  it("seeds the fixture the wipe must survive", async () => {
    expect(await prisma.product.count({ where: { tenantId } })).toBe(4);
    expect(await prisma.recipe.count({ where: { tenantId } })).toBe(2);
    expect(await prisma.recipeComponent.count({ where: { tenantId } })).toBe(3);
  });

  it("wipes the tenant: exit 0, no FK error, its recipe rows and products are gone, a bystander is untouched", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: dbUrl };
    for (const k of Object.keys(env)) {
      if (k.startsWith("RAILWAY_") || k === "DATABASE_PUBLIC_URL") delete env[k];
    }
    const res = spawnSync(process.execPath, [SCRIPT, slug, "--local", "--execute"], {
      cwd: path.resolve(__dirname, "../.."),
      encoding: "utf8",
      env,
      input: `${slug}\n`,
      timeout: 120_000,
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    expect(out).not.toMatch(/P2003|Foreign key constraint/i);
    expect(res.status).toBe(0);

    expect(await prisma.recipeComponent.count({ where: { tenantId } })).toBe(0);
    expect(await prisma.recipe.count({ where: { tenantId } })).toBe(0);
    expect(await prisma.product.count({ where: { tenantId } })).toBe(0);

    expect(await prisma.tenant.count({ where: { id: tenantId } })).toBe(1); // the shell is preserved
    expect(await prisma.product.count({ where: { id: otherProductId } })).toBe(1);
  });
});
