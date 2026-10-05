/**
 * DB lane. Real two-tenant Postgres (superuser connection, so RLS is bypassed and this proves
 * the JS tenancy layers specifically): unique lookups on a tenant-scoped model carry the tenant
 * filter in the query itself, under BOTH `prisma.forTenant()` and `prisma.tenantTransaction()`,
 * including when the caller's `select` leaves the tenant column out. The in-memory matrix lives
 * in tenant-unique-lookup.spec.ts; this file proves the real Prisma engine accepts the query
 * shape (a compound unique selector plus a plain filter) and answers it as intended.
 *
 * Run via `npm run local:test:db` (compose Postgres); collected only by jest.db.config.js.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "./prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

interface Fixture {
  tenantId: string;
  userId: string;
  customerId: string;
  addonId: string;
}

describeDb("tenant-scoped unique lookups on a real two-tenant database", () => {
  let pool: Pool;
  let raw: PrismaClient; // superuser fixture client, deliberately unscoped
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;

  const runSuffix = randomUUID().slice(0, 8);
  const slugA = assertTestTenant(`qa-ul-${runSuffix}-a`, "tenant-unique-lookup.db.spec.ts");
  const slugB = assertTestTenant(`qa-ul-${runSuffix}-b`, "tenant-unique-lookup.db.spec.ts");
  const platformKey = `qa-ul-${runSuffix}`;
  const ADDON_KEY = "qa_unique_lookup_addon";

  let a: Fixture;
  let b: Fixture;

  async function seedTenant(slug: string): Promise<Fixture> {
    const tenant = await raw.tenant.create({ data: { slug, name: `Unique lookup ${slug}` } });
    const user = await raw.user.create({
      data: {
        email: `${slug}@example.test`,
        username: slug,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await raw.customer.create({
      data: {
        userId: user.id,
        businessName: `${slug} co`,
        contactName: "Lookup Tester",
        tenantId: tenant.id,
      },
    });
    const addon = await raw.tenantAddon.create({
      data: { tenantId: tenant.id, addonKey: ADDON_KEY },
    });
    return { tenantId: tenant.id, userId: user.id, customerId: customer.id, addonId: addon.id };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    a = await seedTenant(slugA);
    b = await seedTenant(slugB);
    await raw.platformConfig.create({ data: { key: platformKey, value: "v" } });
  }, 120_000);

  afterAll(async () => {
    for (const f of [a, b]) {
      if (!f) continue;
      await raw.tenantAddon.deleteMany({ where: { id: f.addonId } });
      await raw.customer.deleteMany({ where: { id: f.customerId } });
      await raw.user.deleteMany({ where: { id: f.userId } });
      await raw.tenant.deleteMany({ where: { id: f.tenantId } });
    }
    await raw.platformConfig.deleteMany({ where: { key: platformKey } });
    await prisma.$disconnect();
    await raw.$disconnect();
    await pool.end();
  }, 120_000);

  const asTenantA = <T>(fn: () => Promise<T>) => tenantCtx.run(a.tenantId, fn);

  // Each layer hands the same callback a client with the tenant guard applied.
  const layers: Array<[string, (fn: (db: any) => Promise<void>) => Promise<void>]> = [
    ["forTenant()", (fn) => asTenantA(async () => fn(prisma.forTenant()))],
    [
      "tenantTransaction()",
      (fn) => asTenantA(() => prisma.tenantTransaction(async (tx: any) => fn(tx))),
    ],
  ];

  describe.each(layers)("%s", (_name, withDb) => {
    it("a foreign id with `select: { id }` resolves to null", async () => {
      await withDb(async (db) => {
        expect(
          await db.customer.findUnique({ where: { id: b.customerId }, select: { id: true } }),
        ).toBeNull();
      });
    });

    it("a foreign id with the stop-add shape `select: { deletedAt }` resolves to null", async () => {
      await withDb(async (db) => {
        expect(
          await db.customer.findUnique({
            where: { id: b.customerId },
            select: { deletedAt: true },
          }),
        ).toBeNull();
        // ...and the caller's own row still answers that same shape.
        expect(
          await db.customer.findUnique({
            where: { id: a.customerId },
            select: { deletedAt: true },
          }),
        ).toEqual({ deletedAt: null });
      });
    });

    it("an own id with `select: { id }` returns exactly the selected shape", async () => {
      await withDb(async (db) => {
        const row = await db.customer.findUnique({
          where: { id: a.customerId },
          select: { id: true },
        });
        expect(row).toEqual({ id: a.customerId });
      });
    });

    it("the compound unique (tenantId, addonKey) still resolves with the tenant filter injected", async () => {
      await withDb(async (db) => {
        const own = await db.tenantAddon.findUnique({
          where: { tenantId_addonKey: { tenantId: a.tenantId, addonKey: ADDON_KEY } },
        });
        expect(own?.id).toBe(a.addonId);
        const foreign = await db.tenantAddon.findUnique({
          where: { tenantId_addonKey: { tenantId: b.tenantId, addonKey: ADDON_KEY } },
          select: { id: true },
        });
        expect(foreign).toBeNull();
      });
    });

    it("findUniqueOrThrow: own id resolves; a foreign id rejects with P2025", async () => {
      await withDb(async (db) => {
        const own = await db.customer.findUniqueOrThrow({
          where: { id: a.customerId },
          select: { id: true },
        });
        expect(own).toEqual({ id: a.customerId });
        await expect(
          db.customer.findUniqueOrThrow({ where: { id: b.customerId }, select: { id: true } }),
        ).rejects.toMatchObject({ code: "P2025" });
      });
    });

    it("a non-tenant model is unaffected", async () => {
      await withDb(async (db) => {
        const row = await db.platformConfig.findUnique({ where: { key: platformKey } });
        expect(row).toMatchObject({ key: platformKey, value: "v" });
      });
    });
  });
});
