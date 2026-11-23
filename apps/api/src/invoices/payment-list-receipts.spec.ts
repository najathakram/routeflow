/**
 * SA-1208 D1 / M1-03 (SA-1211 BF-6): the staff payments list tags each office-check row with ITS receipt's figures (the one
 * reader, `readReceiptGroup`), so the web list can show one row per check without adding rows up. Red-first on the value a
 * plain list gives: no tag at all, so two rows of $3,000 and $1,000 and no $4,000 anywhere.
 * Mocked at the module boundary: `forTenant()` is the only door to the database.
 */
import { PrismaService } from "../prisma/prisma.service";
import { listAllPayments } from "./payment-list-query";

type Row = Record<string, any>;
let seq = 0;

function pay(over: Row = {}): Row {
  const n = ++seq;
  const { customerId = "cust-1", ...rest } = over;
  return {
    id: `pay-${n}`,
    amount: 100,
    method: "CHECK",
    status: "PAID",
    reference: "1042",
    paymentNumber: `PAY-ACME-${String(n).padStart(4, "0")}`,
    paymentGroupId: null,
    checkStatus: null,
    createdAt: new Date(Date.UTC(2026, 10, 1, 12, 0, n)),
    settledAt: null,
    paidAt: new Date("2026-11-01T12:00:00Z"),
    creditNoteId: null,
    advancePaymentId: null,
    invoice: {
      id: `inv-${n}`,
      invoiceNumber: `INV-ACME-${n}`,
      customerId,
      orderId: null,
      order: null,
      customer: { id: customerId, businessName: "Acme Foods" },
    },
    ...rest,
  };
}

function list(rows: Row[]) {
  const db = {
    invoicePayment: {
      findMany: jest.fn(async ({ where }: any) =>
        where?.paymentGroupId !== undefined
          ? rows.filter(
              (r) =>
                r.paymentGroupId === where.paymentGroupId &&
                (where.invoice?.customerId == null ||
                  r.invoice.customerId === where.invoice.customerId),
            )
          : rows,
      ),
      findUnique: jest.fn(async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null),
      count: jest.fn(async () => rows.length),
    },
    advancePayment: { findMany: jest.fn(async () => []) },
  };
  const prisma = { forTenant: () => db } as unknown as PrismaService;
  const deps = { prisma, resolveTenantInvoiceDefaults: async () => ({ timezone: "UTC" }) };
  return { deps, db };
}

describe("listAllPayments: one receipt tag per office check", () => {
  it("both rows of a $4,000 check carry the server's $4,000 and both invoices", async () => {
    const a = pay({ amount: 3000, paymentGroupId: "g-1042" });
    const b = pay({ amount: 1000, paymentGroupId: "g-1042" });
    const { deps } = list([a, b]);
    const res = await listAllPayments(deps, {});
    for (const row of res.data as Row[]) {
      expect(row.receiptGroup).toEqual({
        key: "g-1042",
        number: a.paymentNumber,
        total: 4000,
        invoices: [
          { id: a.invoice.id, invoiceNumber: a.invoice.invoiceNumber },
          { id: b.invoice.id, invoiceNumber: b.invoice.invoiceNumber },
        ],
      });
    }
  });

  it("a payment with no group carries no tag", async () => {
    const solo = pay({ amount: 75.5, paymentGroupId: null });
    const { deps, db } = list([solo]);
    const res = await listAllPayments(deps, {});
    expect((res.data as Row[])[0].receiptGroup).toBeNull();
    expect(db.invoicePayment.findUnique).not.toHaveBeenCalled(); // no receipt read for a row with no group
  });

  it("two customers sharing a group id are tagged apart (each reads only its own rows)", async () => {
    const mine = pay({ amount: 3000, paymentGroupId: "g-x", customerId: "cust-1" });
    const theirs = pay({ amount: 777, paymentGroupId: "g-x", customerId: "cust-2" });
    const { deps } = list([mine, theirs]);
    const res = await listAllPayments(deps, {});
    const [m, t] = res.data as Row[];
    expect(m.receiptGroup.total).toBe(3000);
    expect(t.receiptGroup.total).toBe(777);
  });

  it("a group with no confirmed row, and a credit use, carry no tag", async () => {
    const draft = pay({ amount: 500, status: "DRAFT", paymentGroupId: "g-d" });
    const credit = pay({ amount: 40, method: "ADVANCE", paymentGroupId: "g-d" });
    const { deps } = list([draft, credit]);
    const res = await listAllPayments(deps, {});
    expect((res.data as Row[]).map((r) => r.receiptGroup)).toEqual([null, null]);
  });

  it("never has more than 8 receipt reads in flight, however many checks are on the page", async () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      pay({ amount: 10, paymentGroupId: `g-${i}` }),
    );
    const { deps, db } = list(rows);
    const find = db.invoicePayment.findUnique.getMockImplementation()!;
    let active = 0;
    let peak = 0;
    db.invoicePayment.findUnique.mockImplementation(async (args: any) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      return find(args);
    });
    await listAllPayments(deps, {});
    expect(db.invoicePayment.findUnique).toHaveBeenCalledTimes(30);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("reads each group once, however many of its rows are on the page", async () => {
    const rows = [1, 2, 3].map(() => pay({ amount: 10, paymentGroupId: "g-3" }));
    const { deps, db } = list(rows);
    await listAllPayments(deps, {});
    expect(db.invoicePayment.findUnique).toHaveBeenCalledTimes(1);
  });
});
