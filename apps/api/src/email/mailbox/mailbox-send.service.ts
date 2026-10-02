import { Injectable, Logger } from "@nestjs/common";
import { AfterCommit } from "../../common/after-commit";
import { ConfigService } from "@nestjs/config";
import type { MailboxConnection, MailboxConnectionStatus, Prisma } from "@prisma/client";
import axios from "axios";
// nodemailer's MIME composer is a submodule, not part of the top-level export surface --
// esModuleInterop (tsconfig.json) makes a default import work against its `export =`.
import MailComposer from "nodemailer/lib/mail-composer";
import { PrismaService } from "../../prisma/prisma.service";
import { EncryptionService } from "../../common/encryption.service";
import { withAdvisoryLock } from "../../common/db-locks";
import { AddonAccessService } from "../../billing/addon-access";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MS_GRAPH_SEND_MAIL_URL = "https://graph.microsoft.com/v1.0/me/sendMail";
/** Must match `MailboxConnectionService`'s startConnectMicrosoft/handleMicrosoftCallback scope
 *  request (design §3) — a refresh with a NARROWER scope than what was granted is rejected. */
const MS_MAILBOX_SCOPES = ["offline_access", "Mail.Send", "User.Read"];
/** Graph's documented raw-MIME `sendMail` size cap (design §2). */
const MS_GRAPH_MAX_MIME_BYTES = 4 * 1024 * 1024;
/** Graph error `code`s (the JSON body's `error.code`, not the HTTP status) that mean the TOKEN
 *  itself is the problem — as opposed to a 403 like `ErrorSendAsDenied` or
 *  `MailboxNotEnabledForRESTAPI`, which mean the account/mailbox can't do this regardless of
 *  how fresh the token is, and reconnecting would not fix them (Opus review, LOW). */
const MS_GRAPH_REAUTH_ERROR_CODE_PATTERN =
  /Authentication|InvalidToken|TokenExpired|TokenNotFound/i;
/** Refresh a bit before actual expiry so a send never races an access token dying mid-flight. */
const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_THROTTLE_MS = 60 * 60_000; // 1 hour, mirrors the design's default Retry-After.
/**
 * A rate limit alerts the tenant's admins at most once per connection in this window: Graph's
 * `Retry-After` is often seconds, so a busy mailbox can be throttled many times a day, and each
 * one must not page every admin. Every transition still writes its audit row.
 */
const THROTTLE_ALERT_WINDOW_MS = 24 * 60 * 60_000;

export interface MailboxSendParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  /** Sanitized display name for the From header (e.g. the tenant's business name). */
  fromName?: string;
  /**
   * Files to attach (invoice PDF today) — passed straight through to nodemailer's
   * `MailComposer`, which both Gmail and Graph send via the SAME MIME buffer. An
   * attachment simply grows that buffer; `sendViaGraph`'s existing 4MB size check
   * already falls through to the next transport for an oversize message, so no
   * separate size handling is needed here for the Microsoft path.
   */
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}

export interface MailboxSendResult {
  delivered: boolean;
  transport: "mailbox";
  id?: string;
  error?: string;
  fromAddress?: string;
}

/** The two states a connection can move into on its own, without a human acting. */
export type MailboxAlertStatus = "REVOKED" | "THROTTLED";

/**
 * Why a connection moved into REVOKED or THROTTLED — one fixed value per detection site. This is
 * all an audit row records about the cause: never a token, an OAuth code, a provider error body
 * or any other secret.
 */
export type MailboxStateChangeReason =
  | "google_invalid_grant"
  | "microsoft_invalid_grant"
  | "microsoft_aadsts"
  | "graph_401"
  | "graph_403"
  | "rate_limited";

/**
 * One automatic transition into REVOKED or THROTTLED (F-10a), emitted after its audit row has
 * committed, and only by the send whose conditional update won it — never for a repeat detection
 * of a state the connection is already in. Every REVOKED transition is emitted; a THROTTLED one
 * only when this connection had no rate limit in the last 24h (`THROTTLE_ALERT_WINDOW_MS`).
 * Carries no token field.
 */
export interface MailboxStateChange {
  tenantId: string;
  connectionId: string;
  provider: "GOOGLE" | "MICROSOFT";
  accountEmail: string;
  status: MailboxAlertStatus;
  reasonCode: MailboxStateChangeReason;
  /** When the mailbox will be tried again (THROTTLED); null for REVOKED. */
  throttledUntil: Date | null;
  /** #2113: the `alertPendingAt` this transition committed — the value a deliverer claims. */
  alertPendingAt: Date;
}

export type MailboxStateChangeListener = (change: MailboxStateChange) => void | Promise<void>;

/**
 * The only states each automatic transition may leave from. REVOKED is terminal until an admin
 * reconnects (`confirmConnect` rebinds the row as CONNECTED), so nothing here ever moves a REVOKED
 * row; a THROTTLED row can still be revoked, but it is never "throttled again" — its window is
 * extended instead, with no new audit row (see `markThrottled`).
 */
const TRANSITION_FROM: Record<MailboxAlertStatus, MailboxConnectionStatus[]> = {
  REVOKED: ["CONNECTED", "THROTTLED"],
  THROTTLED: ["CONNECTED"],
};

const TRANSITION_AUDIT_ACTION: Record<MailboxAlertStatus, string> = {
  REVOKED: "mailbox.revoked_detected",
  THROTTLED: "mailbox.throttled_detected",
};

/** A live access token plus the exact ciphertext it was read from (or written as) — the cipher
 *  pins a later "Graph rejected this token" revocation to THIS credential (see `sendViaGraph`). */
interface AccessGrant {
  accessToken: string;
  accessTokenCipher: string;
}

/** Why a send skipped the mailbox without calling the provider. */
type MailboxSkipReason =
  "not_connected" | "revoked" | "throttled" | "reauth_required" | "addon_required";

/** The add-on the mailbox HTTP routes are gated on (`@RequireAddon`); the send path honours it too. */
const MAILBOX_ADDON_KEY = "email.connected_mailbox";

/** The connection as read UNDER the advisory lock, with a live token — see `prepareSend`. */
interface PreparedSend {
  conn: MailboxConnection;
  grant: AccessGrant;
}

/**
 * A mailbox is identified by (provider, externalSubject) — the same predicate `confirmConnect`
 * uses to tell a re-grant of the same mailbox from a different one. A Google `sub` and a Microsoft
 * object id come from different namespaces, so the subject alone is not enough. Writes that record
 * what THIS mailbox did (a rate limit, a sent message) are pinned to it, so they can never land on
 * a different mailbox an admin reconnected while the send was in flight (the row id survives a
 * reconnect: it is an upsert on tenantId).
 */
function mailboxIdentity(conn: MailboxConnection): Prisma.MailboxConnectionWhereInput {
  return { provider: conn.provider, externalSubject: conn.externalSubject };
}

function isThrottledNow(conn: MailboxConnection): boolean {
  return (
    conn.status === "THROTTLED" &&
    conn.throttledUntil !== null &&
    conn.throttledUntil.getTime() > Date.now()
  );
}

/** Why an existing connection can't be sent through right now, or null when it can. */
function skipReason(conn: MailboxConnection): "revoked" | "throttled" | null {
  if (conn.status === "REVOKED") return "revoked";
  if (isThrottledNow(conn)) return "throttled";
  return null;
}

/**
 * An error's class name and Prisma/Node code, never its message: a Prisma error message can echo
 * the query's arguments — including a pinned token cipher — and a provider message is not ours to
 * vouch for. Enough to tell a lock timeout from a DB outage from a decrypt failure in the logs.
 */
function errorLabel(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code ? `${err.name} ${code}` : err.name;
}

/** When a rate-limited mailbox may be tried again: now + `Retry-After` seconds (default 1h). */
function throttledUntilFrom(err: any): Date {
  const retryAfterSecs = Number(err?.response?.headers?.["retry-after"]);
  const throttleMs =
    Number.isFinite(retryAfterSecs) && retryAfterSecs > 0
      ? retryAfterSecs * 1000
      : DEFAULT_THROTTLE_MS;
  return new Date(Date.now() + throttleMs);
}

/**
 * Sends tenant mail through a connected Google or Microsoft mailbox — Gmail API
 * `users.messages.send` (scope `gmail.send` only — never SMTP XOAUTH2, which needs the
 * restricted `https://mail.google.com/` scope) or Microsoft Graph `POST /me/sendMail` (scope
 * `Mail.Send` only — never `SMTP.Send`, which admins commonly disable). `trySend` NEVER throws —
 * a caller (`EmailService.send`) falls through to its existing tenant-SMTP/platform chain on any
 * `delivered:false`, so every failure mode here degrades to "not applicable" rather than
 * blocking the send.
 *
 * F-10a: when a send finds the mailbox revoked or rate-limited, the connection moves to REVOKED /
 * THROTTLED through ONE conditional update (`transition`), committed in the same transaction as
 * its `mailbox.revoked_detected` / `mailbox.throttled_detected` audit row. Only the send that wins
 * it emits a `MailboxStateChange` to its subscribers (`MailboxAlertService` tells the tenant's
 * admins), and only after that commit — so concurrent sends detecting the same revocation produce
 * one row and one notification, and a later detection on a connection already in that state
 * produces nothing. Everything after the advisory lock uses the connection read under it
 * (`prepareSend`), never the lock-free read before it.
 */
@Injectable()
export class MailboxSendService {
  private readonly logger = new Logger(MailboxSendService.name);
  private readonly stateChangeListeners = new Set<MailboxStateChangeListener>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly config: ConfigService,
    private readonly addonAccess: AddonAccessService,
  ) {}

  /**
   * Subscribe to automatic transitions into REVOKED / THROTTLED; returns the unsubscribe
   * function. This is a subscription rather than a constructor dependency because the one
   * subscriber, `MailboxAlertService`, emails through `EmailService` — which itself depends on
   * this service — so injecting it here would make a DI cycle. A listener is invoked
   * synchronously by the send that won the transition, but that send never waits for it: its
   * result is detached, and nothing it throws or rejects can reach the send.
   */
  onStateChange(listener: MailboxStateChangeListener): () => void {
    this.stateChangeListeners.add(listener);
    return () => {
      this.stateChangeListeners.delete(listener);
    };
  }

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
   * Takes the per-tenant advisory lock — the one `confirmConnect` holds while it rebinds the row
   * — re-reads the connection under it, and returns THAT connection with a live access token
   * (lazily refreshed, serialized per tenant; never an in-process lock — L "Never add a second
   * in-process lock" applies here the same as order-merge). Everything the send does afterwards —
   * the provider, the From address, the audit row, every pinned write — uses this connection,
   * never the lock-free read before it: an admin can reconnect (even with the other provider) in
   * between, and a Google token sent to Graph comes back 401, which would revoke the fresh
   * connection in the old account's name. Returns why not instead when the connection is gone,
   * REVOKED, still THROTTLED, or its refresh failed (the connection's status is then already
   * updated).
   */
  private async prepareSend(tenantId: string): Promise<PreparedSend | MailboxSkipReason> {
    const result = await withAdvisoryLock<PreparedSend | MailboxSkipReason>(
      { family: "mailbox", key: tenantId, mode: "wait", waitMs: 10_000 },
      async () => {
        const conn = await this.prisma.mailboxConnection.findUnique({ where: { tenantId } });
        if (!conn) return "not_connected";
        const skip = skipReason(conn);
        if (skip) return skip;

        const now = Date.now();
        if (
          conn.accessTokenCipher &&
          conn.accessTokenExpiresAt &&
          conn.accessTokenExpiresAt.getTime() > now + ACCESS_TOKEN_REFRESH_SKEW_MS
        ) {
          const accessToken = this.encryption.decrypt(conn.accessTokenCipher);
          return { conn, grant: { accessToken, accessTokenCipher: conn.accessTokenCipher } };
        }

        const refreshToken = this.decryptRefreshToken(conn.refreshTokenCipher);
        const grant =
          conn.provider === "MICROSOFT"
            ? await this.refreshMicrosoftAccessToken(conn, refreshToken, now)
            : await this.refreshGoogleAccessToken(conn, refreshToken, now);
        return grant ? { conn, grant } : "reauth_required";
      },
    );
    return result.acquired ? result.value : "reauth_required";
  }

  private async refreshGoogleAccessToken(
    conn: MailboxConnection,
    refreshToken: string,
    now: number,
  ): Promise<AccessGrant | null> {
    const { tenantId } = conn;
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

      const accessTokenCipher = this.encryption.encrypt(accessToken);
      await this.prisma.mailboxConnection.update({
        where: { tenantId },
        data: {
          accessTokenCipher,
          accessTokenExpiresAt: new Date(now + expiresIn * 1000),
        },
      });
      return { accessToken, accessTokenCipher };
    } catch (err: any) {
      const errCode = err?.response?.data?.error;
      if (errCode === "invalid_grant") {
        // Google revoked the grant (password change, consent revoked, etc.) — reconnect
        // required. Never retried automatically.
        await this.markRevoked(
          conn,
          "google_invalid_grant",
          "Google revoked access to this mailbox — reconnect required.",
          { refreshTokenCipher: conn.refreshTokenCipher },
        );
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
    conn: MailboxConnection,
    refreshToken: string,
    now: number,
  ): Promise<AccessGrant | null> {
    const { tenantId } = conn;
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

      const accessTokenCipher = this.encryption.encrypt(accessToken);
      const data: Record<string, unknown> = {
        accessTokenCipher,
        accessTokenExpiresAt: new Date(now + expiresIn * 1000),
      };
      if (newRefreshToken) data.refreshTokenCipher = this.encryption.encrypt(newRefreshToken);

      await this.prisma.mailboxConnection.update({ where: { tenantId }, data });
      return { accessToken, accessTokenCipher };
    } catch (err: any) {
      const errCode = err?.response?.data?.error;
      const errDesc: string = err?.response?.data?.error_description ?? "";
      if (errCode === "invalid_grant" || /AADSTS70000\d/i.test(errDesc)) {
        // Microsoft revoked the grant (password change, admin revoke, consent withdrawn) —
        // reconnect required. Never retried automatically. `invalid_grant` names the grant
        // itself; an AADSTS70000x description under any other `error` is the second signal.
        await this.markRevoked(
          conn,
          errCode === "invalid_grant" ? "microsoft_invalid_grant" : "microsoft_aadsts",
          "Microsoft revoked access to this mailbox — reconnect required.",
          { refreshTokenCipher: conn.refreshTokenCipher },
        );
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
    attachments?: { filename: string; content: Buffer; contentType?: string }[];
  }): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const composer = new MailComposer({
        from: opts.from,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
        replyTo: opts.replyTo,
        attachments: opts.attachments,
      });
      composer.compile().build((err: Error | null, message: Buffer) => {
        if (err) return reject(err);
        resolve(message);
      });
    });
  }

  /**
   * Attempt to send via the tenant's connected mailbox (Gmail or Microsoft Graph). Returns
   * `delivered:false` — and NEVER throws — for: no connection, REVOKED, still-THROTTLED, a refresh
   * failure, a MIME build failure, any provider API error, or anything unexpected underneath (an
   * advisory-lock timeout, a DB error, an undecryptable token). A rate-limit response additionally
   * moves the connection to THROTTLED with `throttledUntil` set from `Retry-After` (default 1h);
   * an auth-rejection response (Graph 401/403) moves it to REVOKED — see `transition`.
   */
  async trySend(tenantId: string, params: MailboxSendParams): Promise<MailboxSendResult> {
    try {
      // Lock-free pre-check: most tenants have no mailbox, and a connected one is rarely REVOKED
      // or THROTTLED — those skip here without taking a slot of the small `mailbox` lock pool.
      // Nothing below uses this read: `prepareSend` re-reads the connection under the lock.
      const unlocked = await this.prisma.mailboxConnection.findUnique({ where: { tenantId } });
      if (!unlocked) return { delivered: false, transport: "mailbox", error: "not_connected" };
      const early = skipReason(unlocked);
      if (early) return { delivered: false, transport: "mailbox", error: early };

      // Entitlement: the SAME decision the `@RequireAddon` HTTP guard makes. A downgrade can keep
      // the connection row, so the send path must check it too. Dark => send + would-deny warning;
      // enforced => `addon_required`, which EmailService treats like any other skip (falls through).
      const access = await this.addonAccess.decide(tenantId, [MAILBOX_ADDON_KEY]);
      if (access.outcome === "denied") {
        return { delivered: false, transport: "mailbox", error: "addon_required" };
      }
      if (access.outcome === "dark") {
        this.logger.warn(
          `addon gate would deny (dark): keys=${MAILBOX_ADDON_KEY} tenant=${tenantId} route=mailbox send`,
        );
      }

      const prepared = await this.prepareSend(tenantId);
      if (typeof prepared === "string") {
        return { delivered: false, transport: "mailbox", error: prepared };
      }
      const { conn, grant } = prepared;

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
          attachments: params.attachments,
        });
      } catch (err: any) {
        this.logger.error(
          `Mailbox MIME build failed for tenant ${tenantId}: ${err?.message ?? err}`,
        );
        return { delivered: false, transport: "mailbox", error: "mime_build_failed" };
      }

      return conn.provider === "MICROSOFT"
        ? await this.sendViaGraph(conn, grant, mimeBuffer)
        : await this.sendViaGmail(conn, grant, mimeBuffer);
    } catch (err: unknown) {
      // The contract `EmailService.send()` relies on: it falls through to the tenant's SMTP /
      // the platform on any `delivered:false`, and has no catch of its own around this call —
      // so an advisory-lock timeout, a DB error or an undecryptable token must end up here, not
      // as a rejected send.
      this.logger.error(
        `Mailbox send aborted for tenant ${tenantId} (${errorLabel(err)}) — falling back to the next sender.`,
      );
      return { delivered: false, transport: "mailbox", error: "mailbox_unavailable" };
    }
  }

  /**
   * Records a delivered message on the mailbox that sent it, and recovers a THROTTLED connection
   * whose window has lapsed back to CONNECTED (the rate limit has demonstrably cleared). The write
   * matches only when:
   *   - it is still the SAME mailbox (`mailboxIdentity`): an admin who reconnected a different
   *     mailbox while this send was in flight must not see it stamped with a send it never made;
   *   - the row is CONNECTED, or THROTTLED with its window over: a send already in flight when a
   *     concurrent one hit the rate limit must not undo that throttle, or the very next send hits
   *     the limit — and alerts — again;
   *   - it is never REVOKED: that would silently undo an audited, notified revocation.
   * Called only AFTER the provider accepted the message, and never throws: a bookkeeping failure
   * must not turn a delivered message into `delivered:false`, which would make the caller send it
   * a second time through the next sender.
   */
  private async recordSuccessfulSend(conn: MailboxConnection): Promise<void> {
    const now = new Date();
    try {
      await this.prisma.mailboxConnection.updateMany({
        where: {
          ...mailboxIdentity(conn),
          id: conn.id,
          OR: [
            { status: "CONNECTED" },
            { status: "THROTTLED", throttledUntil: null },
            { status: "THROTTLED", throttledUntil: { lte: now } },
          ],
        },
        data: {
          status: "CONNECTED",
          throttledUntil: null,
          lastSentAt: now,
          lastError: null,
        },
      });
    } catch (err: unknown) {
      this.logger.error(
        `Mailbox send bookkeeping failed for tenant ${conn.tenantId} (${errorLabel(err)})`,
      );
    }
  }

  private async sendViaGmail(
    conn: MailboxConnection,
    grant: AccessGrant,
    mimeBuffer: Buffer,
  ): Promise<MailboxSendResult> {
    const { tenantId } = conn;
    const raw = mimeBuffer
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    let messageId: string | undefined;
    try {
      const resp = await axios.post(
        GMAIL_SEND_URL,
        { raw },
        { headers: { Authorization: `Bearer ${grant.accessToken}` }, timeout: 15_000 },
      );
      messageId = resp.data?.id;
    } catch (err: any) {
      const status = err?.response?.status;
      const reason: string =
        err?.response?.data?.error?.errors?.[0]?.reason ?? err?.response?.data?.error?.status ?? "";
      const isRateLimited =
        status === 429 || (status === 403 && /rateLimitExceeded|dailyLimitExceeded/i.test(reason));

      if (isRateLimited) {
        await this.markThrottled(
          conn,
          throttledUntilFrom(err),
          "Rate-limited by Google — falling back to the next sender.",
        );
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

    await this.recordSuccessfulSend(conn);
    return { delivered: true, transport: "mailbox", id: messageId, fromAddress: conn.accountEmail };
  }

  /**
   * Graph `POST /me/sendMail` accepts a raw base64-encoded MIME message directly when the
   * request `Content-Type` is `text/plain` (design §2) — the same MIME buffer `sendViaGmail`
   * builds, just standard base64 rather than base64url, and capped at 4 MB per Graph's own
   * limit. Unlike Gmail, a successful `sendMail` returns 202 with an empty body — there is no
   * provider message id to surface, so `MailboxSendResult.id` stays unset for a Microsoft send.
   */
  private async sendViaGraph(
    conn: MailboxConnection,
    grant: AccessGrant,
    mimeBuffer: Buffer,
  ): Promise<MailboxSendResult> {
    const { tenantId } = conn;
    if (mimeBuffer.length > MS_GRAPH_MAX_MIME_BYTES) {
      // Graph's raw-MIME sendMail documents a 4 MB cap — this is never retryable by falling
      // back to another transport being right for THIS message, but it must still fall through
      // (never REVOKED/THROTTLED — the connection itself is fine) so the caller's existing
      // tenant-SMTP/platform chain gets a chance.
      this.logger.error(
        `Mailbox Graph send skipped for tenant ${tenantId}: MIME message ${mimeBuffer.length}B exceeds Graph's 4MB sendMail limit`,
      );
      await this.prisma.mailboxConnection
        .update({
          where: { tenantId },
          data: {
            lastError:
              "Message too large for Microsoft Graph's 4 MB limit — falling back to the next sender.",
            lastErrorAt: new Date(),
          },
        })
        .catch(() => {});
      return { delivered: false, transport: "mailbox", error: "message_too_large" };
    }

    const raw = mimeBuffer.toString("base64");

    try {
      await axios.post(MS_GRAPH_SEND_MAIL_URL, raw, {
        headers: { Authorization: `Bearer ${grant.accessToken}`, "Content-Type": "text/plain" },
        timeout: 15_000,
      });
    } catch (err: any) {
      const status = err?.response?.status;

      if (status === 429) {
        await this.markThrottled(
          conn,
          throttledUntilFrom(err),
          "Rate-limited by Microsoft — falling back to the next sender.",
        );
        return { delivered: false, transport: "mailbox", error: "throttled" };
      }

      const graphErrorCode: string = err?.response?.data?.error?.code ?? "";
      const isTokenRejection =
        status === 401 ||
        (status === 403 && MS_GRAPH_REAUTH_ERROR_CODE_PATTERN.test(graphErrorCode));

      if (isTokenRejection) {
        // Graph rejected the TOKEN itself (expired/invalid/consent revoked since the last
        // refresh) — reconnect required, never retried automatically. This runs outside the
        // advisory lock, so the revocation is pinned to the access token this send actually
        // used: if an admin reconnected (or another send refreshed the token) while this request
        // was in flight, the credential Graph rejected is no longer the connection's, and the
        // fresh one must not be marked REVOKED on its behalf.
        await this.markRevoked(
          conn,
          status === 401 ? "graph_401" : "graph_403",
          "Microsoft rejected the send — reconnect required.",
          { accessTokenCipher: grant.accessTokenCipher },
        );
        return { delivered: false, transport: "mailbox", error: "revoked" };
      }

      if (status === 403) {
        // A 403 whose code is NOT a token/auth problem — e.g. ErrorSendAsDenied (the mailbox
        // can't send as this address) or MailboxNotEnabledForRESTAPI (no Exchange mailbox on
        // this account). Reconnecting wouldn't fix either, so this is a real send failure, not
        // a revoked grant: record it and fall through WITHOUT touching `status` (Opus review,
        // LOW — a bad-mailbox-config 403 was flipping a perfectly good connection to REVOKED).
        this.logger.error(
          `Mailbox Graph send forbidden for tenant ${tenantId} [code=${graphErrorCode || "unknown"}]: ${err?.message ?? err}`,
        );
        await this.prisma.mailboxConnection
          .update({
            where: { tenantId },
            data: {
              lastError: graphErrorCode
                ? `Microsoft rejected the send (${graphErrorCode}).`
                : "Microsoft rejected the send.",
              lastErrorAt: new Date(),
            },
          })
          .catch(() => {});
        return {
          delivered: false,
          transport: "mailbox",
          error: graphErrorCode || "graph_send_forbidden",
        };
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

    await this.recordSuccessfulSend(conn);
    return { delivered: true, transport: "mailbox", fromAddress: conn.accountEmail };
  }

  // ─── F-10a: automatic state changes (REVOKED / THROTTLED) ───────────────────────────────────

  /** Revocation, pinned to the credential the provider rejected (`evidence`). */
  private async markRevoked(
    conn: MailboxConnection,
    reasonCode: MailboxStateChangeReason,
    lastError: string,
    evidence: Prisma.MailboxConnectionWhereInput,
  ): Promise<void> {
    await this.transition(conn, "REVOKED", reasonCode, { lastError }, evidence);
  }

  /**
   * A rate limit belongs to the MAILBOX that answered with it, so both writes are pinned to it
   * (`mailboxIdentity`): an admin who reconnected a different mailbox while this send was in
   * flight never inherits the throttle.
   */
  private async markThrottled(
    conn: MailboxConnection,
    throttledUntil: Date,
    lastError: string,
  ): Promise<void> {
    const sameMailbox = mailboxIdentity(conn);
    const changed = await this.transition(
      conn,
      "THROTTLED",
      "rate_limited",
      { lastError, throttledUntil },
      sameMailbox,
    );
    if (changed) return;
    // Not a state change: the connection was ALREADY THROTTLED (its window lapsed and this retry
    // was rate-limited again, or a concurrent send throttled it first). Extend the window so the
    // next sends skip the mailbox again — no audit row, no notification. REVOKED outranks
    // THROTTLED, so a revoked row is never touched here.
    await this.prisma.mailboxConnection
      .updateMany({
        where: { ...sameMailbox, id: conn.id, status: "THROTTLED" },
        data: { throttledUntil, lastError, lastErrorAt: new Date() },
      })
      .catch((err: unknown) => {
        this.logger.error(
          `Mailbox throttle window update failed for tenant ${conn.tenantId} (${errorLabel(err)})`,
        );
      });
  }

  /**
   * The ONE place a connection moves into REVOKED or THROTTLED on its own. One transaction holds
   * two writes that must stand or fall together:
   *   - a conditional `updateMany` — this row, only from an allowed previous state
   *     (`TRANSITION_FROM`), only while the evidence (the rejected credential / the rate-limited
   *     mailbox) is still the row's. Postgres re-checks that predicate under the row lock, so of N
   *     concurrent sends that detect the same revocation exactly one gets `count === 1`; every
   *     other detection — a race loser, a connection already in that state, one rebound since
   *     this send read it — writes nothing;
   *   - the transition's audit row, through `tx.auditLog.create` rather than `AuditService.log`
   *     (which swallows its own errors and has no transaction handle): if the audit write fails,
   *     the status change rolls back, so a connection never changes state without its record.
   * When the change warrants an alert, the same transaction also stamps `alertPendingAt` (#2113):
   * the alert is owed from the commit on, and `MailboxAlertOutbox` settles it exactly once.
   * The state change is emitted only after the commit (an AfterCommit queue), so no one is ever
   * told about a change that didn't happen. `lastError` / `lastErrorAt` are written by the winning update, with the same
   * messages as before F-10a. Returns whether this call made the transition. Never throws.
   */
  private async transition(
    conn: MailboxConnection,
    to: MailboxAlertStatus,
    reasonCode: MailboxStateChangeReason,
    fields: { lastError: string; throttledUntil?: Date },
    evidence: Prisma.MailboxConnectionWhereInput,
  ): Promise<boolean> {
    const throttledUntil = to === "THROTTLED" ? (fields.throttledUntil ?? null) : null;
    let outcome: { changed: boolean; alert: boolean };
    // #2113 (SA-528): the alert is emitted from an AfterCommit queue, so its claim can only run
    // once the transaction that owes it (alertPendingAt, below) has committed.
    const after = new AfterCommit();
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        after.reset();
        const { count } = await tx.mailboxConnection.updateMany({
          where: { ...evidence, id: conn.id, status: { in: TRANSITION_FROM[to] } },
          data: {
            status: to,
            lastError: fields.lastError,
            lastErrorAt: new Date(),
            ...(to === "THROTTLED" ? { throttledUntil } : {}),
          },
        });
        if (count !== 1) return { changed: false, alert: false };
        // Read before this transition's own row exists, so only an EARLIER rate limit mutes it.
        const alert = to === "REVOKED" || !(await this.throttledRecently(tx, conn.id));
        if (alert) {
          // #2113: owed until a deliverer clears it — a process death after the commit can no
          // longer lose it (the `mailbox-alert.sweepPending` job delivers it instead).
          const alertPendingAt = new Date();
          await tx.mailboxConnection.update({ where: { id: conn.id }, data: { alertPendingAt } });
          after.push(() =>
            this.emitStateChange({
              tenantId: conn.tenantId,
              connectionId: conn.id,
              provider: conn.provider,
              accountEmail: conn.accountEmail,
              status: to,
              reasonCode,
              throttledUntil,
              alertPendingAt,
            }),
          );
        }
        // Provider, account and a fixed reason vocabulary — never a token, code or secret.
        await tx.auditLog.create({
          data: {
            tenantId: conn.tenantId,
            userId: null,
            action: TRANSITION_AUDIT_ACTION[to],
            entityType: "mailbox_connection",
            entityId: conn.id,
            meta: { provider: conn.provider, accountEmail: conn.accountEmail, reasonCode },
          },
        });
        return { changed: true, alert };
      });
    } catch (err: unknown) {
      this.logger.error(
        `Mailbox ${to} transition failed for tenant ${conn.tenantId} (${errorLabel(err)}) — rolled back, nothing changed.`,
      );
      return false;
    }
    if (!outcome.changed) return false;

    this.logger.warn(
      `Mailbox for tenant ${conn.tenantId} is now ${to} (${conn.provider}, ${reasonCode}) — sends fall back to the next sender.`,
    );
    if (!outcome.alert) {
      this.logger.log(
        `Mailbox THROTTLED for tenant ${conn.tenantId}: it was already rate-limited within 24h, so its admins are not alerted again.`,
      );
      return true;
    }
    after.flush();
    return true;
  }

  /**
   * Whether this connection already had a THROTTLED transition within the alert window — alerted
   * or not, so a mailbox that keeps hitting its limit alerts once and then stays quiet until it
   * has gone a whole window without one. Uses the AuditLog (entityType, entityId) index.
   */
  private async throttledRecently(
    tx: Prisma.TransactionClient,
    connectionId: string,
  ): Promise<boolean> {
    const earlier = await tx.auditLog.findFirst({
      where: {
        entityType: "mailbox_connection",
        entityId: connectionId,
        action: TRANSITION_AUDIT_ACTION.THROTTLED,
        createdAt: { gte: new Date(Date.now() - THROTTLE_ALERT_WINDOW_MS) },
      },
      select: { id: true },
    });
    return earlier !== null;
  }

  private emitStateChange(change: MailboxStateChange): void {
    if (this.stateChangeListeners.size === 0) {
      this.logger.warn(
        // #2113: the alert is still owed (alertPendingAt, committed with the transition), so it is
        // delayed, not lost — `mailbox-alert.sweepPending` delivers it on its next tick.
        `Mailbox ${change.status} for tenant ${change.tenantId}: no subscriber — the admin alert stays owed and the sweep will deliver it.`,
      );
      return;
    }
    const failed = (err: unknown) =>
      this.logger.error(
        `Mailbox ${change.status} subscriber failed for tenant ${change.tenantId} (${errorLabel(err)})`,
      );
    for (const listener of this.stateChangeListeners) {
      try {
        void Promise.resolve(listener(change)).catch(failed);
      } catch (err: unknown) {
        failed(err);
      }
    }
  }
}
