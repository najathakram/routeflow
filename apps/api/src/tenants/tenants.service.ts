import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import type { ThrottlerStorage } from "@nestjs/throttler";
import * as bcrypt from "bcrypt";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../common/encryption.service";
import { StorageService } from "../storage/storage.service";
import { EmailService } from "../email/email.service";
import { RegisterTenantDto } from "./dto/register-tenant.dto";
import { IRS_SYSTEM_CATEGORIES } from "../bookkeeping/irs-categories.constant";
import { UpdateEmailConfigDto } from "./dto/update-email-config.dto";
import { UpdateGoogleOAuthConfigDto } from "./dto/update-google-oauth-config.dto";
import { UpdateBrandingDto } from "./dto/update-branding.dto";
import { compressImage } from "../storage/compress.util";
import { TRIAL_LENGTH_DAYS, planKeyFromEnum } from "../billing/plan-catalog.constants";
import { escapeHtml } from "../common/html-escape";
import { mayIssueVerificationLink } from "../auth/verification-link-eligibility";
import { emailVerifyUrl, issueEmailVerificationToken } from "../auth/email-verification-token";
import type { AppConfig } from "../config/configuration";
import { RESEND_LIMITER, mayResendTo } from "./resend-verification-limit";
import { assertSafeTextCell } from "../common/safe-text-cell";
import { isApprovedTestTenantSlug } from "../common/tenant-class.util";
import { FALLBACK_ZONE } from "../common/tenant-time-zone";
import { assertValidTenantTimeZone } from "../system-config/tenant-timezone.writer";

const RESERVED_SLUGS = new Set([
  "api",
  "www",
  "admin",
  "app",
  "static",
  "assets",
  "mail",
  "support",
  "platform",
  "login",
  "signup",
  "register",
  "billing",
  "dashboard",
]);

/** Usernames that are too generic or reserved to use as a tenant admin */
const RESERVED_USERNAMES = new Set([
  "admin",
  "root",
  "superadmin",
  "administrator",
  "system",
  "support",
  "help",
  "info",
  "demo",
  "owner",
  "staff",
  "operator",
  "driver",
  "customer",
  "test",
  "user",
  "manager",
]);

/** An error's message with every occurrence of the address removed, for a log line. */
function scrubAddress(err: unknown, email: unknown): string {
  const raw = (err as { message?: unknown } | null)?.message;
  const msg = typeof raw === "string" ? raw : "unknown";
  if (typeof email !== "string" || !email.trim()) return msg;
  return msg
    .split(email.trim())
    .join("[address]")
    .split(email.trim().toLowerCase())
    .join("[address]");
}

@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly storage: StorageService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
    // Optional only so a module that never resends can build this service; without a limiter the
    // resend refuses (fails closed), it never sends unthrottled.
    @Optional()
    @Inject(RESEND_LIMITER)
    private readonly resendLimiter?: Pick<ThrottlerStorage, "increment">,
  ) {}

  /** The web origin an emailed link points at, resolved server-side from config only. */
  private webBase(): string {
    return (
      this.config.get<AppConfig["urls"]>("urls")?.web ??
      this.config.get<string>("WEB_URL") ??
      "http://localhost:3001"
    );
  }

  async isUsernameAvailable(username: string): Promise<boolean> {
    if (RESERVED_USERNAMES.has(username.toLowerCase())) return false;
    const existing = await this.prisma.user.findFirst({
      where: { username: { equals: username, mode: "insensitive" } },
      select: { id: true },
    });
    return !existing;
  }

  async isSlugAvailable(slug: string): Promise<boolean> {
    if (RESERVED_SLUGS.has(slug) || isApprovedTestTenantSlug(slug as unknown)) return false;
    const existing = await this.prisma.tenant.findUnique({ where: { slug } });
    return !existing;
  }

  async register(dto: RegisterTenantDto) {
    const { slug, businessName, adminEmail, adminUsername, adminPassword } = dto;
    assertSafeTextCell({ businessName }); // B956: the name is mirrored into a Customer row
    // SA-738: an explicit zone is ALWAYS written (never the column default): the client's, else UTC.
    const timezone = dto.timezone ? assertValidTenantTimeZone(dto.timezone) : FALLBACK_ZONE;

    if (RESERVED_SLUGS.has(slug)) {
      throw new ConflictException(`Slug "${slug}" is reserved`);
    }

    // Row 195: the test-tenant slug patterns are reserved for the policy's own test tenants — a real
    // signup can never land on one (the protected-tenant guard and the test-tenant allow-lists key
    // on them). The message is deliberately neutral: it does not say why.
    // `as unknown`: the predicate would otherwise narrow `slug` to never on the false branch.
    if (isApprovedTestTenantSlug(slug as unknown)) {
      throw new BadRequestException(`Slug "${slug}" is not available`);
    }

    const slugTaken = await this.prisma.tenant.findUnique({ where: { slug } });
    if (slugTaken) {
      throw new ConflictException(`Slug "${slug}" is already taken`);
    }

    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + TRIAL_LENGTH_DAYS);
    const hashedPassword = await bcrypt.hash(adminPassword, 10);

    const result = await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: { slug, name: businessName, status: "TRIAL", plan: "STARTER", trialEndsAt },
      });

      // B556: Tenant.plan is a legacy display shadow — MrrService actually gates MRR on
      // TenantSubscription.planKey (mrr.service.ts payingWhere). A tenant created here with no
      // subscription row drifts the two apart forever unless it later happens to pass through
      // the Change Plan / Activate Subscription admin actions, which is exactly the "shown as
      // paying, contributes $0 forever" shape B556 reports. Create the row now with planKey
      // resolved via the same total planKeyFromEnum() mapping every other consumer already
      // falls back to, so the two fields never start out of sync. No pricing is set here —
      // this tenant is a TRIAL and MrrService's payingWhere excludes non-ACTIVE tenants
      // regardless of planKey; only an explicit activation/plan action ever makes one paying.
      await tx.tenantSubscription.create({
        data: { tenantId: tenant.id, currentPlan: "STARTER", planKey: planKeyFromEnum("STARTER") },
      });

      await tx.tenantConfig.create({ data: { tenantId: tenant.id, businessName, timezone } });

      // Seed IRS Schedule C expense categories so new tenants have a curated
      // list to pick from immediately.
      await tx.expenseCategory.createMany({
        data: IRS_SYSTEM_CATEGORIES.map((c) => ({
          tenantId: tenant.id,
          name: c.name,
          code: c.code,
          isCustom: false,
        })),
        skipDuplicates: true,
      });

      const existingUser = await tx.user.findFirst({
        where: { tenantId: tenant.id, OR: [{ email: adminEmail }, { username: adminUsername }] },
      });
      if (existingUser) throw new BadRequestException("Email or username already in use");

      const user = await tx.user.create({
        data: {
          email: adminEmail,
          username: adminUsername,
          password: hashedPassword,
          role: "TENANT_ADMIN",
          // Keep INACTIVE until email is verified — prevents login until the
          // user clicks the verification link in their inbox.
          status: "INACTIVE",
          forcePasswordChange: false,
          tenantId: tenant.id,
        },
      });

      return { tenant, user };
    });

    // Issue a 24-hour single-use email verification link and send it. Registration itself
    // must never fail over a mail-transport problem (the tenant+user rows are
    // already committed above), but a failed send used to be swallowed here with
    // NO trace anywhere: not logged, not reported to the caller, not visible to
    // the frontend — the account sat INACTIVE forever and the owner had no way
    // to tell a real delivery failure apart from "user hasn't checked their inbox
    // yet". emailSent now flows back to the controller response so the web
    // check-email page can warn instead of lying, and every failure is logged
    // with the reason `EmailService.send()` already computed.
    let emailSent = false;
    try {
      const issued = await issueEmailVerificationToken(this.prisma, result.user.id);
      const verifyUrl = emailVerifyUrl(this.webBase(), issued.token);

      const sendResult = await this.email.send({
        to: result.user.email,
        subject: "Verify your email to activate RouteFlow",
        html: `<p>Hi ${escapeHtml(result.user.username)},</p>
<p>Thanks for signing up for <strong>RouteFlow</strong>! Click the button below to verify your email and activate your 14-day free trial for <strong>${escapeHtml(businessName)}</strong>.</p>
<p style="margin:24px 0;">
  <a href="${escapeHtml(verifyUrl)}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Verify My Email</a>
</p>
<p>Or paste this link into your browser:<br/><a href="${escapeHtml(verifyUrl)}">${escapeHtml(verifyUrl)}</a></p>
<p><em>This link expires in 24 hours. If you didn't sign up, you can safely ignore this email.</em></p>
<p>The RouteFlow Team</p>`,
        // email-connect-google PR-3: platform sender only — never a tenant mailbox/SMTP.
        senderClass: "platform",
      });
      emailSent = sendResult.delivered;
      if (!sendResult.delivered) {
        this.logger.error(
          `Verification email NOT delivered for new tenant "${result.tenant.slug}" ` +
            `(user ${result.user.id}, ${result.user.email}) — transport=${sendResult.transport} ` +
            `error=${sendResult.error ?? sendResult.smtpFallbackReason ?? "unknown"}. ` +
            `Account is INACTIVE until verified; the self-service resend-verification endpoint ` +
            `will hit the same failure until the underlying mail config is fixed.`,
        );
      }
    } catch (err: any) {
      // EmailService.send() is documented to never throw for a delivery/config
      // problem — reaching here means something upstream of it broke (bad JWT
      // config, etc). Log it just as loudly; a swallowed exception here is
      // exactly how this class of outage went unnoticed before.
      this.logger.error(
        `Failed to send verification email for new tenant "${result.tenant.slug}" ` +
          `(user ${result.user.id}, ${result.user.email}): ${err?.message ?? err}`,
      );
    }

    return {
      tenant: {
        id: result.tenant.id,
        slug: result.tenant.slug,
        name: result.tenant.name,
        trialEndsAt: result.tenant.trialEndsAt,
      },
      user: {
        id: result.user.id,
        username: result.user.username,
        email: result.user.email,
      },
      emailSent,
    };
  }

  /**
   * Resend a verification email to an INACTIVE user. The WHOLE body runs detached: this returns as
   * soon as the work is scheduled, so the HTTP response is the same fixed acknowledgement at the
   * same speed whether the address is unknown, ineligible, rate limited or real. Nothing from the
   * detached part reaches the caller: its errors are caught and logged without the address or any
   * link.
   *
   * Per ADDRESS, before any account lookup and for every address alike: a cooldown of one resend
   * per 10 minutes and a cap of five per day, counted in the shared Redis throttler under a hash of
   * the lowercased address (see resend-verification-limit.ts). The throttler fails closed. The
   * daily cap can be used up for one address by a third party; the fallback is the back office.
   *
   * Only an account eligible for the verification link (verification-link-eligibility.ts) is sent
   * one: that includes the issue-time cut-off, so an account created before
   * `VERIFY_RESEND_CUTOFF` gets nothing here and stays on the back-office path. A new link is a
   * stored single-use token; the newest two live ones are kept and older ones are burned.
   */
  async resendVerification(email: string): Promise<void> {
    void this.performResend(email).catch((err: unknown) => {
      this.logger.error(`Resend-verification failed: ${scrubAddress(err, email)}`);
    });
  }

  /**
   * The detached resend body. Resolves true only when a link was handed to the mail transport and
   * delivered; every refusal resolves false. Exposed (not private) so specs can await the outcome;
   * callers on the request path use `resendVerification`, which never exposes it.
   */
  async performResend(email: string): Promise<boolean> {
    if (typeof email !== "string") return false;
    if (!(await mayResendTo(this.resendLimiter, email))) return false;

    const user = await this.prisma.user.findFirst({
      where: {
        email: email.toLowerCase().trim(),
        status: "INACTIVE",
        role: "TENANT_ADMIN",
        lastLoginAt: null,
        deletedAt: null,
      },
      include: { tenant: { select: { id: true, name: true, slug: true } } },
    });

    // Silent return to prevent email enumeration
    if (!user || !user.tenant) return false;
    // The same eligibility test the link itself is checked against; a refused class gets the
    // same silent answer as an unknown address.
    if (!(await mayIssueVerificationLink(this.prisma, user))) return false;

    try {
      const issued = await issueEmailVerificationToken(this.prisma, user.id);
      const verifyUrl = emailVerifyUrl(this.webBase(), issued.token);

      const sendResult = await this.email.send({
        to: user.email,
        subject: "Verify your email to activate RouteFlow",
        html: `<p>Hi ${escapeHtml(user.username)},</p>
<p>Here's a new verification link for your RouteFlow account (<strong>${escapeHtml(user.tenant.name)}</strong>):</p>
<p style="margin:24px 0;">
  <a href="${escapeHtml(verifyUrl)}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Verify My Email</a>
</p>
<p><em>This link expires in 24 hours.</em></p>
<p>The RouteFlow Team</p>`,
        // email-connect-google PR-3: platform sender only — never a tenant mailbox/SMTP.
        senderClass: "platform",
      });
      if (!sendResult.delivered) {
        this.logger.error(
          `Resend-verification email NOT delivered for tenant "${user.tenant.slug}" ` +
            `(user ${user.id}) — transport=${sendResult.transport} ` +
            `error=${sendResult.error ?? sendResult.smtpFallbackReason ?? "unknown"}.`,
        );
      }
      return sendResult.delivered;
    } catch (err: any) {
      this.logger.error(
        `Failed to resend verification email for tenant "${user.tenant.slug}" ` +
          `(user ${user.id}): ${scrubAddress(err, email)}`,
      );
      return false;
    }
  }

  async getBranding(slug: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { slug },
      include: { config: true },
    });

    if (!tenant || tenant.deletedAt || tenant.status === "CANCELLED") return null;

    return {
      slug: tenant.slug,
      businessName: tenant.config?.businessName ?? tenant.name,
      primaryColor: tenant.config?.primaryColor ?? null,
      logoKey: tenant.config?.logoKey ?? null,
    };
  }

  // ─── Email config (TENANT_ADMIN only) ────────────────────────────────────────

  async getEmailConfig(tenantId: string) {
    const cfg = await this.prisma.tenantConfig.findFirst({ where: { tenantId } });
    if (!cfg) throw new NotFoundException("Tenant config not found");
    return {
      smtpHost: cfg.smtpHost,
      smtpPort: cfg.smtpPort,
      smtpSecure: cfg.smtpSecure,
      smtpUser: cfg.smtpUser,
      smtpPasswordSet: !!cfg.smtpPassword,
      smtpFromName: cfg.smtpFromName,
      smtpFromEmail: cfg.smtpFromEmail,
    };
  }

  async updateEmailConfig(tenantId: string, dto: UpdateEmailConfigDto) {
    const cfg = await this.prisma.tenantConfig.findFirst({ where: { tenantId } });
    if (!cfg) throw new NotFoundException("Tenant config not found");

    const data: any = {};
    if (dto.smtpHost !== undefined) data.smtpHost = dto.smtpHost;
    if (dto.smtpPort !== undefined) data.smtpPort = dto.smtpPort;
    if (dto.smtpSecure !== undefined) data.smtpSecure = dto.smtpSecure;
    if (dto.smtpUser !== undefined) data.smtpUser = dto.smtpUser;
    if (dto.smtpPassword !== undefined) {
      data.smtpPassword = dto.smtpPassword ? this.encryption.encrypt(dto.smtpPassword) : null;
    }
    if (dto.smtpFromName !== undefined) data.smtpFromName = dto.smtpFromName;
    if (dto.smtpFromEmail !== undefined) data.smtpFromEmail = dto.smtpFromEmail;

    // Credential-exfil guard (mirrors SettingsController.updateEmailSettings): the stored
    // password belongs to a specific mailbox+server. If the host or user CHANGES without a
    // new password, CLEAR the stored one — never silently replay a saved credential against
    // a different server (a hostile/typo'd host would otherwise receive the tenant's real
    // password on the next send). A blank/omitted password with an unchanged mailbox keeps
    // the existing credential.
    const changingHost = dto.smtpHost !== undefined && dto.smtpHost !== cfg.smtpHost;
    const changingUser = dto.smtpUser !== undefined && dto.smtpUser !== cfg.smtpUser;
    const settingPassword = dto.smtpPassword !== undefined && dto.smtpPassword !== "";
    if ((changingHost || changingUser) && !settingPassword) {
      data.smtpPassword = null;
    }

    await this.prisma.tenantConfig.update({ where: { tenantId }, data });
    return this.getEmailConfig(tenantId);
  }

  // ─── Google OAuth config (TENANT_ADMIN only) ────────────────────────────────

  async getGoogleOAuthConfig(tenantId: string) {
    const cfg = await this.prisma.tenantGoogleOAuth.findFirst({ where: { tenantId } });
    if (!cfg) return { clientId: null, clientSecretSet: false, callbackUrl: null, enabled: false };
    return {
      clientId: cfg.clientId,
      clientSecretSet: !!cfg.clientSecret,
      callbackUrl: cfg.callbackUrl,
      enabled: cfg.enabled,
    };
  }

  async updateGoogleOAuthConfig(tenantId: string, dto: UpdateGoogleOAuthConfigDto) {
    const data: any = {};
    if (dto.clientId !== undefined) data.clientId = dto.clientId;
    if (dto.clientSecret !== undefined) {
      data.clientSecret = dto.clientSecret ? this.encryption.encrypt(dto.clientSecret) : null;
    }
    if (dto.callbackUrl !== undefined) data.callbackUrl = dto.callbackUrl;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;

    await this.prisma.tenantGoogleOAuth.upsert({
      where: { tenantId },
      create: { tenantId, ...data },
      update: data,
    });
    return this.getGoogleOAuthConfig(tenantId);
  }

  // ─── Branding config (TENANT_ADMIN only) ─────────────────────────────────────

  async updateBranding(tenantId: string, dto: UpdateBrandingDto) {
    const cfg = await this.prisma.tenantConfig.findFirst({ where: { tenantId } });
    if (!cfg) throw new NotFoundException("Tenant config not found");
    assertSafeTextCell({ businessName: dto.businessName }, { businessName: cfg.businessName });

    const data: any = {};
    if (dto.businessName !== undefined) data.businessName = dto.businessName;
    if (dto.primaryColor !== undefined) data.primaryColor = dto.primaryColor;

    const updated = await this.prisma.tenantConfig.update({ where: { tenantId }, data });

    // Any branding change (name or color) means cached invoice PDFs are out
    // of date — clear their stored pdfUrl so the next download regenerates
    // against the new branding. New invoices already pull live tenant config
    // at render time.
    const brandingChanged =
      (dto.businessName !== undefined && dto.businessName !== cfg.businessName) ||
      (dto.primaryColor !== undefined && dto.primaryColor !== cfg.primaryColor);
    if (brandingChanged) {
      await this.invalidateInvoicePdfCache(tenantId);
    }

    // Resolve logoUrl if a logo is stored
    const logoUrl = updated.logoKey ? await this.storage.presignedUrl(updated.logoKey) : null;

    return {
      businessName: updated.businessName,
      primaryColor: updated.primaryColor,
      logoKey: updated.logoKey,
      logoUrl,
    };
  }

  /** Resolve a stored logoKey to a presigned (or local) URL. */
  async getLogoUrl(logoKey: string): Promise<string> {
    return this.storage.presignedUrl(logoKey);
  }

  async uploadLogo(
    tenantId: string,
    file: Express.Multer.File,
  ): Promise<{ logoKey: string; logoUrl: string }> {
    const compressed = await compressImage(file.buffer, file.mimetype, 512);
    const key = `tenants/${tenantId}/logo.${compressed.ext}`;

    await this.storage.upload(key, compressed.buffer, compressed.mimeType);
    await this.prisma.tenantConfig.update({ where: { tenantId }, data: { logoKey: key } });

    // The tenant's logo just changed — flush every cached invoice PDF so the
    // next download for any invoice (new or old) re-renders with the new logo.
    await this.invalidateInvoicePdfCache(tenantId);

    const logoUrl = await this.storage.presignedUrl(key);
    return { logoKey: key, logoUrl };
  }

  /**
   * Clear the cached `pdfUrl` on every invoice for this tenant so the next
   * `InvoicePdfService.getOrGenerate(id)` call regenerates the PDF instead of
   * returning the stale cached copy. The actual PDF objects in storage are
   * left in place — they get overwritten at the same key on regeneration.
   *
   * Called whenever something visible on the PDF changes at the tenant level
   * (logo, business name, primary color). Invoice-level edits already mark
   * the invoice "dirty" through their own flows.
   */
  private async invalidateInvoicePdfCache(tenantId: string): Promise<void> {
    await this.prisma.invoice.updateMany({
      where: { tenantId, pdfUrl: { not: null } },
      data: { pdfUrl: null },
    });
  }
}
