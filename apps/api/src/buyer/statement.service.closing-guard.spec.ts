/**
 * SA-1078 S20 (guard): on a plain fixture, this month's PDF `closing` equals the statement's open balance. The monthly
 * `closing` stays unclamped and dated by collection (its opening, charges and payments have to add up), so it can differ
 * from today's open balance for a past month, a post-dated check or an overpaid invoice; this pins the plain case only,
 * so the two can never drift apart where nothing should separate them.
 */
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { StatementService } from "./statement.service";
import { CustomersService } from "../customers/customers.service";
import { createMockPrisma } from "../testing/prisma-mock";

const CUSTOMER = { id: "cust-1", userId: "user-1", businessName: "Acme Corp" };
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);

const invoice = (id: string, total: number, issue: string, payments: object[]) => ({
  id,
  invoiceNumber: id.toUpperCase(),
  total,
  status: "SENT",
  issueDate: day(issue),
  dueDate: day("2099-01-01"),
  createdAt: day(issue),
  expectedPaymentMethod: null,
  payments,
});

describe("SA-1078 S20: the monthly PDF closing equals the open balance on a plain fixture", () => {
  it("one part-paid invoice and one unpaid invoice, both issued this month", async () => {
    const prisma = createMockPrisma();
    prisma.customer.findFirst.mockResolvedValue(CUSTOMER);
    prisma.customer.findUnique.mockResolvedValue(CUSTOMER);
    prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: null });
    prisma.invoice.findMany.mockResolvedValue([
      invoice("a", 500, "2026-10-05", [
        { amount: 100, status: "PAID", method: "CASH", paidAt: day("2026-10-10"), settledAt: null },
      ]),
      invoice("b", 250.1, "2026-10-15", []),
    ]);
    prisma.invoicePayment.findMany.mockResolvedValue([]);
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.advancePayment.findMany.mockResolvedValue([]);
    prisma.order.findMany.mockResolvedValue([]);

    const pdf = await new StatementService(prisma as any).buildMonthlyStatement(
      "cust-1",
      "2026-10",
      new Date("2026-10-31T12:00:00.000Z"),
    );
    const service = Object.create(CustomersService.prototype) as CustomersService;
    (service as any).prisma = prisma;
    const statement = (await service.getStatementForOperator("cust-1")) as any;

    expect(pdf.closing).toBe(650.1);
    expect(pdf.closing).toBe(statement.outstandingAmount);
  });
});
