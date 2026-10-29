import { completionEmailParts } from "./invoice-completion-email";
import { recordInvoiceEmailed } from "./invoice-send-state";

/**
 * I-120 (SA-861 rule 8): the completion email's extra parts. A plain "Email again" (no opts) adds nothing; a
 * COUNTER_COMPLETE send carries the order-complete wording and every OTHER invoice of the order as an attachment, and
 * its #2088 send record says kind COUNTER_COMPLETE.
 */
const pdf = (id: string) => Buffer.from(`pdf-${id}`);
function deps(numbers: Record<string, string>) {
  const generated: string[] = [];
  return {
    generated,
    prisma: {
      forTenant: () => ({
        order: { findFirst: jest.fn(async () => ({ orderNumber: "ORD-7" })) },
        invoice: {
          findUnique: jest.fn(async ({ where }: any) =>
            numbers[where.id] ? { invoiceNumber: numbers[where.id] } : null,
          ),
        },
      }),
    } as any,
    pdfService: {
      getOrGenerate: jest.fn(async (id: string) => {
        generated.push(id);
        return `https://x/${id}.pdf`;
      }),
    } as any,
    storage: { download: jest.fn(async (key: string) => pdf(key)) } as any,
    logger: { warn: jest.fn() },
  };
}

describe("completionEmailParts", () => {
  it("no opts (a plain send / Email again): nothing added", async () => {
    const d = deps({});
    expect(
      await completionEmailParts(d.prisma, d.pdfService, d.storage, d.logger, undefined),
    ).toEqual({});
    expect(d.pdfService.getOrGenerate).not.toHaveBeenCalled();
  });

  it("COUNTER_COMPLETE: the order number for the wording + one attachment per other invoice (FINAL PDF)", async () => {
    const d = deps({ "inv-2": "INV-2", "inv-3": "INV-3" });
    const parts = await completionEmailParts(d.prisma, d.pdfService, d.storage, d.logger, {
      kind: "COUNTER_COMPLETE",
      orderId: "ord-7",
      withInvoiceIds: ["inv-2", "inv-3"],
    });
    expect(parts.completion).toEqual({ orderNumber: "ORD-7" });
    expect(parts.extraAttachments?.map((a) => a.filename)).toEqual([
      expect.stringContaining("INV-2"),
      expect.stringContaining("INV-3"),
    ]);
    expect(d.pdfService.getOrGenerate).toHaveBeenCalledWith("inv-2", { variant: "final" });
  });

  it("an invoice that cannot be read or rendered is left out, never failing the email", async () => {
    const d = deps({ "inv-2": "INV-2" });
    d.pdfService.getOrGenerate.mockRejectedValueOnce(new Error("render failed"));
    const parts = await completionEmailParts(d.prisma, d.pdfService, d.storage, d.logger, {
      kind: "COUNTER_COMPLETE",
      orderId: "ord-7",
      withInvoiceIds: ["inv-2", "inv-missing"],
    });
    expect(parts.extraAttachments).toEqual([]);
    expect(d.logger.warn).toHaveBeenCalled();
  });
});

describe("recordInvoiceEmailed: the send record names the completion kind", () => {
  it("kind COUNTER_COMPLETE is written to meta; a plain send writes no kind", async () => {
    const create = jest.fn(async () => ({}));
    const prisma = { forTenant: () => ({ auditLog: { create } }), getTenantId: () => "t-1" };
    await recordInvoiceEmailed(prisma, {
      id: "inv-1",
      actorId: "op-1",
      to: "b@x.test",
      fingerprint: "fp",
      kind: "COUNTER_COMPLETE",
    });
    await recordInvoiceEmailed(prisma, {
      id: "inv-1",
      actorId: "op-1",
      to: "b@x.test",
      fingerprint: "fp",
    });
    expect((create.mock.calls[0] as any)[0].data.meta.kind).toBe("COUNTER_COMPLETE");
    expect((create.mock.calls[1] as any)[0].data.meta).not.toHaveProperty("kind");
  });
});
