/**
 * SA-839 test harness: ONE stateful in-memory world for the regulated ledger and the documents whose
 * status decides it (Invoice, Return, CreditNote), installed over `createMockPrisma()` with the
 * SplitInvoiceFakeDb (Order / OrderItem / Invoice / InvoiceItem) underneath.
 *
 * It exists so the SA-839 reds drive the REAL writers (`InvoicesService.voidInvoiceInTx` /
 * `unvoidInvoice`, `ReturnsService.cancel`, `InlineReturnsService.cancel`,
 * `CreditNotesService.voidWithReversal`) over a REAL `RegulatedLedgerService` and read the line's
 * signed sum back out of the rows they wrote (the `regulated-ledger.sa835-lifecycle.spec.ts` shape),
 * instead of asserting on call arguments. Every model write goes through the stores below; the tx is
 * the mock itself, so a rolled-back request simply never happens (the services throw before writing).
 */
import { roundMoney } from "@routeflow/pricing";
import { createMockPrisma, type MockPrisma } from "../../testing/prisma-mock";
import { SplitInvoiceFakeDb, fakeOrderLine } from "../../invoices/testing/split-invoice-fake-db";
import { RegulatedLedgerService } from "../regulated-ledger.service";

type Row = Record<string, any>;

export const WORLD_TENANT = "test-tenant";
/** The invoice line's stored category-tax column (a computed key: this fake is not one of the
 *  enumerated writers `common/category-tax-trio-callsites.spec.ts` counts). */
const STORED_LEVY = "categoryTaxAmount" as const;

/** Enough of Prisma's `where` for the ledger, document and filing reads the writers issue. */
export function worldMatches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    if (v === undefined) return true;
    if (k === "OR") return (v as Row[]).some((w) => worldMatches(row, w));
    if (k === "AND") return (v as Row[]).every((w) => worldMatches(row, w));
    if (k === "NOT") return !worldMatches(row, v as Row);
    const cur = row[k];
    if (v === null) return cur == null;
    if (v instanceof Date) return cur instanceof Date && cur.getTime() === v.getTime();
    if (typeof v === "object") {
      return Object.entries(v as Row).every(([op, val]) => {
        if (op === "in") return (val as unknown[]).includes(cur);
        if (op === "notIn") return !(val as unknown[]).includes(cur);
        if (op === "not") return val === null ? cur != null : cur !== val;
        if (op === "equals") return cur === val;
        const a = cur instanceof Date ? cur.getTime() : Number(cur);
        const b = val instanceof Date ? val.getTime() : Number(val);
        if (op === "lt") return a < b;
        if (op === "lte") return a <= b;
        if (op === "gt") return a > b;
        if (op === "gte") return a >= b;
        throw new Error(`sa839-ledger-world: unsupported operator "${op}" on "${k}"`);
      });
    }
    return cur === v;
  });
}

const pick = (row: Row, select?: Row): Row =>
  select
    ? Object.fromEntries(
        Object.keys(select)
          .filter((k) => select[k])
          .map((k) => [k, row[k]]),
      )
    : { ...row };

const r2 = (n: number) => roundMoney(n);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export interface LineSum {
  qty: number;
  unitBasisQty: number;
  net: number;
  tax: number;
}

export class Sa839LedgerWorld {
  readonly prisma: MockPrisma;
  readonly db = new SplitInvoiceFakeDb();
  readonly ledger: Row[] = [];
  readonly returns = new Map<string, Row>();
  readonly creditNotes = new Map<string, Row>();
  readonly filings: Row[] = [];
  readonly service: RegulatedLedgerService;
  private seq = 0;

  constructor() {
    this.prisma = createMockPrisma();
    this.db.install(this.prisma);
    this.install();
    this.service = new RegulatedLedgerService(this.prisma as any);
  }

  /** A ledger row as the writers store it (Decimal columns read back as numbers here). */
  addRow(over: Row): Row {
    const r = {
      id: `led-${++this.seq}`,
      tenantId: WORLD_TENANT,
      trackedCategoryId: "cat-A",
      trackedSubcategoryId: null,
      orderId: "ord-1",
      orderItemId: "oi-1",
      invoiceId: "inv-1",
      invoiceItemId: "ii-1",
      returnId: null,
      creditNoteId: null,
      correctsEntryId: null,
      originalSoldAt: null,
      categoryTax: 0,
      createdAt: new Date(Date.UTC(2026, 0, 1) + this.seq * 1000),
      ...over,
    };
    this.ledger.push(r);
    return r;
  }

  /**
   * The SA-839 fixture: order ord-1 / line oi-1 (10 regulated units), invoice inv-1 / item ii-1
   * billing 10 for 100.00 with 20.00 category tax, and its SALE row booked in 2026-09.
   */
  seedSale(
    opts: {
      invoiceStatus?: string;
      qty?: number;
      net?: number;
      tax?: number;
      orderStatus?: string;
      invoicedQty?: number;
    } = {},
  ): void {
    const { qty = 10, net = 100, tax = 20 } = opts;
    this.db.addOrder(
      {
        id: "ord-1",
        customerId: "cust-1",
        orderNumber: "ORD-1",
        total: net,
        status: opts.orderStatus ?? "DELIVERED",
      },
      [
        fakeOrderLine({
          id: "oi-1",
          productId: "p-1",
          qty,
          invoicedQty: opts.invoicedQty ?? qty,
          trackedCategoryId: "cat-A",
        }),
      ],
    );
    this.db.invoices.push({
      id: "inv-1",
      orderId: "ord-1",
      customerId: "cust-1",
      tenantId: WORLD_TENANT,
      invoiceNumber: "INV-1",
      status: opts.invoiceStatus ?? "SENT",
      createdAt: new Date(Date.UTC(2026, 8, 1)),
      payments: [],
    });
    this.db.invoiceItems.push({
      id: "ii-1",
      invoiceId: "inv-1",
      orderItemId: "oi-1",
      productId: "p-1",
      trackedCategoryId: "cat-A",
      qty,
      subtotal: net,
      [STORED_LEVY]: tax,
      unitsPerBox: null,
      boxes: null,
      pieces: null,
      unitLabel: null,
    });
    const soldAt = new Date(Date.UTC(2026, 8, 5));
    this.addRow({
      entryType: "SALE",
      qty,
      unitBasisQty: qty,
      netSales: net,
      categoryTax: tax,
      soldAt,
      periodBucket: "2026-09",
    });
  }

  /** A received return's REVERSAL row, as `reverseReturnEntries` books it. */
  seedReturnRow(returnId: string, over: Row = {}): Row {
    const soldAt = new Date(Date.UTC(2026, 9, 3));
    return this.addRow({
      entryType: "REVERSAL",
      returnId,
      qty: -3,
      unitBasisQty: -3,
      netSales: -30,
      categoryTax: -6,
      soldAt,
      periodBucket: "2026-10",
      ...over,
    });
  }

  addReturn(id: string, over: Row = {}): Row {
    const r = {
      id,
      tenantId: WORLD_TENANT,
      kind: "STANDARD",
      status: "RECEIVED",
      orderId: "ord-1",
      customerId: "cust-1",
      holdReason: null,
      heldAmount: null,
      creditNoteId: null,
      refundMethod: null,
      refundedAt: null,
      items: [{ productId: "p-1", qty: 3, restock: false }],
      ...over,
    };
    this.returns.set(id, r);
    return r;
  }

  addCreditNote(id: string, over: Row = {}): Row {
    const cn = {
      id,
      tenantId: WORLD_TENANT,
      creditNoteNumber: `CN-${id}`,
      customerId: "cust-1",
      invoiceId: "inv-1",
      status: "ISSUED",
      amount: 10,
      amountUsed: 0,
      ...over,
    };
    this.creditNotes.set(id, cn);
    return cn;
  }

  invoiceStatus(id = "inv-1"): string | undefined {
    return this.db.invoices.find((i) => i.id === id)?.status;
  }

  /** The signed Σ of every ledger row matching `filter` (default: line ii-1). */
  sum(filter: (r: Row) => boolean = (r) => r.invoiceItemId === "ii-1"): LineSum {
    const rows = this.ledger.filter(filter);
    return {
      qty: r3(rows.reduce((n, r) => n + Number(r.qty), 0)),
      unitBasisQty: r3(rows.reduce((n, r) => n + Number(r.unitBasisQty), 0)),
      net: r2(rows.reduce((n, r) => n + Number(r.netSales), 0)),
      tax: r2(rows.reduce((n, r) => n + Number(r.categoryTax), 0)),
    };
  }

  bucketSum(bucket: string): LineSum {
    return this.sum((r) => r.invoiceItemId === "ii-1" && r.periodBucket === bucket);
  }

  /** A filing in `periodKey` ("YYYY-MM") for cat-A with the given status. */
  addFiling(periodKey: string, status: string): void {
    const [y, m] = periodKey.split("-").map(Number);
    this.filings.push({
      id: `fil-${periodKey}`,
      tenantId: WORLD_TENANT,
      trackedCategoryId: "cat-A",
      periodKey,
      status,
      periodStart: new Date(Date.UTC(y, m - 1, 1)),
      periodEnd: new Date(Date.UTC(y, m, 1)),
    });
  }

  private install(): void {
    const p = this.prisma as any;
    const tx = () => p;
    p.forTenant = jest.fn(() => p);
    p.$executeRaw = jest.fn().mockResolvedValue(0);
    p.$queryRaw = jest.fn().mockResolvedValue([]);
    p.tenantTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx()));
    p.$transaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx()));

    // ── the ledger ──
    const L = p.regulatedSalesLedger;
    const ordered = (rows: Row[]) =>
      [...rows].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
      );
    L.findMany.mockImplementation(async (args: Row = {}) =>
      ordered(this.ledger.filter((r) => worldMatches(r, args.where))).map((r) =>
        pick(r, args.select),
      ),
    );
    L.findFirst.mockImplementation(async (args: Row = {}) => {
      const hit = ordered(this.ledger.filter((r) => worldMatches(r, args.where)))[0];
      return hit ? pick(hit, args.select) : null;
    });
    L.count.mockImplementation(
      async (args: Row = {}) => this.ledger.filter((r) => worldMatches(r, args.where)).length,
    );
    L.createMany.mockImplementation(async ({ data }: Row) => {
      for (const d of data as Row[]) this.addRow({ createdAt: new Date(), ...d, ...this.fresh() });
      return { count: (data as Row[]).length };
    });
    L.create.mockImplementation(async ({ data }: Row) =>
      this.addRow({ createdAt: new Date(), ...data, ...this.fresh() }),
    );
    L.deleteMany.mockImplementation(async ({ where }: Row) => {
      let count = 0;
      for (let i = this.ledger.length - 1; i >= 0; i--) {
        if (worldMatches(this.ledger[i], where)) {
          this.ledger.splice(i, 1);
          count++;
        }
      }
      return { count };
    });
    p.regulatedFiling.findFirst.mockImplementation(async (args: Row = {}) => {
      const hit = this.filings.find((f) => worldMatches(f, args.where));
      return hit ? pick(hit, args.select) : null;
    });

    // ── invoices (the fake db holds them; it installs no findUnique / updateMany) ──
    const invById = (id: string) => this.db.invoices.find((i) => i.id === id);
    p.invoice.findUnique.mockImplementation(async (args: Row) => {
      const inv = invById(args.where?.id);
      if (!inv) return null;
      const out: Row = {
        ...inv,
        payments: inv.payments ?? [],
        items: this.db.invoiceItems.filter((it) => it.invoiceId === inv.id),
      };
      return args.select ? pick(out, args.select) : out;
    });
    p.invoice.updateMany.mockImplementation(async ({ where, data }: Row) => {
      const hit = this.db.invoices.filter((i) => worldMatches(i, where));
      for (const i of hit) Object.assign(i, data);
      return { count: hit.length };
    });

    // ── returns ──
    p.return.findUnique.mockImplementation(async (args: Row) => {
      const r = this.returns.get(args.where?.id);
      return r ? pick(r, args.select) : null;
    });
    p.return.findFirst.mockImplementation(async (args: Row) => {
      const r = [...this.returns.values()].find((x) => worldMatches(x, args.where));
      return r ? pick(r, args.select) : null;
    });
    p.return.findMany.mockImplementation(async (args: Row = {}) =>
      [...this.returns.values()]
        .filter((x) => worldMatches(x, args.where))
        .map((x) => pick(x, args.select)),
    );
    p.return.updateMany.mockImplementation(async ({ where, data }: Row) => {
      const hit = [...this.returns.values()].filter((x) => worldMatches(x, where));
      for (const x of hit) Object.assign(x, data);
      return { count: hit.length };
    });

    // ── credit notes ──
    const notes = () => [...this.creditNotes.values()];
    p.creditNote.findMany.mockImplementation(async (args: Row = {}) =>
      notes()
        .filter((x) => worldMatches(x, args.where))
        .map((x) => pick(x, args.select)),
    );
    p.creditNote.findFirst.mockImplementation(async (args: Row = {}) => {
      const x = notes().find((n) => worldMatches(n, args.where));
      return x ? pick(x, args.select) : null;
    });
    p.creditNote.findUnique.mockImplementation(async (args: Row = {}) => {
      const x = this.creditNotes.get(args.where?.id);
      return x ? pick(x, args.select) : null;
    });
    p.creditNote.update.mockImplementation(async ({ where, data }: Row) => {
      const x = this.creditNotes.get(where.id);
      if (!x) throw new Error("creditNote.update: not found");
      Object.assign(x, data);
      return { ...x };
    });
    p.creditNote.updateMany.mockImplementation(async ({ where, data }: Row) => {
      const hit = notes().filter((n) => worldMatches(n, where));
      for (const x of hit) Object.assign(x, data);
      return { count: hit.length };
    });
  }

  /** Id + createdAt for a row a writer appends (ordered after every seeded row). */
  private fresh(): Row {
    const n = ++this.seq;
    return { id: `led-${n}`, createdAt: new Date(Date.UTC(2027, 0, 1) + n * 1000) };
  }
}
