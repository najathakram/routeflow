/**
 * SA-859 / row 2126: the dashboard's revenue is accrual NET sales through the ONE reader family
 * (common/invoiced-sales.ts), never its own `Number(inv.total)` sum. A small in-memory db serves the
 * three reads (invoice / creditNote / return) the way Prisma would, so the trend, top customers and
 * Bookkeeping's `fetchAccrualNetSales` are all computed from the same fixture.
 */
import * as fs from "fs";
import * as path from "path";
import { InvoiceStatus } from "@prisma/client";
import { AnalyticsService } from "./analytics.service";
import { fetchAccrualNetSales } from "../common/invoiced-sales";

type Row = Record<string, any>;
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

function inWindow(d: Date, w: { gte: Date; lte: Date }) {
  return d >= w.gte && d <= w.lte;
}

function makeDb(fx: { invoices?: Row[]; creditNotes?: Row[]; returns?: Row[]; products?: Row[] }) {
  const invoices = fx.invoices ?? [];
  const creditNotes = fx.creditNotes ?? [];
  const returns = fx.returns ?? [];
  const okInvoice = (i: Row, where: Row) =>
    !where.status.notIn.includes(i.status) && inWindow(i.issueDate, where.issueDate);
  const sum = (rows: Row[], k: string) => rows.reduce((t, r) => t + Number(r[k] ?? 0), 0);
  const db = {
    invoice: {
      findMany: jest.fn(async ({ where }: any) => invoices.filter((i) => okInvoice(i, where))),
      aggregate: jest.fn(async ({ where }: any) => {
        const rows = invoices.filter((i) => okInvoice(i, where));
        return { _sum: { total: sum(rows, "total"), taxAmount: sum(rows, "taxAmount") } };
      }),
      groupBy: jest.fn(async () => []),
    },
    creditNote: {
      findMany: jest.fn(async ({ where }: any) =>
        creditNotes.filter((c) => c.status !== "VOID" && inWindow(c.createdAt, where.createdAt)),
      ),
      aggregate: jest.fn(async ({ where }: any) => ({
        _sum: {
          amount: sum(
            creditNotes.filter(
              (c) => c.status !== "VOID" && inWindow(c.createdAt, where.createdAt),
            ),
            "amount",
          ),
        },
      })),
      groupBy: jest.fn(async () => []),
    },
    return: {
      findMany: jest.fn(async ({ where }: any) =>
        returns.filter((r) => inWindow(r.refundedAt, where.refundedAt)),
      ),
      aggregate: jest.fn(async ({ where }: any) => ({
        _sum: {
          refundAmount: sum(
            returns.filter((r) => inWindow(r.refundedAt, where.refundedAt)),
            "refundAmount",
          ),
        },
      })),
      groupBy: jest.fn(async () => []),
    },
    product: { findMany: jest.fn(async () => fx.products ?? []) },
    stockMovement: { findMany: jest.fn(async () => []) },
    customer: {
      findMany: jest.fn(async () => [
        { id: "c1", businessName: "Acme Wholesale" },
        { id: "c2", businessName: "Beta Foods" },
      ]),
    },
  };
  return db;
}

function makeService(
  db: ReturnType<typeof makeDb>,
  opts: { tobacco?: boolean; zone?: string } = {},
) {
  const prisma: any = {
    getTenantId: () => "t1",
    forTenant: () => db,
    tenantConfig: { findUnique: jest.fn(async () => ({ timezone: opts.zone ?? null })) },
  };
  const addon: any = { hasAddon: jest.fn(async () => !!opts.tobacco) };
  const config: any = { get: jest.fn(async () => (opts.tobacco ? "true" : null)) };
  const svc = new AnalyticsService(prisma, addon, config, {} as any);
  return svc;
}

const inv = (over: Row): Row => ({
  customerId: "c1",
  status: InvoiceStatus.SENT,
  total: 110,
  taxAmount: 10,
  issueDate: day("2026-10-05"),
  items: [],
  ...over,
});

describe("AnalyticsService revenue = accrual net sales (SA-859)", () => {
  it("R1: tax out and credit notes out; the trend equals fetchAccrualNetSales for the same window (parity)", async () => {
    const db = makeDb({
      invoices: [inv({}), inv({ total: 220, taxAmount: 20, issueDate: day("2026-10-20") })],
      creditNotes: [
        {
          customerId: "c1",
          amount: 30,
          createdAt: new Date("2026-10-10T15:00:00Z"),
          status: "ISSUED",
        },
      ],
    });
    const rows = await makeService(db).getRevenueTrend("2026-10-01", "2026-10-31", "month");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      period: "2026-10",
      revenue: 270,
      gross: 300,
      creditNotes: 30,
      externalRefunds: 0,
    });
    const net = await fetchAccrualNetSales(db as any, "t1", {
      gte: day("2026-10-01"),
      lte: new Date("2026-10-31T23:59:59.999Z"),
    });
    expect(rows[0].revenue).toBe(net.net);
  });

  it("R2: a WRITTEN_OFF invoice counts as revenue; DRAFT and VOID do not", async () => {
    const db = makeDb({
      invoices: [
        inv({ status: InvoiceStatus.WRITTEN_OFF }),
        inv({ status: InvoiceStatus.DRAFT }),
        inv({ status: InvoiceStatus.VOID }),
      ],
    });
    const rows = await makeService(db).getRevenueTrend("2026-10-01", "2026-10-31", "month");
    expect(rows[0].revenue).toBe(100);
  });

  it("R3: a credit note at 23:30 tenant-local on the last day of the month lands in that local month", async () => {
    // 2026-10-31 23:30 in America/Chicago (CDT, UTC-5) is 2026-11-01T04:30Z
    const db = makeDb({
      invoices: [inv({ issueDate: day("2026-10-02") })],
      creditNotes: [
        {
          customerId: "c1",
          amount: 25,
          createdAt: new Date("2026-11-01T04:30:00Z"),
          status: "ISSUED",
        },
      ],
    });
    const rows = await makeService(db, { zone: "America/Chicago" }).getRevenueTrend(
      "2026-10-01",
      "2026-11-30",
      "month",
    );
    const byPeriod = Object.fromEntries(rows.map((r) => [r.period, r]));
    expect(byPeriod["2026-10"].creditNotes).toBe(25);
    expect(byPeriod["2026-10"].revenue).toBe(75);
    expect(byPeriod["2026-11"]).toBeUndefined();
  });

  it("R4: top customers window on issueDate (an invoice issued in the window counts whatever its createdAt) and rank by net", async () => {
    const db = makeDb({
      invoices: [
        inv({
          customerId: "c1",
          total: 330,
          taxAmount: 30,
          issueDate: day("2026-10-02"),
          createdAt: day("2026-09-01"),
        }),
        inv({ customerId: "c2", total: 220, taxAmount: 20, issueDate: day("2026-10-03") }),
      ],
      creditNotes: [
        {
          customerId: "c1",
          amount: 150,
          createdAt: new Date("2026-10-04T12:00:00Z"),
          status: "ISSUED",
        },
      ],
    });
    const top = await makeService(db).getTopCustomers("revenue", 10, "2026-10-01", "2026-10-31");
    expect(top.map((t) => [t.id, t.totalRevenue, t.orderCount])).toEqual([
      ["c2", 200, 1],
      ["c1", 150, 1],
    ]);
    const where = db.invoice.findMany.mock.calls[0][0].where;
    expect(where.issueDate).toBeDefined();
    expect(where.createdAt).toBeUndefined();
  });

  describe("R5: tobacco switch on (pre-tax basis)", () => {
    const tobaccoInvoice = inv({
      total: 220,
      taxAmount: 20,
      items: [
        { subtotal: 60, product: { isTobacco: true } },
        { subtotal: 140, product: { isTobacco: false } },
      ],
    });
    const lineCredit = {
      customerId: "c1",
      amount: 20,
      createdAt: new Date("2026-10-10T15:00:00Z"),
      status: "ISSUED",
      items: [{ invoiceItemId: "li-t", amount: 20 }],
      invoice: { items: [{ id: "li-t", productId: "p-tob", product: { isTobacco: true } }] },
    };
    const freeform = {
      customerId: "c1",
      amount: 15,
      createdAt: new Date("2026-10-11T15:00:00Z"),
      status: "ISSUED",
      items: [],
      invoice: null,
    };

    it("a tobacco line and a line-based credit on it both leave the main figure; a freeform credit stays", async () => {
      const db = makeDb({ invoices: [tobaccoInvoice], creditNotes: [lineCredit, freeform] });
      const rows = await makeService(db, { tobacco: true }).getRevenueTrend(
        "2026-10-01",
        "2026-10-31",
        "month",
      );
      // gross 200 (220-20 tax) minus tobacco 60 = 140; credits 35 minus tobacco-attributed 20 = 15
      expect(rows[0]).toMatchObject({ gross: 140, creditNotes: 15, revenue: 125 });
    });

    it("with the switch off the same fixture is the full net", async () => {
      const db = makeDb({ invoices: [tobaccoInvoice], creditNotes: [lineCredit, freeform] });
      const rows = await makeService(db).getRevenueTrend("2026-10-01", "2026-10-31", "month");
      expect(rows[0]).toMatchObject({ gross: 200, creditNotes: 35, revenue: 165 });
    });
  });

  it("structural: the revenue methods never sum inv.total themselves", () => {
    const src = fs.readFileSync(path.join(__dirname, "analytics.service.ts"), "utf8");
    const body = (name: string) => {
      const a = src.indexOf(`async ${name}(`);
      const b = src.indexOf("\n  async ", a + 10);
      return src.slice(a, b);
    };
    for (const m of ["getRevenueTrend", "getTopCustomers"]) {
      expect(body(m)).not.toMatch(/Number\(inv\.total\)/);
      expect(body(m)).toMatch(/fetchAccrualNetSales/);
    }
  });
});
