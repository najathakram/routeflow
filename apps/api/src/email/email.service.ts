import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Resend } from "resend";
import * as nodemailer from "nodemailer";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../common/encryption.service";
import { MailboxSendService } from "./mailbox/mailbox-send.service";
// F03/R9: ONE original-price display decision shared with the PDF, so the two
// customer-facing documents of the same send can never disagree (a pure helper —
// no Nest/module coupling, and unlike ./invoice-pdf-template it is not mocked
// away under Jest).
import { showOriginalPrice } from "../invoices/invoice-pdf-item";

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

/**
 * A PERSONAL Microsoft mailbox (Outlook.com/Hotmail/Live/MSN), as opposed to a business
 * Microsoft 365 one. Microsoft permanently ended basic (password) auth for consumer
 * mailboxes on 2026-04-30 — OAuth only — so SMTP+password can never work for these, and
 * no admin setting changes that. Detected from the consumer submission host OR the
 * address domain, because operators routinely enter an @outlook.com address against
 * smtp.office365.com (our own preset used to invite exactly that).
 */
function isConsumerMicrosoftMailbox(host: string, user?: string): boolean {
  if (host.includes("smtp-mail.outlook.com")) return true;
  return /@(outlook|hotmail|live|msn)\./i.test(user ?? "");
}

/**
 * Translate a raw SMTP failure into plain-language, provider-aware guidance the
 * operator can act on. Exported for tests. The raw error is logged by the caller —
 * this string is what the settings UI shows, so it must say what to DO, not just
 * what happened. Keyed on the well-known responses of the providers tenants
 * actually use (Gmail app-passwords, Microsoft 365's disabled-by-default SMTP
 * auth) with sensible fallbacks for connection/TLS problems.
 */
export function mapSmtpError(
  err: { message?: string; code?: string; responseCode?: number } | null | undefined,
  host: string,
  port: number,
  /**
   * The mailbox being authenticated, when known. A personal Outlook.com/Hotmail/Live/MSN
   * address is UNFIXABLE over SMTP+password (Microsoft ended basic auth for consumer
   * mailboxes on 2026-04-30, OAuth only), but it's indistinguishable from a business
   * Microsoft 365 mailbox by host alone — both are commonly entered against
   * smtp.office365.com. Without this the operator is told to go ask an admin to tick a
   * box that will never help them.
   */
  user?: string,
): string {
  const msg = err?.message ?? "";
  const code = err?.code ?? "";
  const lower = msg.toLowerCase();
  const h = (host ?? "").toLowerCase();

  // Microsoft 365 / Outlook (incl. GoDaddy-M365): SMTP AUTH is disabled by default.
  if (lower.includes("smtpclientauthentication is disabled") || msg.includes("5.7.139")) {
    return (
      "Microsoft 365 is blocking SMTP sign-in for this mailbox (it's off by default). " +
      "An admin must enable 'Authenticated SMTP' for the mailbox: Microsoft 365 admin center → " +
      "Users → Active users → select the user → Mail → Manage email apps → tick 'Authenticated SMTP'. " +
      "Wait a few minutes, then test again."
    );
  }
  if (lower.includes("basic authentication is disabled") || lower.includes("basic auth")) {
    return (
      "This mailbox has basic (password) sign-in disabled. For a BUSINESS Microsoft 365 mailbox an admin " +
      "can enable 'Authenticated SMTP' for it (and must turn off tenant security defaults). For a PERSONAL " +
      "Outlook.com/Hotmail/Live/MSN address there is no fix — Microsoft ended password sign-in for those on " +
      "30 April 2026 and now requires OAuth, so send from Gmail or another SMTP provider instead."
    );
  }

  // STARTTLS unavailable on port 587 with requireTLS set: nodemailer either fails the
  // EHLO ("does not support required STARTTLS") or the STARTTLS command itself (code
  // ETLS). Either way the server can't do the upgrade we now insist on — checked BEFORE
  // the generic certificate/ssl/tls fallback below, since that fallback's substring
  // match on "tls" would otherwise swallow this case under a less actionable message.
  if (code === "ETLS" || lower.includes("starttls")) {
    return (
      "The mail server didn't offer a secure connection on port 587 — check the host, or use " +
      "port 465 with the secure toggle ON."
    );
  }

  // Gmail: normal passwords are always rejected — an App Password is required.
  if (lower.includes("application-specific password") || msg.includes("5.7.9")) {
    return (
      "Google rejected this password because Gmail requires an App Password for SMTP (your normal " +
      "password won't work). Turn on 2-Step Verification, then create one at " +
      "myaccount.google.com/apppasswords and paste the 16-character code here."
    );
  }
  if (code === "EAUTH" || msg.includes("535") || lower.includes("password not accepted")) {
    const hint = h.includes("gmail")
      ? " Gmail needs an App Password (myaccount.google.com/apppasswords), not your normal password."
      : isConsumerMicrosoftMailbox(h, user)
        ? " Personal Outlook.com/Hotmail/Live/MSN addresses can no longer send over SMTP with a password — " +
          "Microsoft ended that on 30 April 2026 and now requires OAuth. Send from Gmail or another SMTP provider instead."
        : h.includes("office365") || h.includes("outlook")
          ? " For a business Microsoft 365 mailbox, an admin must enable 'Authenticated SMTP' for it and turn off tenant security defaults."
          : "";
    return `The email address or password wasn't accepted by the mail server.${hint} Double-check both and try again.`;
  }

  // Connection-level problems: wrong host, wrong port, or a TLS mismatch.
  if (code === "EDNS" || code === "ENOTFOUND" || lower.includes("getaddrinfo")) {
    return `The mail server "${host}" couldn't be found — check the SMTP host name.`;
  }
  if (
    code === "ETIMEDOUT" ||
    code === "ESOCKET" ||
    code === "ECONNECTION" ||
    code === "ECONNREFUSED" ||
    lower.includes("timeout")
  ) {
    return (
      `Couldn't reach ${host}:${port}. Check the host and port — the usual pairs are ` +
      "port 587 with the secure toggle OFF (STARTTLS) or port 465 with it ON (SSL)."
    );
  }
  if (lower.includes("certificate") || lower.includes("ssl") || lower.includes("tls")) {
    return (
      "Secure-connection mismatch with the mail server. Try port 587 with the secure toggle OFF, " +
      "or port 465 with it ON."
    );
  }

  // Fallback for uncovered codes (EHOSTUNREACH, ENETUNREACH, ECONNRESET, …). Node embeds
  // the RESOLVED ip:port in these messages (e.g. "connect EHOSTUNREACH 10.0.1.4:587"); since
  // the tenant controls the host, this endpoint must not become an internal-network probe
  // that echoes back resolved private IPs — redact any address literal before surfacing it.
  const safe = redactAddresses(msg);
  return safe ? `The mail server refused the connection: ${safe}` : "The connection test failed.";
}

/**
 * Strip IPv4/IPv6 address literals from an error string (see mapSmtpError fallback).
 * The IPv6 pattern is intentionally NOT \b-anchored at the start and requires ≥2 colon
 * groups: that catches "::"-compressed forms Node actually emits (e.g. "::1:587",
 * ":::53408" for the unspecified address), which a \b-anchored, single-group-minimum
 * pattern would miss. Quantifiers stay bounded ({0,4}/{2,8}) so there is no ReDoS risk,
 * and over-redaction of address-shaped tokens in this fallback branch is acceptable.
 */
function redactAddresses(msg: string): string {
  return msg
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[address]") // IPv4 (and IPv4-mapped tail)
    .replace(/(?:[0-9a-f]{0,4}:){2,8}[0-9a-f]{0,4}/gi, "[address]"); // IPv6 incl. ::-compressed
}

/**
 * N4 ground rule: every interpolated value in a NEW email template must be
 * HTML-escaped — none of the existing templates in this file do (their
 * inputs are operator/tenant-typed strings from an already-authenticated
 * session, an accepted pre-existing gap, not this PR's to fix), but a
 * low-stock digest interpolates PRODUCT NAMES, which a tenant's own staff
 * can set to arbitrary text via the catalogue import/edit flow.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Platform-level Google Workspace SMTP config (B452, owner ruling 2026-09-16). */
interface PlatformSmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

/** Shared card/header/footer shell for the N2 account-notification templates — same
 *  visual grammar as sendMergeVerificationEmail/sendMergeCompleteEmail (page background,
 *  rounded white card, colored header bar, light-gray footer), factored out once here
 *  since N2 adds four templates rather than one. Not a rewrite of buildInvoiceEmail's own
 *  shell — that one stays as-is for invoices. */
function renderEmailShell(params: {
  headerColor: string;
  headerTitle: string;
  bodyHtml: string;
}): string {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:1px solid #e5e7eb;">
  <tr><td style="background:${params.headerColor};padding:24px 32px;border-radius:8px 8px 0 0;">
    <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;">${params.headerTitle}</p>
  </td></tr>
  <tr><td style="padding:32px;">
    ${params.bodyHtml}
  </td></tr>
  <tr><td style="background:#f9fafb;padding:16px 32px;border-top:1px solid #f0f0f0;border-radius:0 0 8px 8px;">
    <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">RouteFlow Platform — this is an automated account email.</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly resend: Resend | null;
  /**
   * Platform-level SMTP (Google Workspace mailbox), set from SMTP_HOST/PORT/SECURE/
   * USER/PASS. This is the platform transport per the owner's 2026-09-16 ruling
   * ("RouteFlow's mail is on Google, not Resend") — selected instead of Resend
   * whenever SMTP_HOST is set; Resend remains an alternative for when it isn't.
   * The two are never both active for the same send (see constructor).
   */
  private readonly platformSmtp: PlatformSmtpConfig | null;
  private readonly platformFrom: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly mailboxSend: MailboxSendService,
  ) {
    const apiKey = this.config.get<string>("RESEND_API_KEY");

    // Platform SMTP requires ALL THREE of host/user/pass — a partial config (e.g. an
    // env var typo dropping SMTP_USER) must never half-activate: previously `SMTP_HOST`
    // alone was enough to disable Resend and report "configured" while every real send
    // 535'd on empty credentials. `smtpFullyConfigured` gates BOTH which transport wins
    // below AND the EMAIL_FROM derivation right after it.
    const smtpHost = this.config.get<string>("SMTP_HOST");
    const smtpUser = this.config.get<string>("SMTP_USER");
    const smtpPass = this.config.get<string>("SMTP_PASS");
    const smtpFullyConfigured = !!(smtpHost && smtpUser && smtpPass);
    if (smtpHost && !smtpFullyConfigured) {
      this.logger.error(
        "SMTP_HOST is set but SMTP_USER/SMTP_PASS are missing — ignoring platform SMTP " +
          "and falling back to Resend (or logging-only if that isn't set either).",
      );
    }

    // Platform verified sending address. With platform SMTP this MUST be the
    // authenticated Google Workspace mailbox (SMTP_USER); with Resend it must be on a
    // domain verified in Resend. Per-tenant sends swap the display name for the
    // tenant's business name and set Reply-To to the tenant's own email (see
    // getResendFrom/getReplyTo/getTenantFromAddress/getPlatformSmtpFrom). If platform
    // SMTP is active but EMAIL_FROM was never set, defaulting to the Resend-shaped
    // literal would send from an address that doesn't match the authenticated mailbox
    // — a guaranteed SPF/DKIM misalignment — so derive it from SMTP_USER instead.
    const rawEmailFrom = this.config.get<string>("EMAIL_FROM");
    if (smtpFullyConfigured && !rawEmailFrom) {
      this.platformFrom = `RouteFlow <${smtpUser}>`;
      this.logger.error(
        `EMAIL_FROM is not set while platform SMTP is configured — using the authenticated ` +
          `mailbox (${smtpUser}) as the sender so SPF/DKIM stay aligned. Set EMAIL_FROM ` +
          "explicitly to control the display name.",
      );
    } else {
      this.platformFrom = rawEmailFrom ?? "RouteFlow <invoices@send.routeflow.info>";
    }

    if (smtpFullyConfigured) {
      // Platform SMTP wins when fully configured — never run both transports for the
      // same platform send.
      this.platformSmtp = {
        host: smtpHost!,
        port: this.parseSmtpPort(this.config.get<string>("SMTP_PORT")),
        secure: this.parseSmtpSecure(this.config.get<string>("SMTP_SECURE")),
        user: smtpUser!,
        pass: smtpPass!,
      };
      this.resend = null;
      this.logger.log("Email service initialised (platform SMTP)");
    } else if (apiKey) {
      this.platformSmtp = null;
      this.resend = new Resend(apiKey);
      this.logger.log("Email service initialised (Resend)");
    } else {
      this.platformSmtp = null;
      this.resend = null;
      this.logger.warn(
        "Neither SMTP_HOST nor RESEND_API_KEY is set — emails will be logged only. " +
          "Set one to enable real platform delivery.",
      );
    }
  }

  /** SMTP_PORT parsing shared with check-email-sender.mjs: any positive integer, else 587. */
  private parseSmtpPort(raw: string | undefined): number {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : 587;
  }

  /** SMTP_SECURE parsing shared with check-email-sender.mjs: true/1/yes, case-insensitive. */
  private parseSmtpSecure(raw: string | undefined): boolean {
    return /^(true|1|yes)$/i.test(raw ?? "");
  }

  /**
   * Strip characters that could break out of a `Name <addr>` From/Reply-To
   * header. `\r`/`\n` are the CRLF-injection vector — a tenant business name
   * containing them could otherwise smuggle a second header (e.g. a forged
   * `Bcc:`) into the raw message; `["<>]` guard the `Name <addr>` quoting
   * itself.
   */
  private sanitizeDisplayName(name: string): string {
    return name
      .replace(/["<>]/g, "")
      .replace(/[\r\n]+/g, " ")
      .trim();
  }

  /**
   * Build a nodemailer transport with the shared fail-fast timeouts + fail-secure
   * STARTTLS behaviour used by every SMTP send path (tenant SMTP, platform SMTP).
   * `mapSmtpError`'s provider-aware guidance (Gmail app-passwords, M365 Authenticated
   * SMTP, …) is applied by each caller's catch block, not here.
   */
  private createSendTransport(
    host: string,
    port: number,
    secure: boolean,
    user: string,
    pass: string,
  ) {
    return nodemailer.createTransport({
      host,
      port,
      secure,
      // A 587 server that won't offer STARTTLS would otherwise hand the password
      // over in cleartext — refuse instead of silently degrading.
      requireTLS: port === 587 && !secure,
      auth: { user, pass },
      // Fail fast — invoice send/download UX awaits this round-trip.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      dnsTimeout: 10_000,
    });
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
   * Is real email delivery available for the current tenant? True when a platform
   * transport (SMTP or Resend) is configured OR the tenant has SMTP set. The
   * invoice send + settings surfaces use this to warn/guide BEFORE claiming an
   * email went out.
   */
  async isEmailConfigured(): Promise<boolean> {
    if (this.resend || this.platformSmtp) return true;
    return (await this.getTenantEmailConfig()) != null;
  }

  /**
   * The From header for a tenant's email sent via the TENANT'S OWN SMTP
   * transport, when no `smtpFromEmail` is configured. `smtpUser` — the
   * mailbox the tenant's SMTP server actually authenticated as — is the
   * fallback address, NOT the platform's: the message is physically
   * transmitted through the tenant's own mail server, so claiming the
   * platform's `EMAIL_FROM` address here is exactly the SPF/DKIM/DMARC
   * misalignment those checks exist to catch (B452 followups (c) — this
   * used to fall back to the platform's verified address; before that, an
   * even worse hard-coded "noreply@routeflow.app", a domain RouteFlow
   * doesn't even own).
   */
  private async getTenantFromAddress(smtpUser: string): Promise<string> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return smtpUser;

    const cfg = await this.prisma.tenantConfig.findFirst({ where: { tenantId } });
    if (cfg?.smtpFromEmail) {
      return cfg.smtpFromName ? `${cfg.smtpFromName} <${cfg.smtpFromEmail}>` : cfg.smtpFromEmail;
    }
    // The name is sanitized — an unescaped businessName here is a From-header
    // injection vector (e.g. `Acme <evil@attacker.com>` becomes the real From).
    const businessName = cfg?.businessName ? this.sanitizeDisplayName(cfg.businessName) : "";
    return businessName ? `${businessName} <${smtpUser}>` : smtpUser;
  }

  /**
   * The From header for a tenant's email sent via the PLATFORM SMTP transport:
   * `"<Business Name> via RouteFlow" <authenticated platform mailbox>`. Unlike Resend,
   * platform SMTP is a single authenticated Google Workspace mailbox — a tenant's
   * verified own-domain (Resend domains API) cannot be used here, only the display
   * name changes; the address is always the authenticated mailbox so SPF/DKIM/DMARC
   * alignment holds. Used when a tenant has no SMTP of their own configured, so the
   * platform sends on their behalf — mirrors getResendFrom()'s branding but without
   * the Resend-only own-domain lookup.
   */
  private async getPlatformSmtpFrom(): Promise<string> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return this.platformFrom;
    const cfg = await this.prisma.tenantConfig.findFirst({ where: { tenantId } });
    const businessName = cfg?.businessName ? this.sanitizeDisplayName(cfg.businessName) : "";
    return businessName
      ? `${businessName} via RouteFlow <${this.addressOf(this.platformFrom)}>`
      : this.platformFrom;
  }

  /**
   * The tenant's display name for outbound email, "RouteFlow" when there's no
   * tenant context or no businessName configured. Public (N1) — EmailChannelProvider
   * (the messaging engine's EMAIL transport) calls this to brand order-status/POD
   * notification emails the same way invoice emails are branded, rather than
   * hard-coding "RouteFlow" for every tenant.
   */
  async getTenantBusinessName(): Promise<string> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return "RouteFlow";
    const cfg = await this.prisma.tenantConfig.findFirst({ where: { tenantId } });
    return cfg?.businessName ?? "RouteFlow";
  }

  // ─── Transactional From-identity (Resend) ──────────────────────────────────

  /** Extract the bare address from a `Name <addr@x>` (or plain `addr@x`) header. */
  private addressOf(fromHeader: string): string {
    const m = fromHeader.match(/<([^>]+)>/);
    return (m ? m[1] : fromHeader).trim();
  }

  /**
   * A verified per-tenant OWN-domain from-address, or null. Reads the sending-domain
   * config that the domain-verification flow persists once Resend reports the domain
   * `verified` and the operator picked a from-address (SystemConfig `email.sendingDomain`).
   * Null until a tenant sets up + verifies their own domain — the platform address is
   * used in that case.
   */
  private async getVerifiedOwnDomainFrom(): Promise<string | null> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return null;
    const row = await this.prisma
      .forTenant()
      .systemConfig.findFirst({ where: { key: "email.sendingDomain" } });
    if (!row?.value) return null;
    try {
      const cfg = JSON.parse(row.value) as { status?: string; fromAddress?: string };
      if (cfg.status === "verified" && cfg.fromAddress) return cfg.fromAddress;
    } catch {
      /* corrupt config → fall back to the platform address */
    }
    return null;
  }

  /**
   * The From header for a tenant's transactional email via Resend:
   * `"<Business Name>" <verified sending address>`. Uses the tenant's own verified
   * domain address when set up, else the platform verified address (EMAIL_FROM). The
   * address MUST be on a domain verified in Resend or the send is rejected — that's
   * why we never send from a raw tenant mailbox here (deliverability), only set the
   * display name + Reply-To to identify the business.
   */
  private async getResendFrom(): Promise<string> {
    const businessName = this.sanitizeDisplayName(await this.getTenantBusinessName());
    const address = (await this.getVerifiedOwnDomainFrom()) ?? this.addressOf(this.platformFrom);
    return businessName ? `${businessName} <${address}>` : address;
  }

  /**
   * Reply-To for tenant email — the business's own email, so a customer replying to an
   * invoice reaches the tenant, not the platform sending domain. Uses the customer-
   * facing email, falling back to the tenant's configured From email, then the tenant
   * admin's own login email; undefined only when none of those exist (replies then go
   * to the sending address).
   */
  private async getReplyTo(): Promise<string | undefined> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return undefined;
    const cfg = await this.prisma.tenantConfig.findFirst({ where: { tenantId } });
    const configured = cfg?.customerEmail?.trim() || cfg?.smtpFromEmail?.trim();
    if (configured) return configured;
    const admin = await this.prisma.user.findFirst({
      where: { tenantId, role: "TENANT_ADMIN", deletedAt: null, status: "ACTIVE" },
      // Deterministic pick among multiple ACTIVE admins — the longest-tenured
      // one, not whatever order the DB happens to return.
      orderBy: { createdAt: "asc" },
      select: { email: true },
    });
    return admin?.email?.trim() || undefined;
  }

  // ─── Per-tenant sending-domain verification (Resend domains API, Phase 2) ────
  // Lets a tenant send from THEIR OWN domain (any address on it) with proper SPF/DKIM
  // instead of a shared platform address. Config is stored (non-secret — the DNS
  // records + from-address are public) under SystemConfig `email.sendingDomain`:
  //   { domain, resendId, status, records[], fromAddress }

  private static readonly SENDING_DOMAIN_KEY = "email.sendingDomain";

  /** Normalize Resend's domain status to our small enum. */
  private mapDomainStatus(s: unknown): "pending" | "verified" | "failed" {
    const v = (typeof s === "string" ? s : "").toLowerCase();
    if (v === "verified") return "verified";
    if (v.includes("fail")) return "failed";
    return "pending";
  }

  /** Normalize Resend's records array to a stable DNS-record shape for the UI. */
  private mapDomainRecords(records: any): Array<{
    record: string;
    type: string;
    name: string;
    value: string;
    priority?: number;
    status?: string;
  }> {
    if (!Array.isArray(records)) return [];
    return records.map((r: any) => ({
      record: r.record ?? r.type ?? "",
      type: r.type ?? "",
      name: r.name ?? "",
      value: r.value ?? "",
      ...(r.priority != null ? { priority: Number(r.priority) } : {}),
      ...(r.status ? { status: String(r.status) } : {}),
    }));
  }

  private async readSendingDomainConfig(): Promise<{
    domain: string;
    resendId: string;
    status: "pending" | "verified" | "failed";
    records: any[];
    fromAddress: string | null;
  } | null> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return null;
    const row = await this.prisma
      .forTenant()
      .systemConfig.findFirst({ where: { key: EmailService.SENDING_DOMAIN_KEY } });
    if (!row?.value) return null;
    try {
      const cfg = JSON.parse(row.value);
      return cfg && cfg.domain ? cfg : null;
    } catch {
      return null;
    }
  }

  private async writeSendingDomainConfig(cfg: object | null): Promise<void> {
    const key = EmailService.SENDING_DOMAIN_KEY;
    const value = JSON.stringify(cfg);
    const existing = await this.prisma.forTenant().systemConfig.findFirst({ where: { key } });
    if (existing) {
      await this.prisma
        .forTenant()
        .systemConfig.update({ where: { id: existing.id }, data: { value } });
    } else {
      await (this.prisma.forTenant().systemConfig.create as any)({ data: { key, value } });
    }
  }

  /** Current sending-domain state for the settings UI. */
  async getSendingDomainStatus(): Promise<{
    platformConfigured: boolean;
    domain: string | null;
    status: "none" | "pending" | "verified" | "failed";
    records: any[];
    fromAddress: string | null;
  }> {
    const cfg = await this.readSendingDomainConfig();
    return {
      // Either platform transport counts as "platform email is set up" — own-domain
      // sending itself remains Resend-only (enforced in addSendingDomain below).
      platformConfigured: !!(this.resend || this.platformSmtp),
      domain: cfg?.domain ?? null,
      status: cfg?.status ?? "none",
      records: cfg?.records ?? [],
      fromAddress: cfg?.fromAddress ?? null,
    };
  }

  /**
   * Register the tenant's sending domain with Resend and store the DNS records to add.
   * Own-domain sending is a Resend-only feature — platform SMTP is a single
   * authenticated Google Workspace mailbox and can never send as another domain, so
   * that case gets its own explanation rather than the generic "not set up" message.
   */
  async addSendingDomain(domain: string) {
    if (!this.resend) {
      if (this.platformSmtp) {
        throw new BadRequestException(
          "Own-domain sending is a Resend-only feature — platform email is currently routed " +
            "through Google Workspace SMTP, a single authenticated mailbox that can't send as " +
            "another domain. Set RESEND_API_KEY (and unset SMTP_HOST) to use your own domain.",
        );
      }
      throw new BadRequestException(
        "Platform email isn't set up yet. An admin must set RESEND_API_KEY before verifying a domain.",
      );
    }
    const name = (domain ?? "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name)) {
      throw new BadRequestException("Enter a valid domain, e.g. mail.yourbusiness.com");
    }
    const res: any = await this.resend.domains.create({ name });
    if (res?.error) {
      throw new BadRequestException(res.error?.message ?? "Resend couldn't add this domain.");
    }
    const d = res?.data ?? {};
    await this.writeSendingDomainConfig({
      domain: name,
      resendId: d.id ?? "",
      status: this.mapDomainStatus(d.status),
      records: this.mapDomainRecords(d.records),
      fromAddress: null,
    });
    return this.getSendingDomainStatus();
  }

  /** Re-fetch the domain's status + records from Resend (poll after adding DNS). */
  async refreshSendingDomain() {
    const cfg = await this.readSendingDomainConfig();
    if (!cfg?.resendId || !this.resend) return this.getSendingDomainStatus();
    const res: any = await this.resend.domains.get(cfg.resendId);
    const d = res?.data;
    if (d) {
      cfg.status = this.mapDomainStatus(d.status);
      const recs = this.mapDomainRecords(d.records);
      if (recs.length) cfg.records = recs;
      await this.writeSendingDomainConfig(cfg);
    }
    return this.getSendingDomainStatus();
  }

  /** Ask Resend to verify the domain (checks DNS), then refresh the stored status. */
  async verifySendingDomain() {
    const cfg = await this.readSendingDomainConfig();
    if (!cfg?.resendId || !this.resend) {
      throw new BadRequestException("Add a sending domain first.");
    }
    const res: any = await this.resend.domains.verify(cfg.resendId);
    if (res?.error) {
      throw new BadRequestException(res.error?.message ?? "Verification couldn't be started.");
    }
    return this.refreshSendingDomain();
  }

  /** Choose the from-address on the verified domain (any address on it). */
  async setSendingFromAddress(address: string) {
    const cfg = await this.readSendingDomainConfig();
    if (!cfg || cfg.status !== "verified") {
      throw new BadRequestException("Verify your domain before choosing a From address.");
    }
    const addr = (address ?? "").trim().toLowerCase();
    if (!addr.includes("@") || !addr.endsWith(`@${cfg.domain}`)) {
      throw new BadRequestException(
        `The From address must be on ${cfg.domain} — e.g. invoices@${cfg.domain}`,
      );
    }
    cfg.fromAddress = addr;
    await this.writeSendingDomainConfig(cfg);
    return this.getSendingDomainStatus();
  }

  /** Remove the tenant's sending domain (reverts to the platform address). */
  async removeSendingDomain() {
    const cfg = await this.readSendingDomainConfig();
    if (cfg?.resendId && this.resend) {
      try {
        await this.resend.domains.remove(cfg.resendId);
      } catch {
        /* already gone / transient — clear locally regardless */
      }
    }
    await this.writeSendingDomainConfig(null);
    return this.getSendingDomainStatus();
  }

  // ─── Verify SMTP connection (pre-save) ─────────────────────────────────────

  /**
   * Do a REAL SMTP handshake + login with the given (possibly unsaved) settings and
   * report the result in plain language — so a tenant knows their credentials work
   * BEFORE saving, instead of discovering a typo on the first invoice send. When
   * `password` is blank, falls back to the tenant's saved password (lets them re-test
   * after saving without retyping). Never throws for a connection problem; the SSRF
   * guard's rejection is also returned as a friendly failure.
   */
  async verifySmtpConnection(candidate: {
    host?: string;
    port?: number;
    secure?: boolean;
    user?: string;
    password?: string;
  }): Promise<{ ok: boolean; message: string }> {
    const host = candidate.host?.trim() ?? "";
    const user = candidate.user?.trim() ?? "";
    const port = Number(candidate.port ?? 587);
    let pass = candidate.password ?? "";
    if (!pass) {
      const saved = await this.getTenantEmailConfig();
      // Only reuse the saved password when it belongs to the same mailbox+server —
      // a saved Gmail password must not be replayed against a newly-typed host.
      if (saved && saved.host === host && saved.user === user) pass = saved.pass;
    }
    if (!host || !user || !pass) {
      return {
        ok: false,
        message: "Enter the SMTP host, email address, and password first, then test again.",
      };
    }

    try {
      assertSafeSmtpEndpoint(host, port);
    } catch (err: any) {
      return { ok: false, message: err?.message ?? "SMTP host is not permitted" };
    }

    try {
      const secure = !!candidate.secure;
      const transport = nodemailer.createTransport({
        host,
        port,
        secure,
        // A 587 server that won't offer STARTTLS would otherwise hand the tenant's
        // password over in cleartext — refuse instead of silently degrading. Every
        // mainstream host (Gmail, M365) offers STARTTLS on 587; 465 already implies
        // TLS-from-connect (secure:true) so this only applies to the STARTTLS pairing.
        requireTLS: port === 587 && !secure,
        auth: { user, pass },
        // Fail fast — the settings UI is waiting on this round-trip.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
      });
      await transport.verify();
      return { ok: true, message: "Connection successful — your credentials were accepted." };
    } catch (err: any) {
      this.logger.warn(`SMTP verify failed for ${host}:${port} — ${err?.message}`);
      return { ok: false, message: mapSmtpError(err, host, port, user) };
    }
  }

  // ─── Send test email ───────────────────────────────────────────────────────

  async sendTestEmail(toEmail: string): Promise<{ success: boolean; message: string }> {
    const businessName = await this.getTenantBusinessName();
    const html = `<p>This is a test email from ${businessName}. Your SMTP configuration is working correctly.</p>`;
    // send() is honest-by-result and never throws for a delivery/config problem.
    const result = await this.send({ to: toEmail, subject: `${businessName} — Test Email`, html });

    if (result.delivered) {
      // Resend rescued a failing tenant SMTP attempt: the test mail DID arrive (say so
      // honestly), but stay quiet about nothing else — the tenant's own SMTP is still
      // broken and this is the one place they'll find out, so append the mapped reason.
      if (result.smtpFallbackReason) {
        return {
          success: true,
          message: `Test email delivered via RouteFlow's mail service — but your own SMTP failed: ${result.smtpFallbackReason}`,
        };
      }
      return { success: true, message: "Test email sent successfully" };
    }

    // Not delivered. Prefer the mapped SMTP diagnostic — the same one /email/verify
    // shows — over a generic message whenever the SMTP attempt actually produced one.
    if (result.smtpFallbackReason) {
      return { success: false, message: result.smtpFallbackReason };
    }
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
    /**
     * Structured "Net 30"-style label, persisted alongside the due date so the
     * two can never disagree. Undefined/null on historical invoices predating
     * this field — renders nothing beside the due date.
     */
    paymentTermsLabel?: string | null;
    total: number;
    /**
     * CONFIRMED (PAID)-basis amount already collected (F03/R8) — mirrors the
     * PDF's Amount Paid. Undefined on a caller that hasn't been updated yet;
     * the tfoot then falls back to a single "Amount Due" = `total` row (the
     * pre-F03 rendering) instead of a misleading $0-paid line.
     * B421: cash-only — a CREDIT_NOTE or ADVANCE application must never
     * render here, which is exactly the client's original complaint reaching
     * an email sent to their own customer.
     */
    totalPaid?: number;
    /** Confirmed CREDIT_NOTE applications (B421) — reduces balanceDue but is
     *  never cash the customer paid; rendered as its own neutral line. */
    creditApplied?: number;
    /** Confirmed ADVANCE applications (B421) — same treatment. */
    advanceApplied?: number;
    /** Credit note numbers backing `creditApplied` (B421) — "Credit issued —
     *  CN-…". Empty/absent renders the line without a number. */
    creditNoteNumbers?: string[];
    /**
     * CONFIRMED-basis outstanding balance (F03/R8) — what a reminder must
     * demand. NEVER pass `total` here: dunning a customer for the full amount
     * after they've already paid part of it is exactly the bug this exists to
     * kill (B102).
     */
    balanceDue?: number;
    items: {
      description: string;
      qty: number;
      unitPrice: number;
      subtotal: number;
      /** Suggested retail price snapshot, per PIECE — display-only, null renders nothing. */
      msrp?: number | null;
      /**
       * Pre-promo/pre-adjustment per-unit price, for the strikethrough (F03/R9)
       * — null/undefined renders no strike. Mirrors the web invoice detail
       * renderer and the PDF's `showOriginalPrice` (a MANUAL upsell — unitPrice
       * ABOVE originalPrice — never shows it).
       */
      originalPrice?: number | null;
      priceType?: string | null;
      /** BUY_N_GET_M free units on this line — null/0 renders no note. */
      promoFreeUnits?: number | null;
    }[];
    pdfUrl?: string;
    isReminder?: boolean;
    /**
     * The tenant's `invoice.hideOriginalPrice` setting (F03/R9), passed in by the
     * caller exactly as the PDF payload carries it. True suppresses EVERY
     * strikethrough: the attached PDF and the web detail page already honour it,
     * so without it this body would be the one place a tenant's hidden pre-promo
     * price leaks to the buyer.
     */
    hideOriginalPrice?: boolean;
    /** Deposit schedule (display-only, derived server-side) — null/absent renders nothing. */
    depositAmount?: number | null;
    depositDueDate?: string | null;
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
  async send(params: {
    to: string;
    subject: string;
    html: string;
    replyTo?: string;
    /** Plain-text alternative (added independently by both N1 and N3 — same field,
     *  reconciled on merge). Both nodemailer and Resend accept it alongside `html`;
     *  email clients that can't/won't render HTML fall back to this. Optional so every
     *  EXISTING caller is unaffected — a transport that doesn't get one just sends
     *  HTML-only, same as before this field existed. */
    text?: string;
    /**
     * email-connect-google PR-3 (security review Phase 2): `"platform"` DELEGATES the whole
     * send to `sendPlatform()` — bare platform From, no tenant Reply-To, no tenant domain, no
     * connected mailbox, no tenant SMTP. Security/platform mail (invites, password reset/set,
     * verification, new-device, email/role-change notices) must never leave from a tenant's
     * own mailbox or SMTP server, or carry a tenant's own branding. Every EXISTING caller
     * omits this (defaults to tenant-eligible), so no prior behavior changes except for the
     * specific call sites migrated to `"platform"`.
     */
    senderClass?: "tenant" | "platform";
  }): Promise<{
    delivered: boolean;
    transport: "mailbox" | "smtp" | "resend" | "none";
    id?: string;
    error?: string;
    /**
     * The mapped, plain-language SMTP diagnostic — set whenever the tenant's OWN SMTP
     * attempt failed, in EVERY branch that follows the catch (Resend rescue, Resend
     * rejection, no-transport). This is what lets a Resend-rescued send still tell the
     * operator their own mail is broken instead of quietly looking fine.
     */
    smtpFallbackReason?: string;
    /**
     * The bare platform address actually used, set alongside `smtpFallbackReason` on a
     * Resend rescue — the From identity silently changed from the tenant's own mailbox
     * to the platform address, and that's part of the disclosure, not a footnote.
     */
    fromAddress?: string;
  }> {
    // Security review Phase 2: a platform-class send is a full DELEGATION to `sendPlatform()`
    // — not a set of skipped branches inside this method. `sendPlatform` never resolves
    // tenant SMTP, a tenant's own Reply-To, or a tenant's connected mailbox; it always uses
    // the bare platform From. This also means it never reads `prisma.getTenantId()`, so an
    // in-request platform send (e.g. an admin's own action triggering a security notice)
    // cannot accidentally pick up THEIR tenant's own anything.
    if (params.senderClass === "platform") {
      return this.sendPlatform({
        to: params.to,
        subject: params.subject,
        html: params.html,
        text: params.text,
        replyTo: params.replyTo,
      });
    }

    // Reply-To = the business's own email so customer replies reach the tenant, not the
    // (platform) sending address. Applies to every transport, including the mailbox.
    const replyTo = params.replyTo ?? (await this.getReplyTo());

    // 0. Leading branch (PR-3, no parallel path — every other branch is unchanged): a
    // CONNECTED (or THROTTLED-but-past-its-window) tenant Google mailbox sends first.
    // `MailboxSendService.trySend` never throws and returns delivered:false for "not
    // applicable" (no connection, REVOKED, still THROTTLED, a refresh failure, or a Gmail API
    // error) — every one of those falls through to the existing tenant-SMTP → platform-SMTP →
    // Resend chain below, unchanged.
    const tenantId = this.prisma.getTenantId();
    if (tenantId) {
      const businessName = this.sanitizeDisplayName(await this.getTenantBusinessName());
      const mailboxResult = await this.mailboxSend.trySend(tenantId, {
        to: params.to,
        subject: params.subject,
        html: params.html,
        text: params.text,
        replyTo,
        fromName: businessName || undefined,
      });
      if (mailboxResult.delivered) {
        return {
          delivered: true,
          transport: "mailbox",
          id: mailboxResult.id,
          fromAddress: mailboxResult.fromAddress,
        };
      }
    }

    // 1. Try per-tenant SMTP if configured. A config/SSRF error or send failure is
    // caught (not thrown) so we can fall back to Resend and stay honest-by-result.
    const emailCfg = await this.getTenantEmailConfig();
    let smtpError: string | undefined;
    let smtpFallbackReason: string | undefined;
    if (emailCfg) {
      try {
        assertSafeSmtpEndpoint(emailCfg.host, emailCfg.port);
        const from = emailCfg.fromEmail
          ? emailCfg.fromName
            ? `${emailCfg.fromName} <${emailCfg.fromEmail}>`
            : emailCfg.fromEmail
          : await this.getTenantFromAddress(emailCfg.user);
        const transport = this.createSendTransport(
          emailCfg.host,
          emailCfg.port,
          emailCfg.secure,
          emailCfg.user,
          emailCfg.pass,
        );
        const info = await transport.sendMail({
          from,
          to: params.to,
          subject: params.subject,
          html: params.html,
          text: params.text,
          replyTo,
        });
        this.logger.log(
          `Email sent via tenant SMTP to ${params.to} — messageId: ${info.messageId}`,
        );
        return { delivered: true, transport: "smtp", id: info.messageId };
      } catch (err: any) {
        const rawMessage: string = err?.message ?? "SMTP send failed";
        smtpError = rawMessage;
        smtpFallbackReason = mapSmtpError(err, emailCfg.host, emailCfg.port, emailCfg.user);
        this.logger.error(
          `Tenant SMTP send failed [code=${err?.code ?? "unknown"}` +
            `${err?.responseCode ? ` responseCode=${err.responseCode}` : ""}]: ` +
            `${redactAddresses(rawMessage)}. Falling back to Resend. Mapped reason: ${smtpFallbackReason}`,
        );
      }
    }

    // 2. Try platform SMTP (Google Workspace mailbox) — the platform transport per the
    // owner's 2026-09-16 ruling. Mutually exclusive with Resend (constructor picks one),
    // so there is no cascading fallback between the two platform transports here. No
    // SSRF guard here (unlike tenant SMTP): host/port come from owner-set env vars, not
    // tenant-controlled input, and the local dev target (mailpit on port 1025) isn't in
    // the tenant-facing ALLOWED_SMTP_PORTS allow-list.
    if (this.platformSmtp) {
      try {
        const transport = this.createSendTransport(
          this.platformSmtp.host,
          this.platformSmtp.port,
          this.platformSmtp.secure,
          this.platformSmtp.user,
          this.platformSmtp.pass,
        );
        const from = await this.getPlatformSmtpFrom();
        const info = await transport.sendMail({
          from,
          to: params.to,
          subject: params.subject,
          html: params.html,
          replyTo,
        });
        this.logger.log(
          `Email sent via platform SMTP to ${params.to} — messageId: ${info.messageId}`,
        );
        return {
          delivered: true,
          transport: "smtp",
          id: info.messageId,
          smtpFallbackReason,
          fromAddress: smtpFallbackReason ? this.addressOf(from) : undefined,
        };
      } catch (err: any) {
        const rawMessage: string = err?.message ?? "Platform SMTP send failed";
        const mapped = mapSmtpError(
          err,
          this.platformSmtp.host,
          this.platformSmtp.port,
          this.platformSmtp.user,
        );
        this.logger.error(
          `Platform SMTP send failed [code=${err?.code ?? "unknown"}]: ` +
            `${redactAddresses(rawMessage)}. Mapped reason: ${mapped}`,
        );
        return {
          delivered: false,
          transport: "smtp",
          error: smtpError ?? redactAddresses(rawMessage),
          smtpFallbackReason: smtpFallbackReason ?? mapped,
        };
      }
    }

    // 3. Try platform Resend. The SDK returns `{data, error}` (it does NOT throw on an
    // API-level rejection like an unverified domain / bad key), so inspect `error`.
    if (this.resend) {
      try {
        const from = await this.getResendFrom();
        const result = await this.resend.emails.send({
          from,
          to: params.to,
          subject: params.subject,
          html: params.html,
          text: params.text,
          replyTo,
        });
        if ((result as any)?.error) {
          const msg = (result as any).error?.message ?? "Resend rejected the message";
          this.logger.error(`Resend rejected email to ${params.to}: ${msg}`);
          return { delivered: false, transport: "resend", error: msg, smtpFallbackReason };
        }
        this.logger.log(`Email sent via Resend to ${params.to} — id: ${(result.data as any)?.id}`);
        // Resend rescued a failing tenant SMTP send — delivered:true is honest (the mail
        // DID go out), but smtpFallbackReason must still ride along: this is exactly the
        // case where, without it, nobody ever learns their own mailbox is broken. The From
        // identity silently changed too (tenant mailbox → platform address) — surface it.
        return {
          delivered: true,
          transport: "resend",
          id: (result.data as any)?.id,
          smtpFallbackReason,
          fromAddress: smtpFallbackReason ? this.addressOf(from) : undefined,
        };
      } catch (err: any) {
        this.logger.error(`Failed to send email to ${params.to}: ${err?.message}`);
        return {
          delivered: false,
          transport: "resend",
          error: err?.message ?? "Resend send failed",
          smtpFallbackReason,
        };
      }
    }

    // 4. No transport configured — NOT delivered (was a silent mock "success").
    this.logger.warn(
      `[EMAIL NOT SENT] To: ${params.to} | Subject: ${params.subject} — no SMTP or platform email is configured.`,
    );
    return {
      delivered: false,
      transport: emailCfg ? "smtp" : "none",
      error: smtpError,
      smtpFallbackReason,
    };
  }

  /**
   * Platform-only send — NEVER reads or uses a tenant's own SMTP config or branding
   * (unlike `send()`, which tries the tenant's own mailbox first). For security/account
   * mail (verification, password reset, invites, account/role-change notices — N2 ground
   * rule 1) and billing-lifecycle mail (N3), the sender must always be the bare platform
   * identity, never "<Business> via RouteFlow" — `send()` reads `prisma.getTenantId()` on
   * every in-request call, including a tenant admin's own authenticated action, so routing
   * either kind of notification through `send()` would leave from the ACTING TENANT's own
   * mailbox. Merge of N2's and N3's independent copies (both added this method on separate
   * branches, as planned): platform SMTP (Google Workspace) is tried first, same as it is
   * in `send()` above, THEN Resend — N3's original Resend-only version left platformSmtp
   * unused here, which its own review flagged as a gap (a deploy with platformSmtp
   * configured but no Resend key would leave every N3 notification undelivered); folded in
   * as part of this merge rather than left dangling. `text` (N3's plain-text alternative)
   * is threaded through both transports.
   */
  async sendPlatform(params: {
    to: string;
    subject: string;
    html: string;
    text?: string;
    replyTo?: string;
  }): Promise<{
    delivered: boolean;
    transport: "smtp" | "resend" | "none";
    id?: string;
    error?: string;
  }> {
    // 1. Platform SMTP (Google Workspace mailbox) — same transport as send()'s own
    // platform-SMTP step, but the From identity is always the bare platform address.
    if (this.platformSmtp) {
      try {
        const transport = this.createSendTransport(
          this.platformSmtp.host,
          this.platformSmtp.port,
          this.platformSmtp.secure,
          this.platformSmtp.user,
          this.platformSmtp.pass,
        );
        const info = await transport.sendMail({
          from: this.platformFrom,
          to: params.to,
          subject: params.subject,
          html: params.html,
          text: params.text,
          replyTo: params.replyTo,
        });
        this.logger.log(
          `Platform email sent via platform SMTP to ${params.to} — messageId: ${info.messageId}`,
        );
        return { delivered: true, transport: "smtp", id: info.messageId };
      } catch (err: any) {
        const rawMessage: string = err?.message ?? "Platform SMTP send failed";
        this.logger.error(
          `Platform SMTP send failed [code=${err?.code ?? "unknown"}]: ${redactAddresses(rawMessage)}.`,
        );
        return { delivered: false, transport: "smtp", error: redactAddresses(rawMessage) };
      }
    }

    // 2. Platform Resend, bare platform From — never the tenant's own verified domain.
    if (this.resend) {
      try {
        const result = await this.resend.emails.send({
          from: this.platformFrom,
          to: params.to,
          subject: params.subject,
          html: params.html,
          text: params.text,
          replyTo: params.replyTo,
        });
        if ((result as any)?.error) {
          const msg = (result as any).error?.message ?? "Resend rejected the message";
          this.logger.error(`Resend rejected platform email to ${params.to}: ${msg}`);
          return { delivered: false, transport: "resend", error: msg };
        }
        this.logger.log(
          `Platform email sent via Resend to ${params.to} — id: ${(result.data as any)?.id}`,
        );
        return { delivered: true, transport: "resend", id: (result.data as any)?.id };
      } catch (err: any) {
        this.logger.error(`Failed to send platform email to ${params.to}: ${err?.message}`);
        return {
          delivered: false,
          transport: "resend",
          error: err?.message ?? "Resend send failed",
        };
      }
    }

    // 3. No platform transport configured.
    this.logger.warn(
      `[PLATFORM EMAIL NOT SENT] To: ${params.to} | Subject: ${params.subject} — no platform SMTP or Resend configured.`,
    );
    return { delivered: false, transport: "none" };
  }

  // ─── Email template ────────────────────────────────────────────────────────

  private buildInvoiceEmail(
    params: {
      customerName: string;
      invoiceNumber: string;
      issueDate: string;
      dueDate: string;
      paymentTermsLabel?: string | null;
      total: number;
      /** CONFIRMED-basis amount already collected (F03/R8) — see sendInvoice's doc. */
      totalPaid?: number;
      /** Confirmed CREDIT_NOTE applications (B421) — see sendInvoice's doc. */
      creditApplied?: number;
      /** Confirmed ADVANCE applications (B421) — see sendInvoice's doc. */
      advanceApplied?: number;
      /** Credit note numbers backing `creditApplied` (B421). */
      creditNoteNumbers?: string[];
      /** CONFIRMED-basis outstanding balance (F03/R8) — see sendInvoice's doc. */
      balanceDue?: number;
      items: {
        description: string;
        qty: number;
        unitPrice: number;
        subtotal: number;
        /** Suggested retail price snapshot, per PIECE — display-only, null renders nothing. */
        msrp?: number | null;
        /** Pre-promo/pre-adjustment per-unit price, for the strikethrough (F03/R9). */
        originalPrice?: number | null;
        priceType?: string | null;
        /** BUY_N_GET_M free units on this line — null/0 renders no note. */
        promoFreeUnits?: number | null;
      }[];
      pdfUrl?: string;
      isReminder?: boolean;
      /** Tenant's `invoice.hideOriginalPrice` — see sendInvoice's doc. */
      hideOriginalPrice?: boolean;
      /** Deposit schedule (display-only, derived server-side) — null/absent renders nothing. */
      depositAmount?: number | null;
      depositDueDate?: string | null;
    },
    businessName: string,
  ): string {
    const fmt = (n: number) =>
      new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

    const itemRows = params.items
      .map((it) => {
        // F03/R9 — mirrors the web invoice detail renderer and the PDF: name the
        // free units (a BOGO line's reduced subtotal otherwise reads as a pricing
        // error), and delegate the strikethrough decision to the SAME
        // `showOriginalPrice` helper the PDF uses, so the tenant's
        // hide-original-price setting and the MANUAL-upsell exception cannot drift
        // between the body and the PDF attached to the very same message.
        const freeUnits = it.promoFreeUnits != null ? Number(it.promoFreeUnits) : 0;
        const original = it.originalPrice != null ? Number(it.originalPrice) : null;
        const showOriginal = showOriginalPrice(it, !!params.hideOriginalPrice);
        return `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#1a2033;">${it.description}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#1a2033;text-align:center;">${it.qty}${
            freeUnits > 0
              ? `<div style="font-size:11px;color:#b45309;font-weight:600;margin-top:2px;">${freeUnits} free</div>`
              : ""
          }</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#1a2033;text-align:right;">${
            showOriginal
              ? `<s style="color:#9ca3af;font-weight:400;text-decoration:line-through;">${fmt(original as number)}</s><br/>`
              : ""
          }${fmt(it.unitPrice)}${
            it.msrp != null
              ? `<div style="font-size:11px;color:#9ca3af;font-weight:400;margin-top:2px;">MSRP ${fmt(it.msrp)}/pc</div>`
              : ""
          }</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#1a2033;text-align:right;font-weight:600;">${fmt(it.subtotal)}</td>
        </tr>`;
      })
      .join("");

    const reminderBanner = params.isReminder
      ? `<div style="background:#fff7ed;border-left:4px solid #f97316;padding:12px 16px;margin-bottom:24px;border-radius:4px;">
           <p style="margin:0;font-size:14px;color:#9a3412;font-weight:600;">Payment Reminder</p>
           <p style="margin:4px 0 0;font-size:13px;color:#9a3412;">This invoice is overdue. Please arrange payment at your earliest convenience.</p>
         </div>`
      : "";

    // Deposit schedule banner — only when the invoice carries a deposit. The
    // remainder anchors to the invoice due date; amounts arrive pre-derived.
    const depositBanner =
      params.depositAmount != null
        ? `<div style="background:#eef2ff;border-left:4px solid #6366f1;padding:12px 16px;margin-bottom:24px;border-radius:4px;">
           <p style="margin:0;font-size:14px;color:#3730a3;font-weight:600;">Deposit due${
             params.depositDueDate ? ` by ${params.depositDueDate}` : ""
           }: ${fmt(params.depositAmount)}</p>
           <p style="margin:4px 0 0;font-size:13px;color:#3730a3;">Remainder due by ${params.dueDate}.</p>
         </div>`
        : "";

    const pdfButton = params.pdfUrl
      ? `<a href="${params.pdfUrl}" style="display:inline-block;margin-top:8px;background:#f3f4f6;color:#374151;padding:8px 20px;border-radius:6px;font-size:13px;text-decoration:none;font-weight:500;">Download PDF</a>`
      : "";

    // F03/R1/R8/B102 — Amount Paid + Balance Due on the CONFIRMED (PAID) basis,
    // mirroring the PDF's totals box. A reminder must demand the true
    // outstanding balance, never the stale `total`: when the caller has
    // supplied `balanceDue`, that (not `total`) is what appears here — for a
    // reminder that is the whole point of the fix (B102). Callers that haven't
    // been updated yet (balanceDue undefined) keep the pre-F03 single
    // "Amount Due" = total row.
    const amountPaidRow =
      params.totalPaid != null && params.totalPaid > 0
        ? `<tr>
                <td colspan="3" style="padding:8px 12px;font-size:13px;font-weight:600;color:#16a34a;text-align:right;">Amount Paid</td>
                <td style="padding:8px 12px;font-size:14px;font-weight:600;color:#16a34a;text-align:right;">${fmt(params.totalPaid)}</td>
              </tr>`
        : "";
    // B421: a credit note or advance reduces the balance but is never cash the
    // customer paid — neutral styling (never the Amount Paid green), same
    // customer-facing wording as the PDF ("Credit issued — CN-…").
    const creditNoteLabel =
      params.creditNoteNumbers && params.creditNoteNumbers.length > 0
        ? `Credit issued — ${params.creditNoteNumbers.join(", ")}`
        : "Credit issued";
    const creditAppliedRow =
      params.creditApplied != null && params.creditApplied > 0
        ? `<tr>
                <td colspan="3" style="padding:8px 12px;font-size:13px;font-weight:600;color:#374151;text-align:right;">${creditNoteLabel}</td>
                <td style="padding:8px 12px;font-size:14px;font-weight:600;color:#374151;text-align:right;">${fmt(params.creditApplied)}</td>
              </tr>`
        : "";
    const advanceAppliedRow =
      params.advanceApplied != null && params.advanceApplied > 0
        ? `<tr>
                <td colspan="3" style="padding:8px 12px;font-size:13px;font-weight:600;color:#374151;text-align:right;">Advance applied</td>
                <td style="padding:8px 12px;font-size:14px;font-weight:600;color:#374151;text-align:right;">${fmt(params.advanceApplied)}</td>
              </tr>`
        : "";
    const totalsFooter =
      params.balanceDue != null
        ? `${amountPaidRow}${creditAppliedRow}${advanceAppliedRow}
              <tr style="background:#f9fafb;">
                <td colspan="3" style="padding:12px;font-size:14px;font-weight:700;color:#1a2033;text-align:right;">Balance Due</td>
                <td style="padding:12px;font-size:16px;font-weight:700;color:${params.balanceDue > 0 ? "#dc2626" : "#16a34a"};text-align:right;">${fmt(params.balanceDue)}</td>
              </tr>`
        : `<tr style="background:#f9fafb;">
                <td colspan="3" style="padding:12px;font-size:14px;font-weight:700;color:#1a2033;text-align:right;">Amount Due</td>
                <td style="padding:12px;font-size:16px;font-weight:700;color:#1a2033;text-align:right;">${fmt(params.total)}</td>
              </tr>`;

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
          ${depositBanner}
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
            ${
              params.paymentTermsLabel
                ? `<tr>
              <td style="font-size:13px;color:#6b7280;padding-top:6px;">Terms</td>
              <td style="font-size:13px;color:#1a2033;text-align:right;padding-top:6px;">${params.paymentTermsLabel}</td>
            </tr>`
                : ""
            }
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
              ${totalsFooter}
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
  }): Promise<{
    delivered: boolean;
    transport: "mailbox" | "smtp" | "resend" | "none";
    error?: string;
  }> {
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
    // Security review Phase 2: account-merge verification is security mail — platform sender
    // only, never a tenant's connected mailbox/SMTP.
    return this.send({
      to: params.to,
      subject: "Confirm account merge — RouteFlow",
      html,
      senderClass: "platform",
    });
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

  // ─── N2: account + invite emails (staff invite, admin reset, email/role change) ────

  /** Staff invite (createOperator) and admin-triggered password reset share this one
   *  template — both hand the recipient the same single-use set-password link. */
  async sendSetPasswordEmail(params: {
    to: string;
    username: string;
    setPasswordUrl: string;
    expiryHours: number;
  }) {
    const body = `<p style="margin:0 0 16px;font-size:15px;color:#374151;">Hi ${escapeHtml(params.username)},</p>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">
      Your RouteFlow account is ready. Click below to set your password and finish signing in.
    </p>
    <table cellpadding="0" cellspacing="0"><tr><td style="background:#4f46e5;border-radius:6px;">
      <a href="${params.setPasswordUrl}" style="display:inline-block;padding:12px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">
        Set your password
      </a>
    </td></tr></table>
    <p style="margin:24px 0 0;font-size:13px;color:#9ca3af;">
      This link expires in ${params.expiryHours} hours. If you weren't expecting this, contact your administrator.
    </p>`;
    const html = renderEmailShell({
      headerColor: "#4f46e5",
      headerTitle: "RouteFlow — Set your password",
      bodyHtml: body,
    });
    return this.sendPlatform({ to: params.to, subject: "Set your RouteFlow password", html });
  }

  /** Notice to a user's OLD address after their login email is changed — never opt-out. */
  async sendEmailChangedNotice(params: { to: string; username: string; newEmail: string }) {
    const body = `<p style="margin:0 0 16px;font-size:15px;color:#374151;">Hi ${escapeHtml(params.username)},</p>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">
      Your RouteFlow login email was changed to <strong>${escapeHtml(params.newEmail)}</strong>.
    </p>
    <p style="margin:0;font-size:13px;color:#9ca3af;">
      If you didn't make this change, contact your administrator immediately.
    </p>`;
    const html = renderEmailShell({
      headerColor: "#4f46e5",
      headerTitle: "RouteFlow — Login email changed",
      bodyHtml: body,
    });
    return this.sendPlatform({
      to: params.to,
      subject: "Your RouteFlow login email was changed",
      html,
    });
  }

  /** Confirmation to a user's NEW address once it becomes their login email. */
  async sendEmailChangeConfirmation(params: { to: string; username: string }) {
    const body = `<p style="margin:0 0 16px;font-size:15px;color:#374151;">Hi ${escapeHtml(params.username)},</p>
    <p style="margin:0;font-size:15px;color:#374151;">
      This address is now your RouteFlow login email.
    </p>`;
    const html = renderEmailShell({
      headerColor: "#4f46e5",
      headerTitle: "RouteFlow — This is now your login email",
      bodyHtml: body,
    });
    return this.sendPlatform({
      to: params.to,
      subject: "This is now your RouteFlow login email",
      html,
    });
  }

  /** Notice to a user when an operator/admin changes their role — never opt-out. */
  async sendRoleChangedNotice(params: {
    to: string;
    username: string;
    oldRole: string;
    newRole: string;
    changedBy: string;
  }) {
    const body = `<p style="margin:0 0 16px;font-size:15px;color:#374151;">Hi ${escapeHtml(params.username)},</p>
    <p style="margin:0;font-size:15px;color:#374151;">
      Your RouteFlow role was changed from <strong>${escapeHtml(params.oldRole)}</strong> to
      <strong>${escapeHtml(params.newRole)}</strong> by ${escapeHtml(params.changedBy)}.
    </p>`;
    const html = renderEmailShell({
      headerColor: "#4f46e5",
      headerTitle: "RouteFlow — Your role was changed",
      bodyHtml: body,
    });
    return this.sendPlatform({ to: params.to, subject: "Your RouteFlow role was changed", html });
  }

  // ─── N4: low-stock daily digest (platform-sent, tenant-admin-facing) ───────

  /**
   * N4. Always sent via the platform sender — this is an operational alert
   * to the tenant's OWN admins, not tenant-branded customer mail, so it
   * deliberately does NOT resolve tenant SMTP the way `sendInvoice` does.
   * Callers therefore invoke this with no tenant ALS context active
   * (`this.prisma.getTenantId()` returns null inside `send()`), which is
   * what makes it skip straight to whichever platform transport is active —
   * platform SMTP (Google Workspace mailbox, B452) when `SMTP_HOST` is
   * fully configured, else Resend, else logged-only. Fails closed: `send()`
   * never throws, and this method does not add a throwing await on top of
   * it — a caller iterating many tenants/admins must be able to keep going
   * past one bad address.
   */
  async sendLowStockDigest(params: {
    to: string;
    businessName: string;
    items: { name: string; sku: string | null; currentStock: number; reorderPoint: number }[];
  }): Promise<{
    delivered: boolean;
    transport: "mailbox" | "smtp" | "resend" | "none";
    error?: string;
  }> {
    const html = this.buildLowStockDigestEmail(params);
    const count = params.items.length;
    return this.send({
      to: params.to,
      subject: `Low stock alert — ${count} item${count === 1 ? "" : "s"} below threshold`,
      html,
    });
  }

  /** A tenant with a large catalogue and a low blanket reorderPoint could have thousands
   * of below-threshold SKUs — 2,000 rows would be ~850 KB of HTML. Cap the rendered table;
   * the subject line (built from the UN-truncated `items.length` in `sendLowStockDigest`)
   * stays truthful about the real total either way. */
  private static readonly MAX_DIGEST_ROWS = 100;

  /**
   * Same 600px shell/header/body/footer markup as `buildInvoiceEmail`
   * ("no new look" — N4 ground rule) with the invoice's item TABLE shape
   * carried over for the product list. Every interpolated value is
   * `escapeHtml`'d — product names are tenant-catalogue-typed strings, not
   * server-controlled.
   */
  private buildLowStockDigestEmail(params: {
    businessName: string;
    items: { name: string; sku: string | null; currentStock: number; reorderPoint: number }[];
  }): string {
    const shown = params.items.slice(0, EmailService.MAX_DIGEST_ROWS);
    const overflow = params.items.length - shown.length;
    const rows =
      shown
        .map(
          (it) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#1a2033;">${escapeHtml(it.name)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#6b7280;">${it.sku ? escapeHtml(it.sku) : "—"}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#dc2626;font-weight:600;text-align:right;">${it.currentStock}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#6b7280;text-align:right;">${it.reorderPoint}</td>
        </tr>`,
        )
        .join("") +
      (overflow > 0
        ? `
        <tr>
          <td colspan="4" style="padding:8px 12px;font-size:13px;color:#9ca3af;font-style:italic;">…and ${overflow} more item${overflow === 1 ? "" : "s"}</td>
        </tr>`
        : "");

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:40px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">

        <!-- Header -->
        <tr><td style="background:#1a2033;padding:28px 32px;">
          <p style="margin:0;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">${escapeHtml(params.businessName)}</p>
          <p style="margin:4px 0 0;font-size:13px;color:rgba(255,255,255,0.6);">Low Stock Alert</p>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:32px;">
          <p style="margin:0 0 24px;font-size:15px;color:#374151;">
            ${params.items.length} item${params.items.length === 1 ? " is" : "s are"} below its reorder point:
          </p>

          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
            <tr>
              <td style="padding:0 12px 8px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Product</td>
              <td style="padding:0 12px 8px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">SKU</td>
              <td style="padding:0 12px 8px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;text-align:right;">In Stock</td>
              <td style="padding:0 12px 8px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;text-align:right;">Reorder At</td>
            </tr>
            ${rows}
          </table>

          <p style="margin:24px 0 0;font-size:13px;color:#9ca3af;">
            This is a daily summary — you will not receive another alert for these items until tomorrow.
            You can turn this digest off in your account preferences.
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f9fafb;padding:16px 32px;border-top:1px solid #f0f0f0;">
          <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">RouteFlow Platform — automated notification.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  }
}
