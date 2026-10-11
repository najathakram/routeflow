/**
 * SA-750r3 r-note (Train 4 meets day close) on real Postgres: a POS-mode pickup hand-over's cash is TILL cash of the register its
 * order is stamped on, through the real window queries (`readWindowFacts`, the one reader the preview, the close and the re-close
 * share) and the real fold:
 *   (1) a non-counter PICKUP order's own-group (`pickupTenderGroupId(orderId)`) cash row is in that register's tillCash and
 *       moneyIn.cash (a card hand-over is money in by method, never cash);
 *   (2) a driver / route payment on a non-counter order (random group) and an office payment on a pickup order (random group)
 *       are NOT till cash;
 *   (3) a non-counter order's UNGROUPED cash row is NOT till cash and is not read at all (notAtTill stays 0);
 *   (4) two registers: a hand-over on an order stamped 'b' counts only in b's window; a null-key hand-over counts in 'main';
 *   (5) a counter order's ungrouped cash counts, and so does its OWN pickup-group hand-over cash (pickup-complete runs on counter
 *       sales too): ordinary till cash, never counted into totals.handOver;
 *   plus the window and invoice rules: a VOID invoice drops its payments, a WRITTEN_OFF one keeps them, a payment outside the
 *   window counts for nothing, and a hand-over is never a counter sale (salesCount, countSalesSince).
 *
 * NOT RUN by the authoring lane (no Postgres here): the DB lane runs it (`npm run local:test:db`, test tenants only, collected only
 * by jest.db.config.js). Tenant slug `qa-day-close-handover-*` is approved by assertTestTenant.
 */
jest.mock("../../../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../../../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../../../common/testing/db-spec";
import { PrismaService } from "../../../prisma/prisma.service";
import { TenantContextService } from "../../../tenant/tenant-context.service";
import { pickupTenderGroupId } from "../pickup-tender-group";
import { countSalesSince } from "./day-close-facts";
import { CounterDayCloseService } from "./day-close.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../../scripts/lib/test-tenants.cjs");

const NOW = new Date("2026-10-08T20:00:00.000Z"); // 16:00 in New York (EDT): the day opened at 04:00Z
const IN_DAY = "2026-10-08T15:00:00.000Z";
const BEFORE_DAY = "2026-10-08T03:00:00.000Z";

type Group = "v5" | "other" | null;

describeDb("counter day close: POS-mode pickup hand-overs on real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: CounterDayCloseService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-day-close-handover-${run}`, "day-close-handover.db.spec.ts");
  let tenantId = "";
  let userId = "";
  let customerId = "";
  const orderIds: string[] = [];
  const invoiceIds: string[] = [];
  let seq = 0;

  const as = <T>(fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);

  /** One order with one invoice and the given payments (all dated `at`, default inside the window). */
  async function order(o: {
    counterSale: boolean;
    fulfillPath?: "PICKUP" | "ROUTE";
    registerKey?: string | null;
    invoiceStatus?: string;
    payments: Array<{ method?: string; amount: number; group: Group; at?: string }>;
  }) {
    seq += 1;
    const created = await raw.order.create({
      data: {
        customerId,
        tenantId,
        counterSale: o.counterSale,
        fulfillPath: o.fulfillPath ?? "PICKUP",
        registerKey: o.registerKey ?? null,
        status: "DELIVERED",
        orderNumber: `HD${run}-${seq}`,
        total: 100,
        createdAt: new Date("2026-10-08T14:00:00.000Z"),
      },
    });
    orderIds.push(created.id);
    const invoice = await raw.invoice.create({
      data: {
        invoiceNumber: `HINV-${run}-${seq}`,
        customerId,
        orderId: created.id,
        tenantId,
        status: (o.invoiceStatus ?? "SENT") as never,
        subtotal: 100,
        total: 100,
      },
    });
    invoiceIds.push(invoice.id);
    for (const p of o.payments) {
      await raw.invoicePayment.create({
        data: {
          invoiceId: invoice.id,
          tenantId,
          amount: p.amount,
          method: (p.method ?? "CASH") as never,
          status: "PAID" as never,
          paidAt: new Date(p.at ?? IN_DAY),
          paymentGroupId:
            p.group === "v5"
              ? pickupTenderGroupId(created.id)
              : p.group === "other"
                ? randomUUID()
                : null,
        },
      });
    }
    return created.id;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl(), max: 5 });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    service = new CounterDayCloseService(
      prisma,
      { get: async () => ({ counter: "optional" }) } as never,
      { send: async () => ({ delivered: true, transport: "smtp" }) } as never,
    );
    tenantId = (await raw.tenant.create({ data: { slug, name: `Day close handover ${slug}` } })).id;
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

  it("(1)-(5) a hand-over is till cash of its order's register; driver, office and ungrouped cash on a non-counter order is not", async () => {
    // (1) POS hand-overs on 'main' (a null key reads as main): $20 cash, and a card tender
    await order({ counterSale: false, payments: [{ amount: 20, group: "v5" }] });
    await order({
      counterSale: false,
      registerKey: "main",
      payments: [{ method: "CREDIT_CARD", amount: 8, group: "v5" }],
    });
    // a WRITTEN_OFF invoice keeps its cash (only VOID drops payments); a VOID invoice and a payment outside the window do not
    await order({
      counterSale: false,
      invoiceStatus: "WRITTEN_OFF",
      payments: [{ amount: 4, group: "v5" }],
    });
    await order({
      counterSale: false,
      invoiceStatus: "VOID",
      payments: [{ amount: 9, group: "v5" }],
    });
    await order({ counterSale: false, payments: [{ amount: 11, group: "v5", at: BEFORE_DAY }] });
    // (2) a driver's route payment, and an office payment on a pickup order: random group ids
    await order({
      counterSale: false,
      fulfillPath: "ROUTE",
      payments: [{ amount: 40, group: "other" }],
    });
    await order({ counterSale: false, payments: [{ amount: 6, group: "other" }] });
    // a ROUTE order can never be a hand-over even with the pickup-shaped id
    await order({
      counterSale: false,
      fulfillPath: "ROUTE",
      payments: [{ amount: 5, group: "v5" }],
    });
    // (3) an office / driver payment with NO group on a non-counter order
    await order({ counterSale: false, payments: [{ amount: 12, group: null }] });
    await order({
      counterSale: false,
      fulfillPath: "ROUTE",
      payments: [{ amount: 13, group: null }],
    });
    // (4) a hand-over stamped on register 'b'
    await order({ counterSale: false, registerKey: "b", payments: [{ amount: 15, group: "v5" }] });
    // (5) a counter sale's ungrouped cash counts; so does its own pickup-group hand-over cash (ordinary counter till cash)
    await order({ counterSale: true, payments: [{ amount: 30, group: null }] });
    await order({ counterSale: true, payments: [{ amount: 3, group: "v5" }] });

    const main = await as(() => service.state("main", NOW));
    expect(main.preview.windowStart).toBe("2026-10-08T04:00:00.000Z");
    expect(main.preview.tillCash).toBe(57); // 20 + 4 (hand-overs) + 30 + 3 (counter sale); not 'b', driver, office, ungrouped
    expect(main.preview.totals.moneyIn).toEqual({
      cash: 57,
      card: 8,
      check: 0,
      other: 0,
      total: 65,
    });
    expect(main.preview.totals.notAtTill).toBe(0); // the counter order's own pickup-group cash is till cash, not apart
    // totals.handOver: the real queries found 3 hand-over rows (cash 20, card 8, written-off cash 4); cash is the CASH ones only.
    // The counter order's pickup-group row (ordinary counter till cash), the driver / office / ungrouped rows and register 'b' are not hand-overs of main.
    expect(main.preview.totals.handOver).toEqual({ count: 3, cash: 24 });
    expect(main.preview.totals.salesCount).toBe(2); // the two counter sales: a hand-over is not a counter sale
    expect(main.preview.cashRefunds).toBe(0);

    // two registers: 'b' counts its own hand-over, never main's
    const b = await as(() => service.state("b", NOW));
    expect(b.preview.tillCash).toBe(15);
    expect(b.preview.totals.moneyIn).toEqual({ cash: 15, card: 0, check: 0, other: 0, total: 15 });
    expect(b.preview.totals.notAtTill).toBe(0);
    expect(b.preview.totals.handOver).toEqual({ count: 1, cash: 15 });
    expect(b.preview.totals.salesCount).toBe(0);

    // the sheet's "N sales since" is unchanged by hand-overs
    const salesSince = await as(() =>
      countSalesSince(
        prisma.forTenant(),
        tenantId,
        "main",
        new Date("2026-10-08T04:00:00.000Z"),
        NOW,
      ),
    );
    expect(salesSince).toBe(2);
  }, 60_000);
});
