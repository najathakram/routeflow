import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import Redis from "ioredis";
import * as crypto from "crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { EncryptionService } from "../../common/encryption.service";
import { AuditService } from "../../audit/audit.service";

/** Scope granted to the mailbox client — send-only, never a read scope (design D1/§3). */
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const NONCE_TTL_SECS = 600; // 10 minutes, mirrors GoogleOAuthService's sign-in nonce TTL.
const OAUTH_NONCE_PREFIX = "mailbox:oauth:";
const PENDING_GRANT_PREFIX = "mailbox:pending:";

interface OAuthNoncePayload {
  tenantId: string;
  userId: string;
  provider: "GOOGLE";
  verifier: string;
}

/**
 * A completed-but-unbound Google grant, stashed under a fresh, short-TTL, single-use token
 * (security review, Opus round 1, PR #7835e237 fix round — HIGH): the OAuth callback is a
 * TOP-LEVEL BROWSER REDIRECT FROM GOOGLE, so it can carry no bearer token in this app's
 * localStorage-token architecture. Binding the `MailboxConnection` row directly from that
 * unauthenticated redirect would let anyone who can observe/guess the callback URL (a shared
 * machine, a browser history sync, a referrer leak) attach an attacker's Gmail grant to
 * whichever tenant happens to be signed in when they click it. Binding now requires a SECOND,
 * authenticated step (`confirmConnect`) that proves the confirming JWT is the SAME
 * (tenantId, userId) that started the connect.
 */
interface PendingGrant {
  tenantId: string;
  userId: string;
  provider: "GOOGLE";
  accountEmail: string;
  externalSubject: string;
  scopesGranted: string[];
  refreshTokenCipher: string;
  accessTokenCipher: string | null;
  /** ISO string — Redis stores JSON, not Date instances. */
  accessTokenExpiresAt: string | null;
}

/** The ONLY connection shape that ever crosses a controller boundary — no token field, ever. */
export interface MailboxStatusView {
  /** Whether the Google mailbox client env vars are set — the web hides "Connect Gmail" (and
   *  this whole card) when false, regardless of add-on grant (design §4). */
  configured: boolean;
  connected: boolean;
  provider?: "GOOGLE";
  accountEmail?: string;
  status?: "CONNECTED" | "REVOKED" | "THROTTLED";
  throttledUntil?: string | null;
  lastError?: string | null;
  lastSentAt?: string | null;
}

/** 32 random bytes, base64url — used for both the OAuth state nonce and the confirm token
 *  (security review NIT: was `crypto.randomUUID()`, which is only ~122 bits and structured;
 *  this is the full 256 bits a single-use security token warrants). */
function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * `MailboxConnection` CRUD + the Google OAuth connect/disconnect flow (PR-2). Tenant isolation
 * is structural, not a filter: every method takes `tenantId` from the caller's OWN JWT (never a
 * client-supplied id), and `MailboxConnection.tenantId` is the row's unique key — there is no
 * by-id lookup anywhere in this surface, so tenant A's JWT can never address tenant B's row.
 *
 * Connect is TWO steps, not one: `handleCallback` (unauthenticated, Google's redirect) only
 * exchanges the code and stashes a `PendingGrant`; `confirmConnect` (authenticated,
 * TENANT_ADMIN) is the ONLY place a `MailboxConnection` row is ever written from an OAuth flow,
 * and only after proving the confirming JWT matches who started it.
 */
@Injectable()
export class MailboxConnectionService {
  private readonly logger = new Logger(MailboxConnectionService.name);
  private readonly redis: Redis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {
    const redisUrl = this.config.get<string>("REDIS_URL") ?? "redis://localhost:6379";
    const redisPassword = this.config.get<string>("REDIS_PASSWORD");
    this.redis = new Redis(redisUrl, {
      password: redisPassword || undefined,
      maxRetriesPerRequest: 3,
      connectTimeout: 5000,
      enableOfflineQueue: true,
      lazyConnect: true,
    });
    this.redis.on("error", (err: Error) =>
      this.logger.warn(`MailboxConnection Redis error: ${err.message}`),
    );
  }

  private clientId(): string {
    return this.config.get<string>("GOOGLE_MAILBOX_CLIENT_ID") ?? "";
  }
  private clientSecret(): string {
    return this.config.get<string>("GOOGLE_MAILBOX_CLIENT_SECRET") ?? "";
  }
  private redirectUri(): string {
    return this.config.get<string>("GOOGLE_MAILBOX_REDIRECT_URI") ?? "";
  }

  /** Whether the Google mailbox client is configured — the web only shows "Connect Gmail" when true. */
  isConfigured(): boolean {
    return !!(this.clientId() && this.clientSecret() && this.redirectUri());
  }

  private newOAuthClient(): OAuth2Client {
    return new OAuth2Client(this.clientId(), this.clientSecret(), this.redirectUri());
  }

  /** The only place `EncryptionService.decrypt` is called for connect/disconnect (mirrors
   *  `CrmConnectionService.decryptToken`'s data-minimization pattern; `MailboxSendService` has
   *  its own, for sending). */
  private decryptRefreshToken(cipher: string): string {
    return this.encryption.decrypt(cipher);
  }

  private async getdel(key: string): Promise<string | null> {
    try {
      return await (this.redis as any).getdel(key);
    } catch {
      const luaResult = await this.redis
        .eval(
          `local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]) end; return v`,
          1,
          key,
        )
        .catch(() => null);
      return luaResult as string | null;
    }
  }

  private toStatusView(
    row: {
      provider: string;
      accountEmail: string;
      status: string;
      throttledUntil: Date | null;
      lastError: string | null;
      lastSentAt: Date | null;
    } | null,
  ): MailboxStatusView {
    if (!row) return { configured: this.isConfigured(), connected: false };
    return {
      configured: this.isConfigured(),
      connected: true,
      provider: row.provider as "GOOGLE",
      accountEmail: row.accountEmail,
      status: row.status as "CONNECTED" | "REVOKED" | "THROTTLED",
      throttledUntil: row.throttledUntil ? row.throttledUntil.toISOString() : null,
      lastError: row.lastError,
      lastSentAt: row.lastSentAt ? row.lastSentAt.toISOString() : null,
    };
  }

  async getStatus(tenantId: string): Promise<MailboxStatusView> {
    const row = await this.prisma.mailboxConnection.findUnique({ where: { tenantId } });
    return this.toStatusView(row);
  }

  /**
   * Build the Google consent URL and persist a single-use, PKCE-bound nonce (10 min TTL) that
   * records WHO initiated the connect (`tenantId`/`userId`) — `confirmConnect` re-checks this
   * identity against the confirming JWT before ever writing a row.
   */
  async startConnect(tenantId: string, userId: string): Promise<string> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        "Google mailbox connect is not configured on this server yet.",
      );
    }

    const client = this.newOAuthClient();
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const nonce = randomToken();

    const payload: OAuthNoncePayload = {
      tenantId,
      userId,
      provider: "GOOGLE",
      verifier: codeVerifier,
    };
    await this.redis.set(
      `${OAUTH_NONCE_PREFIX}${nonce}`,
      JSON.stringify(payload),
      "EX",
      NONCE_TTL_SECS,
    );

    return client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: [GMAIL_SEND_SCOPE, "openid", "email"],
      state: nonce,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });
  }

  /**
   * Exchange the callback's `code` for tokens and stash a `PendingGrant` under a FRESH
   * single-use confirm token — never binds a `MailboxConnection` row (see class doc). Rejects a
   * tampered/expired/reused `state` with a 400 BEFORE any code exchange is attempted — the
   * single-use GETDEL below is what makes a replayed state fail even when it was valid once.
   */
  async handleCallback(code: string, state: string): Promise<{ confirmToken: string }> {
    if (!code || !state) throw new BadRequestException("state_invalid");

    const stored = await this.getdel(`${OAUTH_NONCE_PREFIX}${state}`);
    if (!stored) throw new BadRequestException("state_invalid");

    let oauthPayload: OAuthNoncePayload;
    try {
      oauthPayload = JSON.parse(stored) as OAuthNoncePayload;
    } catch {
      throw new BadRequestException("state_invalid");
    }
    if (!oauthPayload?.tenantId || !oauthPayload?.userId || !oauthPayload?.verifier) {
      throw new BadRequestException("state_invalid");
    }

    const client = this.newOAuthClient();
    const { tokens } = await client
      .getToken({ code, codeVerifier: oauthPayload.verifier })
      .catch((err: Error) => {
        this.logger.error(`Mailbox Google code exchange failed: ${err.message}`);
        throw new BadRequestException("google_token_invalid");
      });

    if (!tokens.refresh_token) {
      // No refresh token means Google didn't grant offline access (e.g. a repeat consent
      // without prompt=consent re-issuing one) — nothing usable to store.
      throw new BadRequestException("google_no_refresh_token");
    }

    const grantedScopes = (tokens.scope ?? "").split(" ").filter(Boolean);
    if (!grantedScopes.includes(GMAIL_SEND_SCOPE)) {
      // The consent screen must grant gmail.send — anything else (e.g. the user unchecked it,
      // or a misconfigured client requests a different scope set) is unusable for sending.
      throw new BadRequestException("google_scope_missing");
    }

    const ticket = await client
      .verifyIdToken({ idToken: tokens.id_token!, audience: this.clientId() })
      .catch((err: Error) => {
        this.logger.error(`Mailbox Google ID token verification failed: ${err.message}`);
        throw new BadRequestException("google_token_invalid");
      });
    const idPayload = ticket.getPayload()!;
    if (!idPayload.email_verified) {
      throw new BadRequestException("google_email_not_verified");
    }

    const pending: PendingGrant = {
      tenantId: oauthPayload.tenantId,
      userId: oauthPayload.userId,
      provider: "GOOGLE",
      accountEmail: idPayload.email!.toLowerCase(),
      externalSubject: idPayload.sub,
      scopesGranted: grantedScopes,
      refreshTokenCipher: this.encryption.encrypt(tokens.refresh_token),
      accessTokenCipher: tokens.access_token ? this.encryption.encrypt(tokens.access_token) : null,
      accessTokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
    };

    const confirmToken = randomToken();
    await this.redis.set(
      `${PENDING_GRANT_PREFIX}${confirmToken}`,
      JSON.stringify(pending),
      "EX",
      NONCE_TTL_SECS,
    );

    return { confirmToken };
  }

  /**
   * Bind the pending grant to a real `MailboxConnection` row — ONLY IF the confirming JWT's
   * `(userId, tenantId)` matches who started the connect. The pending grant is single-use
   * (GETDEL) regardless of outcome, so a mismatched confirm cannot be retried against the same
   * token. Controller-level guards (JwtAuthGuard/RolesGuard TENANT_ADMIN) additionally ensure
   * the caller is an authenticated tenant admin before this is ever reached.
   */
  async confirmConnect(
    confirmToken: string,
    jwtUserId: string,
    jwtTenantId: string,
  ): Promise<MailboxStatusView> {
    if (!confirmToken) throw new BadRequestException("state_invalid");

    const stored = await this.getdel(`${PENDING_GRANT_PREFIX}${confirmToken}`);
    if (!stored) throw new BadRequestException("state_invalid");

    let pending: PendingGrant;
    try {
      pending = JSON.parse(stored) as PendingGrant;
    } catch {
      throw new BadRequestException("state_invalid");
    }

    // The pending grant is already deleted (GETDEL above) whether this check passes or fails —
    // a mismatched confirm can never be retried against the same token.
    if (pending.userId !== jwtUserId || pending.tenantId !== jwtTenantId) {
      throw new ForbiddenException("mailbox_confirm_identity_mismatch");
    }

    const existing = await this.prisma.mailboxConnection.findUnique({
      where: { tenantId: pending.tenantId },
    });
    const isReconnect = !!existing;
    const externalSubjectChanged = existing && existing.externalSubject !== pending.externalSubject;

    const data = {
      provider: "GOOGLE" as const,
      accountEmail: pending.accountEmail,
      externalSubject: pending.externalSubject,
      scopesGranted: pending.scopesGranted,
      refreshTokenCipher: pending.refreshTokenCipher,
      accessTokenCipher: pending.accessTokenCipher,
      accessTokenExpiresAt: pending.accessTokenExpiresAt
        ? new Date(pending.accessTokenExpiresAt)
        : null,
      status: "CONNECTED" as const,
      throttledUntil: null,
      lastError: null,
      lastErrorAt: null,
      connectedByUserId: pending.userId,
    };

    const row = await this.prisma.mailboxConnection.upsert({
      where: { tenantId: pending.tenantId },
      create: { tenantId: pending.tenantId, ...data },
      update: data,
    });

    await this.audit.log({
      tenantId: pending.tenantId,
      userId: pending.userId,
      action: isReconnect
        ? externalSubjectChanged
          ? "mailbox.reconnected_different_account"
          : "mailbox.reconnected"
        : "mailbox.connected",
      entityType: "mailbox_connection",
      entityId: row.id,
      // Never a token — provider + account only (spec §3).
      meta: { provider: "GOOGLE", accountEmail: row.accountEmail },
    });

    return this.toStatusView(row);
  }

  /**
   * Revoke at Google, then hard-delete the row ONLY IF the revoke call itself succeeded.
   * A failed revoke keeps the row (marked REVOKED, with a clear message) so a later disconnect
   * can retry — deleting on a failed revoke would silently leave Google still holding a grant
   * with no local record anyone could act on.
   */
  async disconnect(
    tenantId: string,
    userId: string,
  ): Promise<{ deleted: boolean; message?: string }> {
    const row = await this.prisma.mailboxConnection.findUnique({ where: { tenantId } });
    if (!row) throw new NotFoundException("No mailbox is connected for this tenant.");

    let revokeOk = false;
    try {
      const refreshToken = this.decryptRefreshToken(row.refreshTokenCipher);
      await axios.post("https://oauth2.googleapis.com/revoke", null, {
        params: { token: refreshToken },
        timeout: 8_000,
      });
      revokeOk = true;
    } catch (err: any) {
      this.logger.warn(`Mailbox revoke-at-Google failed for tenant ${tenantId}: ${err?.message}`);
    }

    if (revokeOk) {
      await this.prisma.mailboxConnection.delete({ where: { tenantId } });
      await this.audit.log({
        tenantId,
        userId,
        action: "mailbox.disconnected",
        entityType: "mailbox_connection",
        entityId: row.id,
        meta: { provider: row.provider, accountEmail: row.accountEmail },
      });
      return { deleted: true };
    }

    const message =
      "Couldn't confirm the disconnect with Google — revoke RouteFlow's access in your Google " +
      "account (myaccount.google.com/permissions), then try disconnecting again.";
    await this.prisma.mailboxConnection.update({
      where: { tenantId },
      data: { status: "REVOKED", lastError: message, lastErrorAt: new Date() },
    });
    await this.audit.log({
      tenantId,
      userId,
      action: "mailbox.disconnect_revoke_failed",
      entityType: "mailbox_connection",
      entityId: row.id,
      meta: { provider: row.provider, accountEmail: row.accountEmail },
    });
    return { deleted: false, message };
  }
}
