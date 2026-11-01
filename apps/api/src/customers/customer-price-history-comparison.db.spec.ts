/**
 * SA-954 on real Postgres: the ONE compare read (every customer's issued invoices of the product, newest 2000, no date
 * bound since W-1058 H-2.5) and the in-memory split into `aggregate`, line 2 and line 3, run against real rows. F6's fixture, one month:
 * this customer buys a Box of 12 at 25.00; others buy a Box of 24 at 46.80, a Piece at 2.15, a Case of 48 at 105.00,
 * and a pre-snapshot Box at 9.99 whose pack is unknown. Line 3 for the Box of 12 is 25.11 (never the round-first 25.08);
 * line 2 is empty (no other buyer bought a Box of 12); no customer id or name leaves. Run as an OPERATOR denied ORDERS and
 * FINANCE (W-1058 H-2.10) the floor of 3 holds: the most-sold unit has 2 other buyers, so the aggregate is null. A fifth
 * other buyer is absent on purpose: with the unknown-pack buyer left out there are exactly 3 known-pack other buyers, the
 * floor. Run as normal staff the aggregate is drawn from those 2 buyers, with its newest month.
 *
 * Collected only by jest.db.config.js (npm run local:test:db). One throwaway `qa-ph-<run>` tenant approved by
 * `assertTestTenant`; afterAll deletes exactly what it made.
 */
import { randomUUID } from "crypto";
import { UserRole } from "@prisma/client";
import { describeDb } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { CustomerPriceHistoryService } from "./customer-price-history.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("SA-954 price history comparison — real Postgres", () => {
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-ph-${run}`, "customer-price-history-comparison.db.spec.ts");
  const slugB = assertTestTenant(`qa-ph-${run}b`, "customer-price-history-comparison.db.spec.ts");
  let tenantCtx: TenantContextService;
  let prisma: PrismaService;
  let service: CustomerPriceHistoryService;
  let tenantId = "";
  let tenantIdB = "";
  let productId = "";
  const customerIds: Record<string, string> = {};
  const userIds: string[] = [];
  /** Last month, the 10th, UTC: always inside the aggregate's 180-day window. */
  const issued = (() => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 10));
  })();
  const month = issued.toISOString().slice(0, 7);

  async function customer(key: string, tid = tenantId) {
    const user = await prisma.user.create({
      data: {
        email: `${key}-${run}@example.invalid`,
        username: `${key}-${run}`,
        role: "CUSTOMER",
        tenantId: tid,
      },
    });
    userIds.push(user.id);
    const c = await prisma.customer.create({
      data: { userId: user.id, businessName: `secret-${key}`, contactName: key, tenantId: tid },
    });
    customerIds[key] = c.id;
  }

  async function sale(key: string, item: Record<string, unknown>, n: number, tid = tenantId) {
    await prisma.invoice.create({
      data: {
        tenantId: tid,
        customerId: customerIds[key]!,
        invoiceNumber: `PH-${run}-${n}`,
        status: "SENT",
        issueDate: issued,
        subtotal: item.unitPrice as number,
        total: item.unitPrice as number,
        items: {
          create: [
            {
              tenantId: tid,
              productId,
              description: "Cola",
              subtotal: item.unitPrice as number,
              ...item,
            } as never,
          ],
        },
      },
    });
  }

  beforeAll(async () => {
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    service = new CustomerPriceHistoryService(prisma);
    tenantId = (await prisma.tenant.create({ data: { slug, name: `PH ${slug}` } })).id;
    productId = (
      await prisma.product.create({
        data: { tenantId, name: `PH cola ${run}`, unit: "pc", pricePerUnit: 2 },
      })
    ).id;
    for (const k of ["c1", "c2", "c3", "c4", "c5"]) await customer(k);
    await sale(
      "c1",
      { unitPrice: 25, qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12, unitLabel: "Box" },
      1,
    );
    await sale(
      "c2",
      { unitPrice: 46.8, qty: 24, boxes: 1, pieces: 0, unitsPerBox: 24, unitLabel: "Box" },
      2,
    );
    await sale("c3", { unitPrice: 2.15, qty: 1 }, 3);
    await sale(
      "c4",
      { unitPrice: 105, qty: 48, boxes: 1, pieces: 0, unitsPerBox: 48, unitLabel: "Case" },
      4,
    );
    await sale("c5", { unitPrice: 9.99, qty: 1, boxes: 1, pieces: 0, unitLabel: "Box" }, 5); // pack unknown
    // A SECOND tenant whose invoices point at the SAME product id (a poisoned cross-tenant row): three buyers of a Box of
    // 12 at 100.00 would give line 2 a point and move line 3, if the read ever counted another tenant's invoices.
    tenantIdB = (await prisma.tenant.create({ data: { slug: slugB, name: `PH ${slugB}` } })).id;
    for (const [i, k] of ["b1", "b2", "b3"].entries()) {
      await customer(k, tenantIdB);
      await sale(
        k,
        { unitPrice: 100, qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12, unitLabel: "Box" },
        101 + i,
        tenantIdB,
      );
    }
  }, 120_000);

  afterAll(async () => {
    const both = { in: [tenantId, tenantIdB].filter(Boolean) };
    await prisma?.invoiceItem.deleteMany({ where: { tenantId: both } });
    await prisma?.invoice.deleteMany({ where: { tenantId: both } });
    await prisma?.customer.deleteMany({ where: { tenantId: both } });
    await prisma?.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma?.product.deleteMany({ where: { tenantId } });
    await prisma?.tenant.deleteMany({ where: { id: both } });
    await prisma?.$disconnect();
  }, 120_000);

  /** An OPERATOR denied ORDERS and FINANCE: the floor of 3 applies. */
  const history = () =>
    tenantCtx.run(tenantId, () =>
      service.getHistory(customerIds.c1!, productId, {
        role: UserRole.OPERATOR,
        compare: "all",
        deniedGroups: ["ORDERS", "FINANCE"],
      }),
    );
  /** Normal staff: no floor. */
  const historyNoFloor = () =>
    tenantCtx.run(tenantId, () =>
      service.getHistory(customerIds.c1!, productId, {
        role: UserRole.OPERATOR,
        compare: "all",
        deniedGroups: [],
      }),
    );

  it("F6: line 3 for this customer's Box of 12 is 25.11, line 2 is empty", async () => {
    const r = await history();
    const e = r.comparison!.find((x) => x.unitLabel === "Box" && x.unitsPerBox === 12)!;
    expect(e).toBeDefined();
    expect(e.converted).toEqual([{ month, average: 25.11 }]);
    expect(e.likeForLike).toEqual([]);
  });

  it("an OPERATOR denied ORDERS and FINANCE keeps the floor: the most-sold unit (Box) has 2 other buyers, so the aggregate is null, while line 3 clears its floor across units", async () => {
    const r = await history();
    expect(r.aggregate).toBeNull();
    expect(r.comparison!.find((x) => x.unitsPerBox === 12)!.converted).toHaveLength(1);
  });

  it("normal staff have no floor: the aggregate is drawn from the 2 other buyers of the most-sold unit, with its newest month", async () => {
    const r = await historyNoFloor();
    expect(r.aggregate).toMatchObject({ unitLabel: "Box", customers: 2, newestMonth: month });
    expect(r.comparison!.find((x) => x.unitsPerBox === 12)!.converted).toEqual([
      { month, average: 25.11 },
    ]);
  });

  it("another tenant's invoices for the same product id are never counted (SA-954: tenant isolation)", async () => {
    const r = await history();
    const e = r.comparison!.find((x) => x.unitLabel === "Box" && x.unitsPerBox === 12)!;
    // had the 100.00 sales leaked: line 2 would hold a point (3 other buyers of a Box of 12) and line 3 would read ~49
    expect(e.likeForLike).toEqual([]);
    expect(e.converted).toEqual([{ month, average: 25.11 }]);
    expect(r.aggregate).toBeNull();
    const json = JSON.stringify(r);
    for (const k of ["b1", "b2", "b3"]) expect(json).not.toContain(customerIds[k]!);
  });

  it("no customer id or name anywhere in the comparison", async () => {
    const r = await history();
    const json = JSON.stringify(r.comparison) + JSON.stringify(r.aggregate);
    for (const id of Object.values(customerIds)) expect(json).not.toContain(id);
    expect(json).not.toMatch(/secret-/);
  });
});
