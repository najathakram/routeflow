import { CounterSaleTodayService } from "./counter-sale-today.service";
import {
  carriedReturnSelect,
  carriedReturnWhere,
  creditNoteReadSelect,
  creditNoteReadWhere,
  pageQuery,
} from "./counter-sale-today";
import type { CounterSaleTodayDto } from "./counter-sale-today.dto";
import { createMockPrisma, type MockPrisma } from "../../testing/prisma-mock";

/**
 * B1262 / SA-838 (e): the ONE batched read of the returns behind the page's credit-note payments. `Return.creditNoteId` and
 * `ReturnItem.sourceOrderId` have no Prisma relation, so an INLINE return carried on another order is only reachable by
 * the credit note id. Pure wiring: a mocked prisma, the REAL args the service sends. Placeholders only (acme).
 */
const T = "test-tenant";
const NOW = new Date("2026-10-07T15:00:00.000Z");

const payment = (creditNoteId: string | null, method = "CREDIT_NOTE") => ({
  method,
  amount: "5.50",
  status: "PAID",
  creditNoteId,
  creditNote: creditNoteId ? { invoiceId: "i-a" } : null,
});

/** sale A: $12.50, $7 cash + a $5.50 credit-note application */
const saleA = (payments: ReturnType<typeof payment>[]) => ({
  id: "o-a",
  orderNumber: "A1",
  status: "DELIVERED",
  total: "12.50",
  createdAt: new Date("2026-10-07T16:00:00.000Z"),
  customerId: "c-1",
  customer: { businessName: "Acme Test Customer", isWalkIn: false },
  invoices: [{ id: "i-a", invoiceNumber: "INV-A", status: "PAID", payments }],
  returns: [] as unknown[],
});

/** a credit note as the batched read returns it: status, amount, the invoice, and the PAID payments applied to it anywhere */
const note = (id: string, status: string, appliedAnywhere: number[] = []) => ({
  id,
  status,
  amount: "5.50",
  invoiceId: null,
  invoicePayments: appliedAnywhere.map((amount) => ({ amount: String(amount) })),
});

function setup(pageRows: unknown[], carried: unknown[] = [], notes: unknown[] = []) {
  const prisma: MockPrisma = createMockPrisma();
  prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: "America/New_York" });
  prisma.order.findMany.mockResolvedValue(pageRows);
  prisma.order.count.mockResolvedValue(pageRows.length);
  prisma.return.findMany.mockImplementation(async (args: any) =>
    // the carried read is the one that filters by credit note id and selects the item sources
    args.select?.items ? carried : [],
  );
  // the batched credit-note read is the one that selects the notes' payments (the summary's read selects ids only)
  prisma.creditNote.findMany.mockImplementation(async (args: any) =>
    args.select?.invoicePayments ? notes : [],
  );
  const service = new CounterSaleTodayService(prisma as never);
  const call = (q: Partial<CounterSaleTodayDto> = {}) =>
    service.today({ page: 2, limit: 50, ...q } as CounterSaleTodayDto, NOW);
  const carriedCalls = () =>
    (prisma.return.findMany.mock.calls as any[]).filter((c) => c[0]?.select?.items);
  const noteCalls = () =>
    (prisma.creditNote.findMany.mock.calls as any[]).filter((c) => c[0]?.select?.invoicePayments);
  return { prisma, call, carriedCalls, noteCalls };
}

describe("CounterSaleTodayService: the batched read of carried returns (SA-838 e)", () => {
  it("no credit-note payment on the page: NO return query at all", async () => {
    const { prisma, call, carriedCalls } = setup([saleA([payment(null, "CASH")])]);
    await call();
    expect(carriedCalls()).toHaveLength(0);
    expect(prisma.return.findMany).not.toHaveBeenCalled(); // page 2 has no summary either
  });

  it("an empty page: no return query", async () => {
    const { prisma, call } = setup([]);
    await call();
    expect(prisma.return.findMany).not.toHaveBeenCalled();
  });

  it("credit-note payments: exactly ONE findMany, tenant-scoped, one id once, with the select the row needs", async () => {
    const { call, carriedCalls } = setup([
      saleA([payment("cn-1"), payment("cn-1"), payment("cn-2"), payment(null, "CASH")]),
      { ...saleA([payment("cn-1")]), id: "o-x" },
    ]);
    await call();
    expect(carriedCalls()).toHaveLength(1);
    const args = carriedCalls()[0][0];
    expect(args.where.tenantId).toBe(T);
    expect(args.where.creditNoteId).toEqual({ in: ["cn-1", "cn-2"] });
    expect(args.where).toEqual(carriedReturnWhere(T, ["cn-1", "cn-2"]));
    expect(args.select).toBe(carriedReturnSelect);
    expect(args.select.items.select).toEqual({
      sourceOrderId: true,
      subtotal: true,
      taxAmount: true,
      categoryTax: true,
    });
  });

  it("the INLINE return carried on B, sold on A, makes A's credit its own return credit and A's returnLines.applied", async () => {
    const a = saleA([{ ...payment(null, "CASH"), amount: "7.00" }, payment("cn-1")]);
    const { call } = setup(
      [a],
      [
        {
          id: "r-inline",
          creditNoteId: "cn-1",
          orderId: "o-b",
          kind: "INLINE",
          status: "REFUNDED",
          refundMethod: "CREDIT_NOTE",
          refundedAt: null,
          items: [{ sourceOrderId: "o-a", subtotal: "5.00", taxAmount: "0.50", categoryTax: null }],
        },
      ],
      [note("cn-1", "APPLIED", [5.5])],
    );
    const res = await call();
    const row = res.data[0]!;
    expect(row.returnCredit).toBe(5.5);
    expect(row.tenderPaid).toBe(7);
    expect(row.tenderMethods).toEqual([{ method: "CASH", amount: 7 }]);
    expect(row.returnLines).toEqual({
      applied: 5.5,
      refunded: 0,
      kept: 0,
      used: 0,
      pending: false,
    });
  });

  it("without the batched read's answer, the same credit stays a tender (never hidden)", async () => {
    const { call } = setup([saleA([payment("cn-1")])], []);
    const row = (await call()).data[0]!;
    expect(row.returnCredit).toBe(0);
    expect(row.tenderMethods).toEqual([{ method: "STORE_CREDIT", amount: 5.5 }]);
  });
});

describe("ONE batched credit-note read (SA-838a I2)", () => {
  const inlineOfA = {
    id: "r-inline",
    creditNoteId: "cn-1",
    orderId: "o-b",
    kind: "INLINE",
    status: "REFUNDED",
    refundMethod: "CREDIT_NOTE",
    refundedAt: null,
    items: [{ sourceOrderId: "o-a", subtotal: "5.00", taxAmount: "0.50", categoryTax: null }],
  };

  it("no credit-note reference on the page: NO credit-note read", async () => {
    const { noteCalls, call } = setup([saleA([payment(null, "CASH")])]);
    await call();
    expect(noteCalls()).toHaveLength(0);
  });

  it("payments' notes, the page returns' notes and the carried returns' notes are read in ONE tenant-scoped query", async () => {
    const a = {
      ...saleA([payment("cn-1"), payment("cn-1"), payment(null, "CASH")]),
      returns: [
        {
          id: "r-own",
          returnNumber: "R-1",
          status: "REFUNDED",
          refundMethod: "CREDIT_NOTE",
          refundedAt: null,
          creditNoteId: "cn-2",
          refundAmount: null,
          creditSubtotal: "2.50",
          creditTax: "0",
          creditCategoryTax: "0",
          kind: "STANDARD",
          items: [],
        },
      ],
    };
    const b = { ...saleA([]), id: "o-b", returns: [] as unknown[] };
    const { call, noteCalls } = setup(
      [a, b],
      [{ ...inlineOfA, creditNoteId: "cn-3" }],
      [note("cn-1", "APPLIED", [5.5]), note("cn-2", "ISSUED"), note("cn-3", "ISSUED")],
    );
    await call();
    expect(noteCalls()).toHaveLength(1);
    const args = noteCalls()[0][0];
    expect(args.where.tenantId).toBe(T);
    expect([...args.where.id.in].sort()).toEqual(["cn-1", "cn-2", "cn-3"]);
    expect(args.where).toEqual(creditNoteReadWhere(T, ["cn-1", "cn-2", "cn-3"]));
    expect(args.select).toBe(creditNoteReadSelect);
    expect(args.select.invoicePayments).toEqual({
      where: { status: "PAID" },
      select: { amount: true },
    });
  });

  it("a kept credit (no payment applied it) is read through the return's own note", async () => {
    const a = {
      ...saleA([{ ...payment(null, "CASH"), amount: "12.50" }]),
      returns: [
        {
          id: "r-own",
          returnNumber: "R-1",
          status: "REFUNDED",
          refundMethod: "CREDIT_NOTE",
          refundedAt: null,
          creditNoteId: "cn-2",
          refundAmount: null,
          creditSubtotal: "2.50",
          creditTax: "0",
          creditCategoryTax: "0",
          kind: "STANDARD",
          items: [],
        },
      ],
    };
    const { call } = setup([a], [], [note("cn-2", "ISSUED")]);
    const row = (await call()).data[0]!;
    expect(row.returnLines).toEqual({
      applied: 0,
      refunded: 0,
      kept: 2.5,
      used: 0,
      pending: false,
    });
  });

  it("credit spent on another sale (the note's PAID payments anywhere) is Credit used, not kept", async () => {
    const a = {
      ...saleA([{ ...payment(null, "CASH"), amount: "12.50" }]),
      returns: [
        {
          id: "r-own",
          returnNumber: "R-1",
          status: "REFUNDED",
          refundMethod: "CREDIT_NOTE",
          refundedAt: null,
          creditNoteId: "cn-2",
          refundAmount: null,
          creditSubtotal: "5.50",
          creditTax: "0",
          creditCategoryTax: "0",
          kind: "STANDARD",
          items: [],
        },
      ],
    };
    const { call } = setup([a], [], [note("cn-2", "APPLIED", [5.5])]);
    const row = (await call()).data[0]!;
    expect(row.returnLines).toEqual({
      applied: 0,
      refunded: 0,
      kept: 0,
      used: 5.5,
      pending: false,
    });
    expect(row.balanceDue).toBe(0);
  });

  it("a carried INLINE return whose note is VOID prints nothing; a note absent from the read is not settled", async () => {
    const a = saleA([{ ...payment(null, "CASH"), amount: "7.00" }, payment("cn-1")]);
    const voided = await setup([a], [inlineOfA], [note("cn-1", "VOID")]).call();
    expect(voided.data[0]!.returnLines).toEqual({
      applied: 0,
      refunded: 0,
      kept: 0,
      used: 0,
      pending: false,
    });
    const unseen = await setup([a], [inlineOfA], []).call();
    expect(unseen.data[0]!.returnLines).toEqual({
      // the PAID application still stands, so it is still subtracted (Returned); only the claim of a settled credit is withheld
      applied: 5.5,
      refunded: 0,
      kept: 0,
      used: 0,
      pending: true,
    });
  });

  it("the read is tenant-scoped and refuses an empty id list (an undefined `in` would widen it)", () => {
    expect(creditNoteReadWhere(T, ["cn-1"])).toEqual({ tenantId: T, id: { in: ["cn-1"] } });
    expect(() => creditNoteReadWhere(T, [])).toThrow();
  });
});

describe("the page query carries what SA-838a needs, in the SAME query (no extra read)", () => {
  it("each payment's credit note names its invoice (link 2); the return select carries the refund completion", () => {
    const q = pageQuery(T, { start: new Date(0), end: new Date(1) }, 1, 50) as any;
    const invoices = q.select.invoices.select;
    expect(invoices.payments.select.creditNote).toEqual({ select: { invoiceId: true } });
    expect(invoices.creditNotes).toBeUndefined();
    // the refund the return recorded: method + the moment it was recorded (completion), on the page's own return select
    expect(q.select.returns.select).toMatchObject({
      refundMethod: true,
      refundedAt: true,
      creditNoteId: true,
      kind: true,
    });
  });
});
