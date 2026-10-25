import { buildInvoiceEmailAttachment, type InvoiceEmailAttachment } from "./invoice-attachment";
import type { SendEmailOpts } from "./invoice-send-state";

/**
 * I-120 (SA-861 rule 8): the parts the completion email adds to the invoice email `deliverEmail` builds. Nothing for a
 * plain send ("Email again"). For a COUNTER_COMPLETE send: the order number for the order-complete subject and intro, and
 * every OTHER invoice of the order as one more attachment (the FINAL PDF, the cap `buildInvoiceEmailAttachment` applies).
 * Outside invoices.service.ts (the service is on the size ratchet). An invoice that cannot be read or rendered is left
 * out with a warning: the email still goes, never failing on a sibling's PDF.
 */
export async function completionEmailParts(
  prisma: { forTenant(): any },
  pdfService: {
    getOrGenerate(id: string, opts: { variant: "final" }): Promise<string | undefined>;
  },
  storage: { download(key: string): Promise<Buffer> },
  logger: { warn(message: string): void },
  opts: SendEmailOpts | undefined,
): Promise<{ completion?: { orderNumber: string }; extraAttachments?: InvoiceEmailAttachment[] }> {
  if (opts?.kind !== "COUNTER_COMPLETE") return {};
  const order = opts.orderId
    ? await prisma
        .forTenant()
        .order.findFirst({ where: { id: opts.orderId }, select: { orderNumber: true } })
    : null;
  const extraAttachments: InvoiceEmailAttachment[] = [];
  for (const id of opts.withInvoiceIds ?? []) {
    const row = await prisma
      .forTenant()
      .invoice.findUnique({ where: { id }, select: { invoiceNumber: true } });
    if (!row) continue;
    try {
      await pdfService.getOrGenerate(id, { variant: "final" });
    } catch (e) {
      logger.warn(
        `completion email: invoice ${id} PDF not rendered, left out (${(e as Error)?.message ?? e})`,
      );
      continue;
    }
    const attachment = await buildInvoiceEmailAttachment(
      storage.download.bind(storage),
      logger,
      id,
      row.invoiceNumber,
    );
    if (attachment) extraAttachments.push(attachment);
  }
  return { completion: { orderNumber: order?.orderNumber ?? "" }, extraAttachments };
}
