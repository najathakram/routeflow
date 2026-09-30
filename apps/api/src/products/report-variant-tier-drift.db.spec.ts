/**
 * #2717 M2 test 33 (SA-574 Q4, R-030a) — DB-lane spec for `prisma/report-variant-tier-drift.ts`'s
 * `loadCounts`. Real Postgres, one throwaway `qa-*` fixture tenant (L-234: the report is scoped to
 * it by slug, so parallel workers' rows never enter the counts).
 *
 * WRITTEN, NOT RUN by the M2 builder: F2/CI own the DB lane (`npm run local:test:db`).
 * `requireLocalDatabaseUrl()` refuses any non-local host; `afterAll` deletes exactly this tenant.
 *
 * Fixture: 2 families / 5 variants (see the unit spec's FIXTURE) plus CustomerPrice rows for one
 * customer with different tiers on two variants of one family.
 */
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { loadCounts } from "../../prisma/report-variant-tier-drift";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs") as {
  assertTestTenant: (slug: string, context?: string) => string;
};

describeDb("report-variant-tier-drift loadCounts() (db)", () => {
  const pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  const slug = assertTestTenant(
    `qa-2717-drift-${randomUUID().slice(0, 8)}`,
    "report-variant-tier-drift.db.spec.ts",
  );
  let tenantId: string;
  let customerId: string;
  const ids: Record<string, string> = {};

  const make = (
    key: string,
    data: {
      parentKey?: string;
      list: string;
      tiers?: [string, string, string, string];
      isActive?: boolean;
      unitsPerBox?: number;
    },
  ) =>
    prisma.product
      .create({
        data: {
          tenantId,
          name: `${key}-${randomUUID().slice(0, 6)}`,
          sku: `D-${randomUUID().slice(0, 8)}`,
          unit: "case",
          unitsPerBox: data.unitsPerBox ?? 12,
          isActive: data.isActive ?? true,
          parentProductId: data.parentKey ? ids[data.parentKey] : null,
          pricePerUnit: data.list,
          priceTier2: data.tiers?.[0] ?? "0",
          priceTier3: data.tiers?.[1] ?? "0",
          priceTier4: data.tiers?.[2] ?? "0",
          priceTier5: data.tiers?.[3] ?? "0",
        },
      })
      .then((row) => {
        ids[key] = row.id;
      });

  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { slug, name: `2717 drift ${slug}` } });
    tenantId = tenant.id;
    await make("fam1", { list: "10.00", tiers: ["9.50", "9.00", "0", "8.00"] });
    await make("v1a", { parentKey: "fam1", list: "10.00", tiers: ["9.50", "9.00", "0", "8.00"] });
    await make("v1b", {
      parentKey: "fam1",
      list: "10.00",
      tiers: ["9.50", "9.00", "10.00", "8.00"],
    });
    await make("v1c", { parentKey: "fam1", list: "10.00", tiers: ["9.50", "8.50", "0", "8.00"] });
    await make("fam2", { list: "1.50", tiers: ["1.50", "1.50", "1.50", "1.50"] });
    await make("v2a", { parentKey: "fam2", list: "1.50", tiers: ["1.50", "1.50", "1.50", "1.50"] });
    await make("v2b", {
      parentKey: "fam2",
      list: "1.50",
      tiers: ["1.40", "1.50", "1.50", "1.50"],
      isActive: false,
      unitsPerBox: 24,
    });
    const user = await prisma.user.create({
      data: {
        email: `drift-${randomUUID().slice(0, 8)}@example.invalid`,
        username: `drift-${randomUUID().slice(0, 8)}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: "Drift customer", contactName: "Drift", tenantId },
    });
    customerId = customer.id;
    await prisma.customerPrice.createMany({
      data: [
        { tenantId, customerId, productId: ids.v1a, pricingTier: 2 },
        { tenantId, customerId, productId: ids.v1b, pricingTier: 3 },
      ],
    });
  });

  afterAll(async () => {
    await prisma.customerPrice.deleteMany({ where: { tenantId } }).catch(() => undefined);
    await prisma.customer.deleteMany({ where: { tenantId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { tenantId } }).catch(() => undefined);
    await prisma.product
      .deleteMany({ where: { tenantId, parentProductId: { not: null } } })
      .catch(() => undefined);
    await prisma.product.deleteMany({ where: { tenantId } }).catch(() => undefined);
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
    await prisma.$disconnect();
    await pool.end();
  });

  it("the counts match the fixture", async () => {
    expect(await loadCounts(prisma, slug)).toEqual({
      variantsWithTierDiff: 2,
      familiesWithTierDiff: 2,
      variantsWithPackSizeDiff: 1,
      inactiveVariantsWithTierDiff: 1,
      customersWithCustomerPriceTierDiff: 1,
    });
  });

  it("is read-only: every Product updatedAt and the row counts are unchanged", async () => {
    const snapshot = async () => ({
      products: (
        await prisma.product.findMany({ where: { tenantId }, orderBy: { id: "asc" } })
      ).map((p) => [p.id, p.updatedAt.toISOString()]),
      customerPrices: await prisma.customerPrice.count({ where: { tenantId } }),
      productCount: await prisma.product.count({ where: { tenantId } }),
    });
    const before = await snapshot();
    await loadCounts(prisma, slug);
    expect(await snapshot()).toEqual(before);
  });

  it("an unknown tenant slug is refused without echoing it", async () => {
    const err = await loadCounts(prisma, "qa-2717-no-such-tenant").catch((e: Error) => e);
    expect((err as Error).message).not.toContain("qa-2717-no-such-tenant");
  });
});
