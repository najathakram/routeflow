import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
// nodemailer's MIME composer is a submodule, not part of the top-level export surface --
// esModuleInterop (tsconfig.json) makes a default import work against its `export =`.
import MailComposer from "nodemailer/lib/mail-composer";
import { PrismaService } from "../../prisma/prisma.service";
import { EncryptionService } from "../../common/encryption.service";
import { withAdvisoryLock } from "../../common/db-locks";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
/** Refresh a bit before actual expiry so a send never races an access token dying mid-flight. */
const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_THROTTLE_MS = 60 * 60_000; // 1 hour, mirrors the design's default Retry-After.

export interface MailboxSendParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  /** Sanitized display name for the From header (e.g. the tenant's business name). */
  fromName?: string;
}

export interface MailboxSendResult {
  delivered: boolean;
  transport: "mailbox";
  id?: string;
  error?: string;
  fromAddress?: string;
}

/**
 * Sends tenant mail through a connected Google mailbox via the Gmail API
 * (`users.messages.send`, scope `gmail.send` only — never SMTP XOAUTH2, which needs the
 * restricted `https://mail.google.com/` scope). `trySend` NEVER throws — a caller
 * (`EmailService.send`) falls through to its existing tenant-SMTP/platform chain on any
 * `delivered:false`, so every failure mode here degrades to "not applicable" rather than
 * blocking the send.
 */
@Injectable()
export class MailboxSendService {
  private readonly logger = new Logger(MailboxSendService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly config: ConfigService,
  ) {}

  private clientId(): string {
    return this.config.get<string>("GOOGLE_MAILBOX_CLIENT_ID") ?? "";
  }

  private clientSecret(): string {
    return this.config.get<string>("GOOGLE_MAILBOX_CLIENT_SECRET") ?? "";
  }

  /**
   * The only place a `MailboxConnection`'s tokens are decrypted for sending — mirrors
   * `CrmConnectionService.decryptToken`'s data-minimization pattern (never logged, never
   * serialized).
   */
  private decryptRefreshToken(cipher: string): string {
    return this.encryption.decrypt(cipher);
  }

  /**
   * Lazy access-token refresh, serialized per tenant via a Postgres advisory lock (never an
   * in-process lock — L "Never add a second in-process lock" applies here the same as
   * order-merge). Returns the live access token, or null when the connection is missing,
   * already revoked, or the refresh itself failed (in which case the connection's status has
   * already been updated).
   */
  private async ensureAccessToken(tenantId: string): Promise<string | null> {
    const result = await withAdvisoryLock<string | null>(
      { family: "mailbox", key: tenantId, mode: "wait", waitMs: 10_000 },
      async () => {
        const conn = await this.prisma.mailboxConnection.findUnique({ where: { tenantId } });
        if (!conn || conn.status === "REVOKED") return null;

        const now = Date.now();
        if (
          conn.accessTokenCipher &&
          conn.accessTokenExpiresAt &&
          conn.accessTokenExpiresAt.getTime() > now + ACCESS_TOKEN_REFRESH_SKEW_MS
        ) {
          return this.encryption.decrypt(conn.accessTokenCipher);
        }

        const refreshToken = this.decryptRefreshToken(conn.refreshTokenCipher);
        try {
          const resp = await axios.post(
            GOOGLE_TOKEN_URL,
            new URLSearchParams({
              client_id: this.clientId(),
              client_secret: this.clientSecret(),
              refresh_token: refreshToken,
              grant_type: "refresh_token",
            }).toString(),
            {
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              timeout: 10_000,
            },
          );
          const accessToken = resp.data?.access_token as string;
          const expiresIn = Number(resp.data?.expires_in ?? 3600);
          if (!accessToken) throw new Error("Google token refresh returned no access_token");

          await this.prisma.mailboxConnection.update({
            where: { tenantId },
            data: {
              accessTokenCipher: this.encryption.encrypt(accessToken),
              accessTokenExpiresAt: new Date(now + expiresIn * 1000),
            },
          });
          return accessToken;
        } catch (err: any) {
          const errCode = err?.response?.data?.error;
          if (errCode === "invalid_grant") {
            // Google revoked the grant (password change, consent revoked, etc.) — reconnect
            // required. Never retried automatically.
            await this.prisma.mailboxConnection
              .update({
                where: { tenantId },
                data: {
                  status: "REVOKED",
                  lastError: "Google revoked access to this mailbox — reconnect required.",
                  lastErrorAt: new Date(),
                },
              })
              .catch(() => {});
          } else {
            this.logger.error(
              `Mailbox token refresh failed for tenant ${tenantId}: ${err?.message ?? err}`,
            );
          }
          return null;
        }
      },
    );
    return result.acquired ? result.value : null;
  }

  /** Builds a base64url-encoded RFC 2822 MIME message via nodemailer's MailComposer. */
  private buildRawMime(opts: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text?: string;
    replyTo?: string;
  }): Promise<string> {
    return new Promise((resolve, reject) => {
      const composer = new MailComposer({
        from: opts.from,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
        replyTo: opts.replyTo,
      });
      composer.compile().build((err: Error | null, message: Buffer) => {
        if (err) return reject(err);
        resolve(
          message.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
        );
      });
    });
  }

  /**
   * Attempt to send via the tenant's connected Gmail mailbox. Returns `delivered:false`
   * (never throws) for: no connection, REVOKED, still-THROTTLED, a refresh failure, a MIME
   * build failure, or any Gmail API error — a 429/403 rate-limit response additionally flips
   * the connection to THROTTLED with `throttledUntil` set from `Retry-After` (default 1h).
   */
  async trySend(tenantId: string, params: MailboxSendParams): Promise<MailboxSendResult> {
    const conn = await this.prisma.mailboxConnection.findUnique({ where: { tenantId } });
    if (!conn) return { delivered: false, transport: "mailbox", error: "not_connected" };
    if (conn.status === "REVOKED") {
      return { delivered: false, transport: "mailbox", error: "revoked" };
    }
    if (
      conn.status === "THROTTLED" &&
      conn.throttledUntil &&
      conn.throttledUntil.getTime() > Date.now()
    ) {
      return { delivered: false, transport: "mailbox", error: "throttled" };
    }

    const accessToken = await this.ensureAccessToken(tenantId);
    if (!accessToken) return { delivered: false, transport: "mailbox", error: "reauth_required" };

    const fromHeader = params.fromName
      ? `${params.fromName} <${conn.accountEmail}>`
      : conn.accountEmail;

    let raw: string;
    try {
      raw = await this.buildRawMime({
        from: fromHeader,
        to: params.to,
        subject: params.subject,
        html: params.html,
        text: params.text,
        replyTo: params.replyTo,
      });
    } catch (err: any) {
      this.logger.error(`Mailbox MIME build failed for tenant ${tenantId}: ${err?.message ?? err}`);
      return { delivered: false, transport: "mailbox", error: "mime_build_failed" };
    }

    try {
      const resp = await axios.post(
        GMAIL_SEND_URL,
        { raw },
        { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 15_000 },
      );
      // A successful send recovers a THROTTLED connection back to CONNECTED — the throttle
      // window existing to protect against a rate limit that has now demonstrably cleared.
      await this.prisma.mailboxConnection
        .update({
          where: { tenantId },
          data: {
            status: "CONNECTED",
            throttledUntil: null,
            lastSentAt: new Date(),
            lastError: null,
          },
        })
        .catch(() => {});
      return {
        delivered: true,
        transport: "mailbox",
        id: resp.data?.id,
        fromAddress: conn.accountEmail,
      };
    } catch (err: any) {
      const status = err?.response?.status;
      const reason: string =
        err?.response?.data?.error?.errors?.[0]?.reason ?? err?.response?.data?.error?.status ?? "";
      const isRateLimited =
        status === 429 || (status === 403 && /rateLimitExceeded|dailyLimitExceeded/i.test(reason));

      if (isRateLimited) {
        const retryAfterHeader = err?.response?.headers?.["retry-after"];
        const retryAfterSecs = Number(retryAfterHeader);
        const throttleMs =
          Number.isFinite(retryAfterSecs) && retryAfterSecs > 0
            ? retryAfterSecs * 1000
            : DEFAULT_THROTTLE_MS;
        const throttledUntil = new Date(Date.now() + throttleMs);
        await this.prisma.mailboxConnection
          .update({
            where: { tenantId },
            data: {
              status: "THROTTLED",
              throttledUntil,
              lastError: "Rate-limited by Google — falling back to the next sender.",
              lastErrorAt: new Date(),
            },
          })
          .catch(() => {});
        return { delivered: false, transport: "mailbox", error: "throttled" };
      }

      this.logger.error(
        `Mailbox send failed for tenant ${tenantId} [status=${status ?? "unknown"}]: ${err?.message ?? err}`,
      );
      await this.prisma.mailboxConnection
        .update({
          where: { tenantId },
          data: { lastError: err?.message ?? "Gmail send failed", lastErrorAt: new Date() },
        })
        .catch(() => {});
      return { delivered: false, transport: "mailbox", error: err?.message ?? "gmail_send_failed" };
    }
  }
}
