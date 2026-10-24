/**
 * SA-770 r-note: the buyer's analytics summary (`GET /buyer/analytics`) classifies overdue exactly as
 * staff do: an open invoice that still owes a balance and whose due day has ended in THE INVOICE'S OWN
 * seller tenant zone. `unpaidInvoiceTotal` and the breakdown count BALANCE, never gross `total`.
 * Built bare (no Nest module): getAnalytics only touches `this.prisma`.
 */
jest.mock("../invoices/invoice-pdf.service", () => ({ InvoicePdfService: jest.fn() }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { BuyerController } from "./buyer.controller";
import { createMockPrisma } from "../testing/prisma-mock";

const pay = (amount: number, status = "PAID") => ({ amount, status, method: "CASH" });
const row = (total: number, payments: any[], dueDate: string, status = "SENT") => ({
  status,
  total,
  dueDate: new Date(dueDate),
  payments,
});

describe("BuyerController.getAnalytics — overdue means a balance is due (SA-770)", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let controller: BuyerController;

  beforeEach(() => {
    prisma = createMockPrisma();
    prisma.order.findMany.mockResolvedValue([]);
    prisma.invoicePayment.findMany.mockResolvedValue([]);
    prisma.tenantConfig.findUnique.mockResolvedValue(null);
    controller = Object.create(BuyerController.prototype) as BuyerController;
    (controller as any).prisma = prisma;
  });
  afterEach(() => jest.useRealTimers());

  const analytics = async (rows: any[], paidCount = 0) => {
    prisma.invoice.findMany.mockResolvedValue(rows);
    prisma.invoice.count.mockResolvedValue(paidCount);
    return controller.getAnalytics({ customerId: "cust-1" });
  };

  it("reads BOUNDED: PAID invoices are counted, only OPEN ones are fetched, with the confirmed payments' amount, status and method", async () => {
    await analytics([], 4);
    expect(prisma.invoice.count).toHaveBeenCalledWith({
      where: { customerId: "cust-1", status: "PAID" },
    });
    expect(prisma.invoice.findMany).toHaveBeenCalledWith({
      where: { customerId: "cust-1", status: { in: ["SENT", "VIEWED", "PARTIAL", "OVERDUE"] } },
      select: {
        status: true,
        total: true,
        dueDate: true,
        payments: {
          where: { status: "PAID" },
          select: { amount: true, status: true, method: true },
        },
      },
    });
  });

  it("an overpaid open invoice past due: overdueCount 0 and $0 (before the fix: 1 and the gross)", async () => {
    const res = await analytics([row(100, [pay(110)], "2020-01-01")]);
    expect(res.invoiceBreakdown.overdue).toBe(0);
    expect(res.invoiceBreakdown.unpaid).toBe(0);
    expect(res.summary.unpaidInvoiceCount).toBe(0);
    expect(res.summary.unpaidInvoiceTotal).toBe(0);
  });

  it("$100 with $60 paid, past due: one overdue invoice and the total is $40, not $100", async () => {
    const res = await analytics([row(100, [pay(60)], "2020-01-01", "PARTIAL")]);
    expect(res.invoiceBreakdown.overdue).toBe(1);
    expect(res.summary.unpaidInvoiceTotal).toBe(40);
  });

  it("due today (inside the tenant's due day) is unpaid, not overdue", async () => {
    jest.useFakeTimers({
      now: new Date("2026-10-02T12:00:00.000Z"),
      doNotFake: ["nextTick", "setImmediate", "queueMicrotask"],
    });
    const res = await analytics([row(100, [], "2026-10-02T00:00:00.000Z")]);
    expect(res.invoiceBreakdown).toMatchObject({ overdue: 0, unpaid: 1 });
  });

  it("a mix: paid in substance counts as paid; only owed money is summed", async () => {
    const res = await analytics(
      [
        row(100, [pay(100)], "2020-01-01"), // exactly paid, still SENT
        row(50, [], "2020-01-01", "OVERDUE"),
        row(200, [pay(20)], "2099-01-01"),
      ],
      1, // one PAID invoice
    );
    expect(res.invoiceBreakdown).toEqual({ paid: 2, unpaid: 1, overdue: 1 });
    expect(res.summary.unpaidInvoiceCount).toBe(2);
    expect(res.summary.unpaidInvoiceTotal).toBe(230); // 50 + 180
  });

  it("each seller is judged on its own zone: Chicago keeps the due day, Auckland has ended it", async () => {
    // 14:00Z on Oct 1 is 09:00 Oct 1 in Chicago and 03:00 Oct 2 in Auckland.
    jest.useFakeTimers({
      now: new Date("2026-10-01T14:00:00.000Z"),
      doNotFake: ["nextTick", "setImmediate", "queueMicrotask"],
    });
    const dueOct1 = [row(100, [], "2026-10-01T00:00:00.000Z")];
    prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: "America/Chicago" });
    expect((await analytics(dueOct1)).invoiceBreakdown).toMatchObject({ overdue: 0, unpaid: 1 });
    prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: "Pacific/Auckland" });
    expect((await analytics(dueOct1)).invoiceBreakdown).toMatchObject({ overdue: 1, unpaid: 0 });
  });
});
