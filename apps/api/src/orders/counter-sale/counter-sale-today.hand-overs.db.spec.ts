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
  let staffId = "";
  let staffName = "";
  let customerId = "";
  const orderIds: string[] = [];
  const invoiceIds: string[] = [];
  let n = 0;

  async function sale(opts: {
    fulfillPath: "PICKUP" | "ROUTE";
    counterSale: boolean;
    invoiceStatus?: string;
    /** row 342: the register + cashier stamped on the order (absent = an unstamped, older order) */
    registerKey?: string | null;
    soldById?: string | null;
    payments: Array<{
      method: string;
      amount: number;
      group?: "v5" | "other" | null;
      status?: string;
    }>;
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
        registerKey: opts.registerKey ?? null,
        soldById: opts.soldById ?? null,
      },
    });
    orderIds.push(order.id);
    const invoice = await raw.invoice.create({
      data: {
        invoiceNumber: `INV-HO-${run}-${n}`,
        customerId,
        orderId: order.id,
        tenantId,
        status: (opts.invoiceStatus ?? "SENT") as never,
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
          status: (p.status ?? "PAID") as never,
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
    staffName = `cashier-${run}`;
    staffId = (
      await raw.user.create({
        data: {
          email: `s-${run}@example.test`,
          username: staffName,
          role: "OPERATOR",
          tenantId,
        },
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
    await raw.user.deleteMany({ where: { id: { in: [userId, staffId] } } });
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
    // a PICKUP-SHAPED id on a ROUTE order's payment must NOT count (the order predicate is the guard)
    await sale({
      fulfillPath: "ROUTE",
      counterSale: false,
      payments: [{ method: "CASH", amount: 5, group: "v5" }],
    });
    // a VOID payment with the matching id, and a PAID one on a VOID invoice, neither counts
    await sale({
      fulfillPath: "PICKUP",
      counterSale: false,
      payments: [{ method: "CASH", amount: 7, group: "v5", status: "VOID" }],
    });
    await sale({
      fulfillPath: "PICKUP",
      counterSale: false,
      invoiceStatus: "VOID",
      payments: [{ method: "CASH", amount: 9, group: "v5" }],
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
  it("(12) row 342: rows carry the stamped register + cashier; a driver's cash and an office payment are NOT rows", async () => {
    // a hand-over at register "reg-2" by a named cashier: cash + card tender (both the v5 group)
    const stamped = await sale({
      fulfillPath: "PICKUP",
      counterSale: false,
      registerKey: "reg-2",
      soldById: staffId,
      payments: [
        { method: "CASH", amount: 40, group: "v5" },
        { method: "CREDIT_CARD", amount: 10, group: "v5" },
      ],
    });
    // an older, unstamped hand-over: no register, no cashier -> "main" and null
    const unstamped = await sale({
      fulfillPath: "PICKUP",
      counterSale: false,
      payments: [{ method: "CASH", amount: 15, group: "v5" }],
    });
    // the driver-cash leg: a driver collects CASH at the door of a ROUTE order (recordDeliveryPaymentInTx shape:
    // ungrouped, paid on a route-stop order). Never a hand-over row, never in summary.handOvers.
    const driverCash = await sale({
      fulfillPath: "ROUTE",
      counterSale: false,
      registerKey: null,
      soldById: null,
      payments: [{ method: "CASH", amount: 25, group: null }],
    });
    // an office / back-office payment on a PICKUP order (ungrouped): not the hand-over's own tender
    const office = await sale({
      fulfillPath: "PICKUP",
      counterSale: false,
      registerKey: "reg-2",
      soldById: staffId,
      payments: [{ method: "CASH", amount: 12, group: null }],
    });
    const call = (page: number) =>
      tenantCtx.run(tenantId, () =>
        new CounterSaleTodayService(prisma).today({ day: DAY, page, limit: 50 } as never, NOW),
      );
    const res = await call(1);
    const rows = res.handOverRows!;
    const byId = new Map(rows.map((r) => [r.orderId, r]));

    expect(byId.get(stamped)).toMatchObject({
      amount: 50,
      methods: [
        { method: "CASH", amount: 40 },
        { method: "CARD", amount: 10 },
      ],
      registerKey: "reg-2",
      handedOverBy: staffName,
      customerName: `Acme Test ${run}`,
      paidAt: AT,
    });
    expect(byId.get(unstamped)).toMatchObject({
      amount: 15,
      registerKey: "main",
      handedOverBy: null,
    });
    expect(byId.has(driverCash)).toBe(false);
    expect(byId.has(office)).toBe(false);

    // the Z's own consistency: the rows ARE the summary's hand-overs (same tenders, same filter)
    const s = res.summary!;
    expect(rows.length).toBe(s.handOvers.count);
    expect(rows.reduce((t, r) => Math.round((t + r.amount) * 100) / 100, 0)).toBe(
      s.handOvers.total,
    );
    // (11)'s $80 + $50 + $15; the driver's $25 and the office $12 are in neither
    expect(s.handOvers).toEqual({ count: 3, total: 145 });
    // newest first: nothing out of order
    const paid = rows.map((r) => r.paidAt);
    expect([...paid].sort().reverse()).toEqual(paid);

    // later pages carry no rows and no summary (the hand-over read is page 1 only)
    const page2 = await call(2);
    expect(page2.summary).toBeNull();
    expect(page2.handOverRows).toEqual([]);
  });
});
