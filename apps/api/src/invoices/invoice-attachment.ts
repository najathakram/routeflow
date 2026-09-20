/**
 * Pure helpers for the PDF attached to an invoice send/reminder email
 * (feat/email-invoice-pdf-attachment). Kept separate from `invoices.service.ts` so the
 * filename-sanitizing rule is spec'd in isolation — same pattern as `invoice-item-code.ts`.
 */

/**
 * Cap on the PDF an invoice email will attach. An oversize file falls back to the
 * existing Download-PDF link instead of failing the send — see
 * `InvoicesService#buildInvoiceEmailAttachment`. 10 MB comfortably covers even a long
 * multi-page invoice while staying well under common inbound mail-server attachment
 * limits (25 MB on Gmail/Outlook, 4 MB on Microsoft Graph's raw-MIME `sendMail`, which
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
