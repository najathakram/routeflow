import { taxStateStaleCopy } from "../lib/invoice-tax-state-copy";

/** SA-814g: the 409 INVOICE_TAX_STATE_STALE copy on mobile follows the body's `path`. */
const stale = (path?: string) => ({
  response: { status: 409, data: { code: "INVOICE_TAX_STATE_STALE", message: "raw", path } },
});

describe("taxStateStaleCopy", () => {
  it("an order-linked draft says to create it again from the order", () => {
    const copy = taxStateStaleCopy(stale("DRAFT_ORDER"));
    expect(copy).toMatch(/Create it again from the order, or contact support/);
    expect(copy).not.toMatch(/Re-save/);
  });

  it("a manual draft says to create the draft again", () => {
    expect(taxStateStaleCopy(stale("DRAFT_MANUAL"))).toMatch(
      /Create the draft again, or contact support/,
    );
  });

  it("an issued invoice points at a credit note", () => {
    expect(taxStateStaleCopy(stale("ISSUED"))).toMatch(/Issue a credit note or contact support/);
  });

  it("a body with no (or an unknown) path gets the issued sentence", () => {
    expect(taxStateStaleCopy(stale())).toMatch(/Issue a credit note or contact support/);
    expect(taxStateStaleCopy(stale("NEW_KIND"))).toMatch(/Issue a credit note/);
  });

  it("any other error is null (the caller keeps its own fallback)", () => {
    expect(taxStateStaleCopy({ response: { status: 409, data: { code: "OTHER" } } })).toBeNull();
    expect(taxStateStaleCopy(new Error("x"))).toBeNull();
    expect(taxStateStaleCopy(undefined)).toBeNull();
  });
});
