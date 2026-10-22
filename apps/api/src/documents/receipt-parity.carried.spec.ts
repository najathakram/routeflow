import type { ReceiptModel } from "@routeflow/types";
import { formatReceiptMoney as money } from "@routeflow/pricing";
import { receiptModelFromOrder } from "../../../web/lib/counter-receipt";
import { CounterSaleTodayService } from "../orders/counter-sale/counter-sale-today.service";
import { createMockPrisma, type MockPrisma } from "../testing/prisma-mock";
import { ReceiptService } from "./receipt.service";
import { INVOICE, orderFixture } from "./receipt.fixtures";

/**
 * B1262 N1 (Opus review, important 2): a row and its emailed receipt find the SAME carried returns. The Today's-sales page used to
 * pass its page-wide carried set to every row while the email read only the order's own note ids, so an own INLINE return
 * filed on another order, whose credit was never applied here, printed "Credit used" on the reprint and nothing on the email.
 * Both services now build ONE where (`carriedReturnWhere`); this spec runs the REAL services over one fake database that honours
 * that where, for sale A whose INLINE return was filed on order C and whose $5.50 credit was spent on order B (a sale NOT on
 * A's page). Placeholders only (acme).
 */
const T = "test-tenant";
const NOW = new Date("2026-10-07T16:00:00.000Z");
const ZONE = "America/New_York";

/** A's own INLINE return: filed on C, sold on A (ord-1), worth $5.50 */
const INLINE_ON_C = {
  id: "r-inline",
  creditNoteId: "cn-5",
  orderId: "ord-c",
  kind: "INLINE",
  status: "REFUNDED",
  refundMethod: "CREDIT_NOTE",
  refundedAt: null,
  items: [{ sourceOrderId: "ord-1", subtotal: "5.00", taxAmount: "0.50", categoryTax: null }],
};
/** the credit note: issued on C's invoice, its $5.50 PAID application sits on B's invoice */
const NOTE_5 = {
  id: "cn-5",
  status: "APPLIED",
  amount: "5.50",
  invoiceId: "inv-c",
  invoicePayments: [{ amount: "5.50", invoiceId: "inv-b" }],
};

/** the database both services read: it answers a where only the way Postgres would (note id OR an item sold on the order) */
function fakeDb(prisma: MockPrisma) {
  prisma.return.findMany.mockImplementation((async (args: any) => {
    const w = args.where;
    if (w.tenantId !== T) return [];
    if (w.OR) {
      const noteIds: string[] = w.OR[0].creditNoteId.in;
      const orderIds: string[] = w.OR[1].items.some.sourceOrderId.in;
      return [INLINE_ON_C].filter(
        (r) =>
          noteIds.includes(r.creditNoteId) ||
          r.items.some((i) => orderIds.includes(i.sourceOrderId)),
      );
    }
    return []; // A has no return filed on itself
  }) as never);
  prisma.creditNote.findMany.mockImplementation((async (args: any) =>
    [NOTE_5].filter((n) => args.where.id.in.includes(n.id))) as never);
}

/** A: a $12.50 counter sale paid in cash, one invoice, no credit-note payment at all */
function saleA() {
  const { lineItems, ...rest } = orderFixture({ total: "12.50", tax: "0.00" });
  return {
    ...rest,
    lineItems,
    invoices: [
      {
        ...INVOICE,
        payments: [{ method: "CASH", amount: "12.50", status: "PAID", creditNoteId: null }],
      },
    ],
  };
}

async function emailText(): Promise<string> {
  const prisma = createMockPrisma();
  prisma.getTenantId.mockReturnValue(T);
  prisma.order.findFirst.mockResolvedValue(saleA() as never);
  prisma.tenantConfig.findUnique.mockResolvedValue({ businessName: "Acme Test Store" } as never);
  prisma.systemConfig.findMany.mockResolvedValue([] as never);
  prisma.emailDelivery.count.mockResolvedValue(0);
  fakeDb(prisma);
  const email = { send: jest.fn().mockResolvedValue({ delivered: true, transport: "smtp" }) };
  await new ReceiptService(prisma as never, email as never).send(
    "ord-1",
    { channel: "email", to: "buyer@example.com" },
    NOW,
  );
  return email.send.mock.calls[0][0].text as string;
}

async function reprintModel(): Promise<ReceiptModel> {
  const prisma = createMockPrisma();
  prisma.getTenantId.mockReturnValue(T);
  prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: ZONE } as never);
  const a = saleA();
  // the page holds ONLY sale A: sale B (where the credit was spent) is not on it
  prisma.order.findMany.mockResolvedValue([
    {
      id: a.id,
      orderNumber: a.orderNumber,
      status: a.status,
      total: a.total,
      createdAt: a.createdAt,
      customerId: "c1",
      customer: a.customer,
      invoices: a.invoices,
      returns: [],
    },
  ] as never);
  prisma.order.count.mockResolvedValue(1);
  fakeDb(prisma);
  const res = await new CounterSaleTodayService(prisma as never).today(
    { page: 2, limit: 50 } as never,
    NOW,
  );
  const row = res.data[0]!;
  return receiptModelFromOrder({
    cashier: row.cashierName,
    order: {
      orderNumber: row.orderNumber,
      total: 12.5,
      tax: 0,
      lineItems: [{ id: "l1", name: "Cola", qty: 5, unitPrice: 2.5 }],
    },
    sale: {
      invoiceId: row.invoiceId as string,
      invoiceNumber: row.invoiceNumber as string,
      paid: row.paid,
      balanceDue: row.balanceDue,
      methods: row.methods,
      tenderPaid: row.tenderPaid,
      tenderMethods: row.tenderMethods,
      returnLines: row.returnLines,
      createdAt: row.createdAt,
      cashTendered: row.cashTendered,
      change: row.change,
      timezone: ZONE,
    },
    profile: null,
  });
}

/** the rows below Total as CounterReceiptView prints them (this case has no Tendered / Change) */
const reprintLines = (m: ReceiptModel): string[] => [
  ...(m.methodLabel ? [`Payment method ${m.methodLabel}`] : []),
  ...(m.showPaid ? [`Paid ${money(m.paid)}`] : []),
  ...(m.returned ? [`Returned −${money(m.returned)}`] : []),
  ...(m.refunded ? [`Refunded ${money(m.refunded)} (returned items)`] : []),
  ...(m.creditKept ? [`Credit kept ${money(m.creditKept)} (returned items)`] : []),
  ...(m.creditUsed ? [`Credit used ${money(m.creditUsed)} (returned items)`] : []),
  ...(m.showBalance ? [`Balance due ${money(m.balanceDue)}`] : []),
  ...(m.returnPending ? ["Return in progress"] : []),
];
const emailLines = (text: string): string[] => {
  const part = text.split("\n\n").find((p) => p.split("\n").some((l) => l.startsWith("Total: ")))!;
  const rows = part.split("\n");
  return rows
    .slice(rows.findIndex((l) => l.startsWith("Total: ")) + 1)
    .map((l) => l.replace(": ", " "));
};

describe("B1262 N1: a row and its emailed receipt find the same carried returns", () => {
  const PINNED = [
    "Payment method Cash $12.50",
    "Paid $12.50",
    "Credit used $5.50 (returned items)",
  ];

  it("A's own INLINE return filed on C, its credit spent on B: the reprint (a page without B) prints Credit used $5.50", async () => {
    expect(reprintLines(await reprintModel())).toEqual(PINNED);
  });

  it("... and the EMAIL prints the same lines, no Balance due", async () => {
    const text = await emailText();
    expect(emailLines(text)).toEqual(PINNED);
    expect(text).not.toContain("Balance due");
  });
});
