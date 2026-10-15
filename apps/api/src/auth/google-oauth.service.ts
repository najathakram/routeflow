import { safeBuyerDisplayName } from "../common/text-cell-guards";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
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
import { sellerAcceptsBuyerWrite } from "../buyer/seller-status-gate";
import { EntitlementsService } from "../billing/entitlements.service";
import type { DeviceInfo } from "./auth.service";
import { escapeHtml } from "../common/html-escape";
import { DERIVED_JWT_LABELS, derivedJwtKey } from "../common/derived-jwt-key";
import { casLinkProviderId, resolveBySubThenEmail } from "./oauth-account-link";
import {
  BUYER_ACCESS_AUDIENCE,
  BUYER_REFRESH_AUDIENCE,
  STAFF_ACCESS_AUDIENCE,
  STAFF_REFRESH_AUDIENCE,
} from "./session-token";

// ─── Types ────────────────────────────────────────────────────────────────────

interface OAuthState {
  type: "platform" | "tenant";
  nonce: string;
  tenantSlug?: string;
  inviteToken?: string;
  /** "portal" = buyer portal via invite; "staff" = tenant dashboard; "buyer-standalone" = buyer portal without seller context */
  context?: "portal" | "staff" | "buyer-standalone";
  /** When set, this is a link-account flow for an already-authenticated user. */
  linkUserId?: string;
  /** When true, the callback redirects to a mobile deep link (routeflow://) instead of the web URL. */
  mobile?: boolean;
  /**
   * F12-005: device-generated state nonce for the mobile deep-link flow. Echoed
   * back to the app in the routeflow:// callback so the app can prove the flow
   * originated on this device (session-fixation guard). Optional — older app
   * builds don't send it.
   */
  deviceState?: string;
  /**
   * B825: the browser origin the callback should redirect back to for a
   * BROWSER-based flow (never the native `mobile` deep-link flow above) —
   * the Expo mobile-web build's own origin, so a driver signing in from
   * there returns to it instead of always landing on the Next web app.
   * Already validated against the exact allow-list (AuthController's
   * `resolveReturnOrigin`) at mint time, in `generateAuthUrl` — the HMAC over
   * this whole payload (B349) makes it tamper-proof from here on, so nothing
   * downstream needs to re-derive or re-check it against the allow-list;
   * only the callback's PRE-signature-check peek does (untrusted input).
   */
  returnOrigin?: string;
}

export interface GoogleProfile {
  googleId: string;
  email: string;
  name: string;
  picture: string;
  type: "platform" | "tenant";
  tenantSlug?: string;
  inviteToken?: string;
  context?: "portal" | "staff" | "buyer-standalone";
  /** When set, this is a link-account flow — attach Google to this existing user ID. */
  linkUserId?: string;
  /** When true, the callback should redirect to a mobile deep link. */
  mobile?: boolean;
  /** F12-005: device-generated state nonce to echo back in the mobile deep link. */
  deviceState?: string;
  /** B825: already-validated browser origin for a non-`mobile` (browser) flow. */
  returnOrigin?: string;
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
      buyer: { id: string; email: string; name: string; hasPassword: boolean };
      sellerCount: number;
      /** Only when the sign-in carried an invite: what became of it (see InviteOutcome). */
      inviteOutcome?: InviteOutcome;
    } & TokenPair);

// ─── Service ─────────────────────────────────────────────────────────────────

const NONCE_TTL_SECS = 600; // 10 minutes

/** What the callback's invite step did: linked, silently skipped (dead / removed / expired), or refused by the seller's status. */
export type InviteOutcome = "accepted" | "ignored" | "seller_unavailable";

// B349: the OAuth `state` is signed so a caller cannot rewrite `linkUserId` (or any
// other field) to attach their Google identity to someone else's account. The key is
// derived from JWT_SECRET by the shared helper (common/derived-jwt-key.ts) — no new secret to
// provision.

@Injectable()
export class GoogleOAuthService {
  private readonly logger = new Logger(GoogleOAuthService.name);
  private readonly oauth2Client: OAuth2Client;
  private readonly redis: Redis;
  private readonly stateSigningKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    // Use untyped ConfigService — Google and Redis keys are not in AppConfig
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
    private readonly entitlements: EntitlementsService,
  ) {
    const clientId = configService.get<string>("GOOGLE_CLIENT_ID") ?? "";
    const clientSecret = configService.get<string>("GOOGLE_CLIENT_SECRET") ?? "";
    this.oauth2Client = new OAuth2Client(clientId, clientSecret);

    // B349 round 1: a missing or short secret fails closed (the helper throws) rather than
    // deriving the state-signing key from a guessable value.
    this.stateSigningKey = derivedJwtKey(
      DERIVED_JWT_LABELS.oauthState,
      configService.get<{ secret: string }>("jwt")?.secret ?? "",
    );

    if (!clientId || !clientSecret) {
      this.logger.warn(
        "GOOGLE_CLIENT_ID and/or GOOGLE_CLIENT_SECRET are not set. " +
          "Google OAuth sign-in will be unavailable. " +
          "Set these in your Railway environment variables.",
      );
    }

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
   * Returns true if GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are non-empty.
   * Controllers should call this before attempting to generate an OAuth URL.
   */
  isConfigured(): boolean {
    const clientId = this.configService.get<string>("GOOGLE_CLIENT_ID");
    const clientSecret = this.configService.get<string>("GOOGLE_CLIENT_SECRET");
    return !!(clientId && clientSecret);
  }

  /**
   * Resolve the OAuth redirect URI for a given flow type.
   * Priority: explicit env var → Railway auto-domain fallback.
   * Throws ServiceUnavailableException if neither is available.
   */
  private resolveRedirectUri(type: "platform" | "tenant"): string {
    if (type === "platform") {
      const explicit = this.configService.get<string>("GOOGLE_REDIRECT_URI_PLATFORM");
      if (explicit) return explicit;
      const domain = this.configService.get<string>("RAILWAY_PUBLIC_DOMAIN");
      if (domain) return `https://${domain}/api/v1/platform-admin/auth/google/callback`;
      throw new ServiceUnavailableException(
        "Google OAuth redirect URI cannot be resolved. " +
          "Set GOOGLE_REDIRECT_URI_PLATFORM or ensure RAILWAY_PUBLIC_DOMAIN is available.",
      );
    }
    const explicit = this.configService.get<string>("GOOGLE_REDIRECT_URI_TENANT");
    if (explicit) return explicit;
    const domain = this.configService.get<string>("RAILWAY_PUBLIC_DOMAIN");
    if (domain) return `https://${domain}/api/v1/auth/google/callback`;
    throw new ServiceUnavailableException(
      "Google OAuth redirect URI cannot be resolved. " +
        "Set GOOGLE_REDIRECT_URI_TENANT or ensure RAILWAY_PUBLIC_DOMAIN is available.",
    );
  }

  /**
   * B349: sign a state payload — base64url(payloadJson) + "." + base64url(HMAC-SHA256).
   * The MAC covers the exact JSON string, so any edit to the payload (e.g. rewriting
   * `linkUserId`) invalidates it.
   */
  private signState(payloadJson: string): string {
    const mac = crypto.createHmac("sha256", this.stateSigningKey).update(payloadJson).digest();
    return `${Buffer.from(payloadJson, "utf-8").toString("base64url")}.${mac.toString("base64url")}`;
  }

  /**
   * B349: verify a state's signature and return the raw payload JSON on success.
   * Throws the same generic ForbiddenException("state_invalid") the rest of the
   * callback path uses — no oracle distinguishing a bad MAC from any other failure.
   */
  private verifyStateSignature(stateParam: string): string {
    const parts = typeof stateParam === "string" ? stateParam.split(".") : [];
    if (parts.length !== 2) throw new ForbiddenException("state_invalid");
    const [payloadB64, macB64] = parts;

    let payloadJson: string;
    let presentedMac: Buffer;
    try {
      payloadJson = Buffer.from(payloadB64, "base64url").toString("utf-8");
      presentedMac = Buffer.from(macB64, "base64url");
    } catch {
      throw new ForbiddenException("state_invalid");
    }

    const expectedMac = crypto
      .createHmac("sha256", this.stateSigningKey)
      .update(payloadJson)
      .digest();
    if (
      presentedMac.length !== expectedMac.length ||
      !crypto.timingSafeEqual(presentedMac, expectedMac)
    ) {
      throw new ForbiddenException("state_invalid");
    }
    return payloadJson;
  }

  /**
   * Build a Google OAuth consent URL.
   * Persists a one-time nonce in Redis (TTL 10 min) for CSRF protection.
   */
  async generateAuthUrl(
    type: "platform" | "tenant",
    tenantSlug?: string,
    inviteToken?: string,
    context?: "portal" | "staff" | "buyer-standalone",
    mobile?: boolean,
    deviceState?: string,
    // B825: already validated by the caller (AuthController.resolveReturnOrigin)
    // against the exact WEB_URL/MOBILE_WEB_URL allow-list — never re-derived here.
    returnOrigin?: string,
  ): Promise<string> {
    const nonce = crypto.randomUUID();
    const stateObj: OAuthState = {
      type,
      nonce,
      ...(tenantSlug && { tenantSlug }),
      ...(inviteToken && { inviteToken }),
      ...(context && { context }),
      ...(mobile && { mobile: true }),
      // F12-005: carry the device state nonce through Google (opaque round-trip).
      ...(deviceState && { deviceState }),
      ...(returnOrigin && { returnOrigin }),
    };
    const payloadJson = JSON.stringify(stateObj);
    const state = this.signState(payloadJson);

    // Fire-and-forget — a Redis outage must not prevent login initiation.
    // B349: bind the nonce to this exact payload (its content hash) rather than a
    // bare presence flag, so the callback can reject a nonce presented alongside a
    // payload it wasn't minted for.
    const payloadHash = crypto.createHash("sha256").update(payloadJson).digest("hex");
    this.redis
      .set(`oauth:nonce:${nonce}`, payloadHash, "EX", NONCE_TTL_SECS)
      .catch((e: Error) => this.logger.warn(`Nonce write failed: ${e.message}`));

    const redirectUri = this.resolveRedirectUri(type);

    return this.oauth2Client.generateAuthUrl({
      access_type: "online",
      scope: ["email", "profile", "openid"],
      redirect_uri: redirectUri,
      state,
    });
  }

  /**
   * Build a Google OAuth consent URL for linking an existing user's account.
   * The `linkUserId` is embedded in the state so the callback knows to link
   * rather than sign in.
   */
  async generateLinkUrl(type: "platform" | "tenant", userId: string): Promise<string> {
    const nonce = crypto.randomUUID();
    const stateObj: OAuthState = { type, nonce, linkUserId: userId };
    const payloadJson = JSON.stringify(stateObj);
    const state = this.signState(payloadJson);

    const payloadHash = crypto.createHash("sha256").update(payloadJson).digest("hex");
    this.redis
      .set(`oauth:nonce:${nonce}`, payloadHash, "EX", NONCE_TTL_SECS)
      .catch((e: Error) => this.logger.warn(`Nonce write failed: ${e.message}`));

    const redirectUri = this.resolveRedirectUri(type);

    return this.oauth2Client.generateAuthUrl({
      access_type: "online",
      scope: ["email", "profile", "openid"],
      redirect_uri: redirectUri,
      state,
    });
  }

  /**
   * Link a Google account to an existing user (identified by `profile.linkUserId`).
   * Throws if:
   *   - the user doesn't exist
   *   - the user already has a different Google account linked
   *   - the Google ID is already taken by another user
   */
  async linkGoogleAccount(profile: GoogleProfile): Promise<void> {
    const { linkUserId, googleId, email } = profile;
    if (!linkUserId) throw new BadRequestException("linkUserId required");

    const user = await this.prisma.user.findUnique({ where: { id: linkUserId } });
    if (!user || user.deletedAt) throw new ForbiddenException("unauthorized");

    // Check if this Google ID is already claimed by a different user within the same tenant
    const existingByGoogleId = await this.prisma.user.findFirst({
      where: { googleId, tenantId: user.tenantId, id: { not: linkUserId }, deletedAt: null },
    });
    if (existingByGoogleId) throw new ForbiddenException("google_id_taken");
    if (user.googleId) throw new ForbiddenException("google_already_linked");

    // Link by compare-and-set (oauth-account-link.ts, shared with sign-in): only the first writer
    // wins. A lost race to a DIFFERENT sub is refused like the read-time check above; to the SAME
    // sub it is a harmless duplicate (nothing to repeat, no second notification).
    let linked: boolean;
    try {
      ({ linked } = await casLinkProviderId({
        updateMany: (args) => this.prisma.user.updateMany(args as any),
        findUnique: (id) => this.prisma.user.findUnique({ where: { id } }),
        row: user,
        column: "googleId",
        sub: googleId,
        data: { forcePasswordChange: false },
        extraWhere: { tenantId: user.tenantId },
      }));
    } catch (e) {
      if (e instanceof ConflictException) throw new ForbiddenException("google_already_linked");
      throw e;
    }
    if (!linked) return;

    this.logger.log(`Google account linked for user ${linkUserId}`);

    // Fire-and-forget security notification
    if (user.email) {
      void this.emailService
        .send({
          to: user.email,
          subject: "Google Sign-In linked to your RouteFlow account",
          html: `<p>Your Google account (<strong>${escapeHtml(email)}</strong>) has been linked to your RouteFlow account.</p><p>If you did not authorise this, please contact support immediately.</p>`,
          // email-connect-google PR-3: platform sender only — never a tenant mailbox/SMTP.
          senderClass: "platform",
        })
        .catch((e: Error) => this.logger.warn(`Google link notification failed: ${e.message}`));
    }
  }

  /**
   * Exchange Google authorisation code for a verified GoogleProfile.
   * Throws ForbiddenException("state_invalid") if the nonce is missing or expired.
   */
  async verifyCallback(code: string, stateParam: string): Promise<GoogleProfile> {
    // B349: verify the HMAC BEFORE parsing — reject a tampered payload without ever
    // trusting its content (e.g. a rewritten `linkUserId`).
    const payloadJson = this.verifyStateSignature(stateParam);

    let stateObj: OAuthState;
    try {
      stateObj = JSON.parse(payloadJson) as OAuthState;
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

    // B349: bind the nonce to the payload it was minted for — reject a presented
    // payload whose content hash doesn't match what this nonce was stored against.
    // The MAC above already proves the payload wasn't tampered with post-mint; this
    // additionally proves it's the SAME payload the nonce was issued for.
    const presentedHash = crypto.createHash("sha256").update(payloadJson).digest("hex");
    const storedBuf = Buffer.from(stored, "utf-8");
    const presentedBuf = Buffer.from(presentedHash, "utf-8");
    if (
      storedBuf.length !== presentedBuf.length ||
      !crypto.timingSafeEqual(storedBuf, presentedBuf)
    ) {
      throw new ForbiddenException("state_invalid");
    }

    const redirectUri = this.resolveRedirectUri(stateObj.type);

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
    // F3-001: reject accounts where Google has not verified the email address.
    // Unverified emails can be claimed with arbitrary addresses (workspace aliases,
    // edu domains), enabling account-takeover via a spoofed email match.
    if (!idPayload.email_verified) {
      throw new UnauthorizedException("google_email_not_verified");
    }
    return {
      googleId: idPayload.sub,
      email: idPayload.email!.toLowerCase(),
      name: idPayload.name ?? idPayload.email!,
      picture: idPayload.picture ?? "",
      type: stateObj.type,
      tenantSlug: stateObj.tenantSlug,
      inviteToken: stateObj.inviteToken,
      context: stateObj.context,
      linkUserId: stateObj.linkUserId,
      mobile: stateObj.mobile,
      deviceState: stateObj.deviceState,
      returnOrigin: stateObj.returnOrigin,
    };
  }

  // ─── One-time token handoff (F8-001) ───────────────────────────────────────
  // Instead of redirecting the browser to the web app with tokens embedded in the
  // URL query string (which leaks into CDN/proxy/server access logs, browser
  // history and the Referer header), we stash the token bundle in Redis under a
  // single-use opaque code with a short TTL. The callback page exchanges the code
  // for the bundle via a POST, so secrets never touch the URL.

  private static readonly EXCHANGE_TTL_SECS = 120;

  /** Store a token bundle and return a single-use opaque exchange code. */
  async createExchangeCode(bundle: Record<string, string>): Promise<string> {
    const code = crypto.randomBytes(32).toString("base64url");
    await this.redis.set(
      `oauth:xchg:${code}`,
      JSON.stringify(bundle),
      "EX",
      GoogleOAuthService.EXCHANGE_TTL_SECS,
    );
    return code;
  }

  /**
   * Atomically fetch-and-delete a token bundle for an exchange code (single-use).
   * Returns null if the code is unknown, already consumed, or expired.
   */
  async consumeExchangeCode(code: string): Promise<Record<string, string> | null> {
    if (!code) return null;
    const key = `oauth:xchg:${code}`;
    let stored: string | null = null;
    try {
      stored = await (this.redis as any).getdel(key);
    } catch {
      const luaResult = await this.redis
        .eval(
          `local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]) end; return v`,
          1,
          key,
        )
        .catch(() => null);
      stored = luaResult as string | null;
    }
    if (!stored) return null;
    try {
      return JSON.parse(stored) as Record<string, string>;
    } catch {
      return null;
    }
  }

  // ─── Lookup order (#2495) ───────────────────────────────────────────────────
  // Shared by handlePlatformAuth, handleTenantAuth's staff lookup and
  // handleBuyerPortalAuth. The old `findFirst({ OR: [{ googleId }, { email }] })`
  // was nondeterministic when two rows matched (one bound to this Google sub,
  // another merely sharing the email) — Postgres gives no ordering guarantee over
  // an OR with no ORDER BY, so which row "won" could vary. Resolve by the Google
  // sub FIRST (a bound identity is unambiguous); only fall back to email when no
  // sub match exists. If the email match is already bound to a DIFFERENT Google
  // sub, refuse outright — signing in must never silently re-target someone
  // else's linked account.
  //
  // Callers only ever receive a `GoogleProfile` from `verifyCallback`, which
  // rejects `email_verified === false` before ever constructing one (see
  // `google-oauth.email-verified.security.spec.ts`) — so an unverified email
  // can never reach this lookup or the auto-link branches below it. Pinned,
  // not re-checked here, to avoid duplicating that gate.
  private async resolveBySubThenEmail<T extends { googleId: string | null }>(
    findFirst: (args: Record<string, unknown>) => Promise<T | null>,
    baseWhere: Record<string, unknown>,
    profile: GoogleProfile,
  ): Promise<T | null> {
    // #2664: fail closed before touching the DB at all — a falsy sub or email means
    // `verifyCallback`'s profile is malformed, and an undefined/empty filter would turn `where`
    // into an unscoped match. (Google always carries an email, so unlike Apple it is required.)
    if (!profile.googleId || !profile.email) {
      throw new ForbiddenException("unauthorized");
    }
    // The ONE rule (oauth-account-link.ts, shared with Apple): sub first, then the ordered email
    // match; an email row bound to a DIFFERENT sub is a 409 google_account_mismatch.
    return resolveBySubThenEmail({
      findFirst,
      baseWhere,
      column: "googleId",
      sub: profile.googleId,
      email: profile.email,
    });
  }

  // ─── Link race guard (#2495 LOW) ────────────────────────────────────────────
  // The googleId-NULL email-match auto-link (handlePlatformAuth, handleTenantAuth's
  // staff link, handleBuyerPortalAuth's first-link branch) used to be check-then-update:
  // read the row with googleId:null, then unconditionally write the sub. Two concurrent
  // sign-ins for the same email (one with the rightful sub, one with an attacker's) could
  // both pass the read before either wrote, and the writer that lost the race would still
  // overwrite whatever the winner just set. Guard the write itself with a compare-and-set
  // (`updateMany` scoped to `googleId: null`) so only the first writer succeeds; a losing
  // writer re-reads and either finds itself already linked (a harmless duplicate — same
  // sub) or a DIFFERENT sub now bound, which is refused exactly like the read-time check.
  private async casLinkGoogleId<T extends { id: string; googleId: string | null }>(
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>,
    findUnique: (id: string) => Promise<T | null>,
    row: T,
    profile: GoogleProfile,
    data: Record<string, unknown>,
  ): Promise<{ row: T; linked: boolean }> {
    // Shared CAS (oauth-account-link.ts): only the first writer succeeds; a lost race to a
    // different sub is a 409 google_account_mismatch, to the same sub a harmless duplicate.
    return casLinkProviderId({
      updateMany,
      findUnique,
      row,
      column: "googleId",
      sub: profile.googleId,
      data,
    });
  }

  /** Find or create the appropriate user record and return a token pair. */
  async findOrCreateUser(
    profile: GoogleProfile,
    deviceInfo?: DeviceInfo,
  ): Promise<GoogleAuthResult> {
    return profile.type === "platform"
      ? this.handlePlatformAuth(profile, deviceInfo)
      : this.handleTenantAuth(profile, deviceInfo);
  }

  // ─── Platform flow (SUPER_ADMIN only) ─────────────────────────────────────

  private async handlePlatformAuth(
    profile: GoogleProfile,
    deviceInfo?: DeviceInfo,
  ): Promise<GoogleAuthResult> {
    const user = await this.resolveBySubThenEmail(
      (args: any) => this.prisma.user.findFirst(args),
      { tenantId: null, role: "SUPER_ADMIN", deletedAt: null },
      profile,
    );

    if (!user || user.status !== "ACTIVE") {
      throw new ForbiddenException("unauthorized");
    }

    // Link googleId on first Google sign-in via email-match.
    // Also clear forcePasswordChange — Google-authenticated users cannot set a
    // password via the change-password form, so the flag must not block them.
    if (!user.googleId) {
      await this.casLinkGoogleId(
        (args) => this.prisma.user.updateMany(args),
        (id) => this.prisma.user.findUnique({ where: { id } }),
        user,
        profile,
        { googleId: profile.googleId, forcePasswordChange: false },
      );
    }

    const tokens = await this.issueUserTokenPair(user, null, deviceInfo);
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

  private async handleTenantAuth(
    profile: GoogleProfile,
    deviceInfo?: DeviceInfo,
  ): Promise<GoogleAuthResult> {
    // buyer-standalone: Google sign-in from the buyer portal without a seller invite link.
    // Skip tenant resolution entirely and go straight to buyer portal auth.
    if (profile.context === "buyer-standalone") {
      return this.handleBuyerPortalAuth(profile);
    }

    if (!profile.tenantSlug) throw new BadRequestException("tenantSlug required");

    const tenant = await this.prisma.tenant.findFirst({ where: { slug: profile.tenantSlug } });
    if (!tenant) throw new ForbiddenException("tenant_suspended");
    if (tenant.status === "SUSPENDED" || tenant.status === "CANCELLED") {
      throw new ForbiddenException("tenant_suspended");
    }

    // Check for a matching staff user in this tenant first
    let staffUser = await this.resolveBySubThenEmail(
      (args: any) => this.prisma.user.findFirst(args),
      {
        tenantId: tenant.id,
        deletedAt: null,
        role: { in: ["OPERATOR", "DRIVER", "TENANT_ADMIN"] },
      },
      profile,
    );

    if (staffUser) {
      if (staffUser.status !== "ACTIVE") throw new ForbiddenException("unauthorized");

      // Request came from the buyer portal login page — block to prevent confusion
      if (profile.context === "portal") throw new ForbiddenException("google_email_is_staff");

      if (!staffUser.googleId) {
        const { row } = await this.casLinkGoogleId(
          (args) => this.prisma.user.updateMany(args),
          (id) => this.prisma.user.findUnique({ where: { id } }),
          staffUser,
          profile,
          // Clear forcePasswordChange — Google users cannot use the password
          // change form, so the flag must not redirect them to /change-password.
          { googleId: profile.googleId, forcePasswordChange: false },
        );
        staffUser = row;
      }
      const tokens = await this.issueUserTokenPair(staffUser, tenant.slug, deviceInfo);
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
    let buyer = await this.resolveBySubThenEmail(
      (args: any) => this.prisma.buyerAccount.findFirst(args),
      { deletedAt: null },
      profile,
    );

    if (buyer) {
      if (buyer.status === "SUSPENDED") throw new ForbiddenException("unauthorized");

      // Google attests the mailbox it authenticated — when that's the account's own
      // email, it satisfies the registration verification gate (requestSeller's
      // emailVerified check) exactly like clicking the emailed link would. NOT when
      // the account was found via a previously-linked googleId and the emails
      // differ: Google proved profile.email, not the account email.
      const googleAttestsMailbox = buyer.email.toLowerCase() === profile.email;

      // SECURITY (buyer-connect account-takeover): registration issues tokens with no
      // mailbox proof, so a password sitting on an account whose mailbox was NEVER
      // verified is attacker-controlled by assumption — anyone could have registered
      // under this email and chosen that password. When a Google sign-in is now about
      // to VERIFY the mailbox, the rightful owner is the Google identity, not whoever
      // set the password. Neutralize the squatted credential first: replace the hash
      // with an unguessable placeholder (passwordSet:false, so the true owner can claim
      // a real password via /buyer/auth/set-password) and revoke every existing session.
      const squattedPassword = googleAttestsMailbox && buyer.passwordSet && !buyer.emailVerified;

      if (!buyer.googleId) {
        let linked: boolean;
        if (squattedPassword) {
          const placeholderHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
          const casResult = await this.casLinkGoogleId(
            (args) => this.prisma.buyerAccount.updateMany(args),
            (id) => this.prisma.buyerAccount.findUnique({ where: { id } }),
            buyer,
            profile,
            {
              googleId: profile.googleId,
              emailVerified: true,
              passwordHash: placeholderHash,
              passwordSet: false,
            },
          );
          buyer = casResult.row;
          linked = casResult.linked;
          if (linked) {
            await this.prisma.buyerRefreshToken.deleteMany({
              where: { buyerAccountId: buyer.id },
            });
            this.logger.warn(
              `Buyer ${buyer.id} had an unverified password neutralized on first Google link ` +
                `(mailbox now attested by Google; prior sessions revoked)`,
            );
          }
        } else {
          const casResult = await this.casLinkGoogleId(
            (args) => this.prisma.buyerAccount.updateMany(args),
            (id) => this.prisma.buyerAccount.findUnique({ where: { id } }),
            buyer,
            profile,
            {
              googleId: profile.googleId,
              ...(googleAttestsMailbox ? { emailVerified: true } : {}),
            },
          );
          buyer = casResult.row;
          linked = casResult.linked;
        }
        // Only notify when THIS request actually performed the link — a request
        // that lost the race to an identical concurrent one must not re-send it.
        if (linked) {
          void this.emailService
            .send({
              to: buyer.email,
              subject: "Google Sign-In linked to your RouteFlow account",
              html: `<p>Your Google account (<strong>${escapeHtml(profile.email)}</strong>) has been linked to your RouteFlow portal account.</p><p>If you did not authorise this, please contact support immediately.</p>`,
              // email-connect-google PR-3: platform sender only — never a tenant mailbox/SMTP.
              senderClass: "platform",
            })
            .catch((e: Error) => this.logger.warn(`Google link notification failed: ${e.message}`));
        }
      } else if (googleAttestsMailbox && !buyer.emailVerified) {
        // Already-linked account whose mailbox was never verified (e.g. password
        // registration followed by Google linking before this gate existed). Same
        // squat exposure as the first-link path — neutralize the unproven password too.
        if (squattedPassword) {
          const placeholderHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
          buyer = await this.prisma.buyerAccount.update({
            where: { id: buyer.id },
            data: {
              emailVerified: true,
              passwordHash: placeholderHash,
              passwordSet: false,
            },
          });
          await this.prisma.buyerRefreshToken.deleteMany({
            where: { buyerAccountId: buyer.id },
          });
          this.logger.warn(
            `Buyer ${buyer.id} had an unverified password neutralized on Google sign-in ` +
              `(already-linked; prior sessions revoked)`,
          );
        } else {
          buyer = await this.prisma.buyerAccount.update({
            where: { id: buyer.id },
            data: { emailVerified: true },
          });
        }
      }
    } else {
      // Auto-create portal account with an unguessable password hash (Google-only).
      // passwordSet:false marks the hash as a placeholder so the buyer can later
      // claim a real password via /buyer/auth/set-password without knowing it.
      const randomBytes = crypto.randomBytes(32).toString("hex");
      const passwordHash = await bcrypt.hash(randomBytes, 10);
      buyer = await this.prisma.buyerAccount.create({
        data: {
          email: profile.email,
          passwordHash,
          passwordSet: false,
          // B964: the provider's name never blocks a sign-in; a formula-led one is neutralised to the email local-part
          name: safeBuyerDisplayName(profile.name, profile.email),
          googleId: profile.googleId,
          status: "ACTIVE",
          emailVerified: true,
        },
      });
      this.logger.log(`BuyerAccount created via Google: ${buyer.id}`);
    }

    // Process an invite token embedded in the OAuth state
    // The invite never blocks the sign-in: a link that cannot be accepted (dead, removed, expired, or refused by the
    // seller's workspace status) is skipped and the buyer still lands signed in. The outcome rides on the result so
    // the callback reports `linked` only when a link was really activated, and says so when the seller refused.
    let inviteOutcome: InviteOutcome | undefined;
    if (profile.inviteToken) {
      inviteOutcome = await this.acceptInviteToken(profile.inviteToken, buyer.id).catch(
        (e: Error): InviteOutcome => {
          this.logger.warn(`Invite token processing failed: ${e.message}`);
          return "ignored";
        },
      );
    }

    // REG-B141: the count of USABLE sellers the Google callback hands the client (web reads it
    // from the redirect). It must use the SAME definition as BuyerService.getSellers' ACTIVE
    // links — a link whose customer was removed is not one. Mobile no longer branches on it
    // (#2546): it reads GET /buyer/sellers itself so a pending-only buyer lands on its seller list.
    const sellerCount = await this.prisma.customerLink.count({
      where: { buyerAccountId: buyer.id, status: "ACTIVE", customer: { deletedAt: null } },
    });
    const tokens = await this.issueBuyerTokenPair(
      buyer.id,
      buyer.email,
      buyer.name,
      buyer.passwordSet,
    );

    return {
      kind: "buyer",
      ...tokens,
      buyer: {
        id: buyer.id,
        email: buyer.email,
        name: buyer.name,
        hasPassword: buyer.passwordSet,
      },
      sellerCount,
      ...(inviteOutcome ? { inviteOutcome } : {}),
    };
  }

  // ─── Invite token helper ───────────────────────────────────────────────────

  private async acceptInviteToken(token: string, buyerAccountId: string): Promise<InviteOutcome> {
    // PENDING_SELLER_APPROVAL is redeemable too: a buyer-initiated request against an
    // INVITED row flips the status while PRESERVING the token, and the true invitee's
    // emailed link must keep working. Mirrors BuyerService.acceptInvite's gate, including
    // REG-B141's `customer: { deletedAt: null }`: a removed customer's invite is not
    // redeemable, so the link is left untouched and the token is NOT consumed — restore has
    // to be able to bring the pending invite back with the customer. The Google path ignores
    // a non-redeemable token silently (`return`), exactly as it does an expired one.
    const link = await this.prisma.customerLink.findFirst({
      where: {
        inviteToken: token,
        status: { in: ["INVITED", "PENDING_SELLER_APPROVAL"] },
        customer: { deletedAt: null },
      },
      include: { tenant: { select: { id: true, status: true } } },
    });
    if (!link) return "ignored";
    if (link.inviteExpiresAt && link.inviteExpiresAt < new Date()) return "ignored";

    // The acceptance follows the seller's workspace status through the ONE buyer-write rule (SA-776;
    // buyer/seller-status-gate.ts), before any write. A refusal leaves the row and its invite token untouched, so the
    // invite can be accepted once the seller is back.
    const verdict = link.tenant
      ? sellerAcceptsBuyerWrite({
          sellerStatus: link.tenant.status,
          sellerId: link.tenant.id,
          logger: this.logger,
          context: "GET /api/v1/auth/google/callback (invite)",
        })
      : ({ allowed: false, reason: "SELLER_BLOCKED" } as const);
    if (!verdict.allowed) return "seller_unavailable";

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
    return "accepted";
  }

  // ─── Token issuance helpers ────────────────────────────────────────────────

  private async issueUserTokenPair(
    user: any,
    tenantSlug: string | null,
    deviceInfo?: DeviceInfo,
  ): Promise<TokenPair> {
    // #2159 S1: a Google sign-in is an interactive sign-in too — stamp lastLoginAt exactly as
    // AuthService.login() does (best-effort; a failed stamp never blocks the sign-in).
    try {
      await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    } catch (err) {
      this.logger.warn(`lastLoginAt stamp failed for user ${user.id}: ${(err as Error).message}`);
    }
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
      hasPassword: !!user.password,
      // #2495: mirror AuthService.login()'s claims exactly — a Google-authenticated
      // staff token must carry the same isAdmin claim a password login would.
      isAdmin: user.isAdmin || user.role === "TENANT_ADMIN",
      // #1534: the same capability claim password login and refresh mint (auth.service) — the
      // staff socket re-check compares it with the user row.
      canActAsDriver: user.canActAsDriver ?? false,
    };
    // Plans & Billing: embed the entitlement snapshot for Google-login users too.
    const claims = await this.entitlements.claimsFor(payload.tenantId);
    if (claims) Object.assign(payload, claims);
    const accessToken = this.jwtService.sign(payload, {
      secret: jwtConfig.secret,
      audience: STAFF_ACCESS_AUDIENCE,
      expiresIn: jwtConfig.expiresIn as any,
    });
    const refreshToken = this.jwtService.sign(
      { sub: user.id, type: "staff" }, // F5-003: realm discriminator (Google staff login)
      {
        secret: jwtConfig.refreshSecret,
        expiresIn: jwtConfig.refreshExpiresIn as any,
        audience: STAFF_REFRESH_AUDIENCE,
      },
    );
    await this.storeUserRefreshToken(user.id, refreshToken, deviceInfo);
    return { accessToken, refreshToken };
  }

  private async issueBuyerTokenPair(
    buyerAccountId: string,
    email: string,
    name: string,
    hasPassword: boolean,
  ): Promise<TokenPair> {
    const jwtConfig = this.configService.get<{
      secret: string;
      refreshSecret: string;
      expiresIn: string;
      refreshExpiresIn: string;
    }>("jwt")!;
    const payload: BuyerJwtPayload = {
      sub: buyerAccountId,
      email,
      name,
      type: "BUYER",
      hasPassword,
    };
    const accessToken = this.jwtService.sign(payload, {
      secret: jwtConfig.secret,
      audience: BUYER_ACCESS_AUDIENCE,
      expiresIn: jwtConfig.expiresIn as any,
    });
    const refreshToken = this.jwtService.sign(
      { sub: buyerAccountId, type: "buyer" }, // F5-003: realm discriminator (Google buyer login)
      {
        secret: jwtConfig.refreshSecret,
        expiresIn: jwtConfig.refreshExpiresIn as any,
        audience: BUYER_REFRESH_AUDIENCE,
      },
    );
    const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
    const decoded = this.jwtService.decode(refreshToken);
    const expiresAt = new Date(decoded.exp * 1000);
    await this.prisma.buyerRefreshToken.upsert({
      where: { tokenHash },
      create: { buyerAccountId, tokenHash, expiresAt },
      update: { expiresAt },
    });
    return { accessToken, refreshToken };
  }

  private async storeUserRefreshToken(
    userId: string,
    token: string,
    deviceInfo?: DeviceInfo,
  ): Promise<void> {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const decoded = this.jwtService.decode(token);
    const expiresAt = new Date(decoded.exp * 1000);
    await this.prisma.refreshToken.upsert({
      where: { tokenHash },
      create: {
        userId,
        tokenHash,
        expiresAt,
        userAgent: deviceInfo?.userAgent,
        ipAddress: deviceInfo?.ipAddress,
      },
      update: { expiresAt, userAgent: deviceInfo?.userAgent, ipAddress: deviceInfo?.ipAddress },
    });
  }
}
