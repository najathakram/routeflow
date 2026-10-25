/**
 * SA-954 on real Postgres: the ONE compare read (every customer's issued invoices of the product, the last 180 days) and
 * the in-memory split into `aggregate`, line 2 and line 3, run against real rows. F6's fixture, one month:
 * this customer buys a Box of 12 at 25.00; others buy a Box of 24 at 46.80, a Piece at 2.15, a Case of 48 at 105.00,
 * and a pre-snapshot Box at 9.99 whose pack is unknown. Line 3 for the Box of 12 is 25.11 (never the round-first 25.08);
 * line 2 is empty (no other buyer bought a Box of 12); the aggregate keeps its own floor (the most-sold unit has 2 other buyers, so it is null); no customer id or name
 * leaves. A fifth other buyer is absent on purpose: with the unknown-pack buyer left out there are exactly 3 known-pack
 * other buyers, the floor.
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
  let tenantCtx: TenantContextService;
  let prisma: PrismaService;
  let service: CustomerPriceHistoryService;
  let tenantId = "";
  let productId = "";
  const customerIds: Record<string, string> = {};
  const userIds: string[] = [];
  /** Last month, the 10th, UTC: always inside the 180-day window. */
  const issued = (() => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 10));
  })();
  const month = issued.toISOString().slice(0, 7);

  async function customer(key: string) {
    const user = await prisma.user.create({
      data: {
        email: `${key}-${run}@example.invalid`,
        username: `${key}-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    userIds.push(user.id);
    const c = await prisma.customer.create({
      data: { userId: user.id, businessName: `secret-${key}`, contactName: key, tenantId },
    });
    customerIds[key] = c.id;
  }

  async function sale(key: string, item: Record<string, unknown>, n: number) {
    await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customerIds[key]!,
        invoiceNumber: `PH-${run}-${n}`,
        status: "SENT",
        issueDate: issued,
        subtotal: item.unitPrice as number,
        total: item.unitPrice as number,
        items: {
          create: [
            {
              tenantId,
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
  }, 120_000);

  afterAll(async () => {
    await prisma?.invoiceItem.deleteMany({ where: { tenantId } });
    await prisma?.invoice.deleteMany({ where: { tenantId } });
    await prisma?.customer.deleteMany({ where: { tenantId } });
    await prisma?.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma?.product.deleteMany({ where: { tenantId } });
    await prisma?.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
  }, 120_000);

  const history = () =>
    tenantCtx.run(tenantId, () =>
      service.getHistory(customerIds.c1!, productId, { role: UserRole.OPERATOR, compare: "all" }),
    );

  it("F6: line 3 for this customer's Box of 12 is 25.11, line 2 is empty", async () => {
    const r = await history();
    const e = r.comparison!.find((x) => x.unitLabel === "Box" && x.unitsPerBox === 12)!;
    expect(e).toBeDefined();
    expect(e.converted).toEqual([{ month, average: 25.11 }]);
    expect(e.likeForLike).toEqual([]);
  });

  it("the aggregate keeps its own floor: the most-sold unit (Box) has 2 other buyers, so it is null, while line 3 clears its floor across units", async () => {
    const r = await history();
    expect(r.aggregate).toBeNull();
    expect(r.comparison!.find((x) => x.unitsPerBox === 12)!.converted).toHaveLength(1);
  });

  it("no customer id or name anywhere in the comparison", async () => {
    const r = await history();
    const json = JSON.stringify(r.comparison) + JSON.stringify(r.aggregate);
    for (const id of Object.values(customerIds)) expect(json).not.toContain(id);
    expect(json).not.toMatch(/secret-/);
  });
});
