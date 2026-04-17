import { Injectable, NotFoundException, BadRequestException } from "@nestjs/common";
import { OAuth2Client } from "google-auth-library";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../common/encryption.service";

@Injectable()
export class TenantGoogleOAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  private async getOAuth2Client(tenantId: string): Promise<OAuth2Client> {
    const cfg = await this.prisma.tenantGoogleOAuth.findFirst({
      where: { tenantId, enabled: true },
    });

    if (!cfg) {
      throw new NotFoundException("Google OAuth is not configured or not enabled for this tenant");
    }
    if (!cfg.clientId || !cfg.clientSecret) {
      throw new BadRequestException("Google OAuth credentials are incomplete");
    }

    const clientSecret = this.encryption.decrypt(cfg.clientSecret);
    return new OAuth2Client(cfg.clientId, clientSecret, cfg.callbackUrl ?? undefined);
  }

  /**
   * Build the Google authorization URL for a given tenant slug.
   * State encodes the tenant slug so the callback can resolve the tenant.
   */
  async buildAuthUrl(tenantSlug: string): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant || tenant.deletedAt) throw new NotFoundException("Tenant not found");

    const client = await this.getOAuth2Client(tenant.id);

    return client.generateAuthUrl({
      access_type: "offline",
      scope: ["openid", "email", "profile"],
      state: tenantSlug,
      prompt: "select_account",
    });
  }

  /**
   * Exchange an authorization code for a Google profile, then find or create
   * the tenant-scoped user. Returns the user record for JWT issuance.
   */
  async exchangeCode(
    code: string,
    tenantSlug: string,
  ): Promise<{
    id: string;
    username: string;
    email: string;
    role: string;
    status: string;
    tenantId: string;
  }> {
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant || tenant.deletedAt) throw new NotFoundException("Tenant not found");

    const client = await this.getOAuth2Client(tenant.id);
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token!,
      audience: (await this.prisma.tenantGoogleOAuth.findFirst({ where: { tenantId: tenant.id } }))!
        .clientId,
    });
    const payload = ticket.getPayload();
    if (!payload?.email) throw new BadRequestException("Could not retrieve email from Google");

    const googleId = payload.sub;
    const email = payload.email;
    const name = payload.name ?? email.split("@")[0];

    // Find existing user by googleId within this tenant, or by email
    let user = await this.prisma.user.findFirst({
      where: { tenantId: tenant.id, googleId },
    });

    if (!user) {
      user = await this.prisma.user.findFirst({
        where: { tenantId: tenant.id, email },
      });
      if (user) {
        // Link the Google ID to the existing account
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: { googleId },
        });
      }
    }

    if (!user) {
      // Auto-provision a new user for this tenant
      const username = await this.generateUniqueUsername(name, tenant.id);
      user = await this.prisma.user.create({
        data: {
          email,
          username,
          googleId,
          role: "OPERATOR",
          status: "ACTIVE",
          forcePasswordChange: false,
          tenantId: tenant.id,
        },
      });
    }

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      status: user.status,
      tenantId: user.tenantId!,
    };
  }

  private async generateUniqueUsername(name: string, tenantId: string): Promise<string> {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "_")
      .slice(0, 20);
    let candidate = base;
    let suffix = 1;
    while (await this.prisma.user.findFirst({ where: { tenantId, username: candidate } })) {
      candidate = `${base}_${suffix++}`;
    }
    return candidate;
  }
}
