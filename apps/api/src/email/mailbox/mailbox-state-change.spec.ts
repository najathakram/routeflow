/**
 * F-10a (#2077) — the connected mailbox's AUTOMATIC state changes. Every place a send detects a
 * revoked or rate-limited mailbox moves the connection with ONE conditional update, and only the
 * send whose update wins it (count === 1) writes the audit row and emits the MailboxStateChange
 * that becomes the tenant-admin notification (MailboxAlertService). Pinned here, per detection
 * site:
 *   - the transition's exact query: this row, only from an allowed previous state, only while
 *     the evidence (the rejected credential / the rate-limited account) is still the row's;
 *   - exactly one `mailbox.revoked_detected` / `mailbox.throttled_detected` row, meta
 *     {provider, accountEmail, reasonCode} and nothing else;
 *   - exactly one emitted state change;
 *   - a repeat detection (count 0: a race loser, or a connection already in that state) writes
 *     no audit row and emits nothing;
 *   - the send still falls through (`delivered:false`) and `trySend` never throws;
 *   - no token, cipher or client secret reaches the audit row, the event, or any log line.
 * Real-Postgres concurrency (two sends, one row) lives in mailbox-state-change.db.spec.ts.
 */
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { inspect } from "util";
import { EncryptionService } from "../../common/encryption.service";
import { LockTimeoutError, withAdvisoryLock } from "../../common/db-locks";
import { MailboxSendService, type MailboxStateChange } from "./mailbox-send.service";

jest.mock("axios");

// Pass-through lock — a single process has no cross-replica contention to model. The real
// module is spread in so `LockTimeoutError` is the genuine class.
jest.mock("../../common/db-locks", () => ({
  ...jest.requireActual("../../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MS_GRAPH_SEND_MAIL_URL = "https://graph.microsoft.com/v1.0/me/sendMail";

/** Every secret the send path handles. None may reach an audit row, an event or a log line. */
const SECRET = {
  refreshToken: "rt-plain-0f3a91c4",
  accessToken: "at-plain-7c22e4b1",
  googleClientSecret: "google-client-secret-d41c77",
  msClientSecret: "ms-client-secret-8a0e53",
};

const encryption = new EncryptionService({
  get: (k: string) => (k === "ENCRYPTION_KEY" ? "e".repeat(64) : undefined),
} as unknown as ConfigService);

const config = {
  get: (k: string) =>
    ({
      GOOGLE_MAILBOX_CLIENT_ID: "google-client-id",
      GOOGLE_MAILBOX_CLIENT_SECRET: SECRET.googleClientSecret,
      MICROSOFT_MAILBOX_CLIENT_ID: "ms-client-id",
      MICROSOFT_MAILBOX_CLIENT_SECRET: SECRET.msClientSecret,
    })[k],
} as unknown as ConfigService;

type Provider = "GOOGLE" | "MICROSOFT";

function row(provider: Provider, over: Record<string, unknown> = {}) {
  return {
    id: "mc-1",
    tenantId: "tenant-a",
    provider,
    accountEmail: "sales@acme.test",
    externalSubject: "subject-acme-1",
    status: "CONNECTED",
    throttledUntil: null,
    refreshTokenCipher: encryption.encrypt(SECRET.refreshToken),
    accessTokenCipher: encryption.encrypt(SECRET.accessToken) as string | null,
    accessTokenExpiresAt: new Date(Date.now() + 3600_000) as Date | null,
    ...over,
  };
}
type Row = ReturnType<typeof row>;

/** No usable cached access token — forces `prepareSend` down the refresh path. */
const NEEDS_REFRESH = { accessTokenCipher: null, accessTokenExpiresAt: null };

function httpError(status: number, data: unknown, headers: Record<string, string> = {}) {
  const err: any = new Error(`Request failed with status code ${status}`);
  err.response = { status, data, headers };
  return err;
}

const unexpected = (url: string) => Promise.reject(new Error(`unexpected POST to ${url}`));

/**
 * `updateManyCounts` scripts what each successive `updateMany` returns: `[1]` = this send wins
 * the transition, `[0, …]` = the row is no longer in an allowed previous state (a concurrent send
 * already moved it, or it was already there).
 */
function build(conn: Row, updateManyCounts: number[] = [1]) {
  const counts = [...updateManyCounts];
  const prisma: any = {
    mailboxConnection: {
      findUnique: jest.fn().mockResolvedValue(conn),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockImplementation(async () => ({
        count: counts.length > 0 ? counts.shift() : 1,
      })),
    },
    // The transition's audit row is written in the same transaction as its status change; this
    // stub's transaction client is the stub itself.
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  prisma.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
  const service = new MailboxSendService(prisma, encryption, config, {
    decide: jest.fn().mockResolvedValue({ outcome: "granted", overrides: new Map() }),
  } as any);
  const changes: MailboxStateChange[] = [];
  const unsubscribe = service.onStateChange((c) => {
    changes.push(c);
  });
  /** Every audit row the service inserted. */
  const auditRows = (): Record<string, any>[] =>
    prisma.auditLog.create.mock.calls.map((c: any[]) => c[0].data);
  return { service, prisma, auditRows, changes, unsubscribe };
}

const send = (service: MailboxSendService) =>
  service.trySend("tenant-a", {
    to: "customer@example.test",
    subject: "Invoice INV-1001",
    html: "<p>Your invoice</p>",
  });

/** Every status an unconditional `update()` tried to set — a status must never move that way. */
const unconditionalStatusWrites = (prisma: ReturnType<typeof build>["prisma"]) =>
  prisma.mailboxConnection.update.mock.calls
    .map((c: any[]) => c[0].data.status)
    .filter((s: unknown) => s !== undefined);

/** Captures every Logger line (all levels), objects and errors rendered in full. */
function captureLogs() {
  const lines: string[] = [];
  const spies = (["log", "error", "warn", "debug", "verbose", "fatal"] as const)
    .filter((level) => typeof (Logger.prototype as any)[level] === "function")
    .map((level) =>
      jest.spyOn(Logger.prototype, level as "log").mockImplementation((...args: unknown[]) => {
        lines.push(
          args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 6 }))).join(" "),
        );
      }),
    );
  return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
}

interface Site {
  name: string;
  provider: Provider;
  rowOverrides: Record<string, unknown>;
  post: (url: string) => Promise<unknown>;
  status: "REVOKED" | "THROTTLED";
  reasonCode: string;
  sendError: string;
  lastError: string;
  evidence: (conn: Row) => Record<string, unknown>;
}

const SITES: Site[] = [
  {
    name: "Google token refresh: invalid_grant",
    provider: "GOOGLE",
    rowOverrides: NEEDS_REFRESH,
    post: (url) =>
      url === GOOGLE_TOKEN_URL
        ? Promise.reject(
            httpError(400, {
              error: "invalid_grant",
              error_description: "Token has been expired or revoked.",
            }),
          )
        : unexpected(url),
    status: "REVOKED",
    reasonCode: "google_invalid_grant",
    sendError: "reauth_required",
    lastError: "Google revoked access to this mailbox — reconnect required.",
    evidence: (c) => ({ refreshTokenCipher: c.refreshTokenCipher }),
  },
  {
    name: "Microsoft token refresh: invalid_grant",
    provider: "MICROSOFT",
    rowOverrides: NEEDS_REFRESH,
    post: (url) =>
      url === MS_TOKEN_URL
        ? Promise.reject(
            httpError(400, {
              error: "invalid_grant",
              error_description: "AADSTS70000: The provided grant has expired due to revocation.",
            }),
          )
        : unexpected(url),
    status: "REVOKED",
    reasonCode: "microsoft_invalid_grant",
    sendError: "reauth_required",
    lastError: "Microsoft revoked access to this mailbox — reconnect required.",
    evidence: (c) => ({ refreshTokenCipher: c.refreshTokenCipher }),
  },
  {
    name: "Microsoft token refresh: AADSTS70000x under another error code",
    provider: "MICROSOFT",
    rowOverrides: NEEDS_REFRESH,
    post: (url) =>
      url === MS_TOKEN_URL
        ? Promise.reject(
            httpError(400, {
              error: "unauthorized_client",
              error_description: "AADSTS700003: Device object was not found in the directory.",
            }),
          )
        : unexpected(url),
    status: "REVOKED",
    reasonCode: "microsoft_aadsts",
    sendError: "reauth_required",
    lastError: "Microsoft revoked access to this mailbox — reconnect required.",
    evidence: (c) => ({ refreshTokenCipher: c.refreshTokenCipher }),
  },
  {
    name: "Graph sendMail: 401",
    provider: "MICROSOFT",
    rowOverrides: {},
    post: (url) =>
      url === MS_GRAPH_SEND_MAIL_URL
        ? Promise.reject(
            httpError(401, {
              error: { code: "InvalidAuthenticationToken", message: "Access token has expired." },
            }),
          )
        : unexpected(url),
    status: "REVOKED",
    reasonCode: "graph_401",
    sendError: "revoked",
    lastError: "Microsoft rejected the send — reconnect required.",
    evidence: (c) => ({ accessTokenCipher: c.accessTokenCipher }),
  },
  {
    name: "Graph sendMail: 403 with a token error code",
    provider: "MICROSOFT",
    rowOverrides: {},
    post: (url) =>
      url === MS_GRAPH_SEND_MAIL_URL
        ? Promise.reject(
            httpError(403, {
              error: { code: "InvalidAuthenticationToken", message: "Consent was revoked." },
            }),
          )
        : unexpected(url),
    status: "REVOKED",
    reasonCode: "graph_403",
    sendError: "revoked",
    lastError: "Microsoft rejected the send — reconnect required.",
    evidence: (c) => ({ accessTokenCipher: c.accessTokenCipher }),
  },
  {
    name: "Gmail send: 429",
    provider: "GOOGLE",
    rowOverrides: {},
    post: (url) =>
      url === GMAIL_SEND_URL
        ? Promise.reject(httpError(429, {}, { "retry-after": "120" }))
        : unexpected(url),
    status: "THROTTLED",
    reasonCode: "rate_limited",
    sendError: "throttled",
    lastError: "Rate-limited by Google — falling back to the next sender.",
    evidence: (c) => ({ provider: c.provider, externalSubject: c.externalSubject }),
  },
  {
    name: "Gmail send: 403 rateLimitExceeded",
    provider: "GOOGLE",
    rowOverrides: {},
    post: (url) =>
      url === GMAIL_SEND_URL
        ? Promise.reject(httpError(403, { error: { errors: [{ reason: "rateLimitExceeded" }] } }))
        : unexpected(url),
    status: "THROTTLED",
    reasonCode: "rate_limited",
    sendError: "throttled",
    lastError: "Rate-limited by Google — falling back to the next sender.",
    evidence: (c) => ({ provider: c.provider, externalSubject: c.externalSubject }),
  },
  {
    name: "Gmail send: 403 dailyLimitExceeded",
    provider: "GOOGLE",
    rowOverrides: {},
    post: (url) =>
      url === GMAIL_SEND_URL
        ? Promise.reject(httpError(403, { error: { errors: [{ reason: "dailyLimitExceeded" }] } }))
        : unexpected(url),
    status: "THROTTLED",
    reasonCode: "rate_limited",
    sendError: "throttled",
    lastError: "Rate-limited by Google — falling back to the next sender.",
    evidence: (c) => ({ provider: c.provider, externalSubject: c.externalSubject }),
  },
  {
    name: "Graph sendMail: 429",
    provider: "MICROSOFT",
    rowOverrides: {},
    post: (url) =>
      url === MS_GRAPH_SEND_MAIL_URL
        ? Promise.reject(httpError(429, {}, { "retry-after": "30" }))
        : unexpected(url),
    status: "THROTTLED",
    reasonCode: "rate_limited",
    sendError: "throttled",
    lastError: "Rate-limited by Microsoft — falling back to the next sender.",
    evidence: (c) => ({ provider: c.provider, externalSubject: c.externalSubject }),
  },
];

const ALLOWED_FROM = { REVOKED: ["CONNECTED", "THROTTLED"], THROTTLED: ["CONNECTED"] };
const AUDIT_ACTION = {
  REVOKED: "mailbox.revoked_detected",
  THROTTLED: "mailbox.throttled_detected",
};

beforeEach(() => jest.clearAllMocks());

describe.each(SITES)("F-10a detection site — $name", (site) => {
  it("moves the connection with ONE conditional update, writes ONE audit row, emits ONE state change, and the send still falls through", async () => {
    const conn = row(site.provider, site.rowOverrides);
    (axios.post as jest.Mock).mockImplementation(site.post);
    const { service, prisma, auditRows, changes } = build(conn, [1]);

    const res = await send(service);

    expect(res).toEqual({ delivered: false, transport: "mailbox", error: site.sendError });
    expect(prisma.mailboxConnection.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.mailboxConnection.updateMany).toHaveBeenCalledWith({
      where: { ...site.evidence(conn), id: "mc-1", status: { in: ALLOWED_FROM[site.status] } },
      data: {
        status: site.status,
        lastError: site.lastError,
        lastErrorAt: expect.any(Date),
        ...(site.status === "THROTTLED" ? { throttledUntil: expect.any(Date) } : {}),
      },
    });
    expect(unconditionalStatusWrites(prisma)).toEqual([]);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(auditRows()).toEqual([
      {
        tenantId: "tenant-a",
        userId: null,
        action: AUDIT_ACTION[site.status],
        entityType: "mailbox_connection",
        entityId: "mc-1",
        meta: {
          provider: site.provider,
          accountEmail: "sales@acme.test",
          reasonCode: site.reasonCode,
        },
      },
    ]);

    expect(changes).toEqual([
      {
        tenantId: "tenant-a",
        connectionId: "mc-1",
        provider: site.provider,
        accountEmail: "sales@acme.test",
        status: site.status,
        reasonCode: site.reasonCode,
        throttledUntil: site.status === "THROTTLED" ? expect.any(Date) : null,
        alertPendingAt: expect.any(Date), // #2113: the value the same tx stamped
      },
    ]);
  });

  it("a repeat detection — the row is no longer in an allowed previous state (count 0) — writes no audit row and emits nothing", async () => {
    const conn = row(site.provider, site.rowOverrides);
    (axios.post as jest.Mock).mockImplementation(site.post);
    const { service, auditRows, changes } = build(conn, [0, 0]);

    const res = await send(service);

    expect(res).toEqual({ delivered: false, transport: "mailbox", error: site.sendError });
    expect(auditRows()).toEqual([]);
    expect(changes).toEqual([]);
  });

  it("no token, cipher or client secret reaches the audit row, the emitted change, or any log line", async () => {
    const logs = captureLogs();
    try {
      const conn = row(site.provider, site.rowOverrides);
      (axios.post as jest.Mock).mockImplementation(site.post);
      const { service, auditRows, changes } = build(conn, [1]);

      await send(service);

      expect(auditRows()).toHaveLength(1);
      expect(Object.keys(auditRows()[0].meta).sort()).toEqual([
        "accountEmail",
        "provider",
        "reasonCode",
      ]);
      expect(changes).toHaveLength(1);
      expect(Object.keys(changes[0]).sort()).toEqual([
        "accountEmail",
        "alertPendingAt",
        "connectionId",
        "provider",
        "reasonCode",
        "status",
        "tenantId",
        "throttledUntil",
      ]);
      // The transition itself logs, so this can never pass on an empty capture.
      expect(logs.lines.length).toBeGreaterThan(0);
      const everything = [inspect(auditRows(), { depth: 6 }), inspect(changes), ...logs.lines];
      const secrets = [
        SECRET.refreshToken,
        SECRET.accessToken,
        SECRET.googleClientSecret,
        SECRET.msClientSecret,
        conn.refreshTokenCipher,
        ...(conn.accessTokenCipher ? [conn.accessTokenCipher] : []),
      ];
      for (const text of everything) {
        for (const secret of secrets) expect(text).not.toContain(secret);
      }
    } finally {
      logs.restore();
    }
  });
});

describe("F-10a — state machine edges", () => {
  it("a THROTTLED mailbox can still be revoked: THROTTLED → REVOKED is a new state, audited once", async () => {
    const conn = row("MICROSOFT", {
      status: "THROTTLED",
      throttledUntil: new Date(Date.now() - 1000),
    });
    (axios.post as jest.Mock).mockImplementation(SITES[3].post); // Graph 401
    const { service, prisma, auditRows, changes } = build(conn, [1]);

    await send(service);

    expect(prisma.mailboxConnection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ["CONNECTED", "THROTTLED"] } }),
        data: expect.objectContaining({ status: "REVOKED" }),
      }),
    );
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0].action).toBe("mailbox.revoked_detected");
    expect(changes.map((c) => c.status)).toEqual(["REVOKED"]);
  });

  it("a repeat 429 on an already-THROTTLED mailbox extends its window — no audit row, no notification", async () => {
    const conn = row("GOOGLE", {
      status: "THROTTLED",
      throttledUntil: new Date(Date.now() - 1000),
    });
    (axios.post as jest.Mock).mockImplementation(SITES[5].post); // Gmail 429, Retry-After 120
    const { service, prisma, auditRows, changes } = build(conn, [0, 1]);

    const before = Date.now();
    const res = await send(service);

    expect(res).toEqual({ delivered: false, transport: "mailbox", error: "throttled" });
    expect(prisma.mailboxConnection.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.mailboxConnection.updateMany.mock.calls[1][0]).toEqual({
      where: {
        provider: "GOOGLE",
        externalSubject: "subject-acme-1",
        id: "mc-1",
        status: "THROTTLED",
      },
      data: {
        throttledUntil: expect.any(Date),
        lastError: "Rate-limited by Google — falling back to the next sender.",
        lastErrorAt: expect.any(Date),
      },
    });
    const extendedUntil: Date =
      prisma.mailboxConnection.updateMany.mock.calls[1][0].data.throttledUntil;
    expect(extendedUntil.getTime() - before).toBeGreaterThan(115_000);
    expect(extendedUntil.getTime() - before).toBeLessThan(125_000);
    expect(auditRows()).toEqual([]);
    expect(changes).toEqual([]);
  });

  it("a 429 never demotes a REVOKED mailbox: neither write can match a REVOKED row", async () => {
    const conn = row("GOOGLE");
    (axios.post as jest.Mock).mockImplementation(SITES[5].post); // Gmail 429
    const { service, prisma, auditRows, changes } = build(conn, [0, 0]); // a concurrent send revoked it

    await send(service);

    const wheres = prisma.mailboxConnection.updateMany.mock.calls.map((c: any[]) => c[0].where);
    expect(wheres).toHaveLength(2);
    for (const where of wheres) expect(JSON.stringify(where.status)).not.toContain("REVOKED");
    expect(auditRows()).toEqual([]);
    expect(changes).toEqual([]);
  });

  it("once REVOKED, later sends reach neither the provider nor the audit log (issue #2077: nothing new)", async () => {
    const conn = row("MICROSOFT");
    (axios.post as jest.Mock).mockImplementation(SITES[3].post); // Graph 401
    const { service, prisma, auditRows, changes } = build(conn, [1]);

    await send(service);
    prisma.mailboxConnection.findUnique.mockResolvedValue({ ...conn, status: "REVOKED" });
    const second = await send(service);
    const third = await send(service);

    expect(second).toEqual({ delivered: false, transport: "mailbox", error: "revoked" });
    expect(third).toEqual(second);
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(prisma.mailboxConnection.updateMany).toHaveBeenCalledTimes(1);
    expect(auditRows()).toHaveLength(1);
    expect(changes).toHaveLength(1);
  });
});

describe("F-10a — trySend never throws", () => {
  it("an advisory-lock timeout falls through as delivered:false", async () => {
    (withAdvisoryLock as jest.Mock).mockRejectedValueOnce(
      new LockTimeoutError("mailbox", "tenant-a", 10_000),
    );
    const { service, auditRows } = build(row("GOOGLE"));

    await expect(send(service)).resolves.toEqual({
      delivered: false,
      transport: "mailbox",
      error: "mailbox_unavailable",
    });
    expect(auditRows()).toEqual([]);
  });

  it("a database error reading the connection falls through as delivered:false", async () => {
    const { service, prisma } = build(row("GOOGLE"));
    prisma.mailboxConnection.findUnique.mockRejectedValueOnce(new Error("connection terminated"));

    await expect(send(service)).resolves.toMatchObject({ delivered: false, transport: "mailbox" });
  });

  it("an undecryptable stored token falls through as delivered:false", async () => {
    const { service } = build(row("GOOGLE", { accessTokenCipher: "not:a:cipher" }));

    await expect(send(service)).resolves.toMatchObject({ delivered: false, transport: "mailbox" });
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("a failed transition write falls through with no audit row, no notification — and never logs the query (it carries a cipher)", async () => {
    const logs = captureLogs();
    try {
      const conn = row("MICROSOFT");
      (axios.post as jest.Mock).mockImplementation(SITES[3].post); // Graph 401
      const { service, prisma, auditRows, changes } = build(conn);
      // A Prisma error message can echo the query's arguments, including the pinned cipher.
      prisma.mailboxConnection.updateMany.mockRejectedValueOnce(
        Object.assign(
          new Error(`Invalid invocation: accessTokenCipher: "${conn.accessTokenCipher}"`),
          {
            code: "P2024",
          },
        ),
      );

      const res = await send(service);

      expect(res).toEqual({ delivered: false, transport: "mailbox", error: "revoked" });
      expect(auditRows()).toEqual([]);
      expect(changes).toEqual([]);
      expect(logs.lines.some((l) => l.includes("REVOKED transition failed"))).toBe(true);
      for (const line of logs.lines) expect(line).not.toContain(conn.accessTokenCipher as string);
    } finally {
      logs.restore();
    }
  });

  it("a subscriber that throws or rejects never reaches the send, and the other subscribers still run", async () => {
    const conn = row("MICROSOFT");
    (axios.post as jest.Mock).mockImplementation(SITES[3].post); // Graph 401
    const { service, changes } = build(conn, [1]);
    service.onStateChange(() => {
      throw new Error("subscriber blew up");
    });
    service.onStateChange(async () => {
      throw new Error("subscriber rejected");
    });
    const late = jest.fn();
    service.onStateChange(late);

    await expect(send(service)).resolves.toEqual({
      delivered: false,
      transport: "mailbox",
      error: "revoked",
    });
    expect(changes).toHaveLength(1);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("with no subscriber the transition is still made and audited, and the missing notification is logged", async () => {
    const logs = captureLogs();
    try {
      const conn = row("MICROSOFT");
      (axios.post as jest.Mock).mockImplementation(SITES[3].post); // Graph 401
      const { service, auditRows, changes, unsubscribe } = build(conn, [1]);
      unsubscribe();

      await send(service);

      expect(auditRows()).toHaveLength(1);
      expect(changes).toEqual([]);
      expect(logs.lines.some((l) => l.includes("no subscriber"))).toBe(true);
    } finally {
      logs.restore();
    }
  });
});
