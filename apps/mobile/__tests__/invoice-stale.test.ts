import { INVOICE_STALE_COPY, isInvoiceStale } from "../lib/invoice-stale";

describe("H4 mobile isInvoiceStale", () => {
  it("is true only for a 409 carrying code INVOICE_STALE", () => {
    expect(isInvoiceStale({ response: { status: 409, data: { code: "INVOICE_STALE" } } })).toBe(
      true,
    );
    expect(
      isInvoiceStale({ response: { status: 409, data: { code: "ORDER_REVISION_STALE" } } }),
    ).toBe(false);
    expect(isInvoiceStale({ response: { status: 400, data: { code: "INVOICE_STALE" } } })).toBe(
      false,
    );
    expect(isInvoiceStale(undefined)).toBe(false);
  });

  it("the copy says nothing was saved and how to recover", () => {
    expect(INVOICE_STALE_COPY).toMatch(/not saved/);
    expect(INVOICE_STALE_COPY).toMatch(/re-apply/);
  });
});
