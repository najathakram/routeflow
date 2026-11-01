import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { AccountStatement } from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { StatementPdfService } from "../buyer/statement-pdf.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { escapeHtml } from "../common/html-escape";
import { resolveRecipientEmail } from "../invoices/invoice-reminder-email";
import { dayOf, fmtMoney } from "./account-statement-pdf-model";

/**
 * SA-1078 (W-1096) PR-4: the "Open balance" statement by email. On demand, from the sheet; same people who can read it
 * (`FINANCE|CUSTOMERS`). Follows `invoice-reminder-email.ts`: the recipient rule, the not-set-up check, then one send with
 * the PDF attached and one `EmailDelivery` row. The subject, the body and the PDF are all drawn from ONE statement object
 * (`StatementPdfService.buildCurrentPdf`), so a value decided twice can never disagree.
 */
export interface StatementEmailDeps {
  prisma: Pick<PrismaService, "forTenant" | "getTenantId">;
  emailService: Pick<EmailService, "isEmailConfigured" | "send">;
  statementPdf: Pick<StatementPdfService, "buildCurrentPdf">;
}

export interface StatementEmail {
  subject: string;
  html: string;
  text: string;
  pdfFilename: string;
}

/** The words a customer reads, from the statement they are about to receive (the spec's table, "Words"). */
export function buildStatementEmail(
  statement: AccountStatement,
  businessName: string | null | undefined,
): StatementEmail {
  const date = dayOf(statement.asOf);
  const name = businessName?.trim();
  const what =
    statement.openBalance > 0
      ? `Here's your statement as of ${date}. Open balance: ${fmtMoney(statement.openBalance)}. Overdue: ${fmtMoney(statement.overdue)}.`
      : `You have no open balance as of ${date}.`;
  const text = `${what} The PDF is attached. Reply to this email with any questions.`;
  return {
    subject: name ? `Your statement from ${name}` : "Your account statement",
    text,
    html: `<p style="margin:0 0 16px;font-size:15px;color:#374151;">${escapeHtml(text)}</p>`,
    pdfFilename: `statement-${statement.asOf}.pdf`,
  };
}

export async function sendCustomerStatementEmail(
  deps: StatementEmailDeps,
  customerId: string,
  overrideEmail?: string,
) {
  const customer = await deps.prisma.forTenant().customer.findFirst({
    where: { id: customerId },
    select: { id: true, businessName: true, email: true },
  });
  if (!customer) throw new NotFoundException("Customer not found");

  const recipientEmail = resolveRecipientEmail(overrideEmail, customer.email);

  // R5: don't claim a statement was sent when email isn't set up — and don't render a PDF nobody can send.
  if (!(await deps.emailService.isEmailConfigured())) {
    throw new BadRequestException({
      code: API_ERROR_CODES.EMAIL_NOT_CONFIGURED,
      message:
        "Email isn't set up yet, so the statement wasn't sent. Configure your email/SMTP settings under Settings → Email, then try again.",
    });
  }

  const { statement, tenant, pdf } = await deps.statementPdf.buildCurrentPdf(customer);
  const mail = buildStatementEmail(statement, tenant?.businessName);

  const tenantId = deps.prisma.getTenantId();
  const result = await deps.emailService.send({
    to: recipientEmail,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    attachments: [{ filename: mail.pdfFilename, content: pdf, contentType: "application/pdf" }],
    ...(tenantId
      ? {
          delivery: {
            tenantId,
            kind: "CUSTOMER_STATEMENT" as const,
            entityType: "Customer",
            entityId: customer.id,
          },
        }
      : {}),
  });

  if (!result.delivered) {
    throw new BadRequestException({
      code: API_ERROR_CODES.EMAIL_SEND_FAILED,
      message: `The statement couldn't be emailed${result.error ? ` (${result.error})` : ""}. Check your email settings under Settings → Email and try again.`,
    });
  }

  return {
    success: true as const,
    sentTo: recipientEmail,
    ...(result.smtpFallbackReason ? { warning: result.smtpFallbackReason } : {}),
    ...(result.fromAddress ? { fromAddress: result.fromAddress } : {}),
  };
}

/** The injectable face of `sendCustomerStatementEmail` (the customers module owns it; no module cycle with the buyer one). */
@Injectable()
export class CustomerStatementEmailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly statementPdf: StatementPdfService,
  ) {}

  send(customerId: string, overrideEmail?: string) {
    return sendCustomerStatementEmail(
      { prisma: this.prisma, emailService: this.emailService, statementPdf: this.statementPdf },
      customerId,
      overrideEmail,
    );
  }
}
