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

/**
 * Microsoft identity platform v2 endpoints, tenant `common` (multi-tenant + personal Microsoft
 * accounts, design §2). `Mail.Send User.Read offline_access` only (design §3) — `User.Read` is
 * needed to look up the connected account's own address via Graph `/me` after token exchange
 * (Microsoft ID tokens don't reliably carry an email claim on `common`); never a mail-read scope.
 */
const MS_AUTHORITY = "https://login.microsoftonline.com/common";
const MS_AUTHORIZE_URL = `${MS_AUTHORITY}/oauth2/v2.0/authorize`;
const MS_TOKEN_URL = `${MS_AUTHORITY}/oauth2/v2.0/token`;
const MS_GRAPH_ME_URL = "https://graph.microsoft.com/v1.0/me";
const MS_MAILBOX_SCOPES = ["offline_access", "Mail.Send", "User.Read"];

type MailboxProviderName = "GOOGLE" | "MICROSOFT";

interface OAuthNoncePayload {
  tenantId: string;
  userId: string;
  provider: MailboxProviderName;
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
  provider: MailboxProviderName;
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
  /** True when EITHER provider's mailbox client env vars are set — the web hides the whole
   *  card when false, regardless of add-on grant (design §4). */
  configured: boolean;
  /** Per-provider configured flags — the web shows "Connect Gmail"/"Connect Outlook"
   *  independently, only for the provider(s) whose client env vars are actually set. */
  googleConfigured: boolean;
  microsoftConfigured: boolean;
  connected: boolean;
  provider?: MailboxProviderName;
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

  private msClientId(): string {
    return this.config.get<string>("MICROSOFT_MAILBOX_CLIENT_ID") ?? "";
  }
  private msClientSecret(): string {
    return this.config.get<string>("MICROSOFT_MAILBOX_CLIENT_SECRET") ?? "";
  }
  private msRedirectUri(): string {
    return this.config.get<string>("MICROSOFT_MAILBOX_REDIRECT_URI") ?? "";
  }

  /** Whether the Google mailbox client is configured — the web only shows "Connect Gmail" when true. */
  isGoogleConfigured(): boolean {
    return !!(this.clientId() && this.clientSecret() && this.redirectUri());
  }

  /** Whether the Microsoft mailbox client is configured — the web only shows "Connect Outlook"
   *  when true (design §4's "buttons render only when the provider env vars are set"). */
  isMicrosoftConfigured(): boolean {
    return !!(this.msClientId() && this.msClientSecret() && this.msRedirectUri());
  }

  /** True when EITHER provider is configured — drives whether the card renders at all. */
  isConfigured(): boolean {
    return this.isGoogleConfigured() || this.isMicrosoftConfigured();
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
    const base = {
      configured: this.isConfigured(),
      googleConfigured: this.isGoogleConfigured(),
      microsoftConfigured: this.isMicrosoftConfigured(),
    };
    if (!row) return { ...base, connected: false };
    return {
      ...base,
      connected: true,
      provider: row.provider as MailboxProviderName,
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
    if (!this.isGoogleConfigured()) {
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
   * Build the Microsoft consent URL (v2 authorize endpoint, tenant `common` — multi-tenant +
   * personal accounts, design §2) and persist the same single-use, PKCE-bound nonce shape
   * `startConnect` uses for Google — `confirmConnect` below is provider-agnostic and binds
   * either grant through the identical pending-grant → authenticated-confirm flow.
   */
  async startConnectMicrosoft(tenantId: string, userId: string): Promise<string> {
    if (!this.isMicrosoftConfigured()) {
      throw new ServiceUnavailableException(
        "Microsoft mailbox connect is not configured on this server yet.",
      );
    }

    const codeVerifier = randomToken(); // 32 random bytes, base64url — well within the 43-128 char PKCE range.
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    const nonce = randomToken();

    const payload: OAuthNoncePayload = {
      tenantId,
      userId,
      provider: "MICROSOFT",
      verifier: codeVerifier,
    };
    await this.redis.set(
      `${OAUTH_NONCE_PREFIX}${nonce}`,
      JSON.stringify(payload),
      "EX",
      NONCE_TTL_SECS,
    );

    const params = new URLSearchParams({
      client_id: this.msClientId(),
      response_type: "code",
      redirect_uri: this.msRedirectUri(),
      response_mode: "query",
      scope: MS_MAILBOX_SCOPES.join(" "),
      state: nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return `${MS_AUTHORIZE_URL}?${params.toString()}`;
  }

  /**
   * Exchange the Microsoft callback's `code` for tokens and stash a `PendingGrant` — mirrors
   * `handleCallback` exactly (never binds a row; single-use state; PKCE verifier). The one extra
   * step is a Graph `/me` lookup: Microsoft's token response carries no reliable email address
   * on `common`, so `User.Read` + one Graph call resolves `accountEmail`/`externalSubject`
   * instead of decoding an ID token (never requested — no `openid`/`profile` scope needed).
   *
   * Admin-consent-required orgs (risk-based step-up consent, design §1) reject at the token
   * endpoint with `AADSTS65001` — surfaced as `microsoft_admin_consent_required` so the
   * controller can point the admin at the tenant's admin-consent URL instead of a bare error.
   */
  async handleMicrosoftCallback(code: string, state: string): Promise<{ confirmToken: string }> {
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

    let tokenData: any;
    try {
      const resp = await axios.post(
        MS_TOKEN_URL,
        new URLSearchParams({
          client_id: this.msClientId(),
          client_secret: this.msClientSecret(),
          grant_type: "authorization_code",
          code,
          redirect_uri: this.msRedirectUri(),
          code_verifier: oauthPayload.verifier,
          scope: MS_MAILBOX_SCOPES.join(" "),
        }).toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10_000 },
      );
      tokenData = resp.data;
    } catch (err: any) {
      const desc: string = err?.response?.data?.error_description ?? "";
      this.logger.error(`Mailbox Microsoft code exchange failed: ${err?.message ?? err}`);
      if (/AADSTS65001/.test(desc)) {
        throw new BadRequestException("microsoft_admin_consent_required");
      }
      throw new BadRequestException("microsoft_token_invalid");
    }

    if (!tokenData?.refresh_token) {
      // No refresh token means Microsoft didn't grant offline access — nothing usable to store.
      throw new BadRequestException("microsoft_no_refresh_token");
    }

    const grantedScopes: string[] = String(tokenData.scope ?? "")
      .split(" ")
      .filter(Boolean);
    // Graph returns granted scopes as full resource URIs (e.g.
    // "https://graph.microsoft.com/Mail.Send"), so match on the trailing segment.
    if (!grantedScopes.some((s) => /(^|\/)Mail\.Send$/i.test(s))) {
      throw new BadRequestException("microsoft_scope_missing");
    }

    let me: { id?: string; mail?: string; userPrincipalName?: string };
    try {
      const meResp = await axios.get(MS_GRAPH_ME_URL, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
        timeout: 10_000,
      });
      me = meResp.data ?? {};
    } catch (err: any) {
      this.logger.error(`Mailbox Microsoft /me lookup failed: ${err?.message ?? err}`);
      throw new BadRequestException("microsoft_token_invalid");
    }

    const accountEmail = (me.mail || me.userPrincipalName || "").toLowerCase();
    if (!accountEmail || !me.id) {
      throw new BadRequestException("microsoft_email_not_verified");
    }

    const pending: PendingGrant = {
      tenantId: oauthPayload.tenantId,
      userId: oauthPayload.userId,
      provider: "MICROSOFT",
      accountEmail,
      externalSubject: me.id,
      scopesGranted: grantedScopes,
      refreshTokenCipher: this.encryption.encrypt(tokenData.refresh_token),
      accessTokenCipher: tokenData.access_token
        ? this.encryption.encrypt(tokenData.access_token)
        : null,
      accessTokenExpiresAt: tokenData.expires_in
        ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString()
        : null,
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
      provider: pending.provider,
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
      meta: { provider: pending.provider, accountEmail: row.accountEmail },
    });

    return this.toStatusView(row);
  }

  /**
   * Revoke at Google, then hard-delete the row ONLY IF the revoke call itself succeeded.
   * A failed revoke keeps the row (marked REVOKED, with a clear message) so a later disconnect
   * can retry — deleting on a failed revoke would silently leave Google still holding a grant
   * with no local record anyone could act on.
   *
   * Microsoft Graph has NO app-side revoke endpoint equivalent to Google's
   * `oauth2.googleapis.com/revoke` — there is nothing this server can call to invalidate the
   * grant at Microsoft. So for a MICROSOFT row, disconnect hard-deletes immediately (nothing
   * here is retryable against Microsoft) and returns a message telling the admin to remove
   * RouteFlow's access themselves from their Microsoft account's app permissions page.
   */
  async disconnect(
    tenantId: string,
    userId: string,
  ): Promise<{ deleted: boolean; message?: string }> {
    const row = await this.prisma.mailboxConnection.findUnique({ where: { tenantId } });
    if (!row) throw new NotFoundException("No mailbox is connected for this tenant.");

    if (row.provider === "MICROSOFT") {
      await this.prisma.mailboxConnection.delete({ where: { tenantId } });
      await this.audit.log({
        tenantId,
        userId,
        action: "mailbox.disconnected",
        entityType: "mailbox_connection",
        entityId: row.id,
        meta: { provider: row.provider, accountEmail: row.accountEmail },
      });
      return {
        deleted: true,
        message:
          "Disconnected. Microsoft doesn't let RouteFlow revoke access on its own — remove " +
          "RouteFlow from your Microsoft account's app permissions " +
          "(myaccount.microsoft.com → Privacy → Apps and services, or account.live.com/consent/Manage " +
          "for a personal account) to fully revoke it.",
      };
    }

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
