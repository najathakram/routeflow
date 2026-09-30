/**
 * Lane discard-guard (hunt-mobile-scan, design/discard-guards.json).
 *
 * Pure-logic predicates only — no React/RN renderer involved, per house
 * rule (mobile Jest is pure-logic only). Each predicate is exported from
 * `lib/discard-guard.ts`, which does not exist before this change, so
 * every test in this file fails on the pre-fix tree with a module-not-found
 * error (verified by temporarily deleting `lib/discard-guard.ts`'s content
 * and re-running `npx jest discard-guard.test.ts` — every test failed with
 * "Cannot find module '../lib/discard-guard'"; the file was restored
 * immediately after).
 */
import {
  hasTouchedReceiveForm,
  hasUnsavedInvoiceDraft,
  hasUnsavedInvoiceLineEdits,
  hasUnsavedPayment,
  hasUnsavedStandingOrder,
  shouldConfirmDiscard,
  type InvoiceEditSnapshot,
} from "../lib/discard-guard";

describe("shouldConfirmDiscard", () => {
  it("REG-DISCARD-A: false when clean, even if not submitting", () => {
    expect(shouldConfirmDiscard(false, false)).toBe(false);
  });

  it("REG-DISCARD-A: false when dirty but submitting (never prompt mid-submit)", () => {
    expect(shouldConfirmDiscard(true, true)).toBe(false);
  });

  it("REG-DISCARD-A: true when dirty and idle", () => {
    expect(shouldConfirmDiscard(true, false)).toBe(true);
  });
});

describe("hasUnsavedStandingOrder", () => {
  it("REG-DISCARD-B: false for a fully empty form", () => {
    expect(hasUnsavedStandingOrder({ name: "", lines: [] })).toBe(false);
  });

  it("REG-DISCARD-B: false for whitespace-only name and no lines", () => {
    expect(hasUnsavedStandingOrder({ name: "   ", lines: [] })).toBe(false);
  });

  it("REG-DISCARD-B: true once a name is typed", () => {
    expect(hasUnsavedStandingOrder({ name: "Tuesday staples", lines: [] })).toBe(true);
  });

  it("REG-DISCARD-B: true once a line exists", () => {
    expect(hasUnsavedStandingOrder({ name: "", lines: [{ productId: "p1", qty: 1 }] })).toBe(true);
  });
});

describe("hasUnsavedInvoiceDraft", () => {
  it("REG-DISCARD-C: false for an empty composer", () => {
    expect(hasUnsavedInvoiceDraft({ items: {}, unlisted: [] })).toBe(false);
  });

  it("REG-DISCARD-C: true once a catalog item is selected", () => {
    expect(hasUnsavedInvoiceDraft({ items: { p1: { qty: 1 } }, unlisted: [] })).toBe(true);
  });

  it("REG-DISCARD-C: true once an unlisted line is added", () => {
    expect(hasUnsavedInvoiceDraft({ items: {}, unlisted: [{ name: "Pallet fee" }] })).toBe(true);
  });
});

describe("hasUnsavedInvoiceLineEdits", () => {
  const baseSnapshot: InvoiceEditSnapshot = {
    lines: [
      {
        productId: "p1",
        description: "Widget",
        qty: 2,
        boxes: null,
        pieces: null,
        unitPrice: 12,
        discount: null,
        taxable: true,
        note: "",
      },
    ],
    issueDate: "2026-09-01",
    dueDate: "2026-09-15",
    invDiscount: null,
    shippingFee: null,
    referenceNumber: "",
    subject: "",
    notes: "",
    terms: "",
  };

  it("REG-DISCARD-D: false when not yet hydrated (original is null)", () => {
    expect(hasUnsavedInvoiceLineEdits(baseSnapshot, null)).toBe(false);
  });

  it("REG-DISCARD-D: false when current equals original", () => {
    expect(hasUnsavedInvoiceLineEdits(baseSnapshot, baseSnapshot)).toBe(false);
  });

  it("REG-DISCARD-D: true when a line's unitPrice changes", () => {
    const changed: InvoiceEditSnapshot = {
      ...baseSnapshot,
      lines: [{ ...baseSnapshot.lines[0], unitPrice: 16 }],
    };
    expect(hasUnsavedInvoiceLineEdits(changed, baseSnapshot)).toBe(true);
  });

  it("REG-DISCARD-D: true when a line is appended", () => {
    const withExtraLine: InvoiceEditSnapshot = {
      ...baseSnapshot,
      lines: [
        ...baseSnapshot.lines,
        {
          productId: "p2",
          description: "Gadget",
          qty: 1,
          boxes: null,
          pieces: null,
          unitPrice: 5,
          discount: null,
          taxable: false,
          note: "",
        },
      ],
    };
    expect(hasUnsavedInvoiceLineEdits(withExtraLine, baseSnapshot)).toBe(true);
  });

  it("REG-DISCARD-D: true when a header field (dueDate) changes", () => {
    const changed: InvoiceEditSnapshot = { ...baseSnapshot, dueDate: "2026-09-20" };
    expect(hasUnsavedInvoiceLineEdits(changed, baseSnapshot)).toBe(true);
  });
});

describe("hasTouchedReceiveForm", () => {
  it("REG-DISCARD-E: false for an untouched (fully seeded) receipt", () => {
    expect(hasTouchedReceiveForm({ qtys: {}, boxQtys: {}, pieceQtys: {}, notes: "" })).toBe(false);
  });

  it("REG-DISCARD-E: true once a qty field is touched, even if it equals the seed", () => {
    expect(
      hasTouchedReceiveForm({ qtys: { line1: "10" }, boxQtys: {}, pieceQtys: {}, notes: "" }),
    ).toBe(true);
  });

  it("REG-DISCARD-E: true once notes is filled in", () => {
    expect(
      hasTouchedReceiveForm({ qtys: {}, boxQtys: {}, pieceQtys: {}, notes: "short 2 cases" }),
    ).toBe(true);
  });
});

describe("hasUnsavedPayment", () => {
  const empty = {
    amount: "",
    reference: "",
    notes: "",
    bankCharges: "",
    paidAt: "",
    settledAt: "",
    photos: [] as unknown[],
    asDraft: false,
  };

  it("REG-DISCARD-F: false for a freshly opened form", () => {
    expect(hasUnsavedPayment(empty)).toBe(false);
  });

  it("REG-DISCARD-F: true once amount is entered", () => {
    expect(hasUnsavedPayment({ ...empty, amount: "150.00" })).toBe(true);
  });

  it("REG-DISCARD-F: true once a photo is attached with no other field set", () => {
    expect(hasUnsavedPayment({ ...empty, photos: ["file://a.jpg"] })).toBe(true);
  });

  it("REG-DISCARD-F: true once asDraft is toggled on with no other field set", () => {
    expect(hasUnsavedPayment({ ...empty, asDraft: true })).toBe(true);
  });
});
