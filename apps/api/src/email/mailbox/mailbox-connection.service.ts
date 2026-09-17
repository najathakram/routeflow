import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
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
const NONCE_PREFIX = "mailbox:oauth:";

interface OAuthNoncePayload {
  tenantId: string;
  userId: string;
  provider: "GOOGLE";
  verifier: string;
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

/**
 * `MailboxConnection` CRUD + the Google OAuth connect/disconnect flow (PR-2). Tenant isolation
 * is structural, not a filter: every method takes `tenantId` from the caller's OWN JWT (never a
 * client-supplied id), and `MailboxConnection.tenantId` is the row's unique key — there is no
 * by-id lookup anywhere in this surface, so tenant A's JWT can never address tenant B's row.
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
   * records WHO initiated the connect (`tenantId`/`userId`) — the callback trusts this record
   * rather than re-authenticating the browser (Google's redirect carries no bearer token in
   * this app's localStorage-token architecture), which is safe because only an already
   * TENANT_ADMIN-authenticated `/start` call can ever mint a valid nonce.
   */
  async startConnect(tenantId: string, userId: string): Promise<string> {
    const client = this.newOAuthClient();
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const nonce = crypto.randomUUID();

    const payload: OAuthNoncePayload = {
      tenantId,
      userId,
      provider: "GOOGLE",
      verifier: codeVerifier,
    };
    await this.redis.set(`${NONCE_PREFIX}${nonce}`, JSON.stringify(payload), "EX", NONCE_TTL_SECS);

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
   * Exchange the callback's `code` for tokens and persist the connection. Rejects a
   * tampered/expired/reused `state` with a 400 BEFORE any code exchange is attempted — the
   * single-use GETDEL below is what makes a replayed state fail even when it was valid once.
   */
  async handleCallback(code: string, state: string): Promise<{ tenantId: string }> {
    if (!code || !state) throw new BadRequestException("state_invalid");

    const key = `${NONCE_PREFIX}${state}`;
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
    if (!stored) throw new BadRequestException("state_invalid");

    let payload: OAuthNoncePayload;
    try {
      payload = JSON.parse(stored) as OAuthNoncePayload;
    } catch {
      throw new BadRequestException("state_invalid");
    }
    if (!payload?.tenantId || !payload?.userId || !payload?.verifier) {
      throw new BadRequestException("state_invalid");
    }

    const client = this.newOAuthClient();
    const { tokens } = await client
      .getToken({ code, codeVerifier: payload.verifier })
      .catch((err: Error) => {
        this.logger.error(`Mailbox Google code exchange failed: ${err.message}`);
        throw new BadRequestException("google_token_invalid");
      });

    if (!tokens.refresh_token) {
      // No refresh token means Google didn't grant offline access (e.g. a repeat consent
      // without prompt=consent re-issuing one) — nothing usable to store.
      throw new BadRequestException("google_no_refresh_token");
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

    const existing = await this.prisma.mailboxConnection.findUnique({
      where: { tenantId: payload.tenantId },
    });
    const isReconnect = !!existing;
    const externalSubjectChanged = existing && existing.externalSubject !== idPayload.sub;

    const data = {
      provider: "GOOGLE" as const,
      accountEmail: idPayload.email!.toLowerCase(),
      externalSubject: idPayload.sub,
      scopesGranted: (tokens.scope ?? GMAIL_SEND_SCOPE).split(" "),
      refreshTokenCipher: this.encryption.encrypt(tokens.refresh_token),
      accessTokenCipher: tokens.access_token ? this.encryption.encrypt(tokens.access_token) : null,
      accessTokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      status: "CONNECTED" as const,
      throttledUntil: null,
      lastError: null,
      lastErrorAt: null,
      connectedByUserId: payload.userId,
    };

    const row = await this.prisma.mailboxConnection.upsert({
      where: { tenantId: payload.tenantId },
      create: { tenantId: payload.tenantId, ...data },
      update: data,
    });

    await this.audit.log({
      tenantId: payload.tenantId,
      userId: payload.userId,
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

    return { tenantId: payload.tenantId };
  }

  /** Revoke at Google (best-effort), then hard-delete the row — never a soft disconnect. */
  async disconnect(tenantId: string, userId: string): Promise<void> {
    const row = await this.prisma.mailboxConnection.findUnique({ where: { tenantId } });
    if (!row) throw new NotFoundException("No mailbox is connected for this tenant.");

    try {
      const refreshToken = this.encryption.decrypt(row.refreshTokenCipher);
      await axios.post("https://oauth2.googleapis.com/revoke", null, {
        params: { token: refreshToken },
        timeout: 8_000,
      });
    } catch (err: any) {
      // Best-effort — the tenant wants to disconnect regardless of whether the revoke call
      // itself succeeds (e.g. the grant was already revoked by Google).
      this.logger.warn(`Mailbox revoke-at-Google failed for tenant ${tenantId}: ${err?.message}`);
    }

    await this.prisma.mailboxConnection.delete({ where: { tenantId } });

    await this.audit.log({
      tenantId,
      userId,
      action: "mailbox.disconnected",
      entityType: "mailbox_connection",
      entityId: row.id,
      meta: { provider: row.provider, accountEmail: row.accountEmail },
    });
  }
}
