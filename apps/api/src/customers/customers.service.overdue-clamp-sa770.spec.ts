/**
 * SA-770 (row 294) follow-up: the statement `overdueAmount` summed `total - amountPaid` per open past-due
 * invoice, so an OVERPAID open invoice (P-3 keeps it out of PAID) subtracted from the figure. Each
 * invoice now contributes max(0, roundMoney(balance)). Both statement readers (the buyer's own and the
 * operator's) pin the same rows. Built bare (no Nest module): the statements only use `prisma`.
 */
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { CustomersService } from "./customers.service";
import { createMockPrisma } from "../testing/prisma-mock";

const PAST = new Date("2020-01-01T00:00:00.000Z");
const FUTURE = new Date("2099-01-01T00:00:00.000Z");
const CUSTOMER = { id: "cust-1", userId: "user-1", businessName: "Acme Corp" };
const user = { sub: "user-1", role: "CUSTOMER" } as any;

const inv = (id: string, total: number, paid: number, dueDate: Date, status = "SENT") => ({
  id,
  invoiceNumber: id.toUpperCase(),
  total,
  status,
  dueDate,
  createdAt: new Date("2019-12-01T00:00:00.000Z"),
  payments: paid ? [{ amount: paid, status: "PAID", method: "CASH" }] : [],
});

describe.each([
  ["getMyStatement", (s: CustomersService) => s.getMyStatement(user)],
  ["getStatementForOperator", (s: CustomersService) => s.getStatementForOperator("cust-1")],
])("%s — overdueAmount never goes negative on an overpaid open invoice (SA-770)", (_name, call) => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let service: CustomersService;

  beforeEach(() => {
    prisma = createMockPrisma();
    prisma.customer.findFirst.mockResolvedValue(CUSTOMER);
    prisma.customer.findUnique.mockResolvedValue(CUSTOMER);
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.advancePayment.findMany.mockResolvedValue([]);
    prisma.order.findMany.mockResolvedValue([]);
    service = Object.create(CustomersService.prototype) as CustomersService;
    (service as any).prisma = prisma;
    (service as any).findCustomerOrThrow = jest.fn().mockResolvedValue(CUSTOMER);
  });

  const overdueOf = async (rows: any[]) => {
    prisma.invoice.findMany.mockResolvedValue(rows);
    return ((await call(service)) as any).overdueAmount as number;
  };

  it("an overpaid open past-due invoice contributes 0, not a negative", async () => {
    expect(await overdueOf([inv("over", 100, 110, PAST)])).toBe(0);
  });

  it("a mix: only the genuinely overdue invoice counts (before the fix: 50 - 10 = 40)", async () => {
    expect(
      await overdueOf([inv("over", 100, 110, PAST), inv("owes", 50, 0, PAST, "OVERDUE")]),
    ).toBe(50);
  });

  it("overdue is the sum of the POSITIVE balances of open past-due invoices, in cents", async () => {
    expect(
      await overdueOf([
        inv("a", 0.1, 0, PAST),
        inv("b", 0.2, 0, PAST),
        inv("partial", 100, 40, PAST, "PARTIAL"),
        inv("exact", 80, 80, PAST),
        inv("over", 30, 90, PAST),
        inv("not-due", 500, 0, FUTURE),
      ]),
    ).toBe(60.3);
  });
});
