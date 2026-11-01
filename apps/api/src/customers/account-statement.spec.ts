/**
 * SA-1078 PR-1 (W-1096), rows S4-S8, S10-S19: the account statement read. Built bare (no Nest module) over the Prisma
 * mock, like the other statement specs. The DB-backed rows (the window's edges, the same cents through every reader,
 * another tenant's customer) live in account-statement.db.spec.ts.
 */
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { NotFoundException } from "@nestjs/common";
import { roundMoney } from "@routeflow/pricing";
import { CustomersController } from "./customers.controller";
import { CustomersService } from "./customers.service";
import { STATEMENT_RECENT_PAYMENTS, buildAccountStatement, daysLateOn } from "./account-statement";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { createMockPrisma } from "../testing/prisma-mock";

const NOW = new Date("2026-10-31T12:00:00.000Z");
const CUSTOMER = {
  id: "cust-1",
  userId: "user-1",
  businessName: "Acme Corp",
  email: "ap@acme.example",
};
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);

type Pay = { amount: number; status: string; method: string };
const pay = (amount: number, method = "CASH", status = "PAID"): Pay => ({ amount, status, method });

const inv = (
  id: string,
  total: number,
  payments: Pay[] = [],
  o: { status?: string; issue?: string; due?: string | null; intent?: string | null } = {},
) => ({
  id,
  invoiceNumber: id.toUpperCase(),
  total,
  status: o.status ?? "SENT",
  issueDate: day(o.issue ?? "2026-09-01"),
  dueDate: o.due === null ? null : day(o.due ?? "2099-01-01"),
  createdAt: day(o.issue ?? "2026-09-01"),
  expectedPaymentMethod: o.intent ?? null,
  payments,
});

describe("SA-1078 account statement (PR-1)", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let service: CustomersService;

  const arrange = (
    o: {
      invoices?: ReturnType<typeof inv>[];
      credits?: unknown[];
      advances?: unknown[];
      payments?: unknown[];
      zone?: string | null;
    } = {},
  ) => {
    prisma = createMockPrisma();
    prisma.customer.findUnique.mockResolvedValue(CUSTOMER);
    prisma.customer.findFirst.mockResolvedValue(CUSTOMER);
    prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: o.zone ?? null });
    prisma.invoice.findMany.mockResolvedValue(o.invoices ?? []);
    prisma.creditNote.findMany.mockResolvedValue(o.credits ?? []);
    prisma.advancePayment.findMany.mockResolvedValue(o.advances ?? []);
    prisma.invoicePayment.findMany.mockResolvedValue(o.payments ?? []);
    prisma.order.findMany.mockResolvedValue([]);
    service = Object.create(CustomersService.prototype) as CustomersService;
    (service as any).prisma = prisma;
  };
  const read = (staff = true) => service.getAccountStatement("cust-1", { staff });

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
  });
  afterEach(() => jest.useRealTimers());

  it("S4: four rows oldest first with Paid, Credit and Unpaid split by what each payment is", async () => {
    arrange({
      invoices: [
        inv("a", 500, [], { issue: "2026-08-01" }),
        inv("b", 500, [pay(200)], { status: "PARTIAL", issue: "2026-08-02" }),
        inv("c", 500, [pay(100, "CREDIT_NOTE")], { issue: "2026-08-03" }),
        inv("d", 500, [pay(50, "ADVANCE")], { issue: "2026-08-04" }),
      ],
    });
    const res = await read();
    expect(res.openInvoices.map((r) => r.invoiceNumber)).toEqual(["A", "B", "C", "D"]);
    expect(res.openInvoices.map((r) => r.paid)).toEqual([0, 200, 0, 0]);
    expect(res.openInvoices.map((r) => r.credit)).toEqual([0, 0, 100, 50]);
    expect(res.openInvoices.map((r) => r.unpaid)).toEqual([500, 300, 400, 450]);
    // the read asks the DB for oldest first, and for no cap
    const q = prisma.invoice.findMany.mock.calls[0][0];
    expect(q.orderBy).toEqual([{ issueDate: "asc" }, { createdAt: "asc" }]);
    expect(q.take).toBeUndefined();
  });

  it("S5: a DRAFT payment and a VOID payment are not money", async () => {
    arrange({
      invoices: [inv("a", 100, [pay(40, "CASH", "DRAFT"), pay(30, "CASH", "VOID")])],
    });
    const [row] = (await read()).openInvoices;
    expect(row.unpaid).toBe(100);
    expect(row.paid).toBe(0);
  });

  it("S6: only an invoice that still owes is a row (draft, paid, void, written off and exactly paid are not)", async () => {
    arrange({
      invoices: [
        inv("draft", 100, [], { status: "DRAFT" }),
        inv("paid", 100, [pay(100)], { status: "PAID" }),
        inv("void", 100, [], { status: "VOID" }),
        inv("wo", 100, [], { status: "WRITTEN_OFF" }),
        inv("exact", 100, [pay(100)]),
        inv("owes", 100),
      ],
    });
    const res = await read();
    expect(res.openInvoices.map((r) => r.invoiceNumber)).toEqual(["OWES"]);
    // and the read itself leaves the dead and unissued statuses out of the query
    const notIn = prisma.invoice.findMany.mock.calls[0][0].where.status.notIn;
    expect(notIn).toEqual(expect.arrayContaining(["DRAFT", "PAID", "VOID", "WRITTEN_OFF"]));
  });

  it("S7: float dust never breaks Total - Paid - Credit = Unpaid, to the cent, on any row", async () => {
    arrange({
      invoices: [
        inv("a", 0.1 + 0.1 + 0.1 + 0.05, [pay(0.1), pay(0.1), pay(0.05, "CREDIT_NOTE")]),
        inv("b", 100.3, [pay(0.1), pay(0.2)]),
        inv("c", 33.33, [pay(11.11), pay(11.11)]),
        inv("dust", 0.1 + 0.2, [pay(0.1), pay(0.1), pay(0.1)]), // exactly paid in cents: not a row
      ],
    });
    const res = await read();
    expect(res.openInvoices.map((r) => r.invoiceNumber)).toEqual(["A", "B", "C"]);
    for (const r of res.openInvoices) {
      expect(roundMoney(r.total - r.paid - r.credit)).toBe(r.unpaid);
    }
  });

  it("S8: the rows add up to openBalance, and it equals outstandingAmount of the older statements", async () => {
    arrange({
      invoices: [
        inv("a", 50, [pay(60)]), // overpaid: not a row, adds 0
        inv("b", 100),
        inv("c", 120.1, [pay(20.05)]),
      ],
    });
    const res = await read();
    const sum = roundMoney(res.openInvoices.reduce((s, r) => s + r.unpaid, 0));
    expect(res.openBalance).toBe(sum);
    expect(res.openBalance).toBe(200.05);
    const operator = (await service.getStatementForOperator("cust-1")) as any;
    expect(operator.outstandingAmount).toBe(res.openBalance);
    expect(operator.overdueAmount).toBe(res.overdue);
  });

  it("S8: overdue never exceeds the open balance", async () => {
    arrange({
      invoices: [inv("a", 100, [], { due: "2026-10-01" }), inv("b", 50, [], { due: "2099-01-01" })],
    });
    const res = await read();
    expect(res.overdue).toBe(100);
    expect(res.openBalance).toBe(150);
    expect(res.overdue).toBeLessThanOrEqual(res.openBalance);
  });

  describe("S10: daysLate counts the tenant's own days", () => {
    it("due today, due yesterday, no due date, in a zone behind UTC at 03:00 UTC", async () => {
      // 03:00 UTC on Nov 1 is still Oct 31 evening in Los Angeles: the tenant's day is 2026-10-31.
      jest.setSystemTime(new Date("2026-11-01T03:00:00.000Z"));
      arrange({
        zone: "America/Los_Angeles",
        invoices: [
          inv("today", 10, [], { due: "2026-10-31" }),
          inv("yday", 10, [], { due: "2026-10-30" }),
          inv("none", 10, [], { due: null }),
          inv("future", 10, [], { due: "2026-11-05" }),
        ],
      });
      const res = await read();
      expect(res.asOf).toBe("2026-10-31");
      expect(
        Object.fromEntries(res.openInvoices.map((r) => [r.invoiceNumber, r.daysLate])),
      ).toEqual({
        TODAY: 0,
        YDAY: 1,
        NONE: 0,
        FUTURE: 0,
      });
    });

    it("is the same count as web's daysPastDue", () => {
      expect(daysLateOn("2026-10-31", day("2026-10-31"))).toBe(0);
      expect(daysLateOn("2026-10-31", day("2026-10-19"))).toBe(12);
      expect(daysLateOn("2026-10-31", day("2026-12-01"))).toBe(0);
      expect(daysLateOn("2026-10-31", null)).toBe(0);
    });
  });

  it("S11: credit notes and advances list what is left; expired and used-up ones are not credit", async () => {
    arrange({
      credits: [
        {
          id: "cn1",
          creditNoteNumber: "CN-1",
          amount: 100,
          amountUsed: 0,
          reason: "Returned stock",
          createdAt: day("2026-10-01"),
          expiresAt: null,
        },
        {
          id: "cn2",
          creditNoteNumber: "CN-2",
          amount: 80,
          amountUsed: 30,
          reason: null,
          createdAt: day("2026-10-02"),
          expiresAt: day("2099-01-01"),
        },
        {
          id: "cn3",
          creditNoteNumber: "CN-3",
          amount: 60,
          amountUsed: 0,
          reason: "Old",
          createdAt: day("2025-01-01"),
          expiresAt: day("2026-01-01"), // expired
        },
        {
          id: "cn4",
          creditNoteNumber: "CN-4",
          amount: 40,
          amountUsed: 40, // used up
          reason: null,
          createdAt: day("2026-10-03"),
          expiresAt: null,
        },
      ],
      advances: [
        { id: "ad1", balance: 25, reference: "CHK-9", notes: null, receivedAt: day("2026-10-05") },
      ],
    });
    const res = await read();
    expect(res.credits.map((c) => [c.kind, c.id, c.remaining])).toEqual([
      ["CREDIT_NOTE", "cn1", 100],
      ["CREDIT_NOTE", "cn2", 50],
      ["ADVANCE", "ad1", 25],
    ]);
    expect(res.creditAvailable).toBe(175);
    // VOID notes and advances with no balance are left out by the query itself
    expect(prisma.creditNote.findMany.mock.calls[0][0].where.status).toEqual({ not: "VOID" });
    expect(prisma.advancePayment.findMany.mock.calls[0][0].where.balance).toEqual({ gt: 0 });
  });

  it("S12: afterCredit is the balance less credit, never below 0, and the balance itself never moves", async () => {
    const credit = [
      {
        id: "cn",
        creditNoteNumber: "CN-1",
        amount: 200,
        amountUsed: 0,
        reason: null,
        createdAt: day("2026-10-01"),
        expiresAt: null,
      },
    ];
    arrange({ invoices: [inv("a", 500)], credits: credit });
    let res = await read();
    expect([res.openBalance, res.creditAvailable, res.afterCredit]).toEqual([500, 200, 300]);

    arrange({ invoices: [inv("a", 100)], credits: credit });
    res = await read();
    expect([res.openBalance, res.afterCredit]).toEqual([100, 0]);
  });

  describe("S13 / S14: recent payments", () => {
    const row = (n: number, o: Partial<Record<string, unknown>> = {}) => ({
      amount: 10,
      method: "CASH",
      reference: null,
      paidAt: new Date(NOW.getTime() - n * 3_600_000),
      settledAt: null,
      invoice: { invoiceNumber: `INV-${n}` },
      ...o,
    });

    it("asks only for confirmed money collected in the last 30 days of the tenant's calendar", async () => {
      arrange();
      await read();
      const q = prisma.invoicePayment.findMany.mock.calls[0][0];
      expect(q.where.status).toBe("PAID");
      expect(q.where.invoice).toEqual({ customerId: "cust-1" });
      const since = day("2026-10-01"); // 30 days before 2026-10-31
      expect(q.where.OR).toEqual([
        { settledAt: { gte: since } },
        { settledAt: null, paidAt: { gte: since } },
      ]);
    });

    it("dates a payment by when it was collected, newest first, and names credit applications", async () => {
      arrange({
        payments: [
          row(100, { reference: "OLD" }),
          row(300, {
            settledAt: new Date(NOW.getTime() - 5 * 3_600_000),
            reference: "CHK-1",
            method: "CHECK",
          }),
          row(10, { method: "CREDIT_NOTE", amount: 12.5 }),
          row(20, { method: "ADVANCE" }),
        ],
      });
      const res = await read();
      expect(res.recentPayments.map((p) => [p.invoiceNumber, p.kind, p.method])).toEqual([
        ["INV-300", "PAYMENT", "CHECK"], // paid 300h ago, collected 5h ago: the newest
        ["INV-10", "CREDIT", "CREDIT_NOTE"],
        ["INV-20", "CREDIT", "ADVANCE"],
        ["INV-100", "PAYMENT", "CASH"],
      ]);
      expect(res.recentPayments[1].amount).toBe(12.5);
      expect(res.recentPayments[0].reference).toBe("CHK-1");
      expect(res.recentPayments[0].date).toBe(
        new Date(NOW.getTime() - 5 * 3_600_000).toISOString(),
      );
    });

    it("S14: 51 payments in 30 days read as 50 rows and truncated; 50 are not truncated", async () => {
      arrange({
        payments: Array.from({ length: STATEMENT_RECENT_PAYMENTS + 1 }, (_, i) => row(i + 1)),
      });
      let res = await read();
      expect(res.recentPayments).toHaveLength(50);
      expect(res.recentPaymentsTruncated).toBe(true);
      expect(res.recentPayments[0].invoiceNumber).toBe("INV-1"); // the newest survives the cut

      arrange({
        payments: Array.from({ length: STATEMENT_RECENT_PAYMENTS }, (_, i) => row(i + 1)),
      });
      res = await read();
      expect(res.recentPayments).toHaveLength(50);
      expect(res.recentPaymentsTruncated).toBe(false);
    });
  });

  it("S15: 150 open invoices are 150 rows and the total covers all 150", async () => {
    arrange({
      invoices: Array.from({ length: 150 }, (_, i) =>
        inv(`i${i}`, 10.01, [], { issue: "2026-09-01" }),
      ),
    });
    const res = await read();
    expect(res.openInvoices).toHaveLength(150);
    expect(res.openBalance).toBe(1501.5);
  });

  it("S16: a post-dated check on hold is waiting to clear, and the invoice still owes in full", async () => {
    arrange({ invoices: [inv("a", 500, [pay(300, "CHECK", "PENDING")])] });
    const res = await read();
    expect(res.openInvoices[0].unpaid).toBe(500);
    expect(res.openInvoices[0].paid).toBe(0);
    expect(res.openBalance).toBe(500);
    expect(res.waitingToClear).toBe(300);
  });

  describe("S17: the buyer's view", () => {
    it("has no emailOnFile, no toCollect on any row, and no exposure keys", async () => {
      arrange({ invoices: [inv("a", 100, [], { intent: "CHECK" })] });
      const res = (await read(false)) as any;
      expect("emailOnFile" in res).toBe(false);
      expect(res.openInvoices.every((r: any) => !("toCollect" in r))).toBe(true);
      for (const k of ["creditExposure", "pendingExposure", "autoApplyCredit", "toCollect"]) {
        expect(k in res).toBe(false);
      }
    });

    it("the staff view carries both", async () => {
      arrange({ invoices: [inv("a", 100, [], { intent: "CHECK" }), inv("b", 50)] });
      const res = await read(true);
      expect(res.emailOnFile).toBe("ap@acme.example");
      expect(res.openInvoices.map((r) => r.toCollect)).toEqual(["TO_COLLECT", "NONE"]);
    });
  });

  it("S18: a customer the tenant does not have is a 404 and nothing else is read", async () => {
    arrange();
    prisma.customer.findUnique.mockResolvedValue(null);
    await expect(read()).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
  });

  it("S19: the staff route is OPERATOR-only (a DRIVER or CUSTOMER role is refused)", () => {
    const roles = Reflect.getMetadata(ROLES_KEY, CustomersController.prototype.getAccountStatement);
    expect(roles).toEqual(["OPERATOR"]);
  });

  it("the function takes Prisma by parameter and needs no service", async () => {
    arrange({ invoices: [inv("a", 10)] });
    const res = await buildAccountStatement(prisma as any, CUSTOMER, { staff: false });
    expect(res.openBalance).toBe(10);
    expect(res.customer).toEqual({ id: "cust-1", businessName: "Acme Corp" });
  });
});
