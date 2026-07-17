import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Resend } from "resend";
import * as nodemailer from "nodemailer";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../common/encryption.service";

// F6-001: SSRF guard — block private/loopback/metadata IPs as SMTP hosts.
// Tenants control smtpHost; without this guard they could point it at
// 169.254.169.254 (cloud metadata), 127.x, or internal network hosts.
const SSRF_BLOCKED_PATTERNS = [
  /^127\./, // loopback
  /^0\./, // this-network
  /^10\./, // RFC1918 class A
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC1918 class B
  /^192\.168\./, // RFC1918 class C
  /^169\.254\./, // link-local / cloud metadata endpoint
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
  /^::1$/, // IPv6 loopback
  /^fc00:/i, // IPv6 unique-local
  /^fe80:/i, // IPv6 link-local
];
const BLOCKED_SMTP_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.gce.internal",
  "169.254.169.254",
  "100.100.100.200",
]);
const ALLOWED_SMTP_PORTS = new Set([25, 465, 587, 2525]);

function assertSafeSmtpEndpoint(host: string, port: number): void {
  const h = host.toLowerCase().trim();
  if (BLOCKED_SMTP_HOSTNAMES.has(h)) {
    throw new BadRequestException("SMTP host is not permitted");
  }
  for (const pattern of SSRF_BLOCKED_PATTERNS) {
    if (pattern.test(h)) {
      throw new BadRequestException("SMTP host is not permitted");
    }
  }
  if (!ALLOWED_SMTP_PORTS.has(port)) {
    throw new BadRequestException(
      `SMTP port ${port} is not permitted. Allowed ports: 25, 465, 587, 2525`,
    );
  }
}

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

  /** AES-256-GCM storage shape (EncryptionService): IV_HEX:TAG_HEX:CIPHERTEXT_B64. */
  private static readonly ENCRYPTED_FORMAT = /^[0-9a-f]{32}:[0-9a-f]{32}:[A-Za-z0-9+/=]+$/;

  /** Decrypt a stored secret, passing through legacy plaintext (pre-F5-004 rows). */
  private decryptStoredSecret(value: string | null | undefined): string | null {
    if (!value) return null;
    if (!EmailService.ENCRYPTED_FORMAT.test(value)) return value; // legacy plaintext
    try {
      return this.encryption.decrypt(value);
    } catch {
      this.logger.error("Failed to decrypt a stored SMTP secret");
      return null;
    }
  }

  /**
   * Resolve the tenant's SMTP config. Reads the **Settings → Email** store first
   * (`SystemConfig` `email.*`, which the operator UI writes and its Test button
   * probes), then falls back to the legacy `TenantConfig` SMTP columns. Returns null
   * when neither is fully configured (host + user + password). This is the wiring
   * fix: previously the sender only read `TenantConfig`, so configuring SMTP through
   * the visible settings tab had zero effect on real delivery.
   */
  private async getTenantEmailConfig(): Promise<{
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    fromName: string | null;
    fromEmail: string | null;
  } | null> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return null;

    // 1. SystemConfig `email.*` (the Settings → Email tab).
    const rows = await this.prisma
      .forTenant()
      .systemConfig.findMany({ where: { key: { startsWith: "email." } } });
    if (rows.length) {
      const m = Object.fromEntries(rows.map((r: any) => [r.key, r.value])) as Record<
        string,
        string
      >;
      const host = m["email.smtpHost"]?.trim();
      const user = m["email.smtpUser"]?.trim();
      const pass = this.decryptStoredSecret(m["email.smtpPassword"]);
      if (host && user && pass) {
        return {
          host,
          user,
          pass,
          port: m["email.smtpPort"] ? parseInt(m["email.smtpPort"], 10) : 587,
          secure: m["email.smtpSecure"] === "true",
          fromName: m["email.fromName"]?.trim() || null,
          fromEmail: m["email.fromEmail"]?.trim() || null,
        };
      }
    }

    // 2. Legacy TenantConfig SMTP columns (backward compat).
    const cfg = await this.prisma.tenantConfig.findFirst({ where: { tenantId } });
    if (cfg?.smtpHost && cfg.smtpUser && cfg.smtpPassword) {
      const pass = this.decryptStoredSecret(cfg.smtpPassword);
      if (pass) {
        return {
          host: cfg.smtpHost,
          user: cfg.smtpUser,
          pass,
          port: cfg.smtpPort ?? 587,
          secure: cfg.smtpSecure,
          fromName: cfg.smtpFromName ?? null,
          fromEmail: cfg.smtpFromEmail ?? null,
        };
      }
    }
    return null;
  }

  /**
   * Is real email delivery available for the current tenant? True when platform
   * Resend is configured OR the tenant has SMTP set. The invoice send + settings
   * surfaces use this to warn/guide BEFORE claiming an email went out.
   */
  async isEmailConfigured(): Promise<boolean> {
    if (this.resend) return true;
    return (await this.getTenantEmailConfig()) != null;
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
    // send() is honest-by-result and never throws for a delivery/config problem.
    const result = await this.send({ to: toEmail, subject: `${businessName} — Test Email`, html });
    if (result.delivered) {
      return { success: true, message: "Test email sent successfully" };
    }
    // Generic messages (don't leak SMTP internals); the full error is logged already.
    return {
      success: false,
      message:
        result.transport === "none"
          ? "Email isn't set up yet. Add your SMTP settings below (or ask an admin to configure a platform email key), then test again."
          : "Failed to send test email. Check your SMTP host, port, username, and password.",
    };
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

  /**
   * Send an email and return an HONEST result. NEVER throws for a delivery/config
   * problem — it returns `{delivered:false, …}` instead — so fire-and-forget callers
   * (auth password-reset, account-merge) are never turned into a 500 by an
   * unconfigured or failing mail server, while callers that must confirm delivery
   * (invoice send, the settings Test button) check `delivered` and surface the truth.
   * Previously this returned success for THREE non-delivering cases (unconfigured →
   * mock, tenant-SMTP failure → fallthrough → mock, and Resend API-level rejection
   * whose `result.error` was never inspected), which is why the UI said "sent" when
   * nothing went out.
   */
  async send(params: { to: string; subject: string; html: string }): Promise<{
    delivered: boolean;
    transport: "smtp" | "resend" | "none";
    id?: string;
    error?: string;
  }> {
    // 1. Try per-tenant SMTP if configured. A config/SSRF error or send failure is
    // caught (not thrown) so we can fall back to Resend and stay honest-by-result.
    const emailCfg = await this.getTenantEmailConfig();
    let smtpError: string | undefined;
    if (emailCfg) {
      try {
        assertSafeSmtpEndpoint(emailCfg.host, emailCfg.port);
        const from = emailCfg.fromEmail
          ? emailCfg.fromName
            ? `${emailCfg.fromName} <${emailCfg.fromEmail}>`
            : emailCfg.fromEmail
          : await this.getTenantFromAddress();
        const transport = nodemailer.createTransport({
          host: emailCfg.host,
          port: emailCfg.port,
          secure: emailCfg.secure,
          auth: { user: emailCfg.user, pass: emailCfg.pass },
        });
        const info = await transport.sendMail({
          from,
          to: params.to,
          subject: params.subject,
          html: params.html,
        });
        this.logger.log(
          `Email sent via tenant SMTP to ${params.to} — messageId: ${info.messageId}`,
        );
        return { delivered: true, transport: "smtp", id: info.messageId };
      } catch (err: any) {
        smtpError = err?.message ?? "SMTP send failed";
        this.logger.error(`Tenant SMTP send failed: ${smtpError}. Falling back to Resend.`);
      }
    }

    // 2. Try platform Resend. The SDK returns `{data, error}` (it does NOT throw on an
    // API-level rejection like an unverified domain / bad key), so inspect `error`.
    if (this.resend) {
      try {
        const result = await this.resend.emails.send({
          from: this.platformFrom,
          to: params.to,
          subject: params.subject,
          html: params.html,
        });
        if ((result as any)?.error) {
          const msg = (result as any).error?.message ?? "Resend rejected the message";
          this.logger.error(`Resend rejected email to ${params.to}: ${msg}`);
          return { delivered: false, transport: "resend", error: msg };
        }
        this.logger.log(`Email sent via Resend to ${params.to} — id: ${(result.data as any)?.id}`);
        return { delivered: true, transport: "resend", id: (result.data as any)?.id };
      } catch (err: any) {
        this.logger.error(`Failed to send email to ${params.to}: ${err?.message}`);
        return {
          delivered: false,
          transport: "resend",
          error: err?.message ?? "Resend send failed",
        };
      }
    }

    // 3. No transport configured — NOT delivered (was a silent mock "success").
    this.logger.warn(
      `[EMAIL NOT SENT] To: ${params.to} | Subject: ${params.subject} — no SMTP or platform email is configured.`,
    );
    return { delivered: false, transport: emailCfg ? "smtp" : "none", error: smtpError };
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

  // ─── Buyer account merge verification email ────────────────────────────────

  async sendMergeVerificationEmail(params: {
    to: string; // secondary account's email
    primaryEmail: string; // the primary account requesting the merge
    verifyUrl: string; // one-click verification link
  }): Promise<{ delivered: boolean; transport: "smtp" | "resend" | "none"; error?: string }> {
    const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:1px solid #e5e7eb;">
  <tr><td style="background:#4f46e5;padding:24px 32px;border-radius:8px 8px 0 0;">
    <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;">RouteFlow — Account Merge Request</p>
  </td></tr>
  <tr><td style="padding:32px;">
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">Hi,</p>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">
      An account merge request has been submitted. The account signed in as <strong>${params.primaryEmail}</strong> wants
      to merge <strong>this account</strong> (${params.to}) into it. After the merge, you'll only need to use the other
      email to sign in.
    </p>
    <p style="margin:0 0 24px;font-size:15px;color:#374151;">
      If you own both accounts and want to proceed, click the button below to confirm ownership of this account.
    </p>
    <table cellpadding="0" cellspacing="0"><tr><td style="background:#4f46e5;border-radius:6px;">
      <a href="${params.verifyUrl}" style="display:inline-block;padding:12px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">
        Confirm — I own this account
      </a>
    </td></tr></table>
    <p style="margin:24px 0 0;font-size:13px;color:#9ca3af;">
      This link expires in 24 hours. If you did not request this merge, you can safely ignore this email — your account will not be affected.
    </p>
  </td></tr>
  <tr><td style="background:#f9fafb;padding:16px 32px;border-top:1px solid #f0f0f0;border-radius:0 0 8px 8px;">
    <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">RouteFlow Platform — this is an automated security email.</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

    // Return the honest send result so the caller can avoid claiming the verification
    // email "has been sent" when it hasn't (R5).
    return this.send({ to: params.to, subject: "Confirm account merge — RouteFlow", html });
  }

  // ─── Buyer account merge completion email ──────────────────────────────────

  async sendMergeCompleteEmail(params: {
    primaryEmail: string;
    secondaryEmail: string;
    primaryName: string;
  }) {
    const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:1px solid #e5e7eb;">
  <tr><td style="background:#059669;padding:24px 32px;border-radius:8px 8px 0 0;">
    <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;">RouteFlow — Accounts Merged</p>
  </td></tr>
  <tr><td style="padding:32px;">
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">Hi ${params.primaryName},</p>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">
      Your two RouteFlow buyer accounts have been successfully merged.
    </p>
    <ul style="margin:0 0 16px;padding-left:20px;font-size:15px;color:#374151;">
      <li><strong>Active account:</strong> ${params.primaryEmail}</li>
      <li><strong>Deactivated account:</strong> ${params.secondaryEmail}</li>
    </ul>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">
      All your seller connections from the deactivated account have been transferred to your active account.
      You can now sign in with <strong>${params.primaryEmail}</strong> to access everything in one place.
    </p>
    <p style="margin:0;font-size:13px;color:#9ca3af;">
      If you did not request this change, contact our support team immediately.
    </p>
  </td></tr>
  <tr><td style="background:#f9fafb;padding:16px 32px;border-top:1px solid #f0f0f0;border-radius:0 0 8px 8px;">
    <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">RouteFlow Platform — automated notification.</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

    await this.send({
      to: params.primaryEmail,
      subject: "Your accounts have been merged — RouteFlow",
      html,
    });
    // Also notify the secondary inbox (in case the buyer checks it)
    await this.send({
      to: params.secondaryEmail,
      subject: "This account has been merged — RouteFlow",
      html: html
        .replace(`Hi ${params.primaryName}`, `Hi`)
        .replace(
          `You can now sign in with <strong>${params.primaryEmail}</strong> to access everything in one place.`,
          `Please use <strong>${params.primaryEmail}</strong> to sign in going forward. This account (${params.secondaryEmail}) is now deactivated.`,
        ),
    });
  }
}
