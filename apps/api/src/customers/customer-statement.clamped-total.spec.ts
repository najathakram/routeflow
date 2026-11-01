/**
 * SA-1078 PR-1 (W-1096), rows S1-S3: the open balance never nets an overpaid invoice against the others.
 *
 * Both statement builders summed `total - confirmed paid` over every open invoice, so an invoice paid $10 over its
 * total subtracted $10 from what the customer owes on the others. Every other balance clamps an invoice at 0
 * (SA-770 row 310, `confirmedBalance`), so the rows can never add up to a total built that way, and the overdue
 * figure (already clamped) could read above the total. The total now sums the clamped balance of each invoice.
 * Built bare (no Nest module), like the SA-770 statement specs.
 */
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { CustomersService } from "./customers.service";
import { createMockPrisma } from "../testing/prisma-mock";

const CUSTOMER = { id: "cust-1", userId: "user-1", businessName: "Acme Corp" };
const FUTURE = new Date("2099-01-01T00:00:00.000Z");
const PAST = new Date("2020-01-01T00:00:00.000Z");

const inv = (id: string, total: number, paid: number, status: string, dueDate: Date) => ({
  id,
  invoiceNumber: id.toUpperCase(),
  total,
  status,
  dueDate,
  expectedPaymentMethod: null,
  createdAt: new Date("2019-12-01T00:00:00.000Z"),
  payments: paid ? [{ amount: paid, status: "PAID", method: "CASH" }] : [],
});

describe("SA-1078 S1-S3: the open balance is the sum of clamped invoice balances", () => {
  let service: CustomersService;

  const arrange = (invoices: ReturnType<typeof inv>[]) => {
    const prisma = createMockPrisma();
    prisma.customer.findFirst.mockResolvedValue(CUSTOMER);
    prisma.customer.findUnique.mockResolvedValue(CUSTOMER);
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.advancePayment.findMany.mockResolvedValue([]);
    prisma.order.findMany.mockResolvedValue([]);
    prisma.invoice.findMany.mockResolvedValue(invoices);
    service = Object.create(CustomersService.prototype) as CustomersService;
    (service as any).prisma = prisma;
    (service as any).findCustomerOrThrow = jest.fn().mockResolvedValue(CUSTOMER);
  };

  // A is paid $10 over its total, B owes the full $100 and is not yet due.
  const overpaidPlusOwing = () => [
    inv("a", 50, 60, "SENT", FUTURE),
    inv("b", 100, 0, "SENT", FUTURE),
  ];

  it("S1: the operator statement does not subtract an overpayment from what the other invoice owes", async () => {
    arrange(overpaidPlusOwing());
    const res = (await service.getStatementForOperator("cust-1")) as any;
    expect(res.outstandingAmount).toBe(100);
  });

  it("S2: the buyer's own statement reads the same 100.00", async () => {
    arrange(overpaidPlusOwing());
    const res = (await service.getMyStatement({ sub: "user-1", role: "CUSTOMER" } as any)) as any;
    expect(res.outstandingAmount).toBe(100);
  });

  it("S3: with B past due, overdue equals the total instead of reading above it", async () => {
    arrange([inv("a", 50, 60, "SENT", FUTURE), inv("b", 100, 0, "SENT", PAST)]);
    const res = (await service.getStatementForOperator("cust-1")) as any;
    expect(res.overdueAmount).toBe(100);
    expect(res.outstandingAmount).toBe(100);
    expect(res.overdueAmount).toBeLessThanOrEqual(res.outstandingAmount);
  });
});
