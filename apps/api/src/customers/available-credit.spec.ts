/**
 * SA-1208 D7 (M1-05): one available-credit figure on every statement surface. A $300 unused credit note plus a $200
 * advance reads $500 on the buyer's own statement, the monthly statement and the account statement (portal and PDF).
 * Before the helper the first two counted notes only and read $300.
 *
 * Specs run bare over the Prisma mock (no database). The mock `forTenant()` here filters rows to one tenant, as the
 * real tenant extension does, so a row planted on another tenant must never reach the sum.
 */
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("../common/tenant-time-zone", () => ({
  tenantTimeZone: jest.fn().mockResolvedValue("UTC"),
}));
jest.mock("../invoices/credit-exposure", () => ({
  OPEN_ORDER_STATUSES: [],
  loadCreditExposure: jest.fn().mockResolvedValue({ counted: 0, pendingExposure: 0 }),
}));

import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { StatementService } from "../buyer/statement.service";
import { buildAccountStatement } from "./account-statement";
import { buildMyStatement, buildOperatorStatement } from "./customer-statement";
import {
  advanceRemaining,
  creditNoteRemaining,
  loadAvailableCredit,
  sumAvailableCredit,
} from "./available-credit";
import { createMockPrisma } from "../testing/prisma-mock";

const NOW = new Date("2026-10-31T12:00:00.000Z");
const FUTURE = new Date("2099-01-01T00:00:00.000Z");
const PAST = new Date("2026-01-01T00:00:00.000Z");

const TENANT = "tenant-acme";
const OTHER_TENANT = "tenant-other";
const CUSTOMER = "cust-1";
const OTHER_CUSTOMER = "cust-2";

type CreditRow = {
  id: string;
  tenantId: string;
  customerId: string;
  creditNoteNumber: string;
  amount: number;
  amountUsed: number;
  status: string;
  expiresAt: Date | null;
  reason: string | null;
  createdAt: Date;
};
type AdvanceRow = {
  id: string;
  tenantId: string;
  customerId: string;
  amount: number;
  balance: number;
  method: string;
  reference: string | null;
  receivedAt: Date;
};

const note = (o: Partial<CreditRow> & { amount: number }): CreditRow => ({
  id: `cn-${o.customerId ?? CUSTOMER}-${o.amount}-${o.amountUsed ?? 0}`,
  tenantId: TENANT,
  customerId: CUSTOMER,
  creditNoteNumber: "CN-1",
  amountUsed: 0,
  status: "ISSUED",
  expiresAt: null,
  reason: null,
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  ...o,
});
const advance = (o: Partial<AdvanceRow> & { balance: number }): AdvanceRow => ({
  id: `adv-${o.customerId ?? CUSTOMER}-${o.balance}`,
  tenantId: TENANT,
  customerId: CUSTOMER,
  amount: o.balance,
  method: "CHECK",
  reference: null,
  receivedAt: new Date("2026-10-02T00:00:00.000Z"),
  ...o,
});

/** Evaluate the slice of a Prisma `where` the credit reads use, over rows already narrowed to the caller's tenant. */
function scoped<T extends { tenantId: string; customerId: string }>(rows: T[]) {
  return jest.fn(async (args: any) => {
    const w = args?.where ?? {};
    return rows
      .filter((r) => r.tenantId === TENANT) // the tenant extension of forTenant()
      .filter((r) => w.customerId === undefined || r.customerId === w.customerId)
      .filter((r: any) => !w.status?.not || r.status !== w.status.not)
      .filter((r: any) => !w.balance?.gt || Number(r.balance) > w.balance.gt);
  });
}

function arrange(rows: { notes: CreditRow[]; advances: AdvanceRow[] }) {
  const prisma = createMockPrisma();
  prisma.creditNote.findMany = scoped(rows.notes) as any;
  prisma.advancePayment.findMany = scoped(rows.advances) as any;
  prisma.customer.findFirst.mockResolvedValue({
    id: CUSTOMER,
    userId: "user-1",
    businessName: "Acme Corp",
    email: "ap@acme.example",
  });
  prisma.invoice.findMany.mockResolvedValue([]);
  prisma.invoice.aggregate.mockResolvedValue({ _sum: {} });
  prisma.invoicePayment.findMany.mockResolvedValue([]);
  prisma.invoicePayment.aggregate.mockResolvedValue({ _sum: {} });
  prisma.order.findMany.mockResolvedValue([]);
  prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: null });
  return prisma;
}

const NOTE_300_ADVANCE_200 = {
  notes: [note({ amount: 300 })],
  advances: [advance({ balance: 200 })],
};

async function monthly(prisma: ReturnType<typeof createMockPrisma>) {
  const module = await Test.createTestingModule({
    providers: [StatementService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return module.get(StatementService).buildMonthlyStatement(CUSTOMER, "2026-10", NOW);
}

describe("SA-1208 D7: one available-credit figure ($300 note + $200 advance)", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
  });
  afterEach(() => jest.useRealTimers());

  it("surface 1, the buyer's own statement: $500", async () => {
    const prisma = arrange(NOTE_300_ADVANCE_200);
    const stmt = await buildMyStatement(prisma as any, { sub: "user-1" } as any);
    expect(stmt.availableCredit).toBe(500);
  });

  it("surface 2, the monthly statement: $500", async () => {
    const prisma = arrange(NOTE_300_ADVANCE_200);
    const stmt = await monthly(prisma);
    expect(stmt.availableCredit).toBe(500);
  });

  it("surface 3, the account statement (portal and PDF): $500", async () => {
    const prisma = arrange(NOTE_300_ADVANCE_200);
    const stmt = await buildAccountStatement(
      prisma as any,
      { id: CUSTOMER, businessName: "Acme Corp" },
      { staff: false, now: NOW },
    );
    expect(stmt.creditAvailable).toBe(500);
  });

  it("the staff statement keeps its two tiles: availableCredit is the notes, advanceBalance the advances", async () => {
    const prisma = arrange(NOTE_300_ADVANCE_200);
    const stmt = await buildOperatorStatement(prisma as any, CUSTOMER);
    expect([stmt.availableCredit, stmt.advanceBalance]).toEqual([300, 200]);
  });

  it("credit is shown on its own and never netted against the open balance", async () => {
    const prisma = arrange(NOTE_300_ADVANCE_200);
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: "inv-a",
        invoiceNumber: "INV-A",
        total: 1000,
        status: "SENT",
        issueDate: new Date("2026-09-01T00:00:00.000Z"),
        dueDate: new Date("2099-01-01T00:00:00.000Z"),
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
        expectedPaymentMethod: null,
        payments: [],
      },
    ]);
    const stmt = await buildMyStatement(prisma as any, { sub: "user-1" } as any);
    expect([stmt.outstandingAmount, stmt.availableCredit]).toEqual([1000, 500]);
  });
});

describe("SA-1208 D7: credit stays one customer's and one tenant's", () => {
  const world = {
    notes: [
      note({ amount: 300 }),
      note({ amount: 999, customerId: OTHER_CUSTOMER }),
      note({ amount: 888, tenantId: OTHER_TENANT }),
    ],
    advances: [
      advance({ balance: 200 }),
      advance({ balance: 777, customerId: OTHER_CUSTOMER }),
      advance({ balance: 666, tenantId: OTHER_TENANT }),
    ],
  };

  it("the buyer's statement never counts another customer's or another tenant's credit", async () => {
    const stmt = await buildMyStatement(arrange(world) as any, { sub: "user-1" } as any);
    expect(stmt.availableCredit).toBe(500);
  });

  it("the monthly statement never counts another customer's or another tenant's credit", async () => {
    expect((await monthly(arrange(world))).availableCredit).toBe(500);
  });

  it("the account statement never counts another customer's or another tenant's credit", async () => {
    const stmt = await buildAccountStatement(
      arrange(world) as any,
      { id: CUSTOMER, businessName: "Acme Corp" },
      { staff: false, now: NOW },
    );
    expect(stmt.creditAvailable).toBe(500);
  });

  it("the loader asks for this customer only, on the tenant-scoped client", async () => {
    const prisma = arrange(world);
    const credit = await loadAvailableCredit(prisma.forTenant() as any, CUSTOMER, NOW);
    expect(credit).toEqual({ notes: 300, advances: 200, total: 500 });
    expect((prisma.creditNote.findMany as jest.Mock).mock.calls[0][0].where.customerId).toBe(
      CUSTOMER,
    );
    expect((prisma.advancePayment.findMany as jest.Mock).mock.calls[0][0].where.customerId).toBe(
      CUSTOMER,
    );
  });
});

describe("SA-1208 D7: the helper's rules", () => {
  it("a used-up, VOID or expired note adds nothing; an open note adds its remainder", () => {
    expect(creditNoteRemaining({ amount: 100, amountUsed: 100 }, NOW)).toBe(0);
    expect(creditNoteRemaining({ amount: 100, amountUsed: 0, status: "VOID" }, NOW)).toBe(0);
    expect(creditNoteRemaining({ amount: 100, amountUsed: 0, expiresAt: PAST }, NOW)).toBe(0);
    expect(creditNoteRemaining({ amount: 100, amountUsed: 0, expiresAt: FUTURE }, NOW)).toBe(100);
    expect(creditNoteRemaining({ amount: 100, amountUsed: 35.5 }, NOW)).toBe(64.5);
  });

  it("an empty advance adds nothing; the balance, not the original amount, counts", () => {
    expect(advanceRemaining({ balance: 0 })).toBe(0);
    expect(advanceRemaining({ balance: "40.00" })).toBe(40);
  });

  it("sums to the cent with no float drift", () => {
    const credit = sumAvailableCredit({
      notes: [
        { amount: 0.3, amountUsed: 0.1 },
        { amount: 0.2, amountUsed: 0 },
      ],
      advances: [{ balance: 0.1 }, { balance: 0.2 }],
      now: NOW,
    });
    expect(credit).toEqual({ notes: 0.4, advances: 0.3, total: 0.7 });
  });
});
