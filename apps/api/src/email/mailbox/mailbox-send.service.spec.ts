import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { MailboxSendService } from "./mailbox-send.service";
import { EncryptionService } from "../../common/encryption.service";
import { withAdvisoryLock } from "../../common/db-locks";

jest.mock("axios");

// Pass-through mock — a single-process test has no real cross-replica contention to model,
// so this simply awaits `fn()` under the (unused) lock, mirroring addon.service.spec.ts's
// simplest mode. Kept as a real jest.fn() (not just an inline arrow) so tests can assert on
// the `family`/`key` it was called with (security review NIT #7).
jest.mock("../../common/db-locks", () => ({
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

describe("MailboxSendService", () => {
  function realEncryption(): EncryptionService {
    const config = {
      get: (k: string) => (k === "ENCRYPTION_KEY" ? "b".repeat(64) : undefined),
    } as unknown as ConfigService;
    return new EncryptionService(config);
  }

  function buildService(opts: { prisma?: any } = {}) {
    const config = {
      get: (k: string) =>
        ({
          GOOGLE_MAILBOX_CLIENT_ID: "client-id",
          GOOGLE_MAILBOX_CLIENT_SECRET: "client-secret",
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
      provider: "GOOGLE",
      accountEmail: "owner@acme.test",
      externalSubject: "google-sub-1",
      status: "CONNECTED",
      throttledUntil: null,
      refreshTokenCipher: enc.encrypt("real-refresh-token"),
      accessTokenCipher: enc.encrypt("cached-access-token"),
      accessTokenExpiresAt: new Date(Date.now() + 3600_000), // valid, no refresh needed
      ...overrides,
    };
  }

  beforeEach(() => jest.clearAllMocks());

  it("CONNECTED + valid cached token: sends via Gmail with From = accountEmail, never calls the token endpoint", async () => {
    const encryption = realEncryption();
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(connectedRow({}, encryption)),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    (axios.post as jest.Mock).mockImplementation((url: string) => {
      if (url === GMAIL_SEND_URL) return Promise.resolve({ data: { id: "gmail-msg-1" } });
      throw new Error(`unexpected POST to ${url}`);
    });
    const { service } = buildService({ prisma });

    const res = await service.trySend("tenant-a", {
      to: "customer@example.com",
      subject: "Hi",
      html: "<p>hi</p>",
      fromName: "Acme Wholesale",
    });

    expect(res).toMatchObject({ delivered: true, transport: "mailbox", id: "gmail-msg-1" });
    expect(axios.post).toHaveBeenCalledTimes(1); // only the Gmail send, no token refresh
    const [, body] = (axios.post as jest.Mock).mock.calls[0];
    expect(body.raw).toBeTruthy();
    const decoded = Buffer.from(body.raw, "base64").toString("utf8");
    expect(decoded).toContain("Acme Wholesale <owner@acme.test>");
  });

  it("uses the withAdvisoryLock 'mailbox' family, keyed by tenantId, for the access-token refresh path (security review NIT)", async () => {
    const encryption = realEncryption();
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(connectedRow({}, encryption)),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    (axios.post as jest.Mock).mockResolvedValue({ data: { id: "gmail-msg-1" } });
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
        findUnique: jest.fn().mockResolvedValue(
          connectedRow(
            // Throttle window already passed — trySend treats this as eligible-to-retry.
            { status: "THROTTLED", throttledUntil: new Date(Date.now() - 1000) },
            encryption,
          ),
        ),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    (axios.post as jest.Mock).mockImplementation((url: string) => {
      if (url === GMAIL_SEND_URL) return Promise.resolve({ data: { id: "gmail-msg-1" } });
      throw new Error(`unexpected POST to ${url}`);
    });
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
        provider: "GOOGLE",
        externalSubject: "google-sub-1",
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

  it("REVOKED connection: falls through without calling Gmail", async () => {
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

  it("THROTTLED and still within the window: falls through without calling Gmail", async () => {
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

  it("429 from Gmail sets THROTTLED with throttledUntil ≈ now + Retry-After, and falls through", async () => {
    const encryption = realEncryption();
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(connectedRow({}, encryption)),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    (axios.post as jest.Mock).mockImplementation((url: string) => {
      if (url === GMAIL_SEND_URL) {
        const err: any = new Error("rate limited");
        err.response = { status: 429, headers: { "retry-after": "120" }, data: {} };
        return Promise.reject(err);
      }
      throw new Error(`unexpected POST to ${url}`);
    });
    const { service } = buildService({ prisma });

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
        provider: "GOOGLE",
        externalSubject: "google-sub-1",
        id: "mc-1",
        status: { in: ["CONNECTED"] },
      },
      data: expect.objectContaining({ status: "THROTTLED" }),
    });
    const throttledUntil: Date = (prisma.mailboxConnection.updateMany as jest.Mock).mock.calls[0][0]
      .data.throttledUntil;
    const deltaMs = throttledUntil.getTime() - before;
    expect(deltaMs).toBeGreaterThan(115_000);
    expect(deltaMs).toBeLessThan(125_000);
  });

  it("access-token refresh invalid_grant: sets REVOKED and falls through — Gmail send is never called", async () => {
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
      if (url === GOOGLE_TOKEN_URL) {
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
    // Only the (failed) token refresh happened — never a Gmail send with no access token.
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect((axios.post as jest.Mock).mock.calls[0][0]).toBe(GOOGLE_TOKEN_URL);
  });

  it("Gmail 500 with no other transport configured downstream still returns {delivered:false}, never throws", async () => {
    const encryption = realEncryption();
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(connectedRow({}, encryption)),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    (axios.post as jest.Mock).mockImplementation((url: string) => {
      if (url === GMAIL_SEND_URL) {
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
});
