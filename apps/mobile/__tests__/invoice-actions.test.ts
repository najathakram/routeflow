/**
 * Gating for the mobile invoice actions ported from web (Wave 3):
 * write-off eligibility and payment editability. Wave 2 adds the detail-screen
 * action flags (edit/reminder/duplicate/reopen/unvoid/revert/apply-credit) and
 * the pending-order-mirror edit block — all mirrors of server guards.
 */
import {
  canWriteOff,
  invoiceActionFlags,
  isPaymentEditable,
  isPendingOrderMirror,
} from "../lib/invoices-logic";

describe("canWriteOff", () => {
  it("allows only unpaid-but-live statuses", () => {
    for (const s of ["SENT", "VIEWED", "PARTIAL", "OVERDUE"] as const) {
      expect(canWriteOff(s)).toBe(true);
    }
  });
  it("blocks draft/paid/void/written-off", () => {
    for (const s of ["DRAFT", "PAID", "VOID", "WRITTEN_OFF"] as const) {
      expect(canWriteOff(s)).toBe(false);
    }
  });
});

describe("isPaymentEditable", () => {
  it("allows a normal cash payment on a live invoice", () => {
    expect(isPaymentEditable("CASH", "PAID", "PARTIAL")).toBe(true);
  });
  it("blocks Advance / Credit-Note source draws (server rejects them)", () => {
    expect(isPaymentEditable("ADVANCE", "PAID", "PARTIAL")).toBe(false);
    expect(isPaymentEditable("CREDIT_NOTE", "PAID", "PARTIAL")).toBe(false);
  });
  it("blocks a voided payment", () => {
    expect(isPaymentEditable("CASH", "VOID", "PARTIAL")).toBe(false);
  });
  it("blocks edits on terminal invoice states", () => {
    expect(isPaymentEditable("CASH", "PAID", "VOID")).toBe(false);
    expect(isPaymentEditable("CASH", "PAID", "WRITTEN_OFF")).toBe(false);
    expect(isPaymentEditable("CASH", "PAID", "PAID")).toBe(false);
  });
});

describe("invoiceActionFlags", () => {
  const base = { paymentCount: 0, isOrderLinked: false };

  it("DRAFT → edit + duplicate + apply-credit only", () => {
    expect(invoiceActionFlags({ ...base, status: "DRAFT" })).toEqual({
      canEdit: true,
      canSendReminder: false,
      canDuplicate: true,
      canReopen: false,
      canUnvoid: false,
      canRevertToDraft: false,
      canApplyCredit: true,
    });
  });

  it.each(["SENT", "VIEWED", "OVERDUE"])("%s → reminder + revert (no payments)", (status) => {
    const f = invoiceActionFlags({ ...base, status });
    expect(f.canSendReminder).toBe(true);
    expect(f.canRevertToDraft).toBe(true);
    expect(f.canEdit).toBe(false);
    expect(f.canApplyCredit).toBe(true);
  });

  it("PARTIAL → reminder yes, revert no (partial implies payments anyway)", () => {
    const f = invoiceActionFlags({ ...base, status: "PARTIAL", paymentCount: 1 });
    expect(f.canSendReminder).toBe(true);
    expect(f.canRevertToDraft).toBe(false);
  });

  it("ANY payment row blocks revert — even a fully-voided history (server counts unfiltered)", () => {
    expect(invoiceActionFlags({ ...base, status: "SENT", paymentCount: 1 }).canRevertToDraft).toBe(
      false,
    );
  });

  it("PAID → reopen only; no reminder, no credit", () => {
    const f = invoiceActionFlags({ ...base, status: "PAID" });
    expect(f).toMatchObject({
      canReopen: true,
      canSendReminder: false,
      canApplyCredit: false,
      canRevertToDraft: false,
    });
  });

  it("VOID → unvoid only; WRITTEN_OFF → nothing money-side", () => {
    const v = invoiceActionFlags({ ...base, status: "VOID" });
    expect(v).toMatchObject({ canUnvoid: true, canApplyCredit: false, canSendReminder: false });
    const w = invoiceActionFlags({ ...base, status: "WRITTEN_OFF" });
    expect(w).toMatchObject({ canUnvoid: false, canApplyCredit: false, canSendReminder: false });
  });

  it("order-linked blocks duplicate on every status (RF-011)", () => {
    for (const status of ["DRAFT", "SENT", "PAID", "VOID"]) {
      expect(invoiceActionFlags({ ...base, status, isOrderLinked: true }).canDuplicate).toBe(false);
    }
  });
});

describe("isPendingOrderMirror", () => {
  it("standalone invoice is never a mirror", () => {
    expect(isPendingOrderMirror({ orderId: null })).toBe(false);
    expect(isPendingOrderMirror({})).toBe(false);
  });

  it("order-linked + no batch + undelivered order → pending mirror (server blocks edit/send)", () => {
    expect(
      isPendingOrderMirror({ orderId: "o1", deliveryBatchId: null, orderStatus: "CONFIRMED" }),
    ).toBe(true);
    expect(
      isPendingOrderMirror({ orderId: "o1", deliveryBatchId: null, orderStatus: undefined }),
    ).toBe(true);
  });

  it("delivered (or partially delivered) order unlocks the invoice", () => {
    for (const orderStatus of ["DELIVERED", "PARTIALLY_DELIVERED"]) {
      expect(isPendingOrderMirror({ orderId: "o1", deliveryBatchId: null, orderStatus })).toBe(
        false,
      );
    }
  });

  it("a delivery-batch invoice is never a pending mirror", () => {
    expect(
      isPendingOrderMirror({ orderId: "o1", deliveryBatchId: "b1", orderStatus: "CONFIRMED" }),
    ).toBe(false);
  });
});
