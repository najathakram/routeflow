/**
 * SA-1026 Part A: the STAFF customer statement carries `toCollect: { count, balance }`, the number and the existing balance
 * due of the customer's open invoices that read To collect (no new money math: `confirmedBalance`, the statement's own
 * balance basis). The buyer reads the same builder (`buyer.controller` calls `getStatementForOperator` WITHOUT the staff
 * flag), so the key must be ABSENT there. Built bare (no Nest module), like the SA-770 statement specs.
 */
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { CustomersService } from "./customers.service";
import { createMockPrisma } from "../testing/prisma-mock";

const CUSTOMER = { id: "cust-1", userId: "user-1", businessName: "Acme Corp" };
const FUTURE = new Date("2099-01-01T00:00:00.000Z");

const inv = (
  id: string,
  total: number,
  paid: number,
  status: string,
  expectedPaymentMethod: string | null,
) => ({
  id,
  invoiceNumber: id.toUpperCase(),
  total,
  status,
  dueDate: FUTURE,
  expectedPaymentMethod,
  createdAt: new Date("2019-12-01T00:00:00.000Z"),
  payments: paid ? [{ amount: paid, status: "PAID", method: "CASH" }] : [],
});

describe("customer statement toCollect (SA-1026)", () => {
  let service: CustomersService;
  beforeEach(() => {
    const prisma = createMockPrisma();
    prisma.customer.findFirst.mockResolvedValue(CUSTOMER);
    prisma.customer.findUnique.mockResolvedValue(CUSTOMER);
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.advancePayment.findMany.mockResolvedValue([]);
    prisma.order.findMany.mockResolvedValue([]);
    prisma.invoice.findMany.mockResolvedValue([
      inv("a", 120.1, 0, "SENT", "CHECK"),
      inv("b", 80.2, 0, "OVERDUE", "CHECK"),
      inv("part", 100, 40, "PARTIAL", "CHECK"),
      inv("plain", 500, 0, "SENT", null),
    ]);
    service = Object.create(CustomersService.prototype) as CustomersService;
    (service as any).prisma = prisma;
    (service as any).findCustomerOrThrow = jest.fn().mockResolvedValue(CUSTOMER);
  });

  it("the staff statement counts the To collect invoices and sums their existing balance due, in cents", async () => {
    const res = (await service.getStatementForOperator("cust-1", { includeExposure: true })) as any;
    expect(res.toCollect).toEqual({ count: 3, balance: 260.3 });
  });

  it("the buyer's read of the same builder (no staff flag) has no toCollect key", async () => {
    const res = (await service.getStatementForOperator("cust-1")) as any;
    expect("toCollect" in res).toBe(false);
  });

  it("the buyer's own statement has no toCollect key", async () => {
    const res = (await service.getMyStatement({ sub: "user-1", role: "CUSTOMER" } as any)) as any;
    expect("toCollect" in res).toBe(false);
  });

  it("a customer with nothing To collect reads count 0, balance 0", async () => {
    (service as any).prisma.invoice.findMany.mockResolvedValue([
      inv("plain", 500, 0, "SENT", null),
    ]);
    const res = (await service.getStatementForOperator("cust-1", { includeExposure: true })) as any;
    expect(res.toCollect).toEqual({ count: 0, balance: 0 });
  });
});
