import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { OAuth2Client } from "google-auth-library";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import Redis from "ioredis";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import type { AppConfig } from "../config/configuration";
import type { JwtPayload } from "./jwt-payload.interface";
import type { BuyerJwtPayload } from "../buyer/interfaces/buyer-jwt-payload.interface";

// ─── Types ────────────────────────────────────────────────────────────────────

interface OAuthState {
  type: "platform" | "tenant";
  nonce: string;
  tenantSlug?: string;
  inviteToken?: string;
  /** "portal" = buyer portal login page; "staff" = tenant dashboard login page */
  context?: "portal" | "staff";
}

export interface GoogleProfile {
  googleId: string;
  email: string;
  name: string;
  picture: string;
  type: "platform" | "tenant";
  tenantSlug?: string;
  inviteToken?: string;
  context?: "portal" | "staff";
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export type GoogleAuthResult =
  | ({
      kind: "platform";
      user: { id: string; username: string; role: string; tenantId: null; tenantSlug: null };
    } & TokenPair)
  | ({
      kind: "staff";
      user: { id: string; username: string; role: string; tenantId: string; tenantSlug: string };
    } & TokenPair)
  | ({
      kind: "buyer";
      buyer: { id: string; email: string; name: string };
      sellerCount: number;
    } & TokenPair);

// ─── Service ─────────────────────────────────────────────────────────────────

const NONCE_TTL_SECS = 600; // 10 minutes

@Injectable()
export class GoogleOAuthService {
  private readonly logger = new Logger(GoogleOAuthService.name);
  private readonly oauth2Client: OAuth2Client;
  private readonly redis: Redis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    // Use untyped ConfigService — Google and Redis keys are not in AppConfig
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
  ) {
    const clientId = configService.get<string>("GOOGLE_CLIENT_ID") ?? "";
    const clientSecret = configService.get<string>("GOOGLE_CLIENT_SECRET") ?? "";
    this.oauth2Client = new OAuth2Client(clientId, clientSecret);

    const redisUrl = configService.get<string>("REDIS_URL") ?? "redis://localhost:6379";
    const redisPassword = configService.get<string>("REDIS_PASSWORD");
    this.redis = new Redis(redisUrl, {
      password: redisPassword || undefined,
      maxRetriesPerRequest: 3,
      connectTimeout: 5000,
      enableOfflineQueue: true,
      lazyConnect: true,
    });
    this.redis.on("error", (err: Error) =>
      this.logger.warn(`GoogleOAuth Redis error: ${err.message}`),
    );
  }

  /**
   * Build a Google OAuth consent URL.
   * Persists a one-time nonce in Redis (TTL 10 min) for CSRF protection.
   */
  async generateAuthUrl(
    type: "platform" | "tenant",
    tenantSlug?: string,
    inviteToken?: string,
    context?: "portal" | "staff",
  ): Promise<string> {
    const nonce = crypto.randomUUID();
    const stateObj: OAuthState = {
      type,
      nonce,
      ...(tenantSlug && { tenantSlug }),
      ...(inviteToken && { inviteToken }),
      ...(context && { context }),
    };
    const state = Buffer.from(JSON.stringify(stateObj)).toString("base64url");

    // Fire-and-forget — a Redis outage must not prevent login initiation
    this.redis
      .set(`oauth:nonce:${nonce}`, "1", "EX", NONCE_TTL_SECS)
      .catch((e: Error) => this.logger.warn(`Nonce write failed: ${e.message}`));

    const redirectUri =
      type === "platform"
        ? (this.configService.get<string>("GOOGLE_REDIRECT_URI_PLATFORM") ?? "")
        : (this.configService.get<string>("GOOGLE_REDIRECT_URI_TENANT") ?? "");

    return this.oauth2Client.generateAuthUrl({
      access_type: "online",
      scope: ["email", "profile", "openid"],
      redirect_uri: redirectUri,
      state,
    });
  }

  /**
   * Exchange Google authorisation code for a verified GoogleProfile.
   * Throws ForbiddenException("state_invalid") if the nonce is missing or expired.
   */
  async verifyCallback(code: string, stateParam: string): Promise<GoogleProfile> {
    let stateObj: OAuthState;
    try {
      stateObj = JSON.parse(Buffer.from(stateParam, "base64url").toString("utf-8")) as OAuthState;
    } catch {
      throw new ForbiddenException("state_invalid");
    }

    if (!stateObj?.nonce) throw new ForbiddenException("state_invalid");

    // Atomically get-and-delete the nonce in a single round-trip (GETDEL, Redis ≥ 6.2).
    // Falls back to a Lua transaction on older Redis versions.
    const nonceKey = `oauth:nonce:${stateObj.nonce}`;
    let stored: string | null = null;
    try {
      // ioredis exposes sendCommand for commands not yet wrapped as methods
      stored = await (this.redis as any).getdel(nonceKey);
    } catch {
      // GETDEL not supported (Redis < 6.2) — use a Lua script for atomicity
      const luaResult = await this.redis
        .eval(
          `local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]) end; return v`,
          1,
          nonceKey,
        )
        .catch(() => null);
      stored = luaResult as string | null;
    }
    if (!stored) throw new ForbiddenException("state_invalid");

    const redirectUri =
      stateObj.type === "platform"
        ? (this.configService.get<string>("GOOGLE_REDIRECT_URI_PLATFORM") ?? "")
        : (this.configService.get<string>("GOOGLE_REDIRECT_URI_TENANT") ?? "");

    // Exchange code → tokens
    const { tokens } = await this.oauth2Client
      .getToken({ code, redirect_uri: redirectUri })
      .catch((err: Error) => {
        this.logger.error(`Google code exchange failed: ${err.message}`);
        throw new UnauthorizedException("google_token_invalid");
      });

    // Verify ID token
    const ticket = await this.oauth2Client
      .verifyIdToken({
        idToken: tokens.id_token!,
        audience: this.configService.get<string>("GOOGLE_CLIENT_ID") ?? "",
      })
      .catch((err: Error) => {
        this.logger.error(`Google ID token verification failed: ${err.message}`);
        throw new UnauthorizedException("google_token_invalid");
      });

    const idPayload = ticket.getPayload()!;
    return {
      googleId: idPayload.sub,
      email: idPayload.email!.toLowerCase(),
      name: idPayload.name ?? idPayload.email!,
      picture: idPayload.picture ?? "",
      type: stateObj.type,
      tenantSlug: stateObj.tenantSlug,
      inviteToken: stateObj.inviteToken,
      context: stateObj.context,
    };
  }

  /** Find or create the appropriate user record and return a token pair. */
  async findOrCreateUser(profile: GoogleProfile): Promise<GoogleAuthResult> {
    return profile.type === "platform"
      ? this.handlePlatformAuth(profile)
      : this.handleTenantAuth(profile);
  }

  // ─── Platform flow (SUPER_ADMIN only) ─────────────────────────────────────

  private async handlePlatformAuth(profile: GoogleProfile): Promise<GoogleAuthResult> {
    const user = await this.prisma.user.findFirst({
      where: {
        tenantId: null,
        role: "SUPER_ADMIN",
        deletedAt: null,
        OR: [{ googleId: profile.googleId }, { email: profile.email }],
      },
    });

    if (!user || user.status !== "ACTIVE") {
      throw new ForbiddenException("unauthorized");
    }

    // Link googleId on first Google sign-in via email-match.
    // Also clear forcePasswordChange — Google-authenticated users cannot set a
    // password via the change-password form, so the flag must not block them.
    if (!user.googleId) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { googleId: profile.googleId, forcePasswordChange: false },
      });
    }

    const tokens = await this.issueUserTokenPair(user, null);
    return {
      kind: "platform",
      ...tokens,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        tenantId: null,
        tenantSlug: null,
      },
    };
  }

  // ─── Tenant flow (OPERATOR/DRIVER or buyer portal) ─────────────────────────

  private async handleTenantAuth(profile: GoogleProfile): Promise<GoogleAuthResult> {
    if (!profile.tenantSlug) throw new BadRequestException("tenantSlug required");

    const tenant = await this.prisma.tenant.findFirst({ where: { slug: profile.tenantSlug } });
    if (!tenant) throw new ForbiddenException("tenant_suspended");
    if (tenant.status === "SUSPENDED" || tenant.status === "CANCELLED") {
      throw new ForbiddenException("tenant_suspended");
    }

    // Check for a matching staff user in this tenant first
    let staffUser = await this.prisma.user.findFirst({
      where: {
        tenantId: tenant.id,
        deletedAt: null,
        role: { in: ["OPERATOR", "DRIVER", "TENANT_ADMIN"] },
        OR: [{ googleId: profile.googleId }, { email: profile.email }],
      },
    });

    if (staffUser) {
      if (staffUser.status !== "ACTIVE") throw new ForbiddenException("unauthorized");

      // Request came from the buyer portal login page — block to prevent confusion
      if (profile.context === "portal") throw new ForbiddenException("google_email_is_staff");

      if (!staffUser.googleId) {
        staffUser = await this.prisma.user.update({
          where: { id: staffUser.id },
          // Clear forcePasswordChange — Google users cannot use the password
          // change form, so the flag must not redirect them to /change-password.
          data: { googleId: profile.googleId, forcePasswordChange: false },
        });
      }
      const tokens = await this.issueUserTokenPair(staffUser, tenant.slug);
      return {
        kind: "staff",
        ...tokens,
        user: {
          id: staffUser.id,
          username: staffUser.username,
          role: staffUser.role,
          tenantId: tenant.id,
          tenantSlug: tenant.slug,
        },
      };
    }

    // No staff match → buyer portal path (auto-create permitted for customers)
    return this.handleBuyerPortalAuth(profile);
  }

  private async handleBuyerPortalAuth(profile: GoogleProfile): Promise<GoogleAuthResult> {
    let buyer = await this.prisma.buyerAccount.findFirst({
      where: {
        deletedAt: null,
        OR: [{ googleId: profile.googleId }, { email: profile.email }],
      },
    });

    if (buyer) {
      if (buyer.status === "SUSPENDED") throw new ForbiddenException("unauthorized");

      // Auto-link googleId and send a security notification (fire-and-forget)
      if (!buyer.googleId) {
        await this.prisma.buyerAccount.update({
          where: { id: buyer.id },
          data: { googleId: profile.googleId },
        });
        void this.emailService
          .send({
            to: buyer.email,
            subject: "Google Sign-In linked to your RouteFlow account",
            html: `<p>Your Google account (<strong>${profile.email}</strong>) has been linked to your RouteFlow portal account.</p><p>If you did not authorise this, please contact support immediately.</p>`,
          })
          .catch((e: Error) => this.logger.warn(`Google link notification failed: ${e.message}`));
      }
    } else {
      // Auto-create portal account with an unguessable password hash (Google-only)
      const randomBytes = crypto.randomBytes(32).toString("hex");
      const passwordHash = await bcrypt.hash(randomBytes, 10);
      buyer = await this.prisma.buyerAccount.create({
        data: {
          email: profile.email,
          passwordHash,
          name: profile.name,
          googleId: profile.googleId,
          status: "ACTIVE",
          emailVerified: true,
        },
      });
      this.logger.log(`BuyerAccount created via Google: ${profile.email}`);
    }

    // Process an invite token embedded in the OAuth state
    if (profile.inviteToken) {
      await this.acceptInviteToken(profile.inviteToken, buyer.id).catch((e: Error) =>
        this.logger.warn(`Invite token processing failed: ${e.message}`),
      );
    }

    const sellerCount = await this.prisma.customerLink.count({
      where: { buyerAccountId: buyer.id, status: "ACTIVE" },
    });
    const tokens = await this.issueBuyerTokenPair(buyer.id, buyer.email, buyer.name);

    return {
      kind: "buyer",
      ...tokens,
      buyer: { id: buyer.id, email: buyer.email, name: buyer.name },
      sellerCount,
    };
  }

  // ─── Invite token helper ───────────────────────────────────────────────────

  private async acceptInviteToken(token: string, buyerAccountId: string): Promise<void> {
    const link = await this.prisma.customerLink.findFirst({
      where: { inviteToken: token, status: "INVITED" },
    });
    if (!link) return;
    if (link.inviteExpiresAt && link.inviteExpiresAt < new Date()) return;

    await this.prisma.customerLink.update({
      where: { id: link.id },
      data: {
        buyerAccountId,
        status: "ACTIVE",
        inviteToken: null,
        inviteExpiresAt: null,
        linkedAt: new Date(),
      },
    });
    this.logger.log(`CustomerLink accepted via Google invite: buyer=${buyerAccountId}`);
  }

  // ─── Token issuance helpers ────────────────────────────────────────────────

  private async issueUserTokenPair(user: any, tenantSlug: string | null): Promise<TokenPair> {
    const jwtConfig = this.configService.get<{
      secret: string;
      refreshSecret: string;
      expiresIn: string;
      refreshExpiresIn: string;
    }>("jwt")!;
    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      forcePasswordChange: user.forcePasswordChange ?? false,
      tenantId: user.tenantId ?? null,
      tenantSlug: tenantSlug ?? null,
    };
    const accessToken = this.jwtService.sign(payload, {
      secret: jwtConfig.secret,
      expiresIn: jwtConfig.expiresIn as any,
    });
    const refreshToken = this.jwtService.sign(
      { sub: user.id },
      { secret: jwtConfig.refreshSecret, expiresIn: jwtConfig.refreshExpiresIn as any },
    );
    await this.storeUserRefreshToken(user.id, refreshToken);
    return { accessToken, refreshToken };
  }

  private async issueBuyerTokenPair(
    buyerAccountId: string,
    email: string,
    name: string,
  ): Promise<TokenPair> {
    const jwtConfig = this.configService.get<{
      secret: string;
      refreshSecret: string;
      expiresIn: string;
      refreshExpiresIn: string;
    }>("jwt")!;
    const payload: BuyerJwtPayload = { sub: buyerAccountId, email, name, type: "BUYER" };
    const accessToken = this.jwtService.sign(payload, {
      secret: jwtConfig.secret,
      expiresIn: jwtConfig.expiresIn as any,
    });
    const refreshToken = this.jwtService.sign(
      { sub: buyerAccountId },
      { secret: jwtConfig.refreshSecret, expiresIn: jwtConfig.refreshExpiresIn as any },
    );
    const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
    const decoded = this.jwtService.decode(refreshToken) as { exp: number };
    const expiresAt = new Date(decoded.exp * 1000);
    await this.prisma.buyerRefreshToken.upsert({
      where: { tokenHash },
      create: { buyerAccountId, tokenHash, expiresAt },
      update: { expiresAt },
    });
    return { accessToken, refreshToken };
  }

  private async storeUserRefreshToken(userId: string, token: string): Promise<void> {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const decoded = this.jwtService.decode(token) as { exp: number };
    const expiresAt = new Date(decoded.exp * 1000);
    await this.prisma.refreshToken.upsert({
      where: { tokenHash },
      create: { userId, tokenHash, expiresAt },
      update: { expiresAt },
    });
  }
}
