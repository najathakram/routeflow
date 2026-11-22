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
import { toBuyerStatement } from "../buyer/buyer-statement-view";
import { buildAccountStatement } from "./account-statement";
import { buildMyStatement, buildOperatorStatement } from "./customer-statement";
import {
  advanceRemaining,
  creditNoteRemaining,
  isAdvanceAvailable,
  loadAvailableCreditByCustomer,
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
  sourcePaymentId?: string | null;
};
type SourceRow = { id: string; tenantId: string; status: string };

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
      .filter((r) =>
        w.customerId === undefined
          ? true
          : w.customerId.in
            ? w.customerId.in.includes(r.customerId)
            : r.customerId === w.customerId,
      )
      .filter((r: any) => !w.status?.not || r.status !== w.status.not)
      .filter((r: any) => !w.balance?.gt || Number(r.balance) > w.balance.gt);
  });
}

/** The status read of an advance's source payments: `where.id.in`, tenant-scoped; any other payment read is empty. */
function sourceReader(sources: SourceRow[]) {
  return jest.fn(async (args: any) => {
    const ids: string[] | undefined = args?.where?.id?.in;
    if (!ids) return [];
    return sources.filter((r) => r.tenantId === TENANT).filter((r) => ids.includes(r.id));
  });
}

/**
 * The tenant client (`forTenant()`) sees only this tenant's rows, as the real extension does; the BARE client sees
 * every tenant's rows, so a read that drops `forTenant()` pulls the other tenant's credit in and goes red.
 */
function arrange(rows: { notes: CreditRow[]; advances: AdvanceRow[]; sources?: SourceRow[] }) {
  const prisma: any = createMockPrisma();
  const unscopedAll = (list: any[]) => jest.fn(async () => list);
  const tenantDb: any = {
    ...prisma.forTenant(),
    creditNote: { findMany: scoped(rows.notes) },
    advancePayment: { findMany: scoped(rows.advances) },
    // every other payment read falls through to the shared mock; only the `id in` source read is scoped here
    invoicePayment: new Proxy({ findMany: sourceReader(rows.sources ?? []) } as any, {
      get: (t, k) => (k in t ? t[k] : (prisma.invoicePayment as any)[k]),
    }),
  };
  prisma.creditNote.findMany = unscopedAll(rows.notes) as any;
  prisma.advancePayment.findMany = unscopedAll(rows.advances) as any;
  prisma.forTenant = jest.fn().mockReturnValue(tenantDb);
  prisma.__tenantDb = tenantDb;
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
    expect(credit).toMatchObject({ notes: 300, advances: 200, total: 500 });
    expect(tenantCall(prisma, "creditNote").where.customerId).toBe(CUSTOMER);
    expect(tenantCall(prisma, "advancePayment").where.customerId).toBe(CUSTOMER);
  });
});

function tenantCall(prisma: any, model: string) {
  return (prisma.__tenantDb[model].findMany as jest.Mock).mock.calls[0][0];
}

describe("SA-1208 D7: the helper's rules", () => {
  it("a note expiring exactly now is excluded (<=), one a millisecond later counts", () => {
    expect(creditNoteRemaining({ amount: 100, amountUsed: 0, expiresAt: NOW }, NOW)).toBe(0);
    const later = new Date(NOW.getTime() + 1);
    expect(creditNoteRemaining({ amount: 100, amountUsed: 0, expiresAt: later }, NOW)).toBe(100);
  });

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
    expect(credit).toMatchObject({ notes: 0.4, advances: 0.3, total: 0.7 });
  });
});

const ADV_SOURCE = "pay-src-1";
const advWithSource = (status: string) => ({
  notes: [] as CreditRow[],
  advances: [advance({ balance: 200, sourcePaymentId: ADV_SOURCE, reference: "CHK-9999" })],
  sources: [{ id: ADV_SOURCE, tenantId: TENANT, status }],
});

describe("SA-1214 D7': the buyer route's credit tile and list", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
  });
  afterEach(() => jest.useRealTimers());

  const buyerView = async (rows: Parameters<typeof arrange>[0]) =>
    toBuyerStatement(await buildOperatorStatement(arrange(rows) as any, CUSTOMER)) as any;

  it("an advance-only $200 buyer: tile $200.00 and one row, no reference", async () => {
    const view = await buyerView({
      notes: [],
      advances: [advance({ balance: 200, reference: "CHK-9999", method: "CHECK" })],
    });
    expect(view.availableCredit).toBe(200);
    expect(view.creditItems).toHaveLength(1);
    expect(view.creditItems[0]).toMatchObject({ kind: "ADVANCE", remaining: 200 });
    expect(view.creditItems[0].description).toBe("Credit from payment, 2026-10-02");
    expect(JSON.stringify(view.creditItems)).not.toMatch(/CHK-9999|CHECK/);
  });

  it("a $300 note plus a $200 advance: tile $500, two rows summing to the tile; staff still [300, 200]", async () => {
    const view = await buyerView(NOTE_300_ADVANCE_200);
    expect(view.availableCredit).toBe(500);
    expect(view.creditItems).toHaveLength(2);
    expect(view.creditItemsTruncated).toBe(false);
    const sum = view.creditItems.reduce((n: number, i: any) => n + i.remaining, 0);
    expect(sum).toBe(view.availableCredit);
    expect(view.creditTotal).toBeUndefined();
    const staff = await buildOperatorStatement(arrange(NOTE_300_ADVANCE_200) as any, CUSTOMER);
    expect([staff.availableCredit, staff.advanceBalance, staff.creditTotal]).toEqual([
      300, 200, 500,
    ]);
  });

  it("a partly used advance counts its balance, not its amount", async () => {
    const view = await buyerView({
      notes: [],
      advances: [{ ...advance({ balance: 200 }), amount: 500 }],
    });
    expect([view.availableCredit, view.creditItems[0].remaining]).toEqual([200, 200]);
  });

  it("the list is capped at 50 newest first and says so", async () => {
    const many = Array.from({ length: 52 }, (_, i) =>
      advance({ id: `adv-n${i}`, balance: 1, receivedAt: new Date(Date.UTC(2026, 0, 1 + i)) }),
    );
    const view = await buyerView({ notes: [], advances: many });
    expect(view.creditItems).toHaveLength(50);
    expect(view.creditItemsTruncated).toBe(true);
    expect(view.availableCredit).toBe(52);
    expect(view.creditItems[0].id).toBe("adv-n51");
  });

  it("another customer's or tenant's credit never reaches the staff or buyer statement", async () => {
    const world = {
      notes: [note({ amount: 300 }), note({ amount: 999, customerId: OTHER_CUSTOMER })],
      advances: [
        advance({ balance: 200 }),
        advance({ balance: 777, customerId: OTHER_CUSTOMER }),
        advance({ balance: 666, tenantId: OTHER_TENANT }),
      ],
    };
    const staff = await buildOperatorStatement(arrange(world) as any, CUSTOMER);
    expect([staff.availableCredit, staff.advanceBalance]).toEqual([300, 200]);
    expect((await buyerView(world)).availableCredit).toBe(500);
  });

  it("the credit reads run on forTenant(), never the bare client", async () => {
    const world = {
      notes: [note({ amount: 300 }), note({ amount: 888, tenantId: OTHER_TENANT })],
      advances: [advance({ balance: 200 }), advance({ balance: 666, tenantId: OTHER_TENANT })],
    };
    expect((await buyerView(world)).availableCredit).toBe(500);
  });
});

describe("B839 read half: an advance counts only with no source or a PAID source", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
  });
  afterEach(() => jest.useRealTimers());

  const accountOf = (rows: Parameters<typeof arrange>[0]) =>
    buildAccountStatement(
      arrange(rows) as any,
      { id: CUSTOMER, businessName: "Acme Corp" },
      { staff: false, now: NOW },
    );

  it("the predicate", () => {
    expect(isAdvanceAvailable({ balance: 1 }, undefined)).toBe(true);
    expect(isAdvanceAvailable({ balance: 1, sourcePaymentId: "p" }, "PAID")).toBe(true);
    for (const st of ["DRAFT", "PENDING", "VOID", undefined]) {
      expect(isAdvanceAvailable({ balance: 1, sourcePaymentId: "p" }, st)).toBe(false);
    }
  });

  it("a PAID source counts on the tile, the list, the monthly PDF and the account statement", async () => {
    const rows = advWithSource("PAID");
    const op = await buildOperatorStatement(arrange(rows) as any, CUSTOMER);
    const view = toBuyerStatement(op) as any;
    expect([view.availableCredit, view.creditItems.length]).toEqual([200, 1]);
    expect((await monthly(arrange(rows))).availableCredit).toBe(200);
    const acct = await accountOf(rows);
    expect([acct.creditAvailable, acct.credits.length]).toEqual([200, 1]);
  });

  it("an advance with no source counts", async () => {
    const op = await buildOperatorStatement(
      arrange({ notes: [], advances: [advance({ balance: 200 })] }) as any,
      CUSTOMER,
    );
    expect(op.advanceBalance).toBe(200);
  });

  it.each(["DRAFT", "PENDING", "VOID"])(
    "a %s source is excluded from the tile, the list, the monthly PDF and the account statement",
    async (status) => {
      const rows = advWithSource(status);
      const op = await buildOperatorStatement(arrange(rows) as any, CUSTOMER);
      const view = toBuyerStatement(op) as any;
      expect([view.availableCredit, view.creditItems.length]).toEqual([0, 0]);
      expect([op.availableCredit, op.advanceBalance]).toEqual([0, 0]);
      expect((await monthly(arrange(rows))).availableCredit).toBe(0);
      const acct = await accountOf(rows);
      expect([acct.creditAvailable, acct.credits.length]).toEqual([0, 0]);
    },
  );

  it("the source statuses cost ONE extra read, tenant-scoped, by id", async () => {
    const prisma = arrange(advWithSource("PAID"));
    await loadAvailableCredit(prisma.forTenant() as any, CUSTOMER, NOW);
    const reads = (prisma.__tenantDb.invoicePayment.findMany as jest.Mock).mock.calls;
    expect(reads).toHaveLength(1);
    expect(reads[0][0].where).toEqual({ id: { in: [ADV_SOURCE] } });
  });

  it("another tenant's payment with the same id cannot make an advance count", async () => {
    const rows = {
      ...advWithSource("PAID"),
      sources: [{ id: ADV_SOURCE, tenantId: OTHER_TENANT, status: "PAID" }],
    };
    const view = toBuyerStatement(await buildOperatorStatement(arrange(rows) as any, CUSTOMER));
    expect((view as any).availableCredit).toBe(0);
  });
});

describe("SA-1214 A1: the customers list and CSV read one batch helper", () => {
  const ids = Array.from({ length: 50 }, (_, i) => `cust-b${i}`);
  const world = () => ({
    notes: [
      note({ amount: 300, customerId: "cust-b0" }),
      note({ amount: 888, customerId: "cust-b0", tenantId: OTHER_TENANT }),
    ],
    advances: [
      advance({ balance: 200, customerId: "cust-b0", sourcePaymentId: "src-paid" }),
      advance({ id: "adv-void", balance: 90, customerId: "cust-b1", sourcePaymentId: "src-void" }),
      advance({ id: "adv-other", balance: 77, customerId: "cust-b2", tenantId: OTHER_TENANT }),
    ],
    sources: [
      { id: "src-paid", tenantId: TENANT, status: "PAID" },
      { id: "src-void", tenantId: TENANT, status: "VOID" },
    ],
  });

  it("$300 note + $200 advance (source PAID) reads Credit $500; VOID source and other tenants never count", async () => {
    const prisma = arrange(world());
    const byId = await loadAvailableCreditByCustomer(prisma.forTenant() as any, ids, NOW);
    expect(byId.get("cust-b0")).toEqual({ notes: 300, advances: 200, total: 500 });
    expect(byId.get("cust-b1")?.total).toBe(0);
    expect(byId.get("cust-b2")?.total).toBe(0);
    expect(byId.get("cust-b49")).toEqual({ notes: 0, advances: 0, total: 0 });
    expect(byId.size).toBe(50);
  });

  it("50 customers cost three reads (notes, advances, sources), never a read per customer", async () => {
    const prisma = arrange(world());
    await loadAvailableCreditByCustomer(prisma.forTenant() as any, ids, NOW);
    const t = prisma.__tenantDb;
    expect([
      (t.creditNote.findMany as jest.Mock).mock.calls.length,
      (t.advancePayment.findMany as jest.Mock).mock.calls.length,
      (t.invoicePayment.findMany as jest.Mock).mock.calls.length,
    ]).toEqual([1, 1, 1]);
  });
});

describe("SA-1214 A1: the account statement keeps credit on its own row", () => {
  const OPEN = {
    id: "inv-a",
    invoiceNumber: "INV-A",
    total: 1000,
    status: "SENT",
    issueDate: new Date("2026-09-01T00:00:00.000Z"),
    dueDate: new Date("2099-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    expectedPaymentMethod: null,
    payments: [],
  };
  const stmt = async (rows: Parameters<typeof arrange>[0], staff: boolean) => {
    const prisma = arrange(rows);
    prisma.invoice.findMany.mockResolvedValue([OPEN]);
    return buildAccountStatement(
      prisma as any,
      { id: CUSTOMER, businessName: "Acme Corp" },
      { staff, now: NOW },
    );
  };

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
  });
  afterEach(() => jest.useRealTimers());

  it("$1,000 open with $500 credit: open $1,000, credit $500, after credit $500; adding a note leaves openBalance alone", async () => {
    const a = await stmt(
      { notes: [note({ amount: 300 })], advances: [advance({ balance: 200 })] },
      false,
    );
    expect([a.openBalance, a.creditAvailable, a.afterCredit]).toEqual([1000, 500, 500]);
    const b = await stmt(
      {
        notes: [note({ amount: 300 }), note({ amount: 100, id: "cn-extra" })],
        advances: [advance({ balance: 200 })],
      },
      false,
    );
    expect([b.openBalance, b.creditAvailable, b.afterCredit]).toEqual([1000, 600, 400]);
  });

  it("the buyer's advance row has no reference and reads 'Credit from payment'; staff keep the reference", async () => {
    const rows = { notes: [], advances: [advance({ balance: 200, reference: "CHK-9999" })] };
    const buyer = await stmt(rows, false);
    expect(buyer.credits[0]).toMatchObject({
      kind: "ADVANCE",
      number: null,
      label: "Credit from payment",
    });
    expect(JSON.stringify(buyer.credits)).not.toMatch(/CHK-9999/);
    const staff = await stmt(rows, true);
    expect(staff.credits[0]).toMatchObject({ number: "CHK-9999" });
    expect(staff.credits[0].label).toBeUndefined();
  });
});

describe("SA-1221 M1 / SA-1225: same-tenant gone source, ledger status, batch grouping, buyer ledger text", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
  });
  afterEach(() => jest.useRealTimers());

  it("an advance whose source row was deleted (same tenant) is hidden: $0.00 on the tile and the list", async () => {
    const rows = { ...advWithSource("PAID"), sources: [] as SourceRow[] };
    const op = await buildOperatorStatement(arrange(rows) as any, CUSTOMER);
    const view = toBuyerStatement(op) as any;
    expect([view.availableCredit, view.creditItems.length, op.advanceBalance]).toEqual([0, 0, 0]);
  });

  it("MED-1: a $200 advance from a DRAFT source reads NOT_CONFIRMED on the ledger row, beside a $0 tile", async () => {
    const op = await buildOperatorStatement(arrange(advWithSource("DRAFT")) as any, CUSTOMER);
    expect(op.advanceBalance).toBe(0);
    expect(op.transactions.find((t) => t.type === "ADVANCE_PAYMENT")?.status).toBe("NOT_CONFIRMED");
  });

  it("MED-1: a PAID source reads AVAILABLE, no source reads AVAILABLE, an empty advance reads USED", async () => {
    const paid = await buildOperatorStatement(arrange(advWithSource("PAID")) as any, CUSTOMER);
    expect(paid.transactions.find((t) => t.type === "ADVANCE_PAYMENT")?.status).toBe("AVAILABLE");
    const none = await buildOperatorStatement(
      arrange({ notes: [], advances: [advance({ balance: 50 })] }) as any,
      CUSTOMER,
    );
    expect(none.transactions[0].status).toBe("AVAILABLE");
    const used = await buildOperatorStatement(
      arrange({ notes: [], advances: [advance({ balance: 0, amount: 50 })] }) as any,
      CUSTOMER,
    );
    expect(used.transactions[0].status).toBe("USED");
  });

  it("MED-2: the batch helper never filters all rows per customer, and 20,000 customers finish under 1 s", async () => {
    jest.useRealTimers(); // the wall clock is the point here
    const N = 20000;
    const ids = Array.from({ length: N }, (_, i) => `cust-p${i}`);
    const filterSpies: jest.Mock[] = [];
    const rowsOf = <T>(list: T[]) => {
      const arr: any = list;
      const spy = jest.fn(arr.filter.bind(arr));
      arr.filter = spy;
      filterSpies.push(spy);
      return arr as T[];
    };
    const db: any = {
      creditNote: {
        findMany: async () =>
          rowsOf(
            ids.map((customerId) => ({
              customerId,
              amount: 10,
              amountUsed: 0,
              status: "ISSUED",
              expiresAt: null,
            })),
          ),
      },
      advancePayment: {
        findMany: async () => rowsOf(ids.map((customerId) => ({ customerId, balance: 5 }))),
      },
      invoicePayment: { findMany: async () => [] },
    };
    const t0 = Date.now();
    const out = await loadAvailableCreditByCustomer(db, ids, NOW);
    const ms = Date.now() - t0;
    expect(out.size).toBe(N);
    expect(out.get("cust-p19999")).toEqual({ notes: 10, advances: 5, total: 15 });
    expect(filterSpies.reduce((n, s) => n + s.mock.calls.length, 0)).toBe(0);
    expect(ms).toBeLessThan(1000);
    // eslint-disable-next-line no-console
    console.log(`MED-2 20,000-customer batch: ${ms} ms`);
  });
});
