import { keptDraftInvoiceId, keptOrderId } from "./kept-draft-invoice";

const err = (data: unknown) => ({ response: { status: 400, data } });

describe("keptDraftInvoiceId (row 466 reads the kept draft; row 448 control: a validation refusal names none)", () => {
  it("reads the id from any post-commit failure body, whatever its code", () => {
    expect(keptDraftInvoiceId(err({ code: "EMAIL_SEND_FAILED", invoiceId: "inv-1" }))).toBe(
      "inv-1",
    );
    expect(
      keptDraftInvoiceId(err({ code: "INVOICE_CHANGED_CONCURRENTLY", invoiceId: "inv-2" })),
    ).toBe("inv-2");
    expect(keptDraftInvoiceId(err({ statusCode: 400, message: "boom", invoiceId: "inv-3" }))).toBe(
      "inv-3",
    );
  });

  it("VALIDATION_FAILED + invoiceId is a plain failure: nothing was committed, so no draft is named", () => {
    expect(keptDraftInvoiceId(err({ code: "VALIDATION_FAILED", invoiceId: "inv-x" }))).toBeNull();
  });

  it("no invoiceId, an empty or non-string one, or no body at all: null", () => {
    expect(keptDraftInvoiceId(err({ code: "EMAIL_SEND_FAILED" }))).toBeNull();
    expect(keptDraftInvoiceId(err({ invoiceId: "" }))).toBeNull();
    expect(keptDraftInvoiceId(err({ invoiceId: 42 }))).toBeNull();
    expect(keptDraftInvoiceId(new Error("Network Error"))).toBeNull();
    expect(keptDraftInvoiceId(null)).toBeNull();
  });

  it("keptOrderId reads the committed order the same way (the sale path)", () => {
    expect(keptOrderId(err({ orderId: "ord-1" }))).toBe("ord-1");
    expect(keptOrderId(err({ orderId: "" }))).toBeNull();
    expect(keptOrderId(null)).toBeNull();
  });
});
