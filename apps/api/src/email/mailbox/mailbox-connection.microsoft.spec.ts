import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { MailboxConnectionService } from "./mailbox-connection.service";
import { EncryptionService } from "../../common/encryption.service";
import { withAdvisoryLock } from "../../common/db-locks";

jest.mock("axios");

// Pass-through mock — see mailbox-connection.service.spec.ts's identical header for why.
jest.mock("../../common/db-locks", () => ({
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

const MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MS_GRAPH_ME_URL = "https://graph.microsoft.com/v1.0/me";

const GOOD_TOKENS = {
  access_token: "at-1",
  refresh_token: "rt-1",
  expires_in: 3600,
  scope:
    "https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read offline_access",
};
const GOOD_ME = { id: "ms-oid-1", mail: "owner@acme.test", userPrincipalName: "owner@acme.test" };

/**
 * email-connect-microsoft PR-4 — mirrors mailbox-connection.service.spec.ts's Google coverage
 * for the Microsoft path: state + PKCE, a missing Mail.Send scope rejected, ciphertext-at-rest,
 * the two-step account-binding split (confirmConnect is shared code — proven here for provider
 * MICROSOFT specifically), tenant isolation, and admin-consent-required (AADSTS65001) handling.
 */
describe("MailboxConnectionService — Microsoft", () => {
  function realEncryption(): EncryptionService {
    const config = {
      get: (k: string) => (k === "ENCRYPTION_KEY" ? "c".repeat(64) : undefined),
    } as unknown as ConfigService;
    return new EncryptionService(config);
  }

  function makeMockRedis() {
    const store = new Map<string, string>();
    return {
      set: jest.fn(async (key: string, val: string) => {
        store.set(key, val);
        return "OK";
      }),
      getdel: jest.fn(async (key: string) => {
        const v = store.has(key) ? store.get(key)! : null;
        store.delete(key);
        return v;
      }),
      eval: jest.fn(async () => null),
      on: jest.fn(),
      disconnect: jest.fn(),
      _store: store,
    };
  }

  function buildService(opts: { prisma?: any; audit?: any; encryption?: EncryptionService } = {}) {
    const config = {
      get: (k: string) =>
        ({
          MICROSOFT_MAILBOX_CLIENT_ID: "ms-client-id",
          MICROSOFT_MAILBOX_CLIENT_SECRET: "ms-client-secret",
          MICROSOFT_MAILBOX_REDIRECT_URI: "https://api.example.com/microsoft/callback",
        })[k],
    } as unknown as ConfigService;
    const prisma = opts.prisma ?? {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    };
    const audit = opts.audit ?? { log: jest.fn().mockResolvedValue(undefined) };
    const encryption = opts.encryption ?? realEncryption();
    const service = new MailboxConnectionService(prisma, encryption, audit, config);
    const mockRedis = makeMockRedis();
    (service as any).redis = mockRedis;
    return { service, mockRedis, prisma, audit, encryption };
  }

  /** Runs a full startConnectMicrosoft -> handleMicrosoftCallback pair, returning confirmToken. */
  async function connectThroughMicrosoftCallback(
    service: MailboxConnectionService,
    tenantId = "tenant-a",
    userId = "user-1",
    tokens: Record<string, unknown> = GOOD_TOKENS,
    me: Record<string, unknown> = GOOD_ME,
  ): Promise<string> {
    (axios.post as jest.Mock).mockImplementation((url: string) => {
      if (url === MS_TOKEN_URL) return Promise.resolve({ data: tokens });
      throw new Error(`unexpected POST ${url}`);
    });
    (axios.get as jest.Mock).mockImplementation((url: string) => {
      if (url === MS_GRAPH_ME_URL) return Promise.resolve({ data: me });
      throw new Error(`unexpected GET ${url}`);
    });

    const url = await service.startConnectMicrosoft(tenantId, userId);
    const state = new URL(url).searchParams.get("state")!;
    const { confirmToken } = await service.handleMicrosoftCallback("code-1", state);
    return confirmToken;
  }

  beforeEach(() => jest.clearAllMocks());

  // ── state + PKCE ──────────────────────────────────────────────────────────

  it("startConnectMicrosoft builds an authorize URL with an S256 code_challenge and persists the verifier under the state nonce", async () => {
    const { service, mockRedis } = buildService();

    const url = await service.startConnectMicrosoft("tenant-a", "user-1");
    const parsed = new URL(url);

    expect(parsed.origin + parsed.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("code_challenge")).toBeTruthy();
    expect(parsed.searchParams.get("scope")).toContain("Mail.Send");
    expect(parsed.searchParams.get("response_type")).toBe("code");

    expect(mockRedis.set).toHaveBeenCalledTimes(1);
    const [, storedJson, , ttl] = mockRedis.set.mock.calls[0];
    const stored = JSON.parse(storedJson);
    expect(stored).toMatchObject({ tenantId: "tenant-a", userId: "user-1", provider: "MICROSOFT" });
    expect(typeof stored.verifier).toBe("string");
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it("startConnectMicrosoft 503s when the Microsoft mailbox client isn't configured", async () => {
    const { service } = buildService();
    (service as any).config = { get: () => undefined };

    await expect(service.startConnectMicrosoft("tenant-a", "user-1")).rejects.toMatchObject({
      status: 503,
    });
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("rejects a tampered/unknown state with 400 — the token exchange is never attempted", async () => {
    const { service } = buildService();

    await expect(
      service.handleMicrosoftCallback("some-code", "nonce-that-was-never-minted"),
    ).rejects.toThrow(BadRequestException);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("rejects a missing code or state with 400 before touching Redis or Microsoft", async () => {
    const { service, mockRedis } = buildService();

    await expect(service.handleMicrosoftCallback("", "some-state")).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.handleMicrosoftCallback("some-code", "")).rejects.toThrow(
      BadRequestException,
    );
    expect(mockRedis.getdel).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("a REPLAYED oauth state (used once already) is rejected the second time — single-use via GETDEL", async () => {
    const { service } = buildService();
    (axios.post as jest.Mock).mockImplementation((url: string) => {
      if (url === MS_TOKEN_URL) return Promise.resolve({ data: GOOD_TOKENS });
      throw new Error(`unexpected POST ${url}`);
    });
    (axios.get as jest.Mock).mockResolvedValue({ data: GOOD_ME });

    const url = await service.startConnectMicrosoft("tenant-a", "user-1");
    const state = new URL(url).searchParams.get("state")!;

    await service.handleMicrosoftCallback("code-1", state);
    expect(axios.post).toHaveBeenCalledTimes(1);

    await expect(service.handleMicrosoftCallback("code-1", state)).rejects.toThrow(
      BadRequestException,
    );
    expect(axios.post).toHaveBeenCalledTimes(1); // still 1, not 2
  });

  it("passes the stored PKCE verifier as code_verifier to the token exchange", async () => {
    const { service } = buildService();
    (axios.post as jest.Mock).mockImplementation((url: string) => {
      if (url === MS_TOKEN_URL) return Promise.resolve({ data: GOOD_TOKENS });
      throw new Error(`unexpected POST ${url}`);
    });
    (axios.get as jest.Mock).mockResolvedValue({ data: GOOD_ME });

    const url = await service.startConnectMicrosoft("tenant-a", "user-1");
    const state = new URL(url).searchParams.get("state")!;
    await service.handleMicrosoftCallback("code-1", state);

    const [, body] = (axios.post as jest.Mock).mock.calls[0];
    const sent = new URLSearchParams(body as string);
    expect(sent.get("code")).toBe("code-1");
    expect(sent.get("code_verifier")).toBeTruthy();
    expect(sent.get("grant_type")).toBe("authorization_code");
  });

  it("rejects the callback when Microsoft didn't grant a refresh token (no offline access)", async () => {
    const { service } = buildService();
    (axios.post as jest.Mock).mockResolvedValue({ data: { access_token: "at-1" } });

    const url = await service.startConnectMicrosoft("tenant-a", "user-1");
    const state = new URL(url).searchParams.get("state")!;

    await expect(service.handleMicrosoftCallback("code-1", state)).rejects.toThrow(
      BadRequestException,
    );
  });

  it("rejects the callback when the granted scopes don't include Mail.Send", async () => {
    const { service } = buildService();
    (axios.post as jest.Mock).mockResolvedValue({
      data: {
        ...GOOD_TOKENS,
        scope: "https://graph.microsoft.com/User.Read offline_access", // Mail.Send missing
      },
    });

    const url = await service.startConnectMicrosoft("tenant-a", "user-1");
    const state = new URL(url).searchParams.get("state")!;

    await expect(service.handleMicrosoftCallback("code-1", state)).rejects.toThrow(
      BadRequestException,
    );
    expect(axios.get).not.toHaveBeenCalled(); // never reaches the Graph /me lookup
  });

  it("rejects the callback with a distinct error when the org requires admin consent (AADSTS65001)", async () => {
    const { service } = buildService();
    (axios.post as jest.Mock).mockImplementation((url: string) => {
      if (url === MS_TOKEN_URL) {
        const err: any = new Error("consent required");
        err.response = {
          data: {
            error: "invalid_grant",
            error_description:
              "AADSTS65001: The user or administrator has not consented to use the application.",
          },
        };
        return Promise.reject(err);
      }
      throw new Error(`unexpected POST ${url}`);
    });

    const url = await service.startConnectMicrosoft("tenant-a", "user-1");
    const state = new URL(url).searchParams.get("state")!;

    await expect(service.handleMicrosoftCallback("code-1", state)).rejects.toMatchObject({
      message: "microsoft_admin_consent_required",
    });
  });

  it("handleMicrosoftCallback never touches the database — it only mints a pending-grant confirm token", async () => {
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    };
    const { service } = buildService({ prisma });

    const confirmToken = await connectThroughMicrosoftCallback(service);

    expect(typeof confirmToken).toBe("string");
    expect(confirmToken.length).toBeGreaterThan(20);
    expect(prisma.mailboxConnection.findUnique).not.toHaveBeenCalled();
    expect(prisma.mailboxConnection.upsert).not.toHaveBeenCalled();
  });

  // ── confirmConnect: shared code, proven here for provider MICROSOFT ───────

  it("confirmConnect binds a MICROSOFT row when the confirming JWT matches who started the connect", async () => {
    let savedData: any;
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockImplementation(({ create }) => {
          savedData = create;
          return Promise.resolve({
            id: "mc-1",
            accountEmail: "owner@acme.test",
            provider: "MICROSOFT",
          });
        }),
      },
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const { service } = buildService({ prisma, audit });

    const confirmToken = await connectThroughMicrosoftCallback(service, "tenant-a", "user-1");
    const view = await service.confirmConnect(confirmToken, "user-1", "tenant-a");

    expect(view).toMatchObject({
      connected: true,
      accountEmail: "owner@acme.test",
      provider: "MICROSOFT",
    });
    expect(savedData.provider).toBe("MICROSOFT");
    expect(savedData.externalSubject).toBe("ms-oid-1");
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "mailbox.connected",
        meta: expect.objectContaining({ provider: "MICROSOFT" }),
      }),
    );
  });

  it("confirmConnect 403s when the confirming JWT's userId doesn't match who started the Microsoft connect — no row is written", async () => {
    const prisma = {
      mailboxConnection: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
    };
    const { service } = buildService({ prisma });

    const confirmToken = await connectThroughMicrosoftCallback(service, "tenant-a", "user-1");

    await expect(service.confirmConnect(confirmToken, "user-2", "tenant-a")).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.mailboxConnection.upsert).not.toHaveBeenCalled();
  });

  it("confirmConnect 403s when the confirming JWT's tenantId doesn't match who started the Microsoft connect — no row is written", async () => {
    const prisma = {
      mailboxConnection: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
    };
    const { service } = buildService({ prisma });

    const confirmToken = await connectThroughMicrosoftCallback(service, "tenant-a", "user-1");

    await expect(service.confirmConnect(confirmToken, "user-1", "tenant-b")).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.mailboxConnection.upsert).not.toHaveBeenCalled();
  });

  it("a REPLAYED Microsoft confirm token (used once already) is rejected the second time", async () => {
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: "mc-1", accountEmail: "owner@acme.test" }),
      },
    };
    const { service } = buildService({ prisma });

    const confirmToken = await connectThroughMicrosoftCallback(service, "tenant-a", "user-1");

    await service.confirmConnect(confirmToken, "user-1", "tenant-a");
    await expect(service.confirmConnect(confirmToken, "user-1", "tenant-a")).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.mailboxConnection.upsert).toHaveBeenCalledTimes(1);
  });

  // ── ciphertext-at-rest ────────────────────────────────────────────────────

  it("confirmConnect stores the Microsoft refresh/access tokens ONLY as EncryptionService ciphertext, never plaintext", async () => {
    let savedData: any;
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockImplementation(({ create }) => {
          savedData = create;
          return Promise.resolve({ id: "mc-1", accountEmail: "owner@acme.test" });
        }),
      },
    };
    const { service } = buildService({ prisma });

    const confirmToken = await connectThroughMicrosoftCallback(service, "tenant-a", "user-1", {
      ...GOOD_TOKENS,
      refresh_token: "super-secret-ms-refresh-token",
      access_token: "super-secret-ms-access-token",
    });
    await service.confirmConnect(confirmToken, "user-1", "tenant-a");

    const CIPHERTEXT_FORMAT = /^[0-9a-f]{32}:[0-9a-f]{32}:[A-Za-z0-9+/=]+$/;
    expect(savedData.refreshTokenCipher).toMatch(CIPHERTEXT_FORMAT);
    expect(savedData.refreshTokenCipher).not.toContain("super-secret-ms-refresh-token");
    expect(savedData.accessTokenCipher).toMatch(CIPHERTEXT_FORMAT);
    expect(savedData.accessTokenCipher).not.toContain("super-secret-ms-access-token");
  });

  // ── DTO/response never carries a token ────────────────────────────────────

  it("MailboxStatusView for a MICROSOFT row has no key matching /token/i", async () => {
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue({
          id: "mc-a",
          provider: "MICROSOFT",
          accountEmail: "a@acme.test",
          status: "CONNECTED",
          refreshTokenCipher: "iv:tag:ct",
          accessTokenCipher: "iv:tag:ct2",
          throttledUntil: null,
          lastError: null,
          lastSentAt: null,
        }),
      },
    };
    const { service } = buildService({ prisma });

    const view = await service.getStatus("tenant-a");

    for (const key of Object.keys(view)) {
      expect(key).not.toMatch(/token/i);
    }
    expect(JSON.stringify(view)).not.toMatch(/refreshTokenCipher|accessTokenCipher|iv:tag:ct/);
  });

  // ── tenant isolation ──────────────────────────────────────────────────────

  it("getStatus only ever queries the CALLER's own tenantId for a Microsoft row too", async () => {
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue({
          id: "mc-a",
          provider: "MICROSOFT",
          accountEmail: "a@acme.test",
          status: "CONNECTED",
          throttledUntil: null,
          lastError: null,
          lastSentAt: null,
        }),
      },
    };
    const { service } = buildService({ prisma });

    await service.getStatus("tenant-a");
    expect(prisma.mailboxConnection.findUnique).toHaveBeenCalledWith({
      where: { tenantId: "tenant-a" },
    });
  });

  // ── disconnect: Microsoft has no app-side revoke — immediate delete ───────

  it("disconnect on a MICROSOFT row hard-deletes immediately (no revoke call) and returns a message pointing the admin at Microsoft's own permissions page", async () => {
    const row = {
      id: "mc-1",
      provider: "MICROSOFT",
      accountEmail: "owner@acme.test",
      refreshTokenCipher: realEncryption().encrypt("real-refresh-token"),
    };
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(row),
        delete: jest.fn().mockResolvedValue(row),
      },
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const { service } = buildService({ prisma, audit });

    const result = await service.disconnect("tenant-a", "user-1");

    expect(result.deleted).toBe(true);
    expect(result.message).toMatch(/microsoft/i);
    expect(axios.post).not.toHaveBeenCalled(); // no oauth2.googleapis.com/revoke-equivalent exists
    expect(prisma.mailboxConnection.delete).toHaveBeenCalledWith({
      where: { tenantId: "tenant-a" },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "mailbox.disconnected", tenantId: "tenant-a" }),
    );
  });

  // ── cross-provider state rejection (Opus review, LOW) ──────────────────────

  it("a state minted for GOOGLE is rejected at the Microsoft callback with 400 — never exchanged", async () => {
    const { service, mockRedis } = buildService();
    // Forge a GOOGLE-provider nonce directly under the same key handleMicrosoftCallback reads —
    // simulates a state that started via /google/start being replayed at /microsoft/callback.
    await mockRedis.set(
      "mailbox:oauth:cross-provider-nonce",
      JSON.stringify({ tenantId: "tenant-a", userId: "user-1", provider: "GOOGLE", verifier: "v" }),
      "EX",
      600,
    );

    await expect(service.handleMicrosoftCallback("code-1", "cross-provider-nonce")).rejects.toThrow(
      BadRequestException,
    );
    expect(axios.post).not.toHaveBeenCalled();
  });

  // ── rotation race (Opus review, LOW) ────────────────────────────────────────

  it("confirmConnect for a MICROSOFT grant also serializes through the shared 'mailbox' advisory lock", async () => {
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({
          id: "mc-1",
          accountEmail: "owner@acme.test",
          provider: "MICROSOFT",
        }),
      },
    };
    const { service } = buildService({ prisma });

    const confirmToken = await connectThroughMicrosoftCallback(service, "tenant-a", "user-1");
    await service.confirmConnect(confirmToken, "user-1", "tenant-a");

    expect(withAdvisoryLock).toHaveBeenCalledWith(
      expect.objectContaining({ family: "mailbox", key: "tenant-a" }),
      expect.any(Function),
    );
  });
});
