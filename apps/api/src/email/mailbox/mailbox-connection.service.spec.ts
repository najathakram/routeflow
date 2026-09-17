import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { MailboxConnectionService } from "./mailbox-connection.service";
import { EncryptionService } from "../../common/encryption.service";

jest.mock("axios");

// A single shared mock OAuth2Client instance — the service builds a fresh `newOAuthClient()`
// per call, so every test configures THIS mock's methods before invoking the service.
const mockOAuthClient = {
  generateCodeVerifierAsync: jest.fn(),
  generateAuthUrl: jest.fn(),
  getToken: jest.fn(),
  verifyIdToken: jest.fn(),
};
jest.mock("google-auth-library", () => ({
  OAuth2Client: jest.fn().mockImplementation(() => mockOAuthClient),
  CodeChallengeMethod: { S256: "S256" },
}));

/**
 * email-connect-google PR-2 — state + PKCE, tenant isolation, ciphertext-at-rest, and
 * best-effort revoke-then-hard-delete on disconnect.
 */
describe("MailboxConnectionService", () => {
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

  function realEncryption(): EncryptionService {
    const config = {
      get: (k: string) => (k === "ENCRYPTION_KEY" ? "a".repeat(64) : undefined),
    } as unknown as ConfigService;
    return new EncryptionService(config);
  }

  function buildService(opts: { prisma?: any; audit?: any; encryption?: EncryptionService } = {}) {
    const config = {
      get: (k: string) =>
        ({
          GOOGLE_MAILBOX_CLIENT_ID: "client-id",
          GOOGLE_MAILBOX_CLIENT_SECRET: "client-secret",
          GOOGLE_MAILBOX_REDIRECT_URI: "https://api.example.com/callback",
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

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── state + PKCE ──────────────────────────────────────────────────────────

  it("startConnect requests a PKCE code_challenge and persists the verifier under the state nonce", async () => {
    mockOAuthClient.generateCodeVerifierAsync.mockResolvedValue({
      codeVerifier: "verifier-123",
      codeChallenge: "challenge-abc",
    });
    mockOAuthClient.generateAuthUrl.mockReturnValue(
      "https://accounts.google.com/o/oauth2/v2/auth?...",
    );

    const { service, mockRedis } = buildService();
    const url = await service.startConnect("tenant-a", "user-1");

    expect(url).toContain("accounts.google.com");
    expect(mockOAuthClient.generateAuthUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        code_challenge: "challenge-abc",
        code_challenge_method: "S256",
        scope: expect.arrayContaining(["https://www.googleapis.com/auth/gmail.send"]),
      }),
    );
    expect(mockRedis.set).toHaveBeenCalledTimes(1);
    const [, storedJson, , ttl] = mockRedis.set.mock.calls[0];
    const stored = JSON.parse(storedJson);
    expect(stored).toMatchObject({
      tenantId: "tenant-a",
      userId: "user-1",
      verifier: "verifier-123",
    });
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it("rejects a tampered/unknown state with 400 — the code exchange is never attempted", async () => {
    const { service } = buildService();

    await expect(
      service.handleCallback("some-code", "nonce-that-was-never-minted"),
    ).rejects.toThrow(BadRequestException);
    expect(mockOAuthClient.getToken).not.toHaveBeenCalled();
  });

  it("rejects a missing code or state with 400 before touching Redis or Google", async () => {
    const { service, mockRedis } = buildService();

    await expect(service.handleCallback("", "some-state")).rejects.toThrow(BadRequestException);
    await expect(service.handleCallback("some-code", "")).rejects.toThrow(BadRequestException);
    expect(mockRedis.getdel).not.toHaveBeenCalled();
    expect(mockOAuthClient.getToken).not.toHaveBeenCalled();
  });

  it("a REPLAYED state (used once already) is rejected the second time — single-use via GETDEL", async () => {
    mockOAuthClient.generateCodeVerifierAsync.mockResolvedValue({
      codeVerifier: "verifier-xyz",
      codeChallenge: "challenge-xyz",
    });
    mockOAuthClient.generateAuthUrl.mockImplementation(
      (opts: any) => `https://accounts.google.com/auth?state=${opts.state}`,
    );
    mockOAuthClient.getToken.mockResolvedValue({
      tokens: {
        refresh_token: "rt-1",
        access_token: "at-1",
        id_token: "idt-1",
        expiry_date: Date.now() + 3600_000,
        scope: "https://www.googleapis.com/auth/gmail.send",
      },
    });
    mockOAuthClient.verifyIdToken.mockResolvedValue({
      getPayload: () => ({ sub: "google-sub-1", email: "owner@acme.test", email_verified: true }),
    });

    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: "mc-1", accountEmail: "owner@acme.test" }),
        update: jest.fn(),
        delete: jest.fn(),
      },
    };
    const { service } = buildService({ prisma });

    const url = await service.startConnect("tenant-a", "user-1");
    const state = new URL(url).searchParams.get("state")!;

    // First use succeeds.
    await service.handleCallback("code-1", state);
    expect(mockOAuthClient.getToken).toHaveBeenCalledTimes(1);

    // Second use of the SAME state (replay) is rejected — and the exchange is not
    // attempted again.
    await expect(service.handleCallback("code-1", state)).rejects.toThrow(BadRequestException);
    expect(mockOAuthClient.getToken).toHaveBeenCalledTimes(1); // still 1, not 2
  });

  it("passes the stored PKCE verifier to the token exchange", async () => {
    mockOAuthClient.generateCodeVerifierAsync.mockResolvedValue({
      codeVerifier: "the-real-verifier",
      codeChallenge: "the-real-challenge",
    });
    mockOAuthClient.generateAuthUrl.mockImplementation(
      (opts: any) => `https://accounts.google.com/auth?state=${opts.state}`,
    );
    mockOAuthClient.getToken.mockResolvedValue({
      tokens: {
        refresh_token: "rt-1",
        access_token: "at-1",
        id_token: "idt-1",
        expiry_date: Date.now() + 3600_000,
        scope: "https://www.googleapis.com/auth/gmail.send",
      },
    });
    mockOAuthClient.verifyIdToken.mockResolvedValue({
      getPayload: () => ({ sub: "google-sub-1", email: "owner@acme.test", email_verified: true }),
    });
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: "mc-1", accountEmail: "owner@acme.test" }),
      },
    };
    const { service } = buildService({ prisma });

    const url = await service.startConnect("tenant-a", "user-1");
    const state = new URL(url).searchParams.get("state")!;
    await service.handleCallback("code-1", state);

    expect(mockOAuthClient.getToken).toHaveBeenCalledWith(
      expect.objectContaining({ code: "code-1", codeVerifier: "the-real-verifier" }),
    );
  });

  // ── ciphertext-at-rest ────────────────────────────────────────────────────

  it("stores the refresh token ONLY as EncryptionService ciphertext, never plaintext", async () => {
    mockOAuthClient.generateCodeVerifierAsync.mockResolvedValue({
      codeVerifier: "v1",
      codeChallenge: "c1",
    });
    mockOAuthClient.generateAuthUrl.mockImplementation(
      (opts: any) => `https://accounts.google.com/auth?state=${opts.state}`,
    );
    mockOAuthClient.getToken.mockResolvedValue({
      tokens: {
        refresh_token: "super-secret-refresh-token",
        access_token: "super-secret-access-token",
        id_token: "idt-1",
        expiry_date: Date.now() + 3600_000,
        scope: "https://www.googleapis.com/auth/gmail.send",
      },
    });
    mockOAuthClient.verifyIdToken.mockResolvedValue({
      getPayload: () => ({ sub: "google-sub-1", email: "owner@acme.test", email_verified: true }),
    });
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

    const url = await service.startConnect("tenant-a", "user-1");
    const state = new URL(url).searchParams.get("state")!;
    await service.handleCallback("code-1", state);

    // AES-256-GCM storage format: IV_HEX:TAG_HEX:CIPHERTEXT_B64 (email.service.ts's
    // ENCRYPTED_FORMAT, EncryptionService's documented contract).
    const CIPHERTEXT_FORMAT = /^[0-9a-f]{32}:[0-9a-f]{32}:[A-Za-z0-9+/=]+$/;
    expect(savedData.refreshTokenCipher).toMatch(CIPHERTEXT_FORMAT);
    expect(savedData.refreshTokenCipher).not.toContain("super-secret-refresh-token");
    expect(savedData.accessTokenCipher).toMatch(CIPHERTEXT_FORMAT);
    expect(savedData.accessTokenCipher).not.toContain("super-secret-access-token");
  });

  it("rejects the callback when Google didn't grant a refresh token (no offline access)", async () => {
    mockOAuthClient.generateCodeVerifierAsync.mockResolvedValue({
      codeVerifier: "v1",
      codeChallenge: "c1",
    });
    mockOAuthClient.generateAuthUrl.mockImplementation(
      (opts: any) => `https://accounts.google.com/auth?state=${opts.state}`,
    );
    mockOAuthClient.getToken.mockResolvedValue({ tokens: { access_token: "at-1" } });
    const { service } = buildService();

    const url = await service.startConnect("tenant-a", "user-1");
    const state = new URL(url).searchParams.get("state")!;

    await expect(service.handleCallback("code-1", state)).rejects.toThrow(BadRequestException);
  });

  // ── tenant isolation ──────────────────────────────────────────────────────

  it("getStatus/disconnect only ever query by the CALLER's own tenantId — never a second tenant's row", async () => {
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue({
          id: "mc-a",
          provider: "GOOGLE",
          accountEmail: "a@acme.test",
          status: "CONNECTED",
          refreshTokenCipher: "iv:tag:ct",
          throttledUntil: null,
          lastError: null,
          lastSentAt: null,
        }),
        delete: jest.fn().mockResolvedValue({}),
      },
    };
    const { service } = buildService({ prisma });
    (axios.post as jest.Mock).mockResolvedValue({});

    // Tenant A reads/disconnects using ONLY its own id — never tenant B's.
    await service.getStatus("tenant-a");
    expect(prisma.mailboxConnection.findUnique).toHaveBeenCalledWith({
      where: { tenantId: "tenant-a" },
    });

    await service.disconnect("tenant-a", "user-1");
    expect(prisma.mailboxConnection.delete).toHaveBeenCalledWith({
      where: { tenantId: "tenant-a" },
    });

    // Tenant B's own call is independently scoped to ITS id — there is no code path by
    // which tenant A's call above could have touched tenant B's row (no by-id endpoint
    // exists anywhere on this service).
    jest.clearAllMocks();
    (axios.post as jest.Mock).mockResolvedValue({});
    await service.getStatus("tenant-b");
    expect(prisma.mailboxConnection.findUnique).toHaveBeenCalledWith({
      where: { tenantId: "tenant-b" },
    });
  });

  it("disconnect() with no row for the tenant 404s and never deletes/revokes anything", async () => {
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(null),
        delete: jest.fn(),
      },
    };
    const { service } = buildService({ prisma });

    await expect(service.disconnect("tenant-a", "user-1")).rejects.toThrow(NotFoundException);
    expect(prisma.mailboxConnection.delete).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });

  // ── disconnect = revoke-at-Google (best-effort) + hard delete ────────────

  it("disconnect revokes at Google exactly once, then hard-deletes the row and audits it", async () => {
    const row = {
      id: "mc-1",
      provider: "GOOGLE",
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
    (axios.post as jest.Mock).mockResolvedValue({ status: 200 });
    const { service } = buildService({ prisma, audit });

    await service.disconnect("tenant-a", "user-1");

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/revoke",
      null,
      expect.objectContaining({ params: { token: "real-refresh-token" } }),
    );
    expect(prisma.mailboxConnection.delete).toHaveBeenCalledWith({
      where: { tenantId: "tenant-a" },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "mailbox.disconnected", tenantId: "tenant-a" }),
    );
  });

  it("disconnect still hard-deletes the row even when the Google revoke call fails", async () => {
    const row = {
      id: "mc-1",
      provider: "GOOGLE",
      accountEmail: "owner@acme.test",
      refreshTokenCipher: realEncryption().encrypt("real-refresh-token"),
    };
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue(row),
        delete: jest.fn().mockResolvedValue(row),
      },
    };
    (axios.post as jest.Mock).mockRejectedValue(new Error("network error"));
    const { service } = buildService({ prisma });

    await service.disconnect("tenant-a", "user-1");

    expect(prisma.mailboxConnection.delete).toHaveBeenCalledWith({
      where: { tenantId: "tenant-a" },
    });
  });

  // ── DTO/response never carries a token ────────────────────────────────────

  it("MailboxStatusView (the only shape crossing the controller boundary) has no key matching /token/i", async () => {
    const prisma = {
      mailboxConnection: {
        findUnique: jest.fn().mockResolvedValue({
          id: "mc-a",
          provider: "GOOGLE",
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
});
