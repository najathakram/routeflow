import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Resend } from "resend";
import * as nodemailer from "nodemailer";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../common/encryption.service";

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly resend: Resend | null;
  private readonly platformFrom: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {
    const apiKey = this.config.get<string>("RESEND_API_KEY");
    this.platformFrom =
      this.config.get<string>("EMAIL_FROM") ?? "RouteFlow <noreply@routeflow.app>";

    if (apiKey) {
      this.resend = new Resend(apiKey);
      this.logger.log("Email service initialised (Resend)");
    } else {
      this.resend = null;
      this.logger.warn(
        "RESEND_API_KEY not set — emails will be logged only. Set the key to enable real delivery.",
      );
    }
  }

  // ─── Per-tenant SMTP helpers ───────────────────────────────────────────────

  private async getTenantSmtpTransport(): Promise<nodemailer.Transporter | null> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return null;

    const cfg = await this.prisma.tenantConfig.findFirst({ where: { tenantId } });
    if (!cfg?.smtpHost || !cfg.smtpUser || !cfg.smtpPassword) return null;

    const pass = this.encryption.decryptNullable(cfg.smtpPassword);
    if (!pass) return null;

    return nodemailer.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort ?? 587,
      secure: cfg.smtpSecure,
      auth: { user: cfg.smtpUser, pass },
    });
  }

  private async getTenantFromAddress(): Promise<string> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return this.platformFrom;

    const cfg = await this.prisma.tenantConfig.findFirst({ where: { tenantId } });
    if (cfg?.smtpFromEmail) {
      return cfg.smtpFromName ? `${cfg.smtpFromName} <${cfg.smtpFromEmail}>` : cfg.smtpFromEmail;
    }
    // Fall back to businessName as sender name
    if (cfg?.businessName) return `${cfg.businessName} <noreply@routeflow.app>`;
    return this.platformFrom;
  }

  private async getTenantBusinessName(): Promise<string> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return "RouteFlow";
    const cfg = await this.prisma.tenantConfig.findFirst({ where: { tenantId } });
    return cfg?.businessName ?? "RouteFlow";
  }

  // ─── Send test email ───────────────────────────────────────────────────────

  async sendTestEmail(toEmail: string): Promise<{ success: boolean; message: string }> {
    const businessName = await this.getTenantBusinessName();
    const html = `<p>This is a test email from ${businessName}. Your SMTP configuration is working correctly.</p>`;
    try {
      await this.send({ to: toEmail, subject: `${businessName} — Test Email`, html });
      return { success: true, message: "Test email sent successfully" };
    } catch (err: any) {
      return { success: false, message: err?.message ?? "Failed to send test email" };
    }
  }

  // ─── Send Invoice ──────────────────────────────────────────────────────────

  async sendInvoice(params: {
    to: string;
    customerName: string;
    invoiceNumber: string;
    invoiceId: string;
    issueDate: string;
    dueDate: string;
    total: number;
    items: { description: string; qty: number; unitPrice: number; subtotal: number }[];
    pdfUrl?: string;
    isReminder?: boolean;
  }) {
    const businessName = await this.getTenantBusinessName();
    const subject = params.isReminder
      ? `Payment Reminder — Invoice ${params.invoiceNumber}`
      : `Invoice ${params.invoiceNumber}`;

    const html = this.buildInvoiceEmail(params, businessName);
    return this.send({ to: params.to, subject, html });
  }

  // ─── Internal send ─────────────────────────────────────────────────────────

  async send(params: { to: string; subject: string; html: string }) {
    // 1. Try per-tenant SMTP if configured
    const smtpTransport = await this.getTenantSmtpTransport();
    if (smtpTransport) {
      const from = await this.getTenantFromAddress();
      try {
        const info = await smtpTransport.sendMail({
          from,
          to: params.to,
          subject: params.subject,
          html: params.html,
        });
        this.logger.log(
          `Email sent via tenant SMTP to ${params.to} — messageId: ${info.messageId}`,
        );
        return { id: info.messageId };
      } catch (err: any) {
        this.logger.error(`Tenant SMTP send failed: ${err?.message}. Falling back to Resend.`);
      }
    }

    // 2. Try platform Resend
    if (this.resend) {
      try {
        const result = await this.resend.emails.send({
          from: this.platformFrom,
          to: params.to,
          subject: params.subject,
          html: params.html,
        });
        this.logger.log(`Email sent via Resend to ${params.to} — id: ${(result.data as any)?.id}`);
        return result;
      } catch (err: any) {
        this.logger.error(`Failed to send email to ${params.to}: ${err?.message}`);
        throw err;
      }
    }

    // 3. Log only (dev/no keys)
    this.logger.log(`[EMAIL MOCK] To: ${params.to} | Subject: ${params.subject}`);
    return { id: "mock" };
  }

  // ─── Email template ────────────────────────────────────────────────────────

  private buildInvoiceEmail(
    params: {
      customerName: string;
      invoiceNumber: string;
      issueDate: string;
      dueDate: string;
      total: number;
      items: { description: string; qty: number; unitPrice: number; subtotal: number }[];
      pdfUrl?: string;
      isReminder?: boolean;
    },
    businessName: string,
  ): string {
    const fmt = (n: number) =>
      new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

    const itemRows = params.items
      .map(
        (it) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#1a2033;">${it.description}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#1a2033;text-align:center;">${it.qty}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#1a2033;text-align:right;">${fmt(it.unitPrice)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#1a2033;text-align:right;font-weight:600;">${fmt(it.subtotal)}</td>
        </tr>`,
      )
      .join("");

    const reminderBanner = params.isReminder
      ? `<div style="background:#fff7ed;border-left:4px solid #f97316;padding:12px 16px;margin-bottom:24px;border-radius:4px;">
           <p style="margin:0;font-size:14px;color:#9a3412;font-weight:600;">Payment Reminder</p>
           <p style="margin:4px 0 0;font-size:13px;color:#9a3412;">This invoice is overdue. Please arrange payment at your earliest convenience.</p>
         </div>`
      : "";

    const pdfButton = params.pdfUrl
      ? `<a href="${params.pdfUrl}" style="display:inline-block;margin-top:8px;background:#f3f4f6;color:#374151;padding:8px 20px;border-radius:6px;font-size:13px;text-decoration:none;font-weight:500;">Download PDF</a>`
      : "";

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:40px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">

        <!-- Header -->
        <tr><td style="background:#1a2033;padding:28px 32px;">
          <p style="margin:0;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">${businessName}</p>
          <p style="margin:4px 0 0;font-size:13px;color:rgba(255,255,255,0.6);">Invoice</p>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:32px;">
          ${reminderBanner}
          <p style="margin:0 0 8px;font-size:15px;color:#6b7280;">Dear ${params.customerName},</p>
          <p style="margin:0 0 24px;font-size:15px;color:#374151;">
            ${params.isReminder ? "This is a reminder that the following invoice is outstanding." : "Please find your invoice details below."}
          </p>

          <!-- Invoice meta -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
            <tr>
              <td style="font-size:13px;color:#6b7280;">Invoice No.</td>
              <td style="font-size:13px;color:#1a2033;font-weight:600;text-align:right;">${params.invoiceNumber}</td>
            </tr>
            <tr>
              <td style="font-size:13px;color:#6b7280;padding-top:6px;">Issue Date</td>
              <td style="font-size:13px;color:#1a2033;text-align:right;padding-top:6px;">${params.issueDate}</td>
            </tr>
            <tr>
              <td style="font-size:13px;color:#6b7280;padding-top:6px;">Due Date</td>
              <td style="font-size:13px;color:#1a2033;font-weight:600;text-align:right;padding-top:6px;${params.isReminder ? "color:#dc2626;" : ""}">${params.dueDate}</td>
            </tr>
          </table>

          <!-- Line items -->
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #f0f0f0;border-radius:8px;overflow:hidden;margin-bottom:24px;">
            <thead>
              <tr style="background:#f9fafb;">
                <th style="padding:10px 12px;font-size:12px;font-weight:600;color:#6b7280;text-align:left;text-transform:uppercase;letter-spacing:0.5px;">Item</th>
                <th style="padding:10px 12px;font-size:12px;font-weight:600;color:#6b7280;text-align:center;text-transform:uppercase;letter-spacing:0.5px;">Qty</th>
                <th style="padding:10px 12px;font-size:12px;font-weight:600;color:#6b7280;text-align:right;text-transform:uppercase;letter-spacing:0.5px;">Price</th>
                <th style="padding:10px 12px;font-size:12px;font-weight:600;color:#6b7280;text-align:right;text-transform:uppercase;letter-spacing:0.5px;">Total</th>
              </tr>
            </thead>
            <tbody>${itemRows}</tbody>
            <tfoot>
              <tr style="background:#f9fafb;">
                <td colspan="3" style="padding:12px;font-size:14px;font-weight:700;color:#1a2033;text-align:right;">Amount Due</td>
                <td style="padding:12px;font-size:16px;font-weight:700;color:#1a2033;text-align:right;">${fmt(params.total)}</td>
              </tr>
            </tfoot>
          </table>

          ${pdfButton}

          <p style="margin:24px 0 0;font-size:14px;color:#6b7280;">
            If you have any questions about this invoice, please don't hesitate to contact us.
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f9fafb;padding:20px 32px;border-top:1px solid #f0f0f0;">
          <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">This is an automated email from ${businessName}.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
  }
}
