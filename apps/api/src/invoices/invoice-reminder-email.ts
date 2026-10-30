import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { Logger } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";
import type { StorageService } from "../storage/storage.service";
import type { EmailService } from "../email/email.service";
import type { SystemConfigService } from "../system-config/system-config.service";
import type { InvoicePdfService } from "./invoice-pdf.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { isInternalEmail } from "../common/internal-email";
import { buildInvoiceEmailAttachment, type InvoiceEmailAttachment } from "./invoice-attachment";
import { buildReminderEmailPayload } from "./invoice-email-payload";
import { assertReminderIssued, assertReminderOwes } from "./invoice-balance-sql";
import { CONFIRMED_PAYMENT } from "./payment-predicates";

/**
 * The payment-reminder email and the recipient rule it shares with `deliverEmail` — moved verbatim out of
 * `invoices.service.ts` (size ratchet; prefactor for #3691 / #3742 / #3726). `InvoicesService` keeps
 * `sendReminder` as a one-line delegate, so its controller and specs are unchanged.
 */
export interface ReminderEmailDeps {
  prisma: PrismaService;
  emailService: EmailService;
  pdfService: InvoicePdfService;
  storage: StorageService;
  systemConfig: SystemConfigService;
  logger: Logger;
}

/**
 * The address an invoice email goes to: the request's override, else the customer's on-file address.
 * Import sentinels (`@imported.local` / `@placeholder.local`) are non-routable — filtered from BOTH the
 * override (older clients echo the on-file address into the request body) and the customer record, so a
 * sentinel behaves exactly like "no email on file" instead of a doomed send.
 */
export function resolveRecipientEmail(
  overrideEmail: string | undefined,
  customerEmail: string | null | undefined,
): string {
  const requestedEmail = isInternalEmail(overrideEmail) ? null : overrideEmail;
  const onFileEmail = isInternalEmail(customerEmail) ? null : customerEmail;
  const recipientEmail = requestedEmail || onFileEmail;
  if (!recipientEmail)
    throw new BadRequestException(
      "No email address on file for this customer. Provide an email address.",
    );
  return recipientEmail;
}

/** Send a payment reminder email without changing the invoice status. */
export async function sendReminder(deps: ReminderEmailDeps, id: string, overrideEmail?: string) {
  const inv = await deps.prisma.forTenant().invoice.findUnique({
    where: { id },
    include: {
      customer: { select: { id: true, businessName: true, contactName: true, email: true } },
      // SA-1029 A-1: the product's base word for a legacy line that never froze one (no per-item query)
      items: { include: { product: { select: { baseUnitLabel: true } } } },
      // F03/R8: CONFIRMED (PAID) payments only — feeds totalPaid/balanceDue below.
      // B421: creditNote relation needed for the customer-facing "Credit
      // issued — CN-…" line's number.
      payments: {
        where: CONFIRMED_PAYMENT,
        include: { creditNote: { select: { creditNoteNumber: true } } },
      },
    },
  });
  if (!inv) throw new NotFoundException("Invoice not found");
  assertReminderIssued(inv.status); // row 318a: only SENT / VIEWED / PARTIAL / OVERDUE
  assertReminderOwes(inv.total, inv.payments); // SA-770: an exactly-paid or overpaid SENT invoice owes nothing

  const recipientEmail = resolveRecipientEmail(overrideEmail, inv.customer?.email);

  // R5: don't claim a reminder was sent when email isn't set up.
  if (!(await deps.emailService.isEmailConfigured())) {
    throw new BadRequestException({
      code: API_ERROR_CODES.EMAIL_NOT_CONFIGURED,
      message:
        "Email isn't set up yet, so the reminder wasn't sent. Configure your email/SMTP settings under Settings → Email, then try again.",
    });
  }

  let pdfUrl: string | undefined;
  let attachment: InvoiceEmailAttachment | undefined;
  try {
    pdfUrl = await deps.pdfService.getOrGenerate(id);
    if (pdfUrl) {
      const dl = deps.storage.download.bind(deps.storage);
      attachment = await buildInvoiceEmailAttachment(dl, deps.logger, id, inv.invoiceNumber);
    }
  } catch {
    /* non-critical */
  }

  // F03/R9: see sendEmail's matching comment — the reminder renders the same item
  // table, so it honours the same hide-original-price setting.
  const hideOriginalPrice = (await deps.systemConfig.get("invoice.hideOriginalPrice")) === "true";

  const reminderPayload = buildReminderEmailPayload(inv, {
    recipientEmail,
    pdfUrl,
    attachment,
    hideOriginalPrice,
  });
  const sendResult = await deps.emailService.sendInvoice(reminderPayload);

  if (!sendResult.delivered) {
    throw new BadRequestException({
      code: API_ERROR_CODES.EMAIL_SEND_FAILED,
      message: `The reminder couldn't be emailed${sendResult.error ? ` (${sendResult.error})` : ""}. Check your email settings under Settings → Email and try again.`,
    });
  }

  // Non-blocking: see the matching comment in sendEmail() above — Resend rescued a
  // failing tenant SMTP attempt, so tell the operator without blocking the reminder.
  return {
    success: true,
    sentTo: recipientEmail,
    ...(sendResult.smtpFallbackReason ? { warning: sendResult.smtpFallbackReason } : {}),
    ...(sendResult.fromAddress ? { fromAddress: sendResult.fromAddress } : {}),
  };
}
