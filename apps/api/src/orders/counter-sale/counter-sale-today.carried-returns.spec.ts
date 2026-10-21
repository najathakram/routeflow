import { CounterSaleTodayService } from "./counter-sale-today.service";
import { carriedReturnSelect, carriedReturnWhere } from "./counter-sale-today";
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

function setup(pageRows: unknown[], carried: unknown[] = []) {
  const prisma: MockPrisma = createMockPrisma();
  prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: "America/New_York" });
  prisma.order.findMany.mockResolvedValue(pageRows);
  prisma.order.count.mockResolvedValue(pageRows.length);
  prisma.return.findMany.mockImplementation(async (args: any) =>
    // the carried read is the one that filters by credit note id and selects the item sources
    args.select?.items ? carried : [],
  );
  const service = new CounterSaleTodayService(prisma as never);
  const call = (q: Partial<CounterSaleTodayDto> = {}) =>
    service.today({ page: 2, limit: 50, ...q } as CounterSaleTodayDto, NOW);
  const carriedCalls = () =>
    (prisma.return.findMany.mock.calls as any[]).filter((c) => c[0]?.select?.items);
  return { prisma, call, carriedCalls };
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

  it("the INLINE return carried on B, sold on A, makes A's credit its own return credit and its ownReturned", async () => {
    const a = saleA([{ ...payment(null, "CASH"), amount: "7.00" }, payment("cn-1")]);
    const { call } = setup(
      [a],
      [
        {
          id: "r-inline",
          creditNoteId: "cn-1",
          orderId: "o-b",
          kind: "INLINE",
          status: "PROCESSED",
          refundMethod: "CREDIT_NOTE",
          refundedAt: null,
          items: [{ sourceOrderId: "o-a", subtotal: "5.00", taxAmount: "0.50", categoryTax: null }],
        },
      ],
    );
    const res = await call();
    const row = res.data[0]!;
    expect(row.returnCredit).toBe(5.5);
    expect(row.tenderPaid).toBe(7);
    expect(row.tenderMethods).toEqual([{ method: "CASH", amount: 7 }]);
    expect(row.ownReturned).toEqual({ amount: 5.5, allRefunded: false });
  });

  it("without the batched read's answer, the same credit stays a tender (never hidden)", async () => {
    const { call } = setup([saleA([payment("cn-1")])], []);
    const row = (await call()).data[0]!;
    expect(row.returnCredit).toBe(0);
    expect(row.tenderMethods).toEqual([{ method: "STORE_CREDIT", amount: 5.5 }]);
  });
});
