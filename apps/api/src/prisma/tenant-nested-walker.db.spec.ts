/**
 * SA-1110 (B929) rows W-1..W-4 (W-0 is in tenant-nested-walker.enforced.db.spec.ts) on a real Postgres (the DB lane). `VendorBillItem.tenantId` is nullable and carries no
 * T6 CHECK (one of the 28 unchecked tables), so a nested item written without a tenant lands as NULL and is invisible
 * to every tenant-scoped reader. Each row drives the real `PrismaService` inside a TENANT context and reads the child
 * back through a raw client. Collected only by jest.db.config.js.
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

describeDb("B929 nested-create walker (real Postgres)", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let tenantId: string;
  let productId: string;
  const billIds: string[] = [];
  const slug = assertTestTenant(
    `qa-b929-${randomUUID().slice(0, 8)}-walker`,
    "tenant-nested-walker.db.spec.ts",
  );
  const line = (extra: Record<string, unknown> = {}) => ({
    description: "Walker line",
    qty: 1,
    unitCost: 2,
    ...extra,
  });
  const billData = (items: unknown) => ({
    billNumber: `B929-${randomUUID().slice(0, 8)}`,
    totalOwed: 2,
    items,
  });
  const inTenant = <T>(fn: () => Promise<T>) => ctx.run(tenantId, fn, "ANONYMOUS", "B929Spec.run");
  const track = async <T extends { id: string }>(p: Promise<T>): Promise<T> => {
    const row = await p;
    billIds.push(row.id);
    return row;
  };
  const itemsOf = (vendorBillId: string) =>
    raw.vendorBillItem.findMany({ where: { vendorBillId }, orderBy: { createdAt: "asc" } });
  /** A bill written with explicit tenants everywhere, outside the walker's seats. */
  const seedBill = async () =>
    track(
      raw.vendorBill.create({
        data: { ...billData({ create: [line({ tenantId })] }), tenantId },
      }),
    );

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    const tenant = await raw.tenant.create({ data: { slug, name: `B929 walker ${slug}` } });
    tenantId = tenant.id;
    const product = await raw.product.create({
      data: { name: "Walker product", unit: "each", pricePerUnit: 1, tenantId },
    });
    productId = product.id;
  }, 120_000);

  afterAll(async () => {
    await raw.vendorBill.deleteMany({ where: { id: { in: billIds } } }); // items cascade
    await raw.product.deleteMany({ where: { id: productId } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
    await raw.$disconnect();
    await pool.end();
  }, 120_000);

  it("W-1: forTenant().vendorBill.create stamps the nested item", async () => {
    const bill = await inTenant(() =>
      track(prisma.forTenant().vendorBill.create({ data: billData({ create: [line(), line()] }) })),
    );
    expect((await itemsOf(bill.id)).map((i) => i.tenantId)).toEqual([tenantId, tenantId]);
  });

  it("W-2: the same through tenantTransaction", async () => {
    const bill = await inTenant(() =>
      track(
        prisma.tenantTransaction((tx) =>
          tx.vendorBill.create({ data: billData({ create: [line()] }) }),
        ),
      ),
    );
    expect((await itemsOf(bill.id)).map((i) => i.tenantId)).toEqual([tenantId]);
  });

  /** The two layers a TENANT write can take: the forTenant() extension and the tenantTransaction proxy. */
  const layers: [string, <T>(fn: (db: any) => Promise<T>) => Promise<T>][] = [
    ["forTenant", (fn) => inTenant(() => fn(prisma.forTenant()))],
    ["tenantTransaction", (fn) => inTenant(() => prisma.tenantTransaction((tx) => fn(tx)))],
  ];

  describe.each(layers)("%s", (_name, run) => {
    it("W-3: an update with items.createMany stamps the new rows, and a tenant-scoped deleteMany removes them", async () => {
      const bill = await seedBill();
      await run((db) =>
        db.vendorBill.update({
          where: { id: bill.id },
          data: { items: { createMany: { data: [line({ description: "added" })] } } },
        }),
      );
      expect((await itemsOf(bill.id)).map((i) => [i.description, i.tenantId])).toEqual([
        ["Walker line", tenantId],
        ["added", tenantId],
      ]);
      const removed = await run((db) =>
        db.vendorBillItem.deleteMany({ where: { vendorBillId: bill.id } }),
      );
      expect(removed.count).toBe(2);
      expect(await itemsOf(bill.id)).toEqual([]);
    });

    it("W-3b: a nested create inside an update (items.create) is stamped", async () => {
      const bill = await seedBill();
      await run((db) =>
        db.vendorBill.update({
          where: { id: bill.id },
          data: { items: { create: [line({ description: "via create" })] } },
        }),
      );
      expect((await itemsOf(bill.id)).map((i) => i.tenantId)).toEqual([tenantId, tenantId]);
    });

    it("W-4: a checked-form nested child (product connect, no tenantId) is written with tenant: { connect }", async () => {
      const bill = await run((db) =>
        db.vendorBill.create({
          data: billData({ create: [line({ product: { connect: { id: productId } } })] }),
        }),
      );
      billIds.push(bill.id);
      expect((await itemsOf(bill.id)).map((i) => [i.productId, i.tenantId])).toEqual([
        [productId, tenantId],
      ]);
    });
  });
});
