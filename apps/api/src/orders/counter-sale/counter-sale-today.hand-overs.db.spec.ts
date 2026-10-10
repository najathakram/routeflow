/**
 * SA-763r R7 — real-Postgres pin for Today's sales "Hand-overs": a POS-mode hand-over's cash tender (a
 * PICKUP, non-counter order whose payment carries the v5 group id) and a counter sale rung the same day.
 * Hand-overs counts only the PICKUP non-counter payment with the matching v5 id (not a deposit on the same
 * invoice, not another order's id, not a ROUTE order's payment); the counter sale is counted once; both
 * reach moneyIn.cash and cashExpectedInDrawer.
 *
 * NOT RUN by the authoring lane (no Postgres here): the DB lane runs it (`npm run local:test:db`, test
 * tenants only, collected only by jest.db.config.js). One throwaway `qa-handover-<run>` tenant.
 */
jest.mock("../../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { CounterSaleTodayService } from "./counter-sale-today.service";
import { pickupTenderGroupId } from "./pickup-tender-group";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

const DAY = "2026-10-06";
const NOW = new Date("2026-10-07T15:00:00.000Z");
const AT = "2026-10-06T17:00:00.000Z"; // inside the New York day

describeDb("SA-763r — Today's sales Hand-overs on real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-handover-${run}`, "counter-sale-today.hand-overs.db.spec.ts");
  let tenantId = "";
  let userId = "";
  let customerId = "";
  const orderIds: string[] = [];
  const invoiceIds: string[] = [];
  let n = 0;

  async function sale(opts: {
    fulfillPath: "PICKUP" | "ROUTE";
    counterSale: boolean;
    payments: Array<{ method: string; amount: number; group?: "v5" | "other" | null }>;
  }) {
    n += 1;
    const order = await raw.order.create({
      data: {
        customerId,
        tenantId,
        counterSale: opts.counterSale,
        fulfillPath: opts.fulfillPath,
        status: "DELIVERED",
        orderNumber: `HO${run}-${n}`,
        total: 100,
        createdAt: new Date(AT),
      },
    });
    orderIds.push(order.id);
    const invoice = await raw.invoice.create({
      data: {
        invoiceNumber: `INV-HO-${run}-${n}`,
        customerId,
        orderId: order.id,
        tenantId,
        status: "SENT",
        subtotal: 100,
        total: 100,
      },
    });
    invoiceIds.push(invoice.id);
    for (const p of opts.payments) {
      await raw.invoicePayment.create({
        data: {
          invoiceId: invoice.id,
          tenantId,
          paidAt: new Date(AT),
          amount: p.amount,
          method: p.method as never,
          status: "PAID",
          paymentGroupId:
            p.group === "v5"
              ? pickupTenderGroupId(order.id)
              : p.group === "other"
                ? randomUUID()
                : null,
        },
      });
    }
    return order.id;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    tenantId = (await raw.tenant.create({ data: { slug, name: `HandOver ${slug}` } })).id;
    await raw.tenantConfig.create({ data: { tenantId, timezone: "America/New_York" } });
    userId = (
      await raw.user.create({
        data: { email: `c-${run}@example.test`, username: `c-${run}`, role: "CUSTOMER", tenantId },
      })
    ).id;
    customerId = (
      await raw.customer.create({
        data: { userId, businessName: `Acme Test ${run}`, contactName: "Tester", tenantId },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await raw.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    await raw.customer.deleteMany({ where: { id: customerId } });
    await raw.user.deleteMany({ where: { id: userId } });
    await raw.tenantConfig.deleteMany({ where: { tenantId } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("(11) counts only the PICKUP non-counter payment with the matching v5 id; the counter sale once", async () => {
    // a POS hand-over: a $20 deposit (own group) then the $80 cash tender (the v5 group)
    await sale({
      fulfillPath: "PICKUP",
      counterSale: false,
      payments: [
        { method: "CASH", amount: 20, group: "other" },
        { method: "CASH", amount: 80, group: "v5" },
      ],
    });
    // a counter sale the same day: PICKUP + counterSale true, its own $30 cash (never in Hand-overs)
    await sale({
      fulfillPath: "PICKUP",
      counterSale: true,
      payments: [{ method: "CASH", amount: 30, group: null }],
    });
    // a ROUTE order's payment carrying a pickup-shaped id never counts
    await sale({
      fulfillPath: "ROUTE",
      counterSale: false,
      payments: [{ method: "CASH", amount: 5, group: "other" }],
    });
    const res = await tenantCtx.run(tenantId, () =>
      new CounterSaleTodayService(prisma).today({ day: DAY, page: 1, limit: 50 } as never, NOW),
    );
    const s = res.summary!;
    expect(s.handOvers).toEqual({ count: 1, total: 80 });
    expect(s.moneyIn.cash).toBe(110); // 80 hand-over + 30 counter sale, each once
    expect(s.cashExpectedInDrawer).toBe(110);
    expect(s.sales.count).toBe(1); // the counter sale only
  });
});
