import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { MailboxSendService } from "./mailbox-send.service";
import { EncryptionService } from "../../common/encryption.service";
import { withAdvisoryLock } from "../../common/db-locks";

jest.mock("axios");

jest.mock("../../common/db-locks", () => ({
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

const MS_GRAPH_SEND_MAIL_URL = "https://graph.microsoft.com/v1.0/me/sendMail";
const MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

/**
 * email-connect-microsoft PR-4 — mirrors mailbox-send.service.spec.ts's Google coverage for the
 * Microsoft/Graph path: sendMail gets a base64 MIME body with Content-Type text/plain, a
 * rotated refresh token is persisted, 429 throttles (Retry-After honoured), 401/403 revoke, and
 * REVOKED/THROTTLED/no-connection short-circuit before any HTTP call — same as Gmail.
 */
/** Every status any write tried to set — through update() OR updateMany(). A status now moves
 *  only through updateMany (F-10a), so a check over update() alone would pass vacuously. */
function statusWritesOf(prisma: any): string[] {
  return [
    ...(prisma.mailboxConnection.update as jest.Mock).mock.calls,
    ...(prisma.mailboxConnection.updateMany as jest.Mock).mock.calls,
  ]
    .map((c) => c[0].data.status)
    .filter((s) => s !== undefined);
}

describe("MailboxSendService — Microsoft/Graph", () => {
  function realEncryption(): EncryptionService {
    const config = {
      get: (k: string) => (k === "ENCRYPTION_KEY" ? "d".repeat(64) : undefined),
    } as unknown as ConfigService;
    return new EncryptionService(config);
  }

  function buildService(opts: { prisma?: any } = {}) {
    const config = {
      get: (k: string) =>
        ({
          MICROSOFT_MAILBOX_CLIENT_ID: "ms-client-id",
          MICROSOFT_MAILBOX_CLIENT_SECRET: "ms-client-secret",
        })[k],
    } as unknown as ConfigService;
    const encryption = realEncryption();
    const prisma = opts.prisma ?? {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    // F-10a: a state change and its audit row are written in one transaction; the stub's
    // transaction client is the stub itself.
    prisma.auditLog ??= {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
    };
    prisma.$transaction ??= jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
    const service = new MailboxSendService(prisma, encryption, config, {
      decide: jest.fn().mockResolvedValue({ outcome: "granted", overrides: new Map() }),
    } as any);
    return { service, prisma, encryption };
  }

  function connectedRow(overrides: Record<string, unknown> = {}, encryption?: EncryptionService) {
    const enc = encryption ?? realEncryption();
    return {
      id: "mc-1",
      tenantId: "tenant-a",
      provider: "MICROSOFT",
      accountEmail: "owner@acme.test",
      externalSubject: "ms-oid-1",
      status: "CONNECTED",
      throttledUntil: null,
      refreshTokenCipher: enc.encrypt("real-ms-refresh-token"),
      accessTokenCipher: enc.encrypt("cached-ms-access-token"),
      accessTokenExpiresAt: new Date(Date.now() + 3600_000), // valid, no refresh needed
      ...overrides,
    };
  }

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.useRealTimers());

  it("CONNECTED + valid cached token: sends via Graph sendMail with a base64 MIME body and text/plain Content-Type, never calls the token endpoint", async () => {
    const encryption = realEncryption();
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(connectedRow({}, encryption)),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    (axios.post as jest.Mock).mockImplementation((url: string) => {
      if (url === MS_GRAPH_SEND_MAIL_URL) return Promise.resolve({ data: "", status: 202 });
      throw new Error(`unexpected POST to ${url}`);
    });
    const { service } = buildService({ prisma });

    const res = await service.trySend("tenant-a", {
      to: "customer@example.com",
      subject: "Hi",
      html: "<p>hi</p>",
      fromName: "Acme Wholesale",
    });

    expect(res).toMatchObject({
      delivered: true,
      transport: "mailbox",
      fromAddress: "owner@acme.test",
    });
    expect(axios.post).toHaveBeenCalledTimes(1); // only the Graph send, no token refresh
    const [url, body, config] = (axios.post as jest.Mock).mock.calls[0];
    expect(url).toBe(MS_GRAPH_SEND_MAIL_URL);
    expect(config.headers["Content-Type"]).toBe("text/plain");
    expect(typeof body).toBe("string");
    // Standard base64 (Graph's raw-MIME sendMail contract) — never base64url like Gmail's.
    expect(body).not.toMatch(/[-_]/);
    const decoded = Buffer.from(body, "base64").toString("utf8");
    expect(decoded).toContain("Acme Wholesale <owner@acme.test>");
  });

  it("uses the withAdvisoryLock 'mailbox' family, keyed by tenantId, for the access-token refresh path", async () => {
    const encryption = realEncryption();
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(connectedRow({}, encryption)),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    (axios.post as jest.Mock).mockResolvedValue({ data: "", status: 202 });
    const { service } = buildService({ prisma });

    await service.trySend("tenant-a", { to: "x@y.com", subject: "s", html: "<p>h</p>" });

    expect(withAdvisoryLock).toHaveBeenCalledWith(
      expect.objectContaining({ family: "mailbox", key: "tenant-a" }),
      expect.any(Function),
    );
  });

  it("a successful send recovers a THROTTLED connection back to CONNECTED", async () => {
    const encryption = realEncryption();
    const prisma = {
      mailboxConnection: {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            connectedRow(
              { status: "THROTTLED", throttledUntil: new Date(Date.now() - 1000) },
              encryption,
            ),
          ),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    (axios.post as jest.Mock).mockResolvedValue({ data: "", status: 202 });
    const { service } = buildService({ prisma });

    const res = await service.trySend("tenant-a", {
      to: "x@y.com",
      subject: "s",
      html: "<p>h</p>",
    });

    expect(res).toMatchObject({ delivered: true, transport: "mailbox" });
    // F-10a: pinned to the mailbox that sent it, and only CONNECTED or a THROTTLED row whose
    // window has lapsed — never a concurrently REVOKED one, never an open throttle window.
    expect(prisma.mailboxConnection.updateMany).toHaveBeenCalledWith({
      where: {
        provider: "MICROSOFT",
        externalSubject: "ms-oid-1",
        id: "mc-1",
        OR: [
          { status: "CONNECTED" },
          { status: "THROTTLED", throttledUntil: null },
          { status: "THROTTLED", throttledUntil: { lte: expect.any(Date) } },
        ],
      },
      data: expect.objectContaining({ status: "CONNECTED", throttledUntil: null }),
    });
    expect(prisma.mailboxConnection.update).not.toHaveBeenCalled();
  });

  it("no connection for the tenant: returns delivered:false without any HTTP call", async () => {
    const { service } = buildService();
    const res = await service.trySend("tenant-a", {
      to: "x@y.com",
      subject: "s",
      html: "<p>h</p>",
    });
    expect(res).toEqual({ delivered: false, transport: "mailbox", error: "not_connected" });
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("REVOKED connection: falls through without calling Graph", async () => {
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(connectedRow({ status: "REVOKED" })),
      },
    };
    const { service } = buildService({ prisma });

    const res = await service.trySend("tenant-a", {
      to: "x@y.com",
      subject: "s",
      html: "<p>h</p>",
    });

    expect(res).toEqual({ delivered: false, transport: "mailbox", error: "revoked" });
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("THROTTLED and still within the window: falls through without calling Graph", async () => {
    const prisma = {
      mailboxConnection: {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            connectedRow({ status: "THROTTLED", throttledUntil: new Date(Date.now() + 60_000) }),
          ),
      },
    };
    const { service } = buildService({ prisma });

    const res = await service.trySend("tenant-a", {
      to: "x@y.com",
      subject: "s",
      html: "<p>h</p>",
    });

    expect(res).toEqual({ delivered: false, transport: "mailbox", error: "throttled" });
    expect(axios.post).not.toHaveBeenCalled();
  });

  // ── resolver fallthrough on 429 ────────────────────────────────────────────

  it("429 from Graph sets THROTTLED with throttledUntil ≈ now + Retry-After, and falls through", async () => {
    const encryption = realEncryption();
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(connectedRow({}, encryption)),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    (axios.post as jest.Mock).mockImplementation((url: string) => {
      if (url === MS_GRAPH_SEND_MAIL_URL) {
        const err: any = new Error("rate limited");
        err.response = { status: 429, headers: { "retry-after": "90" }, data: {} };
        return Promise.reject(err);
      }
      throw new Error(`unexpected POST to ${url}`);
    });
    const { service } = buildService({ prisma });

    // L-165: pin ONLY the Date clock (timers stay real) so the delta is exact, not a wall-clock window.
    jest.useFakeTimers({
      now: Date.now(), // pinned at the real "now" so token-expiry fixtures stay valid
      doNotFake: [
        "nextTick",
        "setImmediate",
        "setTimeout",
        "setInterval",
        "clearTimeout",
        "clearInterval",
        "queueMicrotask",
      ],
    });
    const before = Date.now();
    const res = await service.trySend("tenant-a", {
      to: "x@y.com",
      subject: "s",
      html: "<p>h</p>",
    });

    expect(res).toEqual({ delivered: false, transport: "mailbox", error: "throttled" });
    // F-10a: a conditional transition — only from CONNECTED, pinned to the rate-limited mailbox.
    expect(prisma.mailboxConnection.updateMany).toHaveBeenCalledWith({
      where: {
        provider: "MICROSOFT",
        externalSubject: "ms-oid-1",
        id: "mc-1",
        status: { in: ["CONNECTED"] },
      },
      data: expect.objectContaining({ status: "THROTTLED" }),
    });
    const throttledUntil: Date = (prisma.mailboxConnection.updateMany as jest.Mock).mock.calls[0][0]
      .data.throttledUntil;
    const deltaMs = throttledUntil.getTime() - before;
    expect(deltaMs).toBe(90_000);
  });

  // ── resolver fallthrough on 401 ─────────────────────────────────────────────

  it("401 from Graph sets REVOKED and falls through — never retried automatically", async () => {
    const encryption = realEncryption();
    const row = connectedRow({}, encryption);
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    (axios.post as jest.Mock).mockImplementation((url: string) => {
      if (url === MS_GRAPH_SEND_MAIL_URL) {
        const err: any = new Error("unauthorized");
        err.response = { status: 401, data: {} };
        return Promise.reject(err);
      }
      throw new Error(`unexpected POST to ${url}`);
    });
    const { service } = buildService({ prisma });

    const res = await service.trySend("tenant-a", {
      to: "x@y.com",
      subject: "s",
      html: "<p>h</p>",
    });

    expect(res).toEqual({ delivered: false, transport: "mailbox", error: "revoked" });
    // F-10a: a conditional transition, pinned to the access token Graph actually rejected.
    expect(prisma.mailboxConnection.updateMany).toHaveBeenCalledWith({
      where: {
        accessTokenCipher: row.accessTokenCipher,
        id: "mc-1",
        status: { in: ["CONNECTED", "THROTTLED"] },
      },
      data: expect.objectContaining({ status: "REVOKED" }),
    });
  });

  it("a 403 with NO error code falls through without revoking (superseded by the refined 403 handling below — only a token-type CODE revokes)", async () => {
    const encryption = realEncryption();
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(connectedRow({}, encryption)),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    (axios.post as jest.Mock).mockImplementation((url: string) => {
      if (url === MS_GRAPH_SEND_MAIL_URL) {
        const err: any = new Error("forbidden");
        err.response = { status: 403, data: {} };
        return Promise.reject(err);
      }
      throw new Error(`unexpected POST to ${url}`);
    });
    const { service } = buildService({ prisma });

    const res = await service.trySend("tenant-a", {
      to: "x@y.com",
      subject: "s",
      html: "<p>h</p>",
    });

    expect(res).toEqual({ delivered: false, transport: "mailbox", error: "graph_send_forbidden" });
    const statusWrites = statusWritesOf(prisma);
    expect(statusWrites).not.toContain("REVOKED");
  });

  // ── refresh rotates the refresh token (Microsoft-only behavior) ───────────

  it("access-token refresh persists Microsoft's ROTATED refresh token, not just the new access token", async () => {
    const encryption = realEncryption();
    const row = connectedRow(
      { accessTokenCipher: null, accessTokenExpiresAt: null }, // forces a refresh attempt
      encryption,
    );
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    (axios.post as jest.Mock).mockImplementation((url: string) => {
      if (url === MS_TOKEN_URL) {
        return Promise.resolve({
          data: {
            access_token: "new-access-token",
            refresh_token: "new-rotated-refresh-token",
            expires_in: 3600,
          },
        });
      }
      if (url === MS_GRAPH_SEND_MAIL_URL) return Promise.resolve({ data: "", status: 202 });
      throw new Error(`unexpected POST to ${url}`);
    });
    const { service } = buildService({ prisma });

    await service.trySend("tenant-a", { to: "x@y.com", subject: "s", html: "<p>h</p>" });

    const refreshUpdateCall = (prisma.mailboxConnection.update as jest.Mock).mock.calls.find(
      (c) => c[0].data.refreshTokenCipher,
    );
    expect(refreshUpdateCall).toBeTruthy();
    const decrypted = encryption.decrypt(refreshUpdateCall[0].data.refreshTokenCipher);
    expect(decrypted).toBe("new-rotated-refresh-token");
  });

  it("access-token refresh invalid_grant: sets REVOKED and falls through — Graph send is never called", async () => {
    const encryption = realEncryption();
    const row = connectedRow(
      { accessTokenCipher: null, accessTokenExpiresAt: null }, // forces a refresh attempt
      encryption,
    );
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    (axios.post as jest.Mock).mockImplementation((url: string) => {
      if (url === MS_TOKEN_URL) {
        const err: any = new Error("invalid_grant");
        err.response = { data: { error: "invalid_grant" } };
        return Promise.reject(err);
      }
      throw new Error(`unexpected POST to ${url}`);
    });
    const { service } = buildService({ prisma });

    const res = await service.trySend("tenant-a", {
      to: "x@y.com",
      subject: "s",
      html: "<p>h</p>",
    });

    expect(res).toMatchObject({ delivered: false, transport: "mailbox", error: "reauth_required" });
    // F-10a: a conditional transition from CONNECTED/THROTTLED, pinned to the rejected grant.
    expect(prisma.mailboxConnection.updateMany).toHaveBeenCalledWith({
      where: {
        refreshTokenCipher: row.refreshTokenCipher,
        id: "mc-1",
        status: { in: ["CONNECTED", "THROTTLED"] },
      },
      data: expect.objectContaining({ status: "REVOKED" }),
    });
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect((axios.post as jest.Mock).mock.calls[0][0]).toBe(MS_TOKEN_URL);
  });

  it("Graph 500 with no other transport configured downstream still returns {delivered:false}, never throws", async () => {
    const encryption = realEncryption();
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(connectedRow({}, encryption)),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    (axios.post as jest.Mock).mockImplementation((url: string) => {
      if (url === MS_GRAPH_SEND_MAIL_URL) {
        const err: any = new Error("internal error");
        err.response = { status: 500, data: {} };
        return Promise.reject(err);
      }
      throw new Error(`unexpected POST to ${url}`);
    });
    const { service } = buildService({ prisma });

    await expect(
      service.trySend("tenant-a", { to: "x@y.com", subject: "s", html: "<p>h</p>" }),
    ).resolves.toMatchObject({ delivered: false, transport: "mailbox" });
  });

  // ── refined 403 handling (Opus review, LOW) ─────────────────────────────────

  it("a 403 with an auth/token error code (e.g. InvalidAuthenticationToken) sets REVOKED", async () => {
    const encryption = realEncryption();
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(connectedRow({}, encryption)),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    (axios.post as jest.Mock).mockImplementation((url: string) => {
      if (url === MS_GRAPH_SEND_MAIL_URL) {
        const err: any = new Error("forbidden");
        err.response = {
          status: 403,
          data: { error: { code: "InvalidAuthenticationToken", message: "token expired" } },
        };
        return Promise.reject(err);
      }
      throw new Error(`unexpected POST to ${url}`);
    });
    const { service } = buildService({ prisma });

    const res = await service.trySend("tenant-a", {
      to: "x@y.com",
      subject: "s",
      html: "<p>h</p>",
    });

    expect(res).toEqual({ delivered: false, transport: "mailbox", error: "revoked" });
    expect(prisma.mailboxConnection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "REVOKED" }) }),
    );
  });

  it("a 403 with a mailbox-configuration error code (ErrorSendAsDenied) records lastError and falls through WITHOUT revoking", async () => {
    const encryption = realEncryption();
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(connectedRow({}, encryption)),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    (axios.post as jest.Mock).mockImplementation((url: string) => {
      if (url === MS_GRAPH_SEND_MAIL_URL) {
        const err: any = new Error("forbidden");
        err.response = {
          status: 403,
          data: {
            error: { code: "ErrorSendAsDenied", message: "Client does not have permissions" },
          },
        };
        return Promise.reject(err);
      }
      throw new Error(`unexpected POST to ${url}`);
    });
    const { service } = buildService({ prisma });

    const res = await service.trySend("tenant-a", {
      to: "x@y.com",
      subject: "s",
      html: "<p>h</p>",
    });

    expect(res).toEqual({ delivered: false, transport: "mailbox", error: "ErrorSendAsDenied" });
    expect(prisma.mailboxConnection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastError: expect.stringContaining("ErrorSendAsDenied") }),
      }),
    );
    // Never flipped to REVOKED — reconnecting would not fix a mailbox-configuration error.
    const statusWrites = statusWritesOf(prisma);
    expect(statusWrites).not.toContain("REVOKED");
  });

  it("a 403 with 'no Exchange mailbox' (MailboxNotEnabledForRESTAPI) also falls through WITHOUT revoking", async () => {
    const encryption = realEncryption();
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(connectedRow({}, encryption)),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    (axios.post as jest.Mock).mockImplementation((url: string) => {
      if (url === MS_GRAPH_SEND_MAIL_URL) {
        const err: any = new Error("forbidden");
        err.response = {
          status: 403,
          data: { error: { code: "MailboxNotEnabledForRESTAPI", message: "no mailbox" } },
        };
        return Promise.reject(err);
      }
      throw new Error(`unexpected POST to ${url}`);
    });
    const { service } = buildService({ prisma });

    const res = await service.trySend("tenant-a", {
      to: "x@y.com",
      subject: "s",
      html: "<p>h</p>",
    });

    expect(res).toEqual({
      delivered: false,
      transport: "mailbox",
      error: "MailboxNotEnabledForRESTAPI",
    });
    const statusWrites = statusWritesOf(prisma);
    expect(statusWrites).not.toContain("REVOKED");
  });

  // ── 4 MB Graph sendMail cap (Opus review, LOW) ──────────────────────────────

  it("a MIME message over Graph's 4 MB cap is never sent — falls through without calling Graph or touching status", async () => {
    const encryption = realEncryption();
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(connectedRow({}, encryption)),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const { service } = buildService({ prisma });

    // A ~4.5 MB html body forces the composed MIME buffer past the 4 MB cap.
    const hugeHtml = `<p>${"a".repeat(4.5 * 1024 * 1024)}</p>`;
    const res = await service.trySend("tenant-a", {
      to: "x@y.com",
      subject: "s",
      html: hugeHtml,
    });

    expect(res).toEqual({ delivered: false, transport: "mailbox", error: "message_too_large" });
    expect(axios.post).not.toHaveBeenCalledWith(
      MS_GRAPH_SEND_MAIL_URL,
      expect.anything(),
      expect.anything(),
    );
    const statusWrites = statusWritesOf(prisma);
    expect(statusWrites).toHaveLength(0);
  });
});
