import {
  MAX_INVOICE_EMAIL_ATTACHMENT_BYTES,
  invoiceAttachmentFilename,
} from "./invoice-attachment";

describe("invoiceAttachmentFilename", () => {
  it("wraps a normal invoice number", () => {
    expect(invoiceAttachmentFilename("INV-2026-0042")).toBe("Invoice-INV-2026-0042.pdf");
  });

  it("strips characters that could break a filename or a Content-Disposition header", () => {
    expect(invoiceAttachmentFilename('INV/2026\\0042"; evil')).toBe(
      "Invoice-INV_2026_0042___evil.pdf",
    );
  });

  it("never lets a path-traversal-shaped invoice number produce a path separator", () => {
    const filename = invoiceAttachmentFilename("../../etc/passwd");
    expect(filename).not.toMatch(/[/\\]/);
    expect(filename.endsWith(".pdf")).toBe(true);
  });

  it("falls back to a safe default for an empty or fully-stripped number", () => {
    expect(invoiceAttachmentFilename("")).toBe("Invoice-invoice.pdf");
    expect(invoiceAttachmentFilename("///")).toBe("Invoice-invoice.pdf");
  });
});

describe("MAX_INVOICE_EMAIL_ATTACHMENT_BYTES", () => {
  it("is a 10MB cap", () => {
    expect(MAX_INVOICE_EMAIL_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024);
  });
});
