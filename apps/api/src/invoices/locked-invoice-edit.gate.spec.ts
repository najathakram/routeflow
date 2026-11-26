import { ConflictException } from "@nestjs/common";
import { InvoiceStatus, UserRole } from "@prisma/client";
import { assertSalesNotLockedForEdit } from "../regulated/filing-lock";
import * as unitAware from "../orders/unit-aware-guard";
import {
  assertEditableUnderLock,
  assertModeUnderLock,
  editModeOf,
  invoiceEditRefusal,
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
 * SA-1508 commit 5 (gate). Red on master: `editModeOf`, `assertModeUnderLock` and `assertEditableUnderLock` do not exist
 * (master refuses every non-DRAFT save with a 400 at three sites). The money gates run ONLY for a money edit, and the
 * policy decides every refusal.
 */
const ADMIN = { sub: "u1", role: UserRole.TENANT_ADMIN } as any;
const OPERATOR = { sub: "u2", role: UserRole.OPERATOR } as any;
const SUPER = { sub: "u3", role: UserRole.SUPER_ADMIN } as any;
const T = "tenant-1";

const inv = (over: Record<string, any> = {}) => ({
  id: "inv-1",
  customerId: "c1",
  orderId: null,
  status: InvoiceStatus.SENT,
  total: 100,
  discount: 0,
  shippingFee: 0,
  issueDate: new Date("2026-11-01T00:00:00Z"),
  dueDate: new Date("2026-12-01T00:00:00Z"),
  depositPercent: null,
  depositDueDate: null,
  ...over,
});
const lockedOf = (over: Record<string, any> = {}, payments: any[] = []): LockedInvoiceForEdit => ({
  invoice: inv(over),
  storedRows: [{ id: "r1", unitLabel: null }],
  isTaxExempt: false,
  payments,
});
const ctx = (over: Partial<IssuedEditCtx> = {}): IssuedEditCtx => ({
  mode: "ISSUED",
  actor: ADMIN,
  tenantId: T,
  dto: {},
  due: { dueDate: null, depositDueDate: null },
  ...over,
});
const fakeTx = (over: { requests?: any[]; credits?: number; returns?: number } = {}): any => ({
  invoicePayment: { findMany: jest.fn().mockResolvedValue([]) },
  buyerPaymentRequest: { findMany: jest.fn().mockResolvedValue(over.requests ?? []) },
  creditNote: { count: jest.fn().mockResolvedValue(over.credits ?? 0) },
  returnItem: { count: jest.fn().mockResolvedValue(over.returns ?? 0) },
  order: { findUnique: jest.fn() },
});
const bodyOf = async (p: Promise<unknown>) => {
  const e: any = await p.then(
    () => null,
    (x) => x,
  );
  return e instanceof ConflictException ? e.getResponse() : e;
};
const modeBody = (fn: () => unknown) => bodyOf(Promise.resolve().then(fn));

beforeEach(() => jest.clearAllMocks());

describe("editModeOf: decided before the transaction", () => {
  it("a DRAFT is DRAFT for anyone (today's rule)", () => {
    expect(editModeOf({ status: InvoiceStatus.DRAFT }, OPERATOR, T)).toBe("DRAFT");
    expect(editModeOf({ status: InvoiceStatus.DRAFT }, undefined, null)).toBe("DRAFT");
  });

  it.each([InvoiceStatus.SENT, InvoiceStatus.VIEWED, InvoiceStatus.OVERDUE])(
    "an admin of the tenant editing a standalone %s invoice is ISSUED",
    (status) => {
      expect(editModeOf({ status }, ADMIN, T)).toBe("ISSUED");
    },
  );

  it.each([
    ["an operator", OPERATOR, T, InvoiceStatus.SENT, "NOT_ADMIN"],
    ["no caller", undefined, T, InvoiceStatus.SENT, "NOT_ADMIN"],
    ["a super admin", SUPER, T, InvoiceStatus.SENT, "NOT_ADMIN"],
    ["a tenant admin with no tenant context", ADMIN, null, InvoiceStatus.SENT, "NOT_ADMIN"],
    ["an admin on a VOID invoice", ADMIN, T, InvoiceStatus.VOID, "VOID"],
    ["an admin on a WRITTEN_OFF invoice", ADMIN, T, InvoiceStatus.WRITTEN_OFF, "WRITTEN_OFF"],
    ["an admin on a PAID invoice", ADMIN, T, InvoiceStatus.PAID, "PAID"],
    ["an admin on a PARTIAL invoice", ADMIN, T, InvoiceStatus.PARTIAL, "PAID"],
  ])("%s is refused 409 INVOICE_EDIT_REFUSED / %s", async (_n, actor, tenant, status, reason) => {
    const body = await modeBody(() => editModeOf({ status }, actor, tenant));
    expect(body).toMatchObject({ code: "INVOICE_EDIT_REFUSED", reason });
    expect(typeof body.message).toBe("string");
  });

  it("an order-linked issued invoice is refused ORDER_LINKED and names the order", async () => {
    const body = await modeBody(() =>
      editModeOf({ status: InvoiceStatus.SENT, orderId: "o1" }, ADMIN, T),
    );
    expect(body).toMatchObject({
      code: "INVOICE_EDIT_REFUSED",
      reason: "ORDER_LINKED",
      orderId: "o1",
    });
  });

  it("invoiceEditRefusal carries the plain words of the reason", () => {
    expect(invoiceEditRefusal({ reason: "NOT_ADMIN" }).getResponse()).toMatchObject({
      reason: "NOT_ADMIN",
      message: "Only an admin can change an invoice that was already sent.",
    });
  });
});

describe("assertModeUnderLock: r87 and the token", () => {
  it("DRAFT mode keeps the 400 'Only DRAFT' for an invoice that left DRAFT under the lock", () => {
    expect(() => assertModeUnderLock({ status: InvoiceStatus.SENT }, "DRAFT", undefined)).toThrow(
      "Only DRAFT invoices can be edited",
    );
    expect(() =>
      assertModeUnderLock({ status: InvoiceStatus.DRAFT }, "DRAFT", undefined),
    ).not.toThrow();
  });

  it("ISSUED mode on an invoice that went back to DRAFT is 409 INVOICE_CHANGED_CONCURRENTLY", async () => {
    const body = await modeBody(() =>
      assertModeUnderLock({ status: InvoiceStatus.DRAFT }, "ISSUED", "2026-11-26T00:00:00Z"),
    );
    expect(body).toMatchObject({ code: "INVOICE_CHANGED_CONCURRENTLY" });
  });

  it("an issued save with no expectedUpdatedAt is 409 INVOICE_STALE (no legacy grace)", async () => {
    const body = await modeBody(() =>
      assertModeUnderLock({ status: InvoiceStatus.SENT }, "ISSUED", undefined),
    );
    expect(body).toMatchObject({ code: "INVOICE_STALE" });
    expect(() => assertModeUnderLock({ status: InvoiceStatus.SENT }, "ISSUED", "t")).not.toThrow();
  });
});

describe("assertEditableUnderLock: money gates only for a money edit", () => {
  const pending = [{ status: "PENDING" }];
  const confirmed = [{ status: "PAID" }];

  it("DRAFT mode judges nothing here", async () => {
    const tx = fakeTx();
    await assertEditableUnderLock(
      tx,
      lockedOf({ status: InvoiceStatus.DRAFT }),
      ctx({ mode: "DRAFT" }),
      { money: true },
    );
    expect(tx.buyerPaymentRequest.findMany).not.toHaveBeenCalled();
    expect(assertSalesNotLockedForEdit).not.toHaveBeenCalled();
  });

  it("a figure-free save goes through with a payment waiting, and calls neither the filing lock nor the unit rewrite check", async () => {
    const tx = fakeTx();
    await assertEditableUnderLock(tx, lockedOf({}, pending), ctx(), { money: false });
    expect(tx.buyerPaymentRequest.findMany).not.toHaveBeenCalled(); // nothing to read: no money can move
    expect(assertSalesNotLockedForEdit).not.toHaveBeenCalled();
    expect(unitAware.assertInvoiceRewriteAllowed).not.toHaveBeenCalled();
  });

  it.each([
    ["a payment waiting", lockedOf({}, pending), {}, "PENDING_PAYMENT"],
    ["a confirmed payment", lockedOf({}, confirmed), {}, "PAID"],
    ["an open cash request", lockedOf(), { requests: [{ kind: "CASH" }] }, "PAYING_CASH"],
    ["an open card request", lockedOf(), { requests: [{ kind: "CARD" }] }, "PAYING_ONLINE"],
    ["a credit note", lockedOf(), { credits: 1 }, "CREDIT"],
    ["a return against a line", lockedOf(), { returns: 1 }, "CREDIT"],
  ])(
    "a money edit with %s is refused %s, nothing else called",
    async (_n, locked, over, reason) => {
      const body = await bodyOf(
        assertEditableUnderLock(fakeTx(over as any), locked, ctx(), { money: true, newTotal: 50 }),
      );
      expect(body).toMatchObject({ code: "INVOICE_EDIT_REFUSED", reason });
      expect(assertSalesNotLockedForEdit).not.toHaveBeenCalled();
    },
  );

  it("a money edit with a line sold by a unit is UNIT_LINE; a total of zero is ZERO_TOTAL", async () => {
    const unit = lockedOf();
    unit.storedRows = [{ id: "r1", unitLabel: "Case" }];
    expect(
      await bodyOf(assertEditableUnderLock(fakeTx(), unit, ctx(), { money: true, newTotal: 50 })),
    ).toMatchObject({ reason: "UNIT_LINE" });
    expect(
      await bodyOf(
        assertEditableUnderLock(fakeTx(), lockedOf(), ctx(), { money: true, newTotal: 0 }),
      ),
    ).toMatchObject({ reason: "ZERO_TOTAL" });
  });

  it("a clean money edit runs the filing lock and the unit-rewrite check on the transaction", async () => {
    const tx = fakeTx();
    await assertEditableUnderLock(tx, lockedOf(), ctx(), { money: true, newTotal: 50 });
    expect(assertSalesNotLockedForEdit).toHaveBeenCalledWith(tx, {
      tenantId: T,
      invoiceId: "inv-1",
    });
    expect(unitAware.assertInvoiceRewriteAllowed).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ id: "inv-1" }),
    );
  });

  it("the issue date and the deposit are refused even on a figure-free save, only when they change", async () => {
    const moved = ctx({ issueDate: new Date("2026-11-02T00:00:00Z") });
    expect(
      await bodyOf(assertEditableUnderLock(fakeTx(), lockedOf(), moved, { money: false })),
    ).toMatchObject({ reason: "ISSUE_DATE" });
    const same = ctx({ issueDate: new Date("2026-11-01T00:00:00Z") });
    await expect(
      assertEditableUnderLock(fakeTx(), lockedOf(), same, { money: false }),
    ).resolves.toBeUndefined();
    const dep = ctx({ dto: { depositPercent: 25 } });
    expect(
      await bodyOf(assertEditableUnderLock(fakeTx(), lockedOf(), dep, { money: false })),
    ).toMatchObject({ reason: "DEPOSIT" });
  });

  it("an operator never reaches the loader (NOT_ADMIN first)", async () => {
    const tx = fakeTx();
    const body = await bodyOf(
      assertEditableUnderLock(tx, lockedOf(), ctx({ actor: OPERATOR }), { money: false }),
    );
    expect(body).toMatchObject({ reason: "NOT_ADMIN" });
    expect(tx.buyerPaymentRequest.findMany).not.toHaveBeenCalled();
    expect(tx.creditNote.count).not.toHaveBeenCalled();
  });

  it("the locked status decides: an invoice paid since the pre-read is refused PAID even for a figure-free save", async () => {
    const body = await bodyOf(
      assertEditableUnderLock(fakeTx(), lockedOf({ status: InvoiceStatus.PAID }), ctx(), {
        money: false,
      }),
    );
    expect(body).toMatchObject({ reason: "PAID" });
  });
});
