/**
 * ACTION-ITEMS row 309 (SA-770 "one predicate"): the customer statement's `overdueAmount` judged
 * "overdue" with `new Date(i.dueDate) < new Date()` - no RF-202 grace (an invoice due TODAY counted as
 * overdue from 00:00Z) and no tenant zone. It now goes through the one classifier with the cutoff of the
 * statement's OWN tenant zone, resolved once per statement. Both statements (the buyer's `getMyStatement`
 * and the operator's `getStatementForOperator`) are pinned on the same rows; the max(0, roundMoney)
 * clamp semantics and the response shape are unchanged.
 *
 * Dates are the schema's UTC-midnight calendar stamps. Pacific/Auckland is UTC+12 in September (NZST):
 * 20:00Z on Sep 20 is 08:00 on Sep 21 there. America/Chicago is UTC-5 (CDT): 03:00Z on Sep 21 is 22:00
 * on Sep 20 there.
 */
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { CustomersService } from "./customers.service";
import { createMockPrisma } from "../testing/prisma-mock";

const CUSTOMER = { id: "cust-1", userId: "user-1", businessName: "Acme Corp" };
const user = { sub: "user-1", role: "CUSTOMER" } as any;
const DUE_SEP_20 = new Date("2026-09-20T00:00:00.000Z");

const inv = (id: string, total: number, paid: number, dueDate: Date | null, status = "SENT") => ({
  id,
  invoiceNumber: id.toUpperCase(),
  total,
  status,
  dueDate,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  payments: paid ? [{ amount: paid, status: "PAID", method: "CASH" }] : [],
});

describe.each([
  ["getMyStatement", (s: CustomersService) => s.getMyStatement(user)],
  ["getStatementForOperator", (s: CustomersService) => s.getStatementForOperator("cust-1")],
])("%s - overdueAmount uses the one overdue rule in the tenant's zone (row 309)", (_n, call) => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let service: CustomersService;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    prisma = createMockPrisma();
    prisma.getTenantId.mockReturnValue("tenant-acme");
    prisma.customer.findFirst.mockResolvedValue(CUSTOMER);
    prisma.customer.findUnique.mockResolvedValue(CUSTOMER);
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.advancePayment.findMany.mockResolvedValue([]);
    prisma.order.findMany.mockResolvedValue([]);
    service = Object.create(CustomersService.prototype) as CustomersService;
    (service as any).prisma = prisma;
    (service as any).findCustomerOrThrow = jest.fn().mockResolvedValue(CUSTOMER);
  });
  afterEach(() => jest.useRealTimers());

  const zone = (timezone: string | null) =>
    prisma.tenantConfig.findUnique.mockResolvedValue({ timezone });

  const overdueOf = async (now: Date, rows: any[]) => {
    jest.setSystemTime(now);
    prisma.invoice.findMany.mockResolvedValue(rows);
    return ((await call(service)) as any).overdueAmount as number;
  };

  it("an invoice due TODAY is not overdue, at any hour of the due day (RF-202 grace)", async () => {
    zone(null); // UTC
    const rows = [inv("today", 100, 0, DUE_SEP_20)];
    expect(await overdueOf(new Date("2026-09-20T00:00:01.000Z"), rows)).toBe(0); // was 100
    expect(await overdueOf(new Date("2026-09-20T23:59:59.000Z"), rows)).toBe(0);
    expect(await overdueOf(new Date("2026-09-21T00:00:00.000Z"), rows)).toBe(100); // day ended
  });

  it("the due day ends in the TENANT's zone: Auckland is overdue where UTC is still on the due day", async () => {
    zone("Pacific/Auckland");
    const rows = [inv("d", 100, 0, DUE_SEP_20)];
    expect(await overdueOf(new Date("2026-09-20T20:00:00.000Z"), rows)).toBe(100);
    expect(await overdueOf(new Date("2026-09-20T11:59:59.000Z"), rows)).toBe(0);
  });

  it("the due day ends in the TENANT's zone: Chicago is still on the due day where UTC has moved on", async () => {
    zone("America/Chicago");
    const rows = [inv("d", 100, 0, DUE_SEP_20)];
    expect(await overdueOf(new Date("2026-09-21T03:00:00.000Z"), rows)).toBe(0); // was 100
    expect(await overdueOf(new Date("2026-09-21T05:00:00.000Z"), rows)).toBe(100);
  });

  it("the zone is looked up once per statement, not per invoice", async () => {
    zone("Pacific/Auckland");
    prisma.tenantConfig.findUnique.mockClear();
    await overdueOf(new Date("2026-09-25T00:00:00.000Z"), [
      inv("a", 10, 0, DUE_SEP_20),
      inv("b", 10, 0, DUE_SEP_20),
      inv("c", 10, 0, DUE_SEP_20),
    ]);
    expect(prisma.tenantConfig.findUnique).toHaveBeenCalledTimes(1);
  });

  it("clamp semantics kept: balances in cents, overpaid adds 0, past-due partial counts its remainder", async () => {
    zone(null);
    expect(
      await overdueOf(new Date("2026-10-01T12:00:00.000Z"), [
        inv("a", 0.1, 0, DUE_SEP_20),
        inv("b", 0.2, 0, DUE_SEP_20),
        inv("partial", 100, 40, DUE_SEP_20, "PARTIAL"),
        inv("exact", 80, 80, DUE_SEP_20),
        inv("over", 30, 90, DUE_SEP_20),
        inv("future", 500, 0, new Date("2026-10-30T00:00:00.000Z")),
        inv("no-due", 500, 0, null),
      ]),
    ).toBe(60.3);
  });
});
