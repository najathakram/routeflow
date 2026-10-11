/**
 * Gating for the mobile invoice actions ported from web (Wave 3):
 * write-off eligibility and payment editability. Wave 2 adds the detail-screen
 * action flags (edit/reminder/duplicate/reopen/unvoid/revert/apply-credit) and
 * the pending-order-mirror edit block — all mirrors of server guards.
 */
import {
  canSendInvoiceNow,
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
  // balanceDue: the reminder tile needs a known balance (row 318d); the rest of the flags ignore it.
  const base = { paymentCount: 0, isOrderLinked: false, balanceDue: 100 };

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

  // Row 318d (SA-770): a reminder demands money, so it needs a balance, like the web `canSendReminder` and the
  // API's REMINDER_NO_BALANCE_DUE refusal. An exactly-paid or overpaid invoice (P-3 keeps it out of PAID) and an
  // unknown balance hide the tile instead of earning a guaranteed error toast.
  describe("canSendReminder needs a balance due", () => {
    it.each(["SENT", "VIEWED", "PARTIAL", "OVERDUE"])("%s with a balance → yes", (status) => {
      expect(invoiceActionFlags({ ...base, status, balanceDue: 5 }).canSendReminder).toBe(true);
    });
    it.each([0, -3, "0", "0.00"])("an open invoice with balanceDue %p → no", (balanceDue) => {
      expect(invoiceActionFlags({ ...base, status: "SENT", balanceDue }).canSendReminder).toBe(
        false,
      );
    });
    it("a numeric-string balance from the API still counts", () => {
      expect(
        invoiceActionFlags({ ...base, status: "OVERDUE", balanceDue: "12.50" }).canSendReminder,
      ).toBe(true);
    });
    it.each([undefined, null, "n/a", Number.NaN, Infinity, "Infinity"])(
      "an unknown balance %p → no",
      (balanceDue) => {
        expect(
          invoiceActionFlags({ ...base, status: "SENT", balanceDue: balanceDue as never })
            .canSendReminder,
        ).toBe(false);
      },
    );
    it.each(["DRAFT", "PAID", "VOID", "WRITTEN_OFF"])("%s never, even with a balance", (status) => {
      expect(invoiceActionFlags({ ...base, status, balanceDue: 100 }).canSendReminder).toBe(false);
    });
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

describe("canSendInvoiceNow", () => {
  it("allows sending a plain DRAFT", () => {
    expect(canSendInvoiceNow("DRAFT", false)).toBe(true);
  });

  it("blocks a DRAFT that is still a pending order mirror (the 400 this fixes)", () => {
    // assertOrderInvoiceUnlocked rejects the send until the order is delivered,
    // so DRAFT alone was never a sufficient gate.
    expect(canSendInvoiceNow("DRAFT", true)).toBe(false);
  });

  it("blocks every already-sent or terminal status", () => {
    for (const s of ["SENT", "VIEWED", "PARTIAL", "OVERDUE", "PAID", "VOID", "WRITTEN_OFF"]) {
      expect(canSendInvoiceNow(s, false)).toBe(false);
    }
  });

  it("leaves a mirrored draft with neither Send nor Edit offered", () => {
    // The screen renders Edit as `flags.canEdit && !pendingMirror`; Send now
    // carries the same mirror term instead of trusting DRAFT alone.
    const pendingMirror = true;
    const flags = invoiceActionFlags({
      status: "DRAFT",
      paymentCount: 0,
      isOrderLinked: true,
    });
    expect(flags.canEdit && !pendingMirror).toBe(false);
    expect(canSendInvoiceNow("DRAFT", pendingMirror)).toBe(false);
  });
});

describe("isPendingOrderMirror honours the server's pendingMirror flag", () => {
  const { isPendingOrderMirror } = require("../lib/invoices-logic");
  const base = { orderId: "o1", deliveryBatchId: null, orderStatus: "OUT_FOR_DELIVERY" };
  it("derives from the order status when the server sends no flag (unchanged)", () => {
    expect(isPendingOrderMirror(base)).toBe(true);
  });
  it("a shipped carrier order's draft is not a mirror when the server says so", () => {
    expect(isPendingOrderMirror({ ...base, pendingMirror: false })).toBe(false);
  });
  it("the server flag wins the other way too", () => {
    expect(isPendingOrderMirror({ ...base, orderStatus: "DELIVERED", pendingMirror: true })).toBe(
      true,
    );
  });
});
