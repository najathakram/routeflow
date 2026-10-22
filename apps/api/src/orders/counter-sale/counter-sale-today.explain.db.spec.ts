/**
 * POS-7b-1 — query-plan evidence for GET /orders/counter-sale/today (brief D-7).
 *
 * Seeds `EXPLAIN_ORDERS` counter orders (default 300, kept small so the lane stays quick; run with
 * `EXPLAIN_ORDERS=5000` for the brief's 5,000-order day) into ONE throwaway test tenant, each with an invoice and
 * a cash payment, then captures the SQL Prisma actually sends for the page query and the three summary queries
 * (the very args the service sends: `pageQuery` and the shared where-builders), runs
 * `EXPLAIN (ANALYZE, BUFFERS)` on every SELECT it captured and prints each plan.
 *
 * Hard assertions are correctness only (the page returns `limit` rows, the summary counts every order): a plan is
 * evidence for a human, not a CI assertion (a small table legitimately gets a seq scan). The reading rule from the
 * brief: if the page query or any summary query exceeds ~150 ms at 5,000 orders, or shows a Seq Scan on "Order",
 * file the follow-up migration `(tenantId, counterSale, createdAt)` as its own PR; this PR adds NO index. The money-in
 * query now filters `InvoicePayment.paidAt`; read its plan too (a `(tenantId, paidAt)` index is filed as its own PR). The seed
 * runs ANALYZE on the seeded tables first, otherwise the planner has no statistics and the plans prove nothing.
 *
 * NOT RUN by the authoring lane (no Postgres): the DB lane runs it (`npm run local:test:db`, test tenant only,
 * collected only by jest.db.config.js).
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import {
  carriedReturnSelect,
  carriedReturnWhere,
  creditNoteReadSelect,
  creditNoteReadWhere,
  counterSalesWhere,
  liveCounterSalesWhere,
  pageQuery,
  paidOnDaysSalesWhere,
  salePaymentsWhere,
  windowReturnsWhere,
} from "./counter-sale-today";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

const N = Number(process.env.EXPLAIN_ORDERS ?? 300);
const WINDOW = {
  start: new Date("2026-10-06T04:00:00.000Z"),
  end: new Date("2026-10-07T04:00:00.000Z"),
};

type QueryEvent = { query: string; params: string; duration: number };

describeDb(`POS-7b-1 — today's sales query plans (${N} orders)`, () => {
  let pool: Pool;
  let raw: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-cs-explain-${run}`, "counter-sale-today.explain.db.spec.ts");
  let tenantId = "";
  let userId = "";
  let customerId = "";
  const captured: QueryEvent[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({
      adapter: new PrismaPg(pool),
      log: [{ emit: "event", level: "query" }],
    });
    (raw as unknown as { $on(e: "query", cb: (q: QueryEvent) => void): void }).$on("query", (q) =>
      captured.push(q),
    );
    tenantId = (await raw.tenant.create({ data: { slug, name: `Explain ${slug}` } })).id;
    userId = (
      await raw.user.create({
        data: {
          email: `x-${run}@example.test`,
          username: `x-${run}`,
          role: "CUSTOMER",
          tenantId,
        },
      })
    ).id;
    customerId = (
      await raw.customer.create({
        data: { userId, businessName: "explain co", contactName: "Tester", tenantId },
      })
    ).id;
    // N orders spread over the window, one invoice and one cash payment each (createMany: three round trips).
    const orderIds = Array.from({ length: N }, () => randomUUID());
    const invoiceIds = Array.from({ length: N }, () => randomUUID());
    const at = (i: number) => new Date(WINDOW.start.getTime() + Math.floor((i / N) * 86_399_000));
    await raw.order.createMany({
      data: orderIds.map((id, i) => ({
        id,
        customerId,
        tenantId,
        counterSale: true,
        status: "DELIVERED" as const,
        orderNumber: `X${run}-${i}`,
        total: 10,
        createdAt: at(i),
      })),
    });
    await raw.invoice.createMany({
      data: invoiceIds.map((id, i) => ({
        id,
        invoiceNumber: `XI-${run}-${i}`,
        customerId,
        tenantId,
        orderId: orderIds[i],
        status: "PAID" as const,
        subtotal: 10,
        total: 10,
      })),
    });
    await raw.invoicePayment.createMany({
      data: invoiceIds.map((invoiceId, i) => ({
        invoiceId,
        tenantId,
        paidAt: at(i),
        amount: 10,
        method: "CASH" as const,
        status: "PAID" as const,
      })),
    });
    // A fresh seed has no planner statistics (row estimate ~1 -> nested loops, a 72 s "hang" on the Mac mini); the plan is
    // only evidence once the tables are analyzed, as they are in production.
    await raw.$executeRawUnsafe('ANALYZE "Order", "Invoice", "InvoicePayment", "Customer"');
  }, 300_000);

  afterAll(async () => {
    await raw.invoicePayment.deleteMany({ where: { tenantId } });
    await raw.invoice.deleteMany({ where: { tenantId } });
    await raw.order.deleteMany({ where: { tenantId } });
    await raw.customer.deleteMany({ where: { id: customerId } });
    await raw.user.deleteMany({ where: { id: userId } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await raw?.$disconnect();
    await pool?.end();
  }, 300_000);

  /** EXPLAIN (ANALYZE, BUFFERS) every SELECT a run of `fn` sent, print each plan with its duration. */
  async function explain(label: string, fn: () => Promise<unknown>): Promise<string[]> {
    captured.length = 0;
    await fn();
    const selects = captured.filter((q) => /^\s*SELECT/i.test(q.query));
    const plans: string[] = [];
    for (const q of selects) {
      const params = q.params ? (JSON.parse(q.params) as unknown[]) : [];
      const res = await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${q.query}`, params as never[]);
      const plan = res.rows.map((r) => String(r["QUERY PLAN"])).join("\n");
      plans.push(plan);
      // eslint-disable-next-line no-console
      console.info(
        `[explain] ${label} (${N} orders, prisma ${q.duration} ms)\n${q.query}\n${plan}`,
      );
    }
    return plans;
  }

  it("page query: a page of rows, plan printed", async () => {
    const limit = 50;
    let rows = 0;
    const plans = await explain("page", async () => {
      rows = (await raw.order.findMany(pageQuery(tenantId, WINDOW, 1, limit))).length;
    });
    expect(rows).toBe(Math.min(limit, N));
    expect(plans.length).toBeGreaterThan(0);
  });

  it("carried returns (B1262 / SA-838 e): the batched read by the page's credit note ids, plan printed", async () => {
    // Return.creditNoteId has no index of its own (no schema change in SA-838): the plan reads tenantId's index and filters
    // the note ids. Evidence for a human, like the rest: the lane prints it.
    const noteIds = Array.from({ length: 50 }, () => randomUUID());
    let rows = -1;
    const plans = await explain("carried returns", async () => {
      rows = (
        await raw.return.findMany({
          where: carriedReturnWhere(tenantId, noteIds),
          select: carriedReturnSelect,
        })
      ).length;
    });
    expect(rows).toBe(0);
    expect(plans.length).toBeGreaterThan(0);
  });

  it("credit notes (SA-838a I2): the ONE batched read by note id, with the PAID payments applied anywhere, plan printed", async () => {
    // CreditNote.id is the primary key and InvoicePayment.creditNoteId is the relation's join column: the plan is evidence
    // for a human, like the rest. The lane prints it.
    const noteIds = Array.from({ length: 50 }, () => randomUUID());
    let rows = -1;
    const plans = await explain("credit notes", async () => {
      rows = (
        await raw.creditNote.findMany({
          where: creditNoteReadWhere(tenantId, noteIds),
          select: creditNoteReadSelect,
        })
      ).length;
    });
    expect(rows).toBe(0);
    expect(plans.length).toBeGreaterThan(0);
  });

  it("summary queries: aggregate, payment groupBy, return groupBy; the figures cover every order, plans printed", async () => {
    let count = 0;
    let cash = 0;
    await explain("summary.sales", async () => {
      const a = await raw.order.aggregate({
        where: liveCounterSalesWhere(tenantId, WINDOW),
        _count: { _all: true },
        _sum: { total: true },
      });
      count = a._count._all;
    });
    await explain("summary.payments", async () => {
      const g = await raw.invoicePayment.groupBy({
        by: ["method"],
        where: salePaymentsWhere(tenantId, WINDOW),
        _sum: { amount: true },
      });
      cash = Number(g.find((x) => x.method === "CASH")?._sum.amount ?? 0);
    });
    await explain("summary.paidOnSales", async () => {
      await raw.invoicePayment.aggregate({
        where: paidOnDaysSalesWhere(tenantId, WINDOW),
        _sum: { amount: true },
      });
    });
    await explain("summary.returns", async () => {
      await raw.return.findMany({
        where: windowReturnsWhere(tenantId, WINDOW),
        select: {
          refundMethod: true,
          refundAmount: true,
          creditSubtotal: true,
          creditTax: true,
          creditCategoryTax: true,
        },
      });
    });
    await explain("count", async () => {
      await raw.order.count({ where: counterSalesWhere(tenantId, WINDOW) });
    });
    expect(count).toBe(N);
    expect(cash).toBe(N * 10);
  });
});
