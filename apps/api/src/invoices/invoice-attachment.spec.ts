import {
  MAX_INVOICE_EMAIL_ATTACHMENT_BYTES,
  buildInvoiceEmailAttachment,
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

describe("buildInvoiceEmailAttachment", () => {
  const logger = { warn: jest.fn() };

  beforeEach(() => {
    logger.warn.mockClear();
  });

  it("returns the PDF with the sanitized filename and content type when it's under the cap", async () => {
    const download = jest.fn().mockResolvedValue(Buffer.from("pdf-bytes"));

    const attachment = await buildInvoiceEmailAttachment(download, logger, "inv-1", "INV-1");

    expect(download).toHaveBeenCalledWith("invoice-pdfs/inv-1.pdf");
    expect(attachment).toEqual({
      filename: "Invoice-INV-1.pdf",
      content: Buffer.from("pdf-bytes"),
      contentType: "application/pdf",
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("falls back to no attachment (never throws) when the PDF exceeds the cap", async () => {
    const oversize = Buffer.alloc(MAX_INVOICE_EMAIL_ATTACHMENT_BYTES + 1);
    const download = jest.fn().mockResolvedValue(oversize);

    const attachment = await buildInvoiceEmailAttachment(download, logger, "inv-1", "INV-1");

    expect(attachment).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("over the"));
  });

  it("falls back to no attachment (never throws) when reading the generated PDF back fails", async () => {
    const download = jest.fn().mockRejectedValue(new Error("storage unavailable"));

    const attachment = await buildInvoiceEmailAttachment(download, logger, "inv-1", "INV-1");

    expect(attachment).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("storage unavailable"));
  });
});
