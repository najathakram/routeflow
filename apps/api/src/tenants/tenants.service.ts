import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import * as bcrypt from "bcrypt";
import * as path from "path";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../common/encryption.service";
import { StorageService } from "../storage/storage.service";
import { EmailService } from "../email/email.service";
import { RegisterTenantDto } from "./dto/register-tenant.dto";
import { IRS_SYSTEM_CATEGORIES } from "../bookkeeping/irs-categories.constant";
import { UpdateEmailConfigDto } from "./dto/update-email-config.dto";
import { UpdateGoogleOAuthConfigDto } from "./dto/update-google-oauth-config.dto";
import { UpdateBrandingDto } from "./dto/update-branding.dto";

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

@Injectable()
export class TenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly storage: StorageService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
  ) {}

  isUsernameAvailable(username: string): boolean {
    return !RESERVED_USERNAMES.has(username.toLowerCase());
  }

  async isSlugAvailable(slug: string): Promise<boolean> {
    if (RESERVED_SLUGS.has(slug)) return false;
    const existing = await this.prisma.tenant.findUnique({ where: { slug } });
    return !existing;
  }

  async register(dto: RegisterTenantDto) {
    const { slug, businessName, adminEmail, adminUsername, adminPassword } = dto;

    if (RESERVED_SLUGS.has(slug)) {
      throw new ConflictException(`Slug "${slug}" is reserved`);
    }

    const slugTaken = await this.prisma.tenant.findUnique({ where: { slug } });
    if (slugTaken) {
      throw new ConflictException(`Slug "${slug}" is already taken`);
    }

    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + 14);
    const hashedPassword = await bcrypt.hash(adminPassword, 10);

    const result = await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: { slug, name: businessName, status: "TRIAL", plan: "STARTER", trialEndsAt },
      });

      await tx.tenantConfig.create({ data: { tenantId: tenant.id, businessName } });

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

    // Generate a 24-hour email verification JWT and send it
    try {
      const webUrl = this.config.get<string>("WEB_URL") ?? "http://localhost:3001";
      const jwtSecret = this.config.get<string>("jwt.secret")!;

      const verifyToken = this.jwt.sign(
        { sub: result.user.id, tenantId: result.tenant.id, type: "email_verify" },
        { secret: jwtSecret, expiresIn: "24h" },
      );

      const verifyUrl = `${webUrl}/verify-email?token=${verifyToken}`;

      await this.email.send({
        to: result.user.email,
        subject: "Verify your email to activate RouteFlow",
        html: `<p>Hi ${result.user.username},</p>
<p>Thanks for signing up for <strong>RouteFlow</strong>! Click the button below to verify your email and activate your 14-day free trial for <strong>${businessName}</strong>.</p>
<p style="margin:24px 0;">
  <a href="${verifyUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Verify My Email</a>
</p>
<p>Or paste this link into your browser:<br/><a href="${verifyUrl}">${verifyUrl}</a></p>
<p><em>This link expires in 24 hours. If you didn't sign up, you can safely ignore this email.</em></p>
<p>The RouteFlow Team</p>`,
      });
    } catch {
      /* best-effort — don't fail signup over email */
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
    };
  }

  /** Resend a verification email to an INACTIVE user (best-effort, always 200) */
  async resendVerification(email: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { email: email.toLowerCase().trim(), status: "INACTIVE", deletedAt: null },
      include: { tenant: { select: { id: true, name: true, slug: true } } },
    });

    // Silent return to prevent email enumeration
    if (!user || !user.tenant) return;

    try {
      const webUrl = this.config.get<string>("WEB_URL") ?? "http://localhost:3001";
      const jwtSecret = this.config.get<string>("jwt.secret")!;

      const verifyToken = this.jwt.sign(
        { sub: user.id, tenantId: user.tenant.id, type: "email_verify" },
        { secret: jwtSecret, expiresIn: "24h" },
      );

      const verifyUrl = `${webUrl}/verify-email?token=${verifyToken}`;

      await this.email.send({
        to: user.email,
        subject: "Verify your email to activate RouteFlow",
        html: `<p>Hi ${user.username},</p>
<p>Here's a new verification link for your RouteFlow account (<strong>${user.tenant.name}</strong>):</p>
<p style="margin:24px 0;">
  <a href="${verifyUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Verify My Email</a>
</p>
<p><em>This link expires in 24 hours.</em></p>
<p>The RouteFlow Team</p>`,
      });
    } catch {
      /* best-effort */
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

    const data: any = {};
    if (dto.businessName !== undefined) data.businessName = dto.businessName;
    if (dto.primaryColor !== undefined) data.primaryColor = dto.primaryColor;

    const updated = await this.prisma.tenantConfig.update({ where: { tenantId }, data });

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
    const ext = (path.extname(file.originalname) || ".jpg")
      .toLowerCase()
      .replace(/[^a-z0-9.]/g, "");
    const key = `tenants/${tenantId}/logo${ext}`;

    await this.storage.upload(key, file.buffer, file.mimetype);
    await this.prisma.tenantConfig.update({ where: { tenantId }, data: { logoKey: key } });

    const logoUrl = await this.storage.presignedUrl(key);
    return { logoKey: key, logoUrl };
  }
}
