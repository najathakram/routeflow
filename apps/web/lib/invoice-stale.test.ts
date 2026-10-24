import { INVOICE_STALE_COPY, isInvoiceStale } from "./invoice-stale";

describe("H4 isInvoiceStale", () => {
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
    expect(isInvoiceStale(new Error("network"))).toBe(false);
    expect(isInvoiceStale(null)).toBe(false);
  });

  it("the copy says nothing was saved and what to do next", () => {
    expect(INVOICE_STALE_COPY).toMatch(/not saved/);
    expect(INVOICE_STALE_COPY).toMatch(/Reload/);
    expect(INVOICE_STALE_COPY).toMatch(/re-apply/);
  });
});
