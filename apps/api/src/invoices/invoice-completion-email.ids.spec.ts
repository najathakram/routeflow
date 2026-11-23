import { completionEmailParts } from "./invoice-completion-email";

/**
 * W-1286 PR-1 (SA-1202 C6): a completion email that carries several invoices names them, so the delivery writer can
 * write one row per invoice. The ids ride the parts `deliverEmail` already merges into the payload.
 */
function deps(numbers: Record<string, string>) {
  return {
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
    pdfService: { getOrGenerate: jest.fn(async (id: string) => `https://x/${id}.pdf`) } as any,
    storage: { download: jest.fn(async (key: string) => Buffer.from(key)) } as any,
    logger: { warn: jest.fn() },
  };
}

describe("completionEmailParts names the other invoices in the email", () => {
  it("T8: both other invoices are named", async () => {
    const d = deps({ "inv-2": "INV-2", "inv-3": "INV-3" });
    const parts = await completionEmailParts(d.prisma, d.pdfService, d.storage, d.logger, {
      kind: "COUNTER_COMPLETE",
      orderId: "ord-7",
      withInvoiceIds: ["inv-2", "inv-3"],
    });
    expect((parts as any).alsoInvoiceIds).toEqual(["inv-2", "inv-3"]);
  });

  it("an invoice left out of the email (unreadable) is not named", async () => {
    const d = deps({ "inv-2": "INV-2" });
    const parts = await completionEmailParts(d.prisma, d.pdfService, d.storage, d.logger, {
      kind: "COUNTER_COMPLETE",
      orderId: "ord-7",
      withInvoiceIds: ["inv-2", "inv-missing"],
    });
    expect((parts as any).alsoInvoiceIds).toEqual(["inv-2"]);
  });

  it("a plain send names none", async () => {
    const d = deps({});
    expect(
      await completionEmailParts(d.prisma, d.pdfService, d.storage, d.logger, undefined),
    ).toEqual({});
  });
});
