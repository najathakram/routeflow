import { taxStateStaleCopy } from "../lib/invoice-tax-state-copy";

/** SA-814e: the 409 INVOICE_TAX_STATE_STALE copy on mobile follows the body's `path`. */
const stale = (path?: string) => ({
  response: { status: 409, data: { code: "INVOICE_TAX_STATE_STALE", message: "raw", path } },
});

describe("taxStateStaleCopy", () => {
  it("a draft edit says the draft can't be recalculated and to create it again", () => {
    const copy = taxStateStaleCopy(stale("DRAFT_EDIT"));
    expect(copy).toMatch(/Create it again from the order, or contact support/);
    expect(copy).not.toMatch(/Re-save/);
  });

  it("a price adjustment points at a credit note", () => {
    expect(taxStateStaleCopy(stale("PRICE_ADJUSTMENT"))).toMatch(
      /Issue a credit note or contact support/,
    );
  });

  it("a body with no path gets the draft sentence", () => {
    expect(taxStateStaleCopy(stale())).toMatch(/Create it again from the order/);
  });

  it("any other error is null (the caller keeps its own fallback)", () => {
    expect(taxStateStaleCopy({ response: { status: 409, data: { code: "OTHER" } } })).toBeNull();
    expect(taxStateStaleCopy(new Error("x"))).toBeNull();
    expect(taxStateStaleCopy(undefined)).toBeNull();
  });
});
