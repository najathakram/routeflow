import { safeBuyerDisplayName } from "../common/text-cell-guards";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from "jose";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import Redis from "ioredis";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { EncryptionService } from "../common/encryption.service";
import type { AppConfig } from "../config/configuration";
import type { JwtPayload } from "./jwt-payload.interface";
import type { BuyerJwtPayload } from "../buyer/interfaces/buyer-jwt-payload.interface";
import { EntitlementsService } from "../billing/entitlements.service";
import type { DeviceInfo } from "./auth.service";
import { escapeHtml } from "../common/html-escape";
import { isLoginEligible } from "./login-eligibility";
import { casLinkProviderId, resolveBySubThenEmail } from "./oauth-account-link";
// GoogleAuthResult is reused verbatim (SA-418 §1) — Apple sign-in returns the same
// discriminated union so downstream consumers (mobile, tests) don't branch on provider.
import type { GoogleAuthResult } from "./google-oauth.service";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export type AppleAuthResult = GoogleAuthResult;

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS_URL = `${APPLE_ISSUER}/auth/keys`;
const APPLE_TOKEN_URL = `${APPLE_ISSUER}/auth/token`;
const APPLE_REVOKE_URL = `${APPLE_ISSUER}/auth/revoke`;
const CLOCK_TOLERANCE_SECS = 60;
const NONCE_TTL_SECS = 600; // 10 minutes (SA-418 §1)
const NONCE_KEY_PREFIX = "oauth:apple-nonce:";
/** Max age of an Apple server notification (its `iat`); retries land within hours. */
const NOTIFICATION_MAX_AGE = "48h";
const NOTIFICATION_JTI_KEY_PREFIX = "apple:notif:jti:";
/** Longer than the max age so a jti outlives every token that could still carry it. */
const NOTIFICATION_JTI_TTL_SECS = 7 * 24 * 3600;
/** Apple signs identity tokens and server notifications with RS256 only. */
const APPLE_ALGORITHMS = ["RS256"];
const APPLE_HTTP_TIMEOUT_MS = 10_000;
const CLIENT_SECRET_TTL = "5m";

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Sign in with Apple (#2309, SA-418) — native iOS only. Mirrors GoogleOAuthService's
 * structure and rules; where SA-418 explicitly says "byte-for-byte the Google rules"
 * (buyer create + the squatted-password neutralization, §4) the logic below is a
 * careful duplicate of google-oauth.service.ts:620-730. The sub-then-email resolve and the
 * CAS link are NOT duplicated: both providers share oauth-account-link.ts (SA-598 P1).
 */
@Injectable()
export class AppleOAuthService {
  private readonly logger = new Logger(AppleOAuthService.name);
  private readonly redis: Redis;
  // Exposed as an instance field (not a local const) so specs can swap in a
  // `createLocalJWKSet` built from a test keypair — same pattern as GoogleOAuthService's
  // `oauth2Client` override in google-oauth.service.spec.ts.
  private jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    // Untyped ConfigService — Apple and Redis keys are not exposed through AppConfig's
    // typed getters (mirrors GoogleOAuthService's constructor comment).
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
    private readonly entitlements: EntitlementsService,
    private readonly encryption: EncryptionService,
  ) {
    this.jwks = createRemoteJWKSet(new URL(APPLE_JWKS_URL));

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
      this.logger.warn(`AppleOAuth Redis error: ${err.message}`),
    );

    // Never this.bundleId() here: it throws when unset, and an unconfigured API must still boot.
    if (!this.isNotificationConfigured()) {
      this.logger.warn(
        "APPLE_BUNDLE_ID (and/or APPLE_TEAM_ID/APPLE_KEY_ID/APPLE_PRIVATE_KEY) is not set. " +
          "Sign in with Apple will be unavailable. Set these in your Railway environment variables.",
      );
    }
  }

  /**
   * The ONE audience every Apple JWT must carry. Never "" — jose skips the audience check
   * for a falsy `audience`, so an unset bundle id would accept any Apple-signed token.
   */
  private bundleId(): string {
    const id = (this.configService.get<string>("APPLE_BUNDLE_ID") ?? "").trim();
    if (!id) throw new ServiceUnavailableException("Sign in with Apple is not configured");
    return id;
  }

  /** Server notifications need only the bundle id (no client-secret key). */
  isNotificationConfigured(): boolean {
    return !!(this.configService.get<string>("APPLE_BUNDLE_ID") ?? "").trim();
  }

  /**
   * True only when every credential the flow needs (verification + the client_secret
   * JWT used for code exchange and revoke) is present. Controllers must check this
   * before calling any other method here.
   */
  isConfigured(): boolean {
    // Trimmed like bundleId()/isNotificationConfigured(): a blank or whitespace-only .env line
    // is "not configured" (a readable 503), never a half-configured flow that fails as a 401.
    return (
      ["APPLE_BUNDLE_ID", "APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY"] as const
    ).every((k) => !!this.configService.get<string>(k)?.trim());
  }

  // ─── Nonce (SA-418 §1, B349 form) ──────────────────────────────────────────

  /**
   * Mint a server-side nonce bound to the hash of {tenantSlug, context}. The client
   * hands SHA-256(nonce) to Apple as the `nonce` request param and returns the raw
   * nonce to us on POST /auth/apple.
   */
  async mintNonce(
    tenantSlug: string | undefined,
    context: "staff" | "buyer-standalone",
  ): Promise<{ nonce: string }> {
    const nonce = crypto.randomBytes(32).toString("base64url");
    const payloadHash = this.nonceBindingHash(tenantSlug, context);
    await this.redis.set(`${NONCE_KEY_PREFIX}${nonce}`, payloadHash, "EX", NONCE_TTL_SECS);
    return { nonce };
  }

  private nonceBindingHash(tenantSlug: string | undefined, context: string): string {
    return crypto
      .createHash("sha256")
      .update(JSON.stringify({ tenantSlug: tenantSlug ?? null, context }))
      .digest("hex");
  }

  // ─── Token verification (SA-418 §1) ────────────────────────────────────────

  /**
   * Verify an Apple identity token end-to-end: GETDEL the nonce, check it was minted
   * for this exact {tenantSlug, context}, then verify the JWT itself (signature via
   * Apple's JWKS, issuer, audience === APPLE_BUNDLE_ID exactly, ≤60s clock skew, the
   * nonce claim, and email_verified). ANY failure throws
   * UnauthorizedException("apple_token_invalid") — no DB write happens before this
   * returns, by construction (this method never touches prisma).
   */
  private async verifyIdentityToken(
    identityToken: string,
    nonce: string,
    tenantSlug: string | undefined,
    context: "staff" | "buyer-standalone",
  ): Promise<{ appleId: string; email: string | null }> {
    const nonceKey = `${NONCE_KEY_PREFIX}${nonce}`;
    let stored: string | null = null;
    try {
      stored = await (this.redis as any).getdel(nonceKey);
    } catch {
      const luaResult = await this.redis
        .eval(
          `local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]) end; return v`,
          1,
          nonceKey,
        )
        .catch(() => null);
      stored = luaResult as string | null;
    }
    if (!stored) throw new UnauthorizedException("apple_token_invalid");

    const expectedHash = this.nonceBindingHash(tenantSlug, context);
    const storedBuf = Buffer.from(stored, "utf-8");
    const expectedBuf = Buffer.from(expectedHash, "utf-8");
    if (
      storedBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(storedBuf, expectedBuf)
    ) {
      throw new UnauthorizedException("apple_token_invalid");
    }

    let payload: Record<string, unknown>;
    try {
      const result = await jwtVerify(identityToken, this.jwks, {
        issuer: APPLE_ISSUER,
        audience: this.bundleId(),
        algorithms: APPLE_ALGORITHMS,
        clockTolerance: CLOCK_TOLERANCE_SECS,
      });
      payload = result.payload as unknown as Record<string, unknown>;
    } catch {
      throw new UnauthorizedException("apple_token_invalid");
    }

    const expectedNonceClaim = crypto.createHash("sha256").update(nonce).digest("hex");
    if (payload.nonce !== expectedNonceClaim) {
      throw new UnauthorizedException("apple_token_invalid");
    }

    if (typeof payload.sub !== "string") {
      throw new UnauthorizedException("apple_token_invalid");
    }

    // Apple sends the email claim only on the FIRST sign-in; later tokens omit it (and
    // email_verified). An ABSENT email is allowed (the caller then matches by sub only and refuses
    // anything that would need an email). A PRESENT email must be a string and verified.
    if (payload.email === undefined) {
      return { appleId: payload.sub, email: null };
    }
    // A present-but-empty email is malformed (Apple omits the claim instead): refuse it.
    if (typeof payload.email !== "string" || !payload.email) {
      throw new UnauthorizedException("apple_token_invalid");
    }
    // Apple sends email_verified as either a boolean or the string "true"/"false".
    if (payload.email_verified !== true && payload.email_verified !== "true") {
      throw new UnauthorizedException("apple_token_invalid");
    }

    return { appleId: payload.sub, email: payload.email.toLowerCase() };
  }

  // ─── Sign-in entry point ────────────────────────────────────────────────────

  async signIn(
    dto: {
      identityToken: string;
      authorizationCode: string;
      nonce: string;
      tenantSlug?: string;
      context: "staff" | "buyer-standalone";
      fullName?: string;
    },
    deviceInfo?: DeviceInfo,
  ): Promise<AppleAuthResult> {
    const { appleId, email } = await this.verifyIdentityToken(
      dto.identityToken,
      dto.nonce,
      dto.tenantSlug,
      dto.context,
    );
    const name = dto.fullName ?? email ?? "Apple user";

    if (dto.context === "staff") {
      return this.handleStaffAuth(dto.tenantSlug, appleId, email, deviceInfo);
    }
    // B964: the provider-supplied name never blocks a buyer sign-in; a formula-led one is neutralised (email local-part, else "Customer")
    const buyerName =
      dto.fullName || email ? safeBuyerDisplayName(dto.fullName ?? email, email) : name;
    return this.handleBuyerAuth(appleId, email, buyerName, dto.authorizationCode);
  }

  // ─── Staff flow (SA-418 §3) ─────────────────────────────────────────────────

  private async handleStaffAuth(
    tenantSlug: string | undefined,
    appleId: string,
    email: string | null,
    deviceInfo?: DeviceInfo,
  ): Promise<AppleAuthResult> {
    if (!tenantSlug) throw new BadRequestException("tenantSlug required");
    // SA-598 P1: a falsy sub refuses before ANY query (an undefined filter would widen). A missing
    // email is allowed only for an already-bound sub (resolveBySubThenEmail allowSubOnly).
    if (!appleId) throw new ForbiddenException("unauthorized");

    const tenant = await this.prisma.tenant.findFirst({ where: { slug: tenantSlug } });
    if (!tenant) throw new ForbiddenException("tenant_suspended");
    if (tenant.status === "SUSPENDED" || tenant.status === "CANCELLED") {
      throw new ForbiddenException("tenant_suspended");
    }

    // SA-598 P1 / #2495: sub first, then the ordered email match; an email row bound to a
    // different sub is a 409 (oauth-account-link.ts, shared with Google).
    let staffUser = await resolveBySubThenEmail({
      findFirst: (args) => this.prisma.user.findFirst(args as any),
      baseWhere: {
        tenantId: tenant.id,
        deletedAt: null,
        role: { in: ["OPERATOR", "DRIVER", "TENANT_ADMIN"] },
      },
      column: "appleId",
      sub: appleId,
      email,
      allowSubOnly: true,
    });

    // SA-418 §3: no auto-create on the staff flow — a relay or otherwise-unmatched
    // email is a hard 403, unlike Google's shared endpoint which falls through to
    // buyer auto-create here.
    if (!staffUser) throw new ForbiddenException("apple_no_match");
    // SA-598 P2: the one eligibility rule (deleted, locked, non-ACTIVE all refuse).
    if (!isLoginEligible(staffUser)) throw new ForbiddenException("unauthorized");

    if (!staffUser.appleId) {
      const linked = await casLinkProviderId({
        updateMany: (args) => this.prisma.user.updateMany(args as any),
        findUnique: (id) => this.prisma.user.findUnique({ where: { id } }),
        row: staffUser,
        column: "appleId",
        sub: appleId,
        data: { forcePasswordChange: false },
        extraWhere: { tenantId: tenant.id },
      });
      staffUser = linked.row;
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

  // ─── Buyer flow (SA-418 §4) ─────────────────────────────────────────────────

  private async handleBuyerAuth(
    appleId: string,
    email: string | null,
    name: string,
    authorizationCode: string,
  ): Promise<AppleAuthResult> {
    // SA-418a: NO staff lookup here — buyer-standalone mirrors Google's handleBuyerPortalAuth
    // exactly (google-oauth.service.ts). apple_email_is_staff belongs only to a future
    // tenant-scoped portal context; the staff match itself stays tenant-scoped (handleStaffAuth).

    // SA-598 P1: a falsy sub refuses before ANY query; a missing email is allowed only for an
    // already-bound sub (it never auto-creates an account: see the create branch below).
    if (!appleId) throw new ForbiddenException("unauthorized");

    let buyer = await resolveBySubThenEmail({
      findFirst: (args) => this.prisma.buyerAccount.findFirst(args as any),
      baseWhere: { deletedAt: null },
      column: "appleId",
      sub: appleId,
      email,
      allowSubOnly: true,
    });

    if (buyer) {
      // SA-598 P2: the one eligibility rule (was a SUSPENDED-only inline check).
      if (!isLoginEligible(buyer)) throw new ForbiddenException("unauthorized");

      // Mirrors google-oauth.service.ts:636 exactly — Apple attests the mailbox it
      // authenticated only when it matches the account's OWN email, not one found via
      // a previously-linked appleId with a different email on file.
      const appleAttestsMailbox = email !== null && buyer.email.toLowerCase() === email;

      // SA-418 §4 / google-oauth.service.ts:640-715, byte-for-byte: neutralize a
      // password that was never mailbox-verified once Apple proves the mailbox.
      const squattedPassword = appleAttestsMailbox && buyer.passwordSet && !buyer.emailVerified;

      if (!buyer.appleId) {
        const placeholderHash = squattedPassword
          ? await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10)
          : null;
        // SA-598 P1: CAS link. Revocation and the email happen ONLY when THIS request wrote.
        const cas = await casLinkProviderId({
          updateMany: (args) => this.prisma.buyerAccount.updateMany(args as any),
          findUnique: (id) => this.prisma.buyerAccount.findUnique({ where: { id } }),
          row: buyer,
          column: "appleId",
          sub: appleId,
          data: placeholderHash
            ? { emailVerified: true, passwordHash: placeholderHash, passwordSet: false }
            : appleAttestsMailbox
              ? { emailVerified: true }
              : {},
        });
        buyer = cas.row;
        if (cas.linked) {
          if (placeholderHash) {
            await this.prisma.buyerRefreshToken.deleteMany({
              where: { buyerAccountId: buyer.id },
            });
            this.logger.warn(
              `Buyer ${buyer.id} had an unverified password neutralized on first Apple link ` +
                `(mailbox now attested by Apple; prior sessions revoked)`,
            );
          }
          void this.emailService
            .send({
              to: buyer.email,
              subject: "Apple Sign-In linked to your RouteFlow account",
              html: `<p>Sign in with Apple (<strong>${escapeHtml(email ?? buyer.email)}</strong>) has been linked to your RouteFlow portal account.</p><p>If you did not authorise this, please contact support immediately.</p>`,
              senderClass: "platform",
            })
            .catch((e: Error) => this.logger.warn(`Apple link notification failed: ${e.message}`));
        }
      } else if (appleAttestsMailbox && !buyer.emailVerified) {
        if (squattedPassword) {
          const placeholderHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
          buyer = await this.prisma.buyerAccount.update({
            where: { id: buyer.id },
            data: { emailVerified: true, passwordHash: placeholderHash, passwordSet: false },
          });
          await this.prisma.buyerRefreshToken.deleteMany({
            where: { buyerAccountId: buyer.id },
          });
          this.logger.warn(
            `Buyer ${buyer.id} had an unverified password neutralized on Apple sign-in ` +
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
      // Defensive: with no bound sub the resolver already refused a missing email, so this is
      // unreachable; never create an account without an email.
      if (!email) throw new ForbiddenException("unauthorized");
      const randomBytes = crypto.randomBytes(32).toString("hex");
      const passwordHash = await bcrypt.hash(randomBytes, 10);
      buyer = await this.prisma.buyerAccount.create({
        data: {
          email,
          passwordHash,
          passwordSet: false,
          name,
          appleId,
          status: "ACTIVE",
          emailVerified: true,
        },
      });
      this.logger.log(`BuyerAccount created via Apple: ${buyer.id}`);
    }

    const sellerCount = await this.prisma.customerLink.count({
      where: { buyerAccountId: buyer.id, status: "ACTIVE", customer: { deletedAt: null } },
    });
    const tokens = await this.issueBuyerTokenPair(
      buyer.id,
      buyer.email,
      buyer.name,
      buyer.passwordSet,
    );

    // SA-418 §4/§7: exchange the authorization code for a refresh token and store it
    // encrypted, for the later Apple /auth/revoke call on account deletion. A failed
    // exchange is logged only — sign-in has already succeeded above.
    await this.exchangeAndStoreRefreshToken(buyer.id, authorizationCode);

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
    };
  }

  // ─── Linking (SA-418 §2) ────────────────────────────────────────────────────

  /**
   * Link an Apple account to an existing, currently-authenticated user. Mirrors
   * linkGoogleAccount. The nonce must have been minted via POST /auth/apple/nonce
   * with context "staff" and no tenantSlug — the same binding this checks against.
   */
  async linkAppleAccount(userId: string, identityToken: string, nonce: string): Promise<void> {
    const { appleId, email } = await this.verifyIdentityToken(
      identityToken,
      nonce,
      undefined,
      "staff",
    );
    // SA-598 P1: a falsy sub/email refuses before ANY query.
    if (!appleId || !email) throw new ForbiddenException("unauthorized");

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt) throw new ForbiddenException("unauthorized");

    const existingByAppleId = await this.prisma.user.findFirst({
      where: { appleId, tenantId: user.tenantId, id: { not: userId }, deletedAt: null },
    });
    if (existingByAppleId) throw new ForbiddenException("apple_already_linked");
    if (user.appleId) throw new ForbiddenException("apple_already_linked");

    // SA-598 P1: CAS link (tenantId + id + appleId:null); a lost race to a different sub is a 409.
    const cas = await casLinkProviderId({
      updateMany: (args) => this.prisma.user.updateMany(args as any),
      findUnique: (id) => this.prisma.user.findUnique({ where: { id } }),
      row: user,
      column: "appleId",
      sub: appleId,
      data: { forcePasswordChange: false },
      extraWhere: { tenantId: user.tenantId },
    });
    if (!cas.linked) return;

    this.logger.log(`Apple account linked for user ${userId}`);

    if (user.email) {
      void this.emailService
        .send({
          to: user.email,
          subject: "Sign in with Apple linked to your RouteFlow account",
          html: `<p>Sign in with Apple (<strong>${escapeHtml(email)}</strong>) has been linked to your RouteFlow account.</p><p>If you did not authorise this, please contact support immediately.</p>`,
          senderClass: "platform",
        })
        .catch((e: Error) => this.logger.warn(`Apple link notification failed: ${e.message}`));
    }
  }

  // ─── Authorization-code exchange + revoke (SA-418 §4/§7) ───────────────────

  private async buildClientSecret(): Promise<string> {
    const teamId = this.configService.get<string>("APPLE_TEAM_ID") ?? "";
    const keyId = this.configService.get<string>("APPLE_KEY_ID") ?? "";
    const rawKey = this.configService.get<string>("APPLE_PRIVATE_KEY") ?? "";
    const privateKey = await importPKCS8(rawKey.replace(/\\n/g, "\n"), "ES256");
    return new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: keyId })
      .setIssuer(teamId)
      .setIssuedAt()
      .setExpirationTime(CLIENT_SECRET_TTL)
      .setAudience(APPLE_ISSUER)
      .setSubject(this.bundleId())
      .sign(privateKey);
  }

  /** Exchange authorizationCode → refresh token and store it encrypted. Never throws. */
  private async exchangeAndStoreRefreshToken(
    buyerAccountId: string,
    authorizationCode: string,
  ): Promise<void> {
    try {
      const clientSecret = await this.buildClientSecret();
      const res = await fetch(APPLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        // a slow Apple endpoint must never hang sign-in or account deletion
        signal: AbortSignal.timeout(APPLE_HTTP_TIMEOUT_MS),
        body: new URLSearchParams({
          client_id: this.bundleId(),
          client_secret: clientSecret,
          code: authorizationCode,
          grant_type: "authorization_code",
        }),
      });
      if (!res.ok) {
        throw new Error(`Apple token exchange returned ${res.status}`);
      }
      const json = (await res.json()) as { refresh_token?: string };
      if (!json.refresh_token) throw new Error("Apple token exchange returned no refresh_token");

      await this.prisma.buyerAccount.update({
        where: { id: buyerAccountId },
        data: { appleRefreshTokenEnc: this.encryption.encrypt(json.refresh_token) },
      });
    } catch (e) {
      this.logger.warn(`Apple authorization-code exchange failed: ${(e as Error).message}`);
    }
  }

  /**
   * Revoke the buyer's stored Apple refresh token (Apple requires this on account
   * deletion). A failure is logged and NEVER thrown — the caller's deletion must
   * proceed regardless.
   */
  async revokeForBuyer(buyerAccountId: string): Promise<void> {
    let enc: string | null | undefined;
    try {
      const buyer = await this.prisma.buyerAccount.findUnique({
        where: { id: buyerAccountId },
        select: { appleRefreshTokenEnc: true },
      });
      enc = buyer?.appleRefreshTokenEnc;
    } catch (e) {
      this.logger.warn(`Apple revoke failed for buyer ${buyerAccountId}: ${(e as Error).message}`);
      return;
    }
    await this.revokeRefreshToken(enc, buyerAccountId);
  }

  /**
   * Revoke an already-loaded ENCRYPTED Apple refresh token (no DB read), for callers that must
   * revoke AFTER their own transaction cleared the stored value (buyer merge, B944). Same
   * guarantees as revokeForBuyer: a failure is logged (buyer id only, never the token) and never
   * thrown.
   */
  async revokeRefreshToken(enc: string | null | undefined, buyerAccountId: string): Promise<void> {
    if (!enc) return;
    try {
      const refreshToken = this.encryption.decrypt(enc);
      const clientSecret = await this.buildClientSecret();
      const res = await fetch(APPLE_REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        // a slow Apple endpoint must never hang sign-in, account deletion or a merge
        signal: AbortSignal.timeout(APPLE_HTTP_TIMEOUT_MS),
        body: new URLSearchParams({
          client_id: this.bundleId(),
          client_secret: clientSecret,
          token: refreshToken,
          token_type_hint: "refresh_token",
        }),
      });
      if (!res.ok) throw new Error(`Apple revoke returned ${res.status}`);
    } catch (e) {
      this.logger.warn(`Apple revoke failed for buyer ${buyerAccountId}: ${(e as Error).message}`);
    }
  }

  // ─── Server-to-server notifications (SA-418 §5) ────────────────────────────

  /**
   * Verify + handle an Apple server notification. consent-revoked/account-delete
   * clear appleId and the stored refresh token, and delete our own refresh tokens
   * for that account — the RouteFlow account itself is NEVER deleted by this event.
   */
  async handleNotification(signedPayload: string): Promise<void> {
    let payload: Record<string, unknown>;
    try {
      const result = await jwtVerify(signedPayload, this.jwks, {
        issuer: APPLE_ISSUER,
        audience: this.bundleId(),
        algorithms: APPLE_ALGORITHMS,
        clockTolerance: CLOCK_TOLERANCE_SECS,
        // Replay window: a notification older than this is refused even if its exp is still
        // ahead. Apple retries failed deliveries for hours, so the cap is generous (48h).
        maxTokenAge: NOTIFICATION_MAX_AGE,
      });
      payload = result.payload as unknown as Record<string, unknown>;
    } catch {
      throw new UnauthorizedException("apple_notification_invalid");
    }

    // Replay guard: remember each notification's jti. A captured consent-revoked token replayed
    // after the user re-linked must not undo the link. A token without a jti cannot be checked,
    // so it is refused; if the store is down we fail closed (503) so Apple retries later.
    const jti = payload.jti;
    if (typeof jti !== "string" || !jti)
      throw new UnauthorizedException("apple_notification_invalid");
    const jtiKey = `${NOTIFICATION_JTI_KEY_PREFIX}${jti}`;
    let firstSeen: unknown;
    try {
      firstSeen = await this.redis.set(jtiKey, "1", "EX", NOTIFICATION_JTI_TTL_SECS, "NX");
    } catch {
      throw new ServiceUnavailableException("apple_notification_unavailable");
    }
    if (firstSeen !== "OK") {
      this.logger.warn("Apple notification replay ignored (jti already processed)");
      return;
    }

    // The jti is marked BEFORE the writes (so a concurrent duplicate cannot double-process). If the
    // writes then fail (Apple gets a 500 and retries the SAME jwt), free the jti so the retry runs
    // instead of being swallowed as a replay and losing the revoke/delete event.
    try {
      await this.applyNotificationEvent(payload);
    } catch (e) {
      await this.redis.del(jtiKey).catch(() => {
        // Never lose this silently: if the delete fails, Apple's retry of this jwt will be
        // treated as a replay and ignored until the jti expires (the jti value is not logged).
        this.logger.warn(
          "Apple notification jti could not be released after a failed write: the retry may be ignored as a replay",
        );
      });
      throw e;
    }
  }

  private async applyNotificationEvent(payload: Record<string, unknown>): Promise<void> {
    let event: { type?: string; sub?: string };
    try {
      event = typeof payload.events === "string" ? JSON.parse(payload.events) : {};
    } catch {
      this.logger.warn("Apple notification events payload was not valid JSON — ignoring");
      return;
    }

    const sub = event.sub;
    if (!sub || (event.type !== "consent-revoked" && event.type !== "account-delete")) {
      return;
    }

    const buyer = await this.prisma.buyerAccount.findFirst({ where: { appleId: sub } });
    if (buyer) {
      await this.prisma.buyerAccount.update({
        where: { id: buyer.id },
        data: { appleId: null, appleRefreshTokenEnc: null },
      });
      await this.prisma.buyerRefreshToken.deleteMany({ where: { buyerAccountId: buyer.id } });
      this.logger.log(`Apple ${event.type} notification: cleared buyer ${buyer.id}`);
    }

    const staffUsers = await this.prisma.user.findMany({
      where: { appleId: sub, deletedAt: null },
      select: { id: true },
    });
    if (staffUsers.length > 0) {
      const ids = staffUsers.map((u) => u.id);
      await this.prisma.user.updateMany({ where: { id: { in: ids } }, data: { appleId: null } });
      await this.prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
      this.logger.log(`Apple ${event.type} notification: cleared user(s) ${ids.join(", ")}`);
    }
  }

  // ─── Token issuance helpers (duplicated from google-oauth.service.ts:801-873 —
  // both private there, so shared use isn't possible without a wider refactor) ──

  private async issueUserTokenPair(
    user: any,
    tenantSlug: string | null,
    deviceInfo?: DeviceInfo,
  ): Promise<TokenPair> {
    // #2159 S1: an Apple sign-in is an interactive sign-in too — stamp lastLoginAt exactly as
    // AuthService.login() and the Google path do (best-effort; a failed stamp never blocks it).
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
      // #2495: mirror AuthService.login()'s claims exactly — an Apple-authenticated
      // staff token must carry the same isAdmin claim a password login would.
      isAdmin: user.isAdmin || user.role === "TENANT_ADMIN",
      // #1534: the same capability claim password login and refresh mint (auth.service) — the
      // staff socket re-check compares it with the user row.
      canActAsDriver: user.canActAsDriver ?? false,
    };
    const claims = await this.entitlements.claimsFor(payload.tenantId);
    if (claims) Object.assign(payload, claims);
    const accessToken = this.jwtService.sign(payload, {
      secret: jwtConfig.secret,
      expiresIn: jwtConfig.expiresIn as any,
    });
    const refreshToken = this.jwtService.sign(
      { sub: user.id, type: "staff" },
      { secret: jwtConfig.refreshSecret, expiresIn: jwtConfig.refreshExpiresIn as any },
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
      expiresIn: jwtConfig.expiresIn as any,
    });
    const refreshToken = this.jwtService.sign(
      { sub: buyerAccountId, type: "buyer" },
      { secret: jwtConfig.refreshSecret, expiresIn: jwtConfig.refreshExpiresIn as any },
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
