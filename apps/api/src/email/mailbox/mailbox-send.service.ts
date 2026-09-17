import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
// nodemailer's MIME composer is a submodule, not part of the top-level export surface.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const MailComposer = require("nodemailer/lib/mail-composer");
import { PrismaService } from "../../prisma/prisma.service";
import { EncryptionService } from "../../common/encryption.service";
import { withAdvisoryLock } from "../../common/db-locks";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MS_GRAPH_SEND_MAIL_URL = "https://graph.microsoft.com/v1.0/me/sendMail";
/** Must match `MailboxConnectionService`'s startConnectMicrosoft/handleMicrosoftCallback scope
 *  request (design §3) — a refresh with a NARROWER scope than what was granted is rejected. */
const MS_MAILBOX_SCOPES = ["offline_access", "Mail.Send", "User.Read"];
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
 * Sends tenant mail through a connected Google or Microsoft mailbox — Gmail API
 * `users.messages.send` (scope `gmail.send` only — never SMTP XOAUTH2, which needs the
 * restricted `https://mail.google.com/` scope) or Microsoft Graph `POST /me/sendMail` (scope
 * `Mail.Send` only — never `SMTP.Send`, which admins commonly disable). `trySend` NEVER throws —
 * a caller (`EmailService.send`) falls through to its existing tenant-SMTP/platform chain on any
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

  private msClientId(): string {
    return this.config.get<string>("MICROSOFT_MAILBOX_CLIENT_ID") ?? "";
  }

  private msClientSecret(): string {
    return this.config.get<string>("MICROSOFT_MAILBOX_CLIENT_SECRET") ?? "";
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
        return conn.provider === "MICROSOFT"
          ? this.refreshMicrosoftAccessToken(tenantId, refreshToken, now)
          : this.refreshGoogleAccessToken(tenantId, refreshToken, now);
      },
    );
    return result.acquired ? result.value : null;
  }

  private async refreshGoogleAccessToken(
    tenantId: string,
    refreshToken: string,
    now: number,
  ): Promise<string | null> {
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
          `Mailbox Google token refresh failed for tenant ${tenantId}: ${err?.message ?? err}`,
        );
      }
      return null;
    }
  }

  /**
   * Microsoft ROTATES the refresh token on every refresh call (design §2) — the response's
   * `refresh_token`, when present, is persisted alongside the new access token, or the NEXT
   * refresh attempt fails against the now-superseded old one. Google never requires this (a
   * refresh token there is reused indefinitely until revoked), so this is Microsoft-only.
   */
  private async refreshMicrosoftAccessToken(
    tenantId: string,
    refreshToken: string,
    now: number,
  ): Promise<string | null> {
    try {
      const resp = await axios.post(
        MS_TOKEN_URL,
        new URLSearchParams({
          client_id: this.msClientId(),
          client_secret: this.msClientSecret(),
          refresh_token: refreshToken,
          grant_type: "refresh_token",
          scope: MS_MAILBOX_SCOPES.join(" "),
        }).toString(),
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          timeout: 10_000,
        },
      );
      const accessToken = resp.data?.access_token as string;
      const newRefreshToken = resp.data?.refresh_token as string | undefined;
      const expiresIn = Number(resp.data?.expires_in ?? 3600);
      if (!accessToken) throw new Error("Microsoft token refresh returned no access_token");

      const data: Record<string, unknown> = {
        accessTokenCipher: this.encryption.encrypt(accessToken),
        accessTokenExpiresAt: new Date(now + expiresIn * 1000),
      };
      if (newRefreshToken) data.refreshTokenCipher = this.encryption.encrypt(newRefreshToken);

      await this.prisma.mailboxConnection.update({ where: { tenantId }, data });
      return accessToken;
    } catch (err: any) {
      const errCode = err?.response?.data?.error;
      const errDesc: string = err?.response?.data?.error_description ?? "";
      if (errCode === "invalid_grant" || /AADSTS70000\d/i.test(errDesc)) {
        // Microsoft revoked the grant (password change, admin revoke, consent withdrawn) —
        // reconnect required. Never retried automatically.
        await this.prisma.mailboxConnection
          .update({
            where: { tenantId },
            data: {
              status: "REVOKED",
              lastError: "Microsoft revoked access to this mailbox — reconnect required.",
              lastErrorAt: new Date(),
            },
          })
          .catch(() => {});
      } else {
        this.logger.error(
          `Mailbox Microsoft token refresh failed for tenant ${tenantId}: ${err?.message ?? err}`,
        );
      }
      return null;
    }
  }

  /** Builds an RFC 2822 MIME message via nodemailer's MailComposer — shared by both providers
   *  (design §2: "One nodemailer MailComposer builds MIME for both"), so templates/escapeHtml/
   *  base layout are identical regardless of transport. Each provider then encodes the same
   *  buffer the way its API expects (Gmail: base64url; Graph: standard base64). */
  private buildMimeBuffer(opts: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text?: string;
    replyTo?: string;
  }): Promise<Buffer> {
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
        resolve(message);
      });
    });
  }

  /**
   * Attempt to send via the tenant's connected mailbox (Gmail or Microsoft Graph). Returns
   * `delivered:false` (never throws) for: no connection, REVOKED, still-THROTTLED, a refresh
   * failure, a MIME build failure, or any provider API error — a rate-limit response
   * additionally flips the connection to THROTTLED with `throttledUntil` set from `Retry-After`
   * (default 1h); an auth-rejection response (Graph 401/403) flips it to REVOKED.
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

    let mimeBuffer: Buffer;
    try {
      mimeBuffer = await this.buildMimeBuffer({
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

    return conn.provider === "MICROSOFT"
      ? this.sendViaGraph(tenantId, conn.accountEmail, accessToken, mimeBuffer)
      : this.sendViaGmail(tenantId, conn.accountEmail, accessToken, mimeBuffer);
  }

  private async sendViaGmail(
    tenantId: string,
    accountEmail: string,
    accessToken: string,
    mimeBuffer: Buffer,
  ): Promise<MailboxSendResult> {
    const raw = mimeBuffer
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

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
        fromAddress: accountEmail,
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

  /**
   * Graph `POST /me/sendMail` accepts a raw base64-encoded MIME message directly when the
   * request `Content-Type` is `text/plain` (design §2) — the same MIME buffer `sendViaGmail`
   * builds, just standard base64 rather than base64url, and capped at 4 MB per Graph's own
   * limit. Unlike Gmail, a successful `sendMail` returns 202 with an empty body — there is no
   * provider message id to surface, so `MailboxSendResult.id` stays unset for a Microsoft send.
   */
  private async sendViaGraph(
    tenantId: string,
    accountEmail: string,
    accessToken: string,
    mimeBuffer: Buffer,
  ): Promise<MailboxSendResult> {
    const raw = mimeBuffer.toString("base64");

    try {
      await axios.post(MS_GRAPH_SEND_MAIL_URL, raw, {
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "text/plain" },
        timeout: 15_000,
      });
      // A successful send recovers a THROTTLED connection back to CONNECTED — same as Gmail.
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
      return { delivered: true, transport: "mailbox", fromAddress: accountEmail };
    } catch (err: any) {
      const status = err?.response?.status;

      if (status === 429) {
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
              lastError: "Rate-limited by Microsoft — falling back to the next sender.",
              lastErrorAt: new Date(),
            },
          })
          .catch(() => {});
        return { delivered: false, transport: "mailbox", error: "throttled" };
      }

      if (status === 401 || status === 403) {
        // Graph rejected the token outright (consent revoked since the last refresh, the app
        // removed from the account, etc.) — reconnect required, never retried automatically.
        await this.prisma.mailboxConnection
          .update({
            where: { tenantId },
            data: {
              status: "REVOKED",
              lastError: "Microsoft rejected the send — reconnect required.",
              lastErrorAt: new Date(),
            },
          })
          .catch(() => {});
        return { delivered: false, transport: "mailbox", error: "revoked" };
      }

      this.logger.error(
        `Mailbox Graph send failed for tenant ${tenantId} [status=${status ?? "unknown"}]: ${err?.message ?? err}`,
      );
      await this.prisma.mailboxConnection
        .update({
          where: { tenantId },
          data: { lastError: err?.message ?? "Graph send failed", lastErrorAt: new Date() },
        })
        .catch(() => {});
      return { delivered: false, transport: "mailbox", error: err?.message ?? "graph_send_failed" };
    }
  }
}
