import type { PrismaService } from "../prisma/prisma.service";
import { emailPaidBasis } from "../invoices/invoice-email-payload";
import { deriveInvoiceDetailFields } from "../invoices/invoice-detail-read";
import {
  accountBlockApplies,
  accountBlockRows,
  readInvoiceAccountBalance,
  type AccountModel,
  type InvoiceAccountBalance,
} from "./invoice-account-balance";

/**
 * SA-1197 (decision 2026-11-20): the invoice account block. Each case names the wrong value it was seen red on.
 * The fake tenant client answers the open-set read the way the database would for the where it is handed: it drops
 * the row whose id the where excludes, and it records every read so C8 (no read when nothing can show) is provable.
 */

type Row = {
  id: string;
  customerId: string;
  total: number;
  status: string;
  dueDate: Date | null;
  issueDate?: Date;
  payments: { amount: number; status: string }[];
};

function fakePrisma(rows: Row[], zone: string | null = "America/Chicago") {
  const reads: { model: string; args: any }[] = [];
  const invoice = {
    findMany: jest.fn(async (args: any) => {
      reads.push({ model: "invoice", args });
      const notId = args?.where?.id?.not;
      // honour a date filter too, so a date-filtered "previous" (O1, vetoed) is seen red, not silently passed
      const lte = args?.where?.issueDate?.lte;
      return rows.filter(
        (r) =>
          r.customerId === args.where.customerId &&
          r.id !== notId &&
          (!lte || !r.issueDate || r.issueDate <= lte),
      );
    }),
  };
  const untouched = (model: string) =>
    new Proxy(
      {},
      {
        get: () => async (args: any) => {
          reads.push({ model, args });
          return [];
        },
      },
    );
  const tenant = new Proxy({} as Record<string, unknown>, {
    get: (_t, name: string) => (name === "invoice" ? invoice : untouched(name)),
  });
  const prisma = {
    forTenant: () => tenant,
    getTenantId: () => "tenant-1",
    tenantConfig: { findUnique: async () => ({ timezone: zone }) },
  } as unknown as PrismaService;
  return { prisma, reads, invoice };
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-20T18:00:00.000Z");

function model(over: Partial<AccountModel> = {}): AccountModel {
  return {
    id: "inv-a",
    customerId: "cust-1",
    status: "SENT",
    total: 50,
    dueDate: new Date(NOW.getTime() + 10 * DAY),
    createdAt: new Date(NOW.getTime() - 5 * DAY),
    payments: [],
    order: null,
    customer: { isWalkIn: null },
    ...over,
  };
}

const open = (id: string, total: number, over: Partial<Row> = {}): Row => ({
  id,
  customerId: "cust-1",
  total,
  status: "SENT",
  dueDate: null,
  payments: [],
  ...over,
});

const ON = { showAccountBalance: true };
const shown = (r: InvoiceAccountBalance) => {
  if (!r.show) throw new Error("expected the block to show");
  return r;
};

describe("readInvoiceAccountBalance: the statement's basis, added never subtracted (SA-1197)", () => {
  it("T1: a reprint of an older invoice counts the newer one (red on a date-filtered 50 -> 80.00)", async () => {
    const later = new Date(NOW.getTime() + 2 * DAY);
    const { prisma } = fakePrisma([open("inv-a", 50), open("inv-b", 30, { issueDate: later })]);
    const r = shown(await readInvoiceAccountBalance(prisma, model(), ON, NOW));
    expect(r.others).toBe(30);
    expect(r.thisInvoice).toBe(50);
    expect(r.openBalance).toBe(80);
  });

  it("T2: this invoice comes from the printed model, never a second read (red on 100 / 130 / others 70 -> 60, 30, 90)", async () => {
    // The live row of this invoice still says 100 owed; the send snapshot (after the dry-run credit) says 60.
    const { prisma, invoice } = fakePrisma([open("inv-a", 100), open("inv-b", 30)]);
    const snapshot = model({
      total: 100,
      payments: [{ amount: 40, status: "PAID", createdAt: NOW }],
    });
    const r = shown(await readInvoiceAccountBalance(prisma, snapshot, ON, NOW));
    expect(r.thisInvoice).toBe(60);
    expect(r.others).toBe(30);
    expect(r.openBalance).toBe(90);
    expect(invoice.findMany).toHaveBeenCalledTimes(1);
    const where = invoice.findMany.mock.calls[0][0].where;
    expect(where.id).toEqual({ not: "inv-a" });
    expect(where.customerId).toBe("cust-1");
  });

  it("T4: an overpaid invoice counts 0 and never nets the others down (red on 20.00 -> 30.00)", async () => {
    const { prisma } = fakePrisma([open("inv-b", 30)]);
    const overpaid = model({ total: 50, payments: [{ amount: 60, status: "PAID" }] });
    const r = shown(await readInvoiceAccountBalance(prisma, overpaid, ON, NOW));
    expect(r.thisInvoice).toBe(0);
    expect(r.openBalance).toBe(30);
  });

  it("T4b: an overpaid OTHER invoice counts 0 too (red on 40 -> 50)", async () => {
    const { prisma } = fakePrisma([
      open("inv-b", 30),
      open("inv-c", 10, { payments: [{ amount: 20, status: "PAID" }] }),
    ]);
    const r = shown(await readInvoiceAccountBalance(prisma, model({ total: 20 }), ON, NOW));
    expect(r.others).toBe(30);
    expect(r.openBalance).toBe(50);
  });

  it("T5: unapplied credit notes and advances are never read or netted", async () => {
    const { prisma, reads } = fakePrisma([open("inv-b", 30)]);
    const r = shown(await readInvoiceAccountBalance(prisma, model(), ON, NOW));
    expect(r.openBalance).toBe(80);
    expect(reads.map((x) => x.model)).toEqual(["invoice"]);
  });

  it("T6: a PENDING or DRAFT payment on another invoice leaves others unchanged", async () => {
    const { prisma } = fakePrisma([
      open("inv-b", 30, {
        payments: [
          { amount: 30, status: "PENDING" },
          { amount: 30, status: "DRAFT" },
        ],
      }),
    ]);
    const r = shown(await readInvoiceAccountBalance(prisma, model(), ON, NOW));
    expect(r.others).toBe(30);
  });

  it("T8: one open invoice only -> nothing to show, in both forms", async () => {
    const { prisma } = fakePrisma([open("inv-a", 50)]);
    const r = await readInvoiceAccountBalance(prisma, model(), ON, NOW);
    expect(r).toEqual({ show: false });
    expect(accountBlockRows(r, { hideBalanceDue: false })).toEqual([]);
    expect(accountBlockRows(r, { hideBalanceDue: true })).toEqual([]);
  });

  it("T8b: others that round to 0 show nothing", async () => {
    const { prisma } = fakePrisma([open("inv-b", 0.004)]);
    expect(await readInvoiceAccountBalance(prisma, model(), ON, NOW)).toEqual({ show: false });
  });

  it("T14: a non-receivable DRAFT being sent counts once as This invoice; this invoice is never in others", async () => {
    const { prisma } = fakePrisma([open("inv-a", 50, { status: "DRAFT" }), open("inv-b", 30)]);
    const r = shown(await readInvoiceAccountBalance(prisma, model({ status: "DRAFT" }), ON, NOW));
    expect(r.thisInvoice).toBe(50);
    expect(r.others).toBe(30);
    expect(r.openBalance).toBe(80);
  });

  it("T19: a render at 23:30 in the tenant's zone carries that zone's date (red on the UTC day)", async () => {
    // 23:30 in Chicago on Nov 20 is 05:30Z on Nov 21.
    const late = new Date("2026-11-21T05:30:00.000Z");
    const { prisma } = fakePrisma([open("inv-b", 30)]);
    const r = shown(await readInvoiceAccountBalance(prisma, model(), ON, late));
    expect(r.asOf).toBe("2026-11-20");
    const full = accountBlockRows(r, { hideBalanceDue: false });
    const one = accountBlockRows(r, { hideBalanceDue: true });
    expect(full[0].label).toBe("Your account on Nov 20, 2026");
    expect(one[0].label).toBe("Open balance on Nov 20, 2026");
  });

  it("T20: float dust: others 0.10 + 0.20, this 0.30 -> open balance 0.60 exactly", async () => {
    const { prisma } = fakePrisma([open("inv-b", 0.1), open("inv-c", 0.2)]);
    const r = shown(await readInvoiceAccountBalance(prisma, model({ total: 0.3 }), ON, NOW));
    expect(r.others).toBe(0.3);
    expect(r.openBalance).toBe(0.6);
  });
});

describe("T16: This invoice equals the Balance Due the same page prints", () => {
  const cases: [string, Partial<AccountModel>][] = [
    ["partial", { total: 100, payments: [{ amount: 40, status: "PAID" }] }],
    ["paid later", { status: "PAID", total: 100, payments: [{ amount: 100, status: "PAID" }] }],
    ["overpaid", { total: 100, payments: [{ amount: 110, status: "PAID" }] }],
    [
      "credit applied",
      { total: 100, payments: [{ amount: 25, status: "PAID", method: "CREDIT_NOTE" } as never] },
    ],
  ];
  it.each(cases)("%s", async (_name, over) => {
    const m = model(over);
    const { prisma } = fakePrisma([open("inv-b", 30)]);
    const r = shown(await readInvoiceAccountBalance(prisma, m, ON, NOW));
    // the email (and the PDF, the same confirmed basis clamped at 0) and the detail payload
    expect(r.thisInvoice).toBe(emailPaidBasis(m as never).balanceDue);
    expect(r.thisInvoice).toBe(deriveInvoiceDetailFields(m, NOW, "America/Chicago").balanceDue);
  });
});

describe("accountBlockApplies: one predicate, fail closed (C6, C7)", () => {
  it("T18: switch off -> no block and zero reads", async () => {
    const { prisma, reads } = fakePrisma([open("inv-b", 30)]);
    const r = await readInvoiceAccountBalance(prisma, model(), { showAccountBalance: false }, NOW);
    expect(r).toEqual({ show: false });
    expect(reads).toEqual([]);
  });

  it("T9: the walk-in customer never carries the block, and is never read", async () => {
    const { prisma, reads } = fakePrisma([open("inv-b", 30)]);
    const walkIn = model({ customer: { isWalkIn: true } });
    expect(await readInvoiceAccountBalance(prisma, walkIn, ON, NOW)).toEqual({ show: false });
    expect(reads).toEqual([]);
  });

  it("T9b: a model without the isWalkIn key fails closed (red on 'shows')", () => {
    expect(accountBlockApplies(model({ customer: {} }), true)).toBe(false);
    expect(accountBlockApplies(model({ customer: { isWalkIn: false } }), true)).toBe(true);
    expect(accountBlockApplies(model({ customer: { isWalkIn: null } }), true)).toBe(true);
  });

  it("T10: paid at the counter, VOID, WRITTEN_OFF and no customer carry no block", () => {
    const at = new Date("2026-11-20T15:00:00.000Z");
    const till = model({
      status: "PAID",
      createdAt: at,
      order: { counterSale: true },
      payments: [{ amount: 50, status: "PAID", createdAt: at }],
    });
    expect(accountBlockApplies(till, true)).toBe(false);
    expect(accountBlockApplies(model({ status: "VOID" }), true)).toBe(false);
    expect(accountBlockApplies(model({ status: "WRITTEN_OFF" }), true)).toBe(false);
    expect(accountBlockApplies(model({ customerId: null }), true)).toBe(false);
    expect(accountBlockApplies(model({ customer: null }), true)).toBe(false);
    // A PAID on-account invoice (paid later, not at the till) still carries it.
    expect(accountBlockApplies(model({ status: "PAID" }), true)).toBe(true);
  });
});

describe("accountBlockRows: the one decision of what prints (C5)", () => {
  const result: InvoiceAccountBalance = {
    show: true,
    others: 30,
    thisInvoice: 50,
    openBalance: 80,
    asOf: "2026-11-20",
  };

  it("the full block: heading, others, this invoice, open balance", () => {
    expect(accountBlockRows(result, { hideBalanceDue: false })).toEqual([
      { kind: "heading", label: "Your account on Nov 20, 2026", amount: null },
      { kind: "others", label: "Other unpaid invoices", amount: 30 },
      { kind: "thisInvoice", label: "This invoice", amount: 50 },
      { kind: "openBalance", label: "Open balance", amount: 80 },
    ]);
  });

  it("T11: Balance Due hidden -> exactly one row, never this invoice's or the others' figure (red on a re-printed row)", () => {
    const rows = accountBlockRows(result, { hideBalanceDue: true });
    expect(rows).toEqual([
      { kind: "openBalanceOn", label: "Open balance on Nov 20, 2026", amount: 80 },
    ]);
    expect(rows.some((r) => r.kind === "thisInvoice" || r.kind === "others")).toBe(false);
  });

  it("T15: no label carries Total, Amount due or a second Balance due", () => {
    for (const hide of [false, true]) {
      for (const row of accountBlockRows(result, { hideBalanceDue: hide })) {
        expect(row.label).not.toMatch(/total|amount due|balance due/i);
      }
    }
  });
});
