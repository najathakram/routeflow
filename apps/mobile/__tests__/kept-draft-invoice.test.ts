/**
 * Row 466 ("the record lies"): create-and-send commits the draft first. A send failure of ANY kind
 * carries the draft's `invoiceId`; the composer opens that draft instead of reporting a plain failure
 * (a retry would create a duplicate). The helper reads the id from any error body and never the message.
 */
import * as fs from "fs";
import * as path from "path";
import { KEPT_DRAFT_COPY, keptDraftInvoiceId } from "../lib/kept-draft-invoice";

const apiError = (data: unknown) => ({ response: { status: 400, data } });

describe("keptDraftInvoiceId", () => {
  it.each([
    ["a plain 400 with no code", { statusCode: 400, message: "RAW", invoiceId: "inv-1" }],
    ["a 409 coded error", { code: "INVOICE_CHANGED_CONCURRENTLY", invoiceId: "inv-1" }],
    ["EMAIL_SEND_FAILED", { code: "EMAIL_SEND_FAILED", message: "smtp", invoiceId: "inv-1" }],
    [
      "the coded 500 for a non-HTTP failure",
      { code: "INVOICE_SEND_AFTER_CREATE_FAILED", invoiceId: "inv-1" },
    ],
    ["the sale path (order + invoice)", { invoiceId: "inv-1", orderId: "ord-1" }],
  ])("%s -> the kept draft's id", (_n, data) => {
    expect(keptDraftInvoiceId(apiError(data))).toBe("inv-1");
  });

  it("a failure with no invoiceId is a plain create failure (null)", () => {
    expect(
      keptDraftInvoiceId(apiError({ statusCode: 400, message: "Customer not found" })),
    ).toBeNull();
  });

  it("is null for an empty or non-string id, a network error, undefined and null", () => {
    expect(keptDraftInvoiceId(apiError({ invoiceId: "" }))).toBeNull();
    expect(keptDraftInvoiceId(apiError({ invoiceId: 42 }))).toBeNull();
    expect(keptDraftInvoiceId(new Error("Network Error"))).toBeNull();
    expect(keptDraftInvoiceId(undefined)).toBeNull();
    expect(keptDraftInvoiceId(null)).toBeNull();
  });

  it("the screen copy is fixed and carries no server text", () => {
    expect(KEPT_DRAFT_COPY).toMatch(/draft/);
    expect(KEPT_DRAFT_COPY).not.toMatch(/RAW|smtp/);
  });
});

describe("the invoice composer wires it on the plain create path", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "app", "(operator)", "(tabs)", "invoices", "new.tsx"),
    "utf8",
  );

  // The sale path no longer redirects: an unknown outcome locks the cart (sale-attempt-key.test.ts).
  it("the plain create opens the kept draft before any other error branch", () => {
    const at = src.indexOf(`onUnitNotOffered("Couldn't create invoice")`);
    expect(at).toBeGreaterThan(0);
    const before = src.slice(Math.max(0, at - 260), at);
    expect(before).toMatch(/keptDraftInvoiceId\(err\)[\s\S]*onKeptDraft\(keptId\)/);
  });
});
