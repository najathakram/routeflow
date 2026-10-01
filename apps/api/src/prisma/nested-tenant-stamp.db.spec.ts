import { randomUUID } from "crypto";
import { PrismaService } from "./prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { NestedTenantWalkError } from "../tenant/nested-tenant-walk";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

/**
 * SA-620 B1 (real PG): a nested relation create through forTenant() / tenantTransaction() yields child
 * rows that carry the tenant, so a later tenant-scoped child query matches them. Order -> lineItems
 * (OrderItem) already has a NOT NULL tenantId CHECK (T6), so on old code that create FAILS (23514) rather
 * than storing NULL; VendorBill -> items (VendorBillItem) is the SILENT-NULL class (no check) and is the
 * motivating case (a bill edit kept the old line). The unit specs enumerate all ten child models.
 * Run by the F prover / F2 (needs the local compose DB).
 */
const RUN = randomUUID().slice(0, 8);

describeDb("nested tenant stamping on a real database (SA-620)", () => {
  let prisma: PrismaService;
  let ctx: TenantContextService;
  const tenantIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
  });

  afterAll(async () => {
    const swallow = () => undefined;
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.vendorBillItem.deleteMany(where).catch(swallow);
      await prisma.vendorBill.deleteMany(where).catch(swallow);
      await prisma.orderItem.deleteMany(where).catch(swallow);
      await prisma.order.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  async function seedTenant(label: string) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-620-${RUN}-${seq}-${label}`,
      "nested-tenant-stamp.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `#2896 ${slug}` } });
    tenantIds.push(tenant.id);
    const user = await prisma.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: label, contactName: label, tenantId: tenant.id },
    });
    return { tenantId: tenant.id, customerId: customer.id };
  }

  const line = (name: string) => ({ name, qty: 1, unitPrice: 5, subtotal: 5 });

  it("forTenant(): a nested create stamps the children; a later tenant-scoped child deleteMany matches them", async () => {
    const { tenantId, customerId } = await seedTenant("create");
    const order = await ctx.run(tenantId, () =>
      prisma.forTenant().order.create({
        data: {
          customerId,
          status: "PENDING",
          total: 10,
          lineItems: { create: [line("a"), line("b")] },
        },
      }),
    );
    const rows = await prisma.orderItem.findMany({ where: { orderId: order.id } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.tenantId === tenantId)).toBe(true);

    const del = await ctx.run(tenantId, () =>
      prisma.forTenant().orderItem.deleteMany({ where: { orderId: order.id } }),
    );
    expect(del.count).toBe(2);
  }, 60_000);

  const billLine = (d: string) => ({ description: d, qty: 1, unitCost: 2 });

  it("VendorBill (silent-NULL class): nested items.createMany carries the tenant, and a tenant-scoped delete matches every line", async () => {
    const { tenantId } = await seedTenant("vbcreate");
    const bill = await ctx.run(tenantId, () =>
      prisma.forTenant().vendorBill.create({
        data: {
          billNumber: `B-${RUN}-1`,
          totalOwed: 4,
          items: { createMany: { data: [billLine("a"), billLine("b")] } },
        },
      }),
    );
    const rows = await prisma.vendorBillItem.findMany({ where: { vendorBillId: bill.id } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.tenantId === tenantId)).toBe(true); // old code: NULL (no CHECK on this table)
    const del = await ctx.run(tenantId, () =>
      prisma.forTenant().vendorBillItem.deleteMany({ where: { vendorBillId: bill.id } }),
    );
    expect(del.count).toBe(2); // the replace-lines delete no longer skips NULL-tenant rows
  }, 60_000);

  it("VendorBill edit: update with items.createMany stamps the added lines (the edit that kept the old line)", async () => {
    const { tenantId } = await seedTenant("vbupdate");
    const bill = await ctx.run(tenantId, () =>
      prisma.forTenant().vendorBill.create({ data: { billNumber: `B-${RUN}-2`, totalOwed: 2 } }),
    );
    await ctx.run(tenantId, () =>
      prisma.forTenant().vendorBill.update({
        where: { id: bill.id },
        data: { items: { createMany: { data: [billLine("added")] } } },
      }),
    );
    const rows = await prisma.vendorBillItem.findMany({ where: { vendorBillId: bill.id } });
    expect(rows.map((r) => r.tenantId)).toEqual([tenantId]);
  }, 60_000);

  it("forTenant(): an UPDATE that adds a line stamps it (the edit that kept the old line)", async () => {
    const { tenantId, customerId } = await seedTenant("update");
    const order = await ctx.run(tenantId, () =>
      prisma.forTenant().order.create({ data: { customerId, status: "PENDING", total: 5 } }),
    );
    await ctx.run(tenantId, () =>
      prisma.forTenant().order.update({
        where: { id: order.id },
        data: { lineItems: { create: [line("added")] } },
      }),
    );
    const rows = await prisma.orderItem.findMany({ where: { orderId: order.id } });
    expect(rows.map((r) => r.tenantId)).toEqual([tenantId]);
  }, 60_000);

  it("tenantTransaction(): the tx proxy stamps nested children too", async () => {
    const { tenantId, customerId } = await seedTenant("tx");
    const orderId = await ctx.run(tenantId, () =>
      prisma.tenantTransaction(async (tx: any) => {
        const o = await tx.order.create({
          data: { customerId, status: "PENDING", total: 5, lineItems: { create: [line("t")] } },
        });
        return o.id as string;
      }),
    );
    const rows = await prisma.orderItem.findMany({ where: { orderId } });
    expect(rows.map((r) => r.tenantId)).toEqual([tenantId]);
  }, 60_000);

  it("an explicit DIFFERENT tenantId on a nested child throws and writes nothing", async () => {
    const a = await seedTenant("xa");
    const b = await seedTenant("xb");
    await expect(
      ctx.run(a.tenantId, () =>
        prisma.forTenant().order.create({
          data: {
            customerId: a.customerId,
            status: "PENDING",
            total: 5,
            lineItems: { create: [{ ...line("x"), tenantId: b.tenantId }] },
          },
        }),
      ),
    ).rejects.toBeInstanceOf(NestedTenantWalkError);
    expect(await prisma.order.count({ where: { tenantId: a.tenantId } })).toBe(0);
  }, 60_000);
});
