import { ConflictException } from "@nestjs/common";
import { InvoiceStatus, UserRole } from "@prisma/client";
import {
  assertEditableUnderLock,
  guardEditTax,
  headerOnlyWrite,
  planHeaderOnlyTotals,
  type IssuedEditCtx,
  type LockedInvoiceForEdit,
} from "./locked-invoice-edit";

jest.mock("../regulated/filing-lock", () => ({
  assertSalesNotLockedForEdit: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../orders/unit-aware-guard", () => ({
  assertInvoiceRewriteAllowed: jest.fn().mockResolvedValue(undefined),
}));

/**
 * SA-1508 commit 6 (consent) through the gate. Red on master: `locked.recompute`, the consent 409 and `guardEditTax` do not
 * exist; master refuses a stale tax with INVOICE_TAX_STATE_STALE or re-taxes silently. Imported fixture: one line at 100.00,
 * file total 108.25, tax 0. Legacy fixture: three lines at 100.00 rate 0, stored tax 24.75, verified rate 0.0825.
 */
const ADMIN = { sub: "u1", role: UserRole.TENANT_ADMIN } as any;
const T = "tenant-1";
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  subtotal: 100,
  taxRate: 0,
  categoryTaxAmount: 0,
  unitLabel: null,
  ...over,
});
const base = (over: Record<string, any>): LockedInvoiceForEdit => ({
  invoice: {
    id: "inv-1",
    customerId: "c1",
    orderId: null,
    status: InvoiceStatus.SENT,
    discount: 0,
    shippingFee: 0,
    issueDate: new Date("2026-11-01T00:00:00Z"),
    dueDate: new Date("2026-12-01T00:00:00Z"),
    depositPercent: null,
    depositDueDate: null,
    ...over.invoice,
  },
  storedRows: over.rows,
  isTaxExempt: false,
  payments: [],
  recompute: over.recompute,
});
const IMPORTED = base({
  invoice: { subtotal: 100, taxAmount: 0, total: 108.25 },
  rows: [row("r1")],
  recompute: { state: "TOTAL_NOT_FROM_LINES", restampRate: null },
});
const LEGACY = base({
  invoice: { subtotal: 300, taxAmount: 24.75, total: 324.75 },
  rows: [row("a"), row("b"), row("c")],
  recompute: { state: "TAX_STALE", restampRate: 0.0825 },
});
const ctx = (over: Partial<IssuedEditCtx> = {}): IssuedEditCtx => ({
  mode: "ISSUED",
  actor: ADMIN,
  tenantId: T,
  dto: {},
  due: { dueDate: null, depositDueDate: null },
  ...over,
});
const fakeTx = (): any => ({
  buyerPaymentRequest: { findMany: jest.fn().mockResolvedValue([]) },
  creditNote: { count: jest.fn().mockResolvedValue(0) },
  returnItem: { count: jest.fn().mockResolvedValue(0) },
  order: { findUnique: jest.fn() },
});
const bodyOf = async (p: Promise<unknown>) => {
  const e: any = await p.then(
    () => null,
    (x) => x,
  );
  return e instanceof ConflictException ? e.getResponse() : e;
};

describe("assertEditableUnderLock: consent (A2-N1 rule 6)", () => {
  it("a money edit of an imported invoice is 409 INVOICE_EDIT_REFUSED / TOTAL_NOT_FROM_LINES with the figures, nothing judged after", async () => {
    const body = await bodyOf(
      assertEditableUnderLock(fakeTx(), IMPORTED, ctx(), {
        money: true,
        newTotal: 200,
        newTax: 0,
        lines: [{ rowId: "r1", untouched: false, data: { taxRate: 0 } as any }],
      }),
    );
    expect(body).toMatchObject({
      code: "INVOICE_EDIT_REFUSED",
      reason: "TOTAL_NOT_FROM_LINES",
      storedTotal: 108.25,
      newTotal: 200,
      difference: -91.75,
      storedTax: 0,
      newTax: 0,
      cause: "TOTAL_NOT_FROM_LINES",
    });
  });

  it("the echoed figures lift it: the save proceeds and the context says consented", async () => {
    const edit = ctx({ dto: { acceptLineTotal: { storedTotal: 108.25, newTotal: 200 } } });
    await expect(
      assertEditableUnderLock(fakeTx(), IMPORTED, edit, { money: true, newTotal: 200, newTax: 0 }),
    ).resolves.toBeUndefined();
    expect(edit.consented).toBe(true);
  });

  it("a stale echo is refused again with the FRESH figures", async () => {
    const body = await bodyOf(
      assertEditableUnderLock(
        fakeTx(),
        IMPORTED,
        ctx({ dto: { acceptLineTotal: { storedTotal: 108.25, newTotal: 150 } } }),
        { money: true, newTotal: 200, newTax: 0 },
      ),
    );
    expect(body).toMatchObject({ reason: "TOTAL_NOT_FROM_LINES", newTotal: 200 });
  });

  it("a figure-free save is never asked for consent, even on a stored total no line explains", async () => {
    const edit = ctx();
    await expect(
      assertEditableUnderLock(fakeTx(), IMPORTED, edit, { money: false }),
    ).resolves.toBeUndefined();
    expect(edit.consented).toBe(false);
  });

  it("money: false is never asked, even when the caller hands it written figures", async () => {
    await expect(
      assertEditableUnderLock(fakeTx(), IMPORTED, ctx(), {
        money: false,
        newTotal: 200,
        newTax: 0,
      }),
    ).resolves.toBeUndefined();
  });

  it("the policy's order holds: a payment waiting is PENDING_PAYMENT before the consent is asked", async () => {
    const withPayment = { ...IMPORTED, payments: [{ amount: 10, status: "PENDING" }] };
    const body = await bodyOf(
      assertEditableUnderLock(fakeTx(), withPayment, ctx(), {
        money: true,
        newTotal: 200,
        newTax: 0,
      }),
    );
    expect(body).toMatchObject({ reason: "PENDING_PAYMENT" });
    expect(body).not.toHaveProperty("storedTotal");
  });

  it("a verified rate on every written goods line is silent (SA-814 R5-2, kept); a rate-0 line left asks", async () => {
    const stamped = ["a", "b", "c"].map((id) => ({
      rowId: id,
      untouched: false,
      data: { taxRate: 0.0825 } as any,
    }));
    await expect(
      assertEditableUnderLock(fakeTx(), LEGACY, ctx(), {
        money: true,
        newTotal: 324.75,
        newTax: 24.75,
        lines: stamped,
      }),
    ).resolves.toBeUndefined();
    const left = [stamped[0], { ...stamped[1], data: { taxRate: 0 } as any }, stamped[2]];
    const body = await bodyOf(
      assertEditableUnderLock(fakeTx(), LEGACY, ctx(), {
        money: true,
        newTotal: 316.5,
        newTax: 16.5,
        lines: left,
      }),
    );
    expect(body).toMatchObject({
      reason: "TOTAL_NOT_FROM_LINES",
      cause: "OLDER_TAX",
      newTax: 16.5,
    });
  });
});

describe("guardEditTax", () => {
  const fixture = () => {
    const lines = ["a", "b", "c"].map((id) => ({
      rowId: id,
      untouched: true,
      data: { taxRate: 0 } as any,
    }));
    return {
      items: [{ taxRate: 0 }, { taxRate: 0 }, { taxRate: 0 }],
      matches: [],
      editLines: lines,
    };
  };

  it("ISSUED stamps the verified rate on the kept rate-0 lines, never refuses, never reads the tenant rate", async () => {
    const args = fixture();
    const tx = { systemConfig: { findFirst: jest.fn() } };
    await guardEditTax(tx, LEGACY, { mode: "ISSUED" }, args as any);
    expect(args.editLines.map((l) => l.data.taxRate)).toEqual([0.0825, 0.0825, 0.0825]);
    expect(tx.systemConfig.findFirst).not.toHaveBeenCalled();
  });

  it("ISSUED with a line the admin set to 5% keeps it and stamps the rest (no 'user set a rate' early return)", async () => {
    const args = fixture();
    args.editLines[0].data.taxRate = 0.05;
    await guardEditTax({}, LEGACY, { mode: "ISSUED" }, args as any);
    expect(args.editLines.map((l) => l.data.taxRate)).toEqual([0.05, 0.0825, 0.0825]);
  });

  it("DRAFT is master's guard: a stale tax with no verified rate is 409 INVOICE_TAX_STATE_STALE", async () => {
    const draft = base({
      invoice: {
        status: InvoiceStatus.DRAFT,
        subtotal: 100000,
        taxAmount: 8875.55,
        total: 108875.55,
      },
      rows: [row("a", { subtotal: 100000 })],
    });
    const args = {
      items: [{ taxRate: 0 }],
      matches: [{ row: draft.storedRows[0] }],
      editLines: [{ rowId: "a", untouched: true, data: { taxRate: 0 } as any }],
    };
    await expect(guardEditTax({}, draft, { mode: "DRAFT" }, args as any)).rejects.toMatchObject({
      response: { code: "INVOICE_TAX_STATE_STALE" },
    });
  });
});

describe("headerOnlyWrite (R-302 M1: what a header-only save writes)", () => {
  const stored150 = base({
    invoice: { subtotal: 150, taxAmount: 0, total: 150 },
    rows: [row("r1")],
    recompute: { state: "TOTAL_NOT_FROM_LINES", restampRate: null },
  });
  const write = (l: LockedInvoiceForEdit, dto: any, mode: "ISSUED" | "DRAFT") =>
    headerOnlyWrite({ notes: "n" }, planHeaderOnlyTotals(l, dto, mode), l, mode);

  it("a consented ISSUED save over an unreproducing invoice writes the line subtotal with the total and tax", () => {
    // stored subtotal 150, lines 100, discount 5: the header must read subtotal 100, total 95
    expect(write(stored150, { discount: 5 }, "ISSUED")).toEqual({
      notes: "n",
      discount: 5,
      shippingFee: 0,
      subtotal: 100,
      taxAmount: 0,
      total: 95,
    });
  });

  it("a stale-tax legacy invoice writes its line subtotal too", () => {
    expect(write(LEGACY, { shippingFee: 5 }, "ISSUED")).toMatchObject({
      subtotal: 300,
      total: 305,
    });
  });

  it("an invoice that reproduces, and a DRAFT, write no subtotal (master's shape)", () => {
    const ok = base({
      invoice: { subtotal: 100, taxAmount: 0, total: 100 },
      rows: [row("r1")],
      recompute: { state: "REPRODUCES", restampRate: null },
    });
    expect(write(ok, { discount: 10 }, "ISSUED")).not.toHaveProperty("subtotal");
    const draft = base({
      invoice: { subtotal: 100, taxAmount: 0, total: 100 },
      rows: [row("r1")],
      recompute: undefined,
    });
    expect(write(draft, { discount: 10 }, "DRAFT")).not.toHaveProperty("subtotal");
  });
});

describe("planHeaderOnlyTotals (header-only save)", () => {
  it("ISSUED on an imported invoice returns the line-based figures, not INVOICE_TAX_STATE_STALE", () => {
    expect(planHeaderOnlyTotals(IMPORTED, { discount: 10 }, "ISSUED")).toEqual({
      discount: 10,
      shippingFee: 0,
      subtotal: 100,
      taxAmount: 0,
      total: 90,
    });
  });

  it("ISSUED on a legacy invoice reads the rate-0 lines (L11: this save cannot stamp)", () => {
    expect(planHeaderOnlyTotals(LEGACY, { shippingFee: 5 }, "ISSUED")).toMatchObject({
      total: 305,
      taxAmount: 0,
      subtotal: 300,
    });
  });

  it("DRAFT keeps master's refusal for the same stale invoice", () => {
    expect(() => planHeaderOnlyTotals(LEGACY, { discount: 1 })).toThrow();
  });

  it("an ISSUED invoice that reproduces takes master's path (no taxAmount in the write)", () => {
    const ok = base({
      invoice: { subtotal: 100, taxAmount: 0, total: 100 },
      rows: [row("r1")],
      recompute: { state: "REPRODUCES", restampRate: null },
    });
    expect(planHeaderOnlyTotals(ok, { discount: 10 }, "ISSUED")).toEqual({
      discount: 10,
      shippingFee: 0,
      subtotal: 100,
      total: 90,
    });
  });
});
