/**
 * B243: the statement ledger rows' `amount` and `runningBalance` were raw `Number(...)` of the stored value, never
 * `roundMoney`, while the summary figures beside them were rounded. Every monetary figure the statements return
 * is rounded to cents. Both builders (the buyer's own and the operator's) are pinned.
 */
jest.mock("../common/tenant-time-zone", () => ({
  tenantTimeZone: jest.fn().mockResolvedValue("UTC"),
}));
jest.mock("../invoices/credit-exposure", () => ({
  OPEN_ORDER_STATUSES: [],
  loadCreditExposure: jest.fn().mockResolvedValue({ counted: 0, pendingExposure: 0 }),
}));

import { buildMyStatement, buildOperatorStatement } from "./customer-statement";
import { createMockPrisma } from "../testing/prisma-mock";

// Float noise a stored or computed amount can carry: 0.1 + 0.2 and 100 - 3e-14.
const DIRTY_TENTHS = 0.1 + 0.2; // 0.30000000000000004
const DIRTY_HUNDRED = 100 - 3e-14; // 99.99999999999997

function arrange() {
  const prisma = createMockPrisma();
  prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", userId: "user-1" });
  prisma.invoice.findMany.mockResolvedValue([
    {
      id: "inv-1",
      invoiceNumber: "INV-1",
      total: DIRTY_HUNDRED,
      status: "SENT",
      dueDate: new Date("2099-01-01T00:00:00.000Z"),
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      expectedPaymentMethod: null,
      payments: [],
    },
  ]);
  prisma.invoice.aggregate.mockResolvedValue({ _sum: {} });
  prisma.invoicePayment.aggregate.mockResolvedValue({ _sum: {} });
  prisma.creditNote.findMany.mockResolvedValue([
    {
      id: "cn-1",
      creditNoteNumber: "CN-1",
      amount: DIRTY_TENTHS,
      amountUsed: 0,
      status: "ISSUED",
      expiresAt: null,
      createdAt: new Date("2026-10-02T00:00:00.000Z"),
    },
  ]);
  prisma.advancePayment.findMany.mockResolvedValue([
    {
      id: "adv-1",
      amount: DIRTY_TENTHS,
      balance: DIRTY_TENTHS,
      method: "CHECK",
      reference: null,
      receivedAt: new Date("2026-10-03T00:00:00.000Z"),
    },
  ]);
  prisma.order.findMany.mockResolvedValue([]);
  prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: null });
  return prisma;
}

const rowsOf = (stmt: { transactions: any[] }) => {
  const by = (type: string) => stmt.transactions.find((t) => t.type === type);
  return {
    invoice: [by("INVOICE").amount, by("INVOICE").runningBalance],
    note: [by("CREDIT_NOTE").amount, by("CREDIT_NOTE").runningBalance],
    advance: [by("ADVANCE_PAYMENT")?.amount, by("ADVANCE_PAYMENT")?.runningBalance],
  };
};

describe("B243: statement ledger rows are rounded to cents", () => {
  it("the operator statement's rows carry cents, not float noise", async () => {
    const stmt = await buildOperatorStatement(arrange() as any, "cust-1");
    expect(rowsOf(stmt)).toEqual({
      invoice: [100, -100],
      note: [-0.3, 0.3],
      advance: [0.3, 0.3],
    });
  });

  it("the buyer's own statement's rows carry cents, not float noise", async () => {
    const stmt = await buildMyStatement(arrange() as any, { sub: "user-1" } as any);
    const rows = rowsOf(stmt);
    expect(rows.invoice).toEqual([100, -100]);
    expect(rows.note).toEqual([-0.3, 0.3]);
  });
});
