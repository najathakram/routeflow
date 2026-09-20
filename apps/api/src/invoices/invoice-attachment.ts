/**
 * Helpers for the PDF attached to an invoice send/reminder email
 * (feat/email-invoice-pdf-attachment). Kept out of `invoices.service.ts` (the size-ratchet
 * gate caps that file's growth — `common/size-ratchet.spec.ts`) so this slice lives, and is
 * spec'd, on its own — same pattern as `invoice-item-code.ts`.
 */
import { invoicePdfStorageKey } from "./invoice-pdf.service";

/**
 * Cap on the PDF an invoice email will attach. An oversize file falls back to the
 * existing Download-PDF link instead of failing the send — see
 * `buildInvoiceEmailAttachment` below. 10 MB comfortably covers even a long multi-page
 * invoice while staying well under common inbound mail-server attachment limits (25 MB
 * on Gmail/Outlook, 4 MB on Microsoft Graph's raw-MIME `sendMail`, which
 * `MailboxSendService` already falls through past on its own).
 */
export const MAX_INVOICE_EMAIL_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Filename for the PDF attached to an invoice email. `invoiceNumber` is tenant-authored
 * free text with no filesystem/header-safety validation elsewhere, so this strips
 * anything but alphanumerics/`_`/`-`/`.` before it reaches a `Content-Disposition`
 * header — never trust it verbatim into a filename.
 */
export function invoiceAttachmentFilename(invoiceNumber: string): string {
  const stripped = invoiceNumber.replace(/[^A-Za-z0-9_.-]/g, "_");
  const trimmed = stripped.replace(/^[-._]+|[-._]+$/g, "");
  // A number that sanitizes down to nothing recognizable (e.g. all path separators)
  // falls back to a plain name rather than shipping an all-punctuation filename.
  const safe = /[A-Za-z0-9]/.test(trimmed) ? trimmed : "invoice";
  return `Invoice-${safe}.pdf`;
}

export type InvoiceEmailAttachment = { filename: string; content: Buffer; contentType: string };

/**
 * Build the PDF attachment for an invoice send/reminder email — reads back the SAME file
 * `pdfService.getOrGenerate` just rendered and uploaded (via `download`, e.g.
 * `StorageService#download`), never a second render. NEVER throws: a download failure or
 * an oversize PDF both fall back to no attachment (`undefined`) — the Download-PDF link
 * already in the email body still works, and an attachment problem must never fail the
 * send itself. Only call this after `getOrGenerate` has already succeeded for the invoice.
 * `download`/`logger` are injected (not the concrete services) so this stays a plain
 * function `invoices.service.ts` can call without growing past the size-ratchet gate.
 */
export async function buildInvoiceEmailAttachment(
  download: (key: string) => Promise<Buffer>,
  logger: { warn: (message: string) => void },
  invoiceId: string,
  invoiceNumber: string,
): Promise<InvoiceEmailAttachment | undefined> {
  try {
    const content = await download(invoicePdfStorageKey(invoiceId));
    if (content.length > MAX_INVOICE_EMAIL_ATTACHMENT_BYTES) {
      logger.warn(
        `Invoice ${invoiceId} PDF is ${content.length}B, over the ` +
          `${MAX_INVOICE_EMAIL_ATTACHMENT_BYTES}B email attachment cap — sending the download link only`,
      );
      return undefined;
    }
    return {
      filename: invoiceAttachmentFilename(invoiceNumber),
      content,
      contentType: "application/pdf",
    };
  } catch (err) {
    logger.warn(
      `Could not read the generated PDF for invoice ${invoiceId} to attach to the email — ` +
        `sending the download link only: ${err instanceof Error ? err.message : err}`,
    );
    return undefined;
  }
}
