import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import axios from "axios";
import * as crypto from "crypto";
import request from "supertest";
import { MailboxController } from "./mailbox.controller";
import { MailboxConnectionService } from "./mailbox-connection.service";
import { EncryptionService } from "../../common/encryption.service";
import { JwtStrategy } from "../../auth/strategies/jwt.strategy";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../../auth/guards/roles.guard";
import { AddonGuard } from "../../billing/addon.guard";
import { AddonService } from "../../billing/addon.service";
import { EntitlementsService } from "../../billing/entitlements.service";
import { FeatureOverrideService } from "../../billing/feature-override.service";
import { listenOnLoopback } from "../../common/testing/listen-loopback";

jest.mock("axios");

// Pass-through lock (see mailbox-connection.service.spec.ts): a real advisory lock needs a live
// Postgres; the lock itself is proven in db-locks.spec.ts.
jest.mock("../../common/db-locks", () => ({
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

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

const JWT_SECRET = "connect-binding-spec-secret";
const BASE = "/settings/email/mailbox";
const SECRET_HEADER = "X-Mailbox-Connect-Secret";
const MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MS_GRAPH_ME_URL = "https://graph.microsoft.com/v1.0/me";

const sha256 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("base64url");

/**
 * #2115 (SA-215): a pending mailbox grant is bound to the admin AND to the browser tab that
 * started the connect, and it is bound to the workspace only by an explicit confirm. Drives the
 * REAL controller with its REAL guard chain (JwtStrategy + JwtAuthGuard + RolesGuard +
 * AddonGuard) and the REAL MailboxConnectionService over HTTP. Only Redis (in memory), the
 * database (a map), the advisory lock (pass-through) and the provider boundary
 * (google-auth-library / axios) are doubles.
 *
 * The connect secret: `/start` hands the initiating tab a random secret. The tab keeps it in
 * sessionStorage; the server keeps only its hash, in the state nonce and then in the pending
 * grant. Preview and confirm both require it in a header, so a confirm link opened in any other
 * tab or browser fails even with the admin's own JWT.
 */
describe("MailboxController: the connect is bound to the tab that started it and confirmed explicitly", () => {
  let app: INestApplication;
  let jwt: JwtService;
  const redisStore = new Map<string, string>();
  const rows = new Map<string, Record<string, unknown>>();
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  /** The account the provider signs in as for the next exchange. */
  let providerAccount = { sub: "owner-sub", email: "owner@acme.test" };

  const redis = {
    set: jest.fn(async (key: string, val: string) => {
      redisStore.set(key, val);
      return "OK";
    }),
    get: jest.fn(async (key: string) => redisStore.get(key) ?? null),
    getdel: jest.fn(async (key: string) => {
      const v = redisStore.get(key) ?? null;
      redisStore.delete(key);
      return v;
    }),
    eval: jest.fn(async () => null),
    on: jest.fn(),
    disconnect: jest.fn(),
  };

  const prisma = {
    mailboxConnection: {
      findUnique: jest.fn(async ({ where }: any) => rows.get(where.tenantId) ?? null),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const existing = rows.get(where.tenantId);
        const row = existing
          ? { ...existing, ...update }
          : {
              id: `mc-${where.tenantId}`,
              throttledUntil: null,
              lastError: null,
              lastSentAt: null,
              ...create,
            };
        rows.set(where.tenantId, row);
        return row;
      }),
    },
  };

  const config = {
    get: (key: string) =>
      ({
        jwt: { secret: JWT_SECRET },
        WEB_URL: "http://localhost:3001",
        ENCRYPTION_KEY: "f".repeat(64),
        GOOGLE_MAILBOX_CLIENT_ID: "g-client-id",
        GOOGLE_MAILBOX_CLIENT_SECRET: "g-client-secret",
        GOOGLE_MAILBOX_REDIRECT_URI: "https://api.acme.test/google/callback",
        MICROSOFT_MAILBOX_CLIENT_ID: "ms-client-id",
        MICROSOFT_MAILBOX_CLIENT_SECRET: "ms-client-secret",
        MICROSOFT_MAILBOX_REDIRECT_URI: "https://api.acme.test/microsoft/callback",
      })[key],
  } as unknown as ConfigService;

  function bearer(sub: string, tenantId = "tenant-a", role = "TENANT_ADMIN") {
    const token = jwt.sign({
      sub,
      username: `user-${sub}`,
      role,
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: `${tenantId}-slug`,
    });
    return `Bearer ${token}`;
  }

  beforeAll(async () => {
    const service = new MailboxConnectionService(
      prisma as any,
      new EncryptionService(config),
      audit as any,
      config,
    );
    (service as any).redis = redis;

    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule, JwtModule.register({ secret: JWT_SECRET })],
      controllers: [MailboxController],
      providers: [
        JwtStrategy,
        JwtAuthGuard,
        RolesGuard,
        AddonGuard,
        Reflector,
        { provide: ConfigService, useValue: config },
        // email.connected_mailbox is registered `dark`: AddonGuard allows regardless of grant.
        { provide: AddonService, useValue: { getActiveAddons: jest.fn().mockResolvedValue([]) } },
        {
          provide: EntitlementsService,
          useValue: { isAlwaysEnforcedTenant: jest.fn().mockResolvedValue(false) },
        },
        {
          provide: FeatureOverrideService,
          useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
        },
        { provide: MailboxConnectionService, useValue: service },
      ],
    }).compile();

    jwt = moduleRef.get(JwtService);
    app = moduleRef.createNestApplication();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    redisStore.clear();
    rows.clear();
    providerAccount = { sub: "owner-sub", email: "owner@acme.test" };
    mockOAuthClient.generateCodeVerifierAsync.mockResolvedValue({
      codeVerifier: "g-verifier",
      codeChallenge: "g-challenge",
    });
    mockOAuthClient.generateAuthUrl.mockImplementation(
      (opts: any) => `https://accounts.google.test/auth?state=${opts.state}`,
    );
    mockOAuthClient.getToken.mockImplementation(async () => ({
      tokens: {
        refresh_token: "g-rt",
        access_token: "g-at",
        id_token: "g-id-token",
        expiry_date: Date.now() + 3_600_000,
        scope: "https://www.googleapis.com/auth/gmail.send",
      },
    }));
    mockOAuthClient.verifyIdToken.mockImplementation(async () => ({
      getPayload: () => ({ ...providerAccount, email_verified: true }),
    }));
    (axios.post as jest.Mock).mockImplementation(async (url: string) => {
      if (url !== MS_TOKEN_URL) throw new Error(`unexpected POST ${url}`);
      return {
        data: {
          access_token: "ms-at",
          refresh_token: "ms-rt",
          expires_in: 3600,
          scope: "https://graph.microsoft.com/Mail.Send offline_access",
        },
      };
    });
    (axios.get as jest.Mock).mockImplementation(async (url: string) => {
      if (url !== MS_GRAPH_ME_URL) throw new Error(`unexpected GET ${url}`);
      return { data: { id: providerAccount.sub, mail: providerAccount.email } };
    });
  });

  const http = () => request(app.getHttpServer());

  /** An admin clicks Connect in one tab: what that tab holds (its secret) and the state nonce. */
  async function start(provider: "google" | "microsoft", sub = "admin-1") {
    const res = await http().get(`${BASE}/${provider}/start`).set("Authorization", bearer(sub));
    expect(res.status).toBe(200);
    const { url, connectSecret } = res.body as { url: string; connectSecret: string };
    return { connectSecret, state: new URL(url).searchParams.get("state")! };
  }

  /** The provider redirects back with a code for that state: the confirm token it hands the web. */
  async function returnFromProvider(provider: "google" | "microsoft", state: string) {
    const res = await http()
      .get(`${BASE}/${provider}/callback`)
      .query({ code: "code-1", state })
      .expect(302);
    const token = new URL(res.headers.location).searchParams.get("mailbox_confirm");
    expect(token).toBeTruthy();
    return token!;
  }

  async function connectUpToTheRedirect(provider: "google" | "microsoft" = "google", sub?: string) {
    const { connectSecret, state } = await start(provider, sub);
    return { connectSecret, token: await returnFromProvider(provider, state) };
  }

  const preview = (token: string, auth: string, secret?: string) => {
    const req = http().get(`${BASE}/confirm/${token}/preview`).set("Authorization", auth);
    return secret === undefined ? req : req.set(SECRET_HEADER, secret);
  };
  const confirm = (token: string, auth: string, secret?: string) => {
    const req = http().post(`${BASE}/confirm`).set("Authorization", auth);
    return (secret === undefined ? req : req.set(SECRET_HEADER, secret)).send({ state: token });
  };
  const cancel = (token: string, auth: string) =>
    http().post(`${BASE}/confirm/cancel`).set("Authorization", auth).send({ state: token });

  it("start hands the tab a one-time connect secret; the server keeps only its hash, in the nonce and then the grant", async () => {
    const res = await http().get(`${BASE}/google/start`).set("Authorization", bearer("admin-1"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      url: expect.stringContaining("state="),
      connectSecret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    const secret: string = res.body.connectSecret;
    const state = new URL(res.body.url).searchParams.get("state")!;
    expect(res.body.url).not.toContain(secret);
    const nonce = JSON.parse(redisStore.get(`mailbox:oauth:${state}`)!);
    expect(nonce.secretHash).toBe(sha256(secret));

    const token = await returnFromProvider("google", state);
    const grant = JSON.parse(redisStore.get(`mailbox:pending:${token}`)!);
    expect(grant.secretHash).toBe(sha256(secret));
    expect([...redisStore.values()].join("\n")).not.toContain(secret);
  });

  it.each(["google", "microsoft"] as const)(
    "%s/start answers Cache-Control: no-store, so no browser or proxy keeps the connect secret",
    async (provider) => {
      const res = await http()
        .get(`${BASE}/${provider}/start`)
        .set("Authorization", bearer("admin-1"));

      expect(res.status).toBe(200);
      expect(res.body.connectSecret).toEqual(expect.any(String));
      expect(res.headers["cache-control"]).toBe("no-store");
    },
  );

  it("from the tab that started it: preview names the account (provider and email only), consumes nothing, and only Confirm binds it", async () => {
    const { connectSecret, token } = await connectUpToTheRedirect();

    for (const attempt of [1, 2]) {
      const res = await preview(token, bearer("admin-1"), connectSecret);
      expect({ attempt, status: res.status }).toEqual({ attempt, status: 200 });
      expect(res.body).toEqual({ provider: "GOOGLE", accountEmail: "owner@acme.test" });
    }
    expect(rows.size).toBe(0);

    const res = await confirm(token, bearer("admin-1"), connectSecret).expect(200);
    expect(res.body).toMatchObject({
      connected: true,
      provider: "GOOGLE",
      accountEmail: "owner@acme.test",
    });
    expect(rows.get("tenant-a")).toMatchObject({ accountEmail: "owner@acme.test" });

    // Single-use: the grant is spent.
    await confirm(token, bearer("admin-1"), connectSecret).expect(400);
    await preview(token, bearer("admin-1"), connectSecret).expect(400);
  });

  it("preview WITHOUT the secret (a link opened in another tab) is refused, and consumes nothing", async () => {
    const { connectSecret, token } = await connectUpToTheRedirect();

    const res = await preview(token, bearer("admin-1"));

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain("owner@acme.test");
    await preview(token, bearer("admin-1"), connectSecret).expect(200);
  });

  it("preview with a WRONG secret is refused, and consumes nothing", async () => {
    const { connectSecret, token } = await connectUpToTheRedirect();

    const res = await preview(token, bearer("admin-1"), `${connectSecret.slice(0, -1)}x`);

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain("owner@acme.test");
    await preview(token, bearer("admin-1"), connectSecret).expect(200);
  });

  it("confirm from a different browser session (the admin's own JWT, no secret) is refused, and the grant is spent", async () => {
    const { connectSecret, token } = await connectUpToTheRedirect();

    await confirm(token, bearer("admin-1")).expect(403);

    expect(rows.size).toBe(0);
    // Refused confirms spend the grant: even the right tab can't bind it now.
    await confirm(token, bearer("admin-1"), connectSecret).expect(400);
    expect(rows.size).toBe(0);
  });

  it("confirm with a WRONG secret is refused, and the grant is spent", async () => {
    const { connectSecret, token } = await connectUpToTheRedirect();

    await confirm(token, bearer("admin-1"), "not-the-secret").expect(403);

    await confirm(token, bearer("admin-1"), connectSecret).expect(400);
    expect(rows.size).toBe(0);
  });

  it("a secret from ANOTHER connect attempt (the same admin, another tab) doesn't open this grant", async () => {
    const other = await start("google");
    const { token } = await connectUpToTheRedirect();

    await preview(token, bearer("admin-1"), other.connectSecret).expect(403);
    await confirm(token, bearer("admin-1"), other.connectSecret).expect(403);
    expect(rows.size).toBe(0);
  });

  it("a different admin's JWT is refused on preview and confirm, even holding the right secret", async () => {
    const { connectSecret, token } = await connectUpToTheRedirect();

    const sameTenant = await preview(token, bearer("admin-2"), connectSecret);
    expect(sameTenant.status).toBe(403);
    expect(JSON.stringify(sameTenant.body)).not.toContain("owner@acme.test");
    await preview(token, bearer("admin-1", "tenant-b"), connectSecret).expect(403);
    await confirm(token, bearer("admin-2"), connectSecret).expect(403);
    expect(rows.size).toBe(0);
  });

  it("Cancel burns the grant: preview and confirm are refused afterwards, and a second cancel is a no-op", async () => {
    const { connectSecret, token } = await connectUpToTheRedirect();

    await cancel(token, bearer("admin-1")).expect(204);

    await preview(token, bearer("admin-1"), connectSecret).expect(400);
    await confirm(token, bearer("admin-1"), connectSecret).expect(400);
    await cancel(token, bearer("admin-1")).expect(204);
    expect(rows.size).toBe(0);
    expect([...redisStore.keys()].filter((k) => k.startsWith("mailbox:pending:"))).toEqual([]);
  });

  it("Microsoft is bound the same way", async () => {
    const { connectSecret, token } = await connectUpToTheRedirect("microsoft");

    await preview(token, bearer("admin-1")).expect(403);
    const res = await preview(token, bearer("admin-1"), connectSecret).expect(200);
    expect(res.body).toEqual({ provider: "MICROSOFT", accountEmail: "owner@acme.test" });
    await confirm(token, bearer("admin-1"), connectSecret).expect(200);
    expect(rows.get("tenant-a")).toMatchObject({ provider: "MICROSOFT" });
  });

  it("the #2115 chain: someone else finishes the admin's sign-in URL with THEIR account; the link they send opens nothing outside the admin's tab, and inside it the dialog names THEIR account", async () => {
    // The admin clicks Connect Gmail; their tab holds the secret, the sign-in URL carries state.
    const adminTab = await start("google", "admin-1");
    // Someone who got hold of that sign-in URL consents with their own mailbox first.
    providerAccount = { sub: "intruder-sub", email: "intruder@elsewhere.test" };
    const craftedToken = await returnFromProvider("google", adminTab.state);

    // The crafted link, opened by the admin anywhere but the tab that started it: refused.
    await preview(craftedToken, bearer("admin-1")).expect(403);
    // Opened in that very tab, the explicit dialog shows WHOSE mailbox it is before anything binds.
    const res = await preview(craftedToken, bearer("admin-1"), adminTab.connectSecret).expect(200);
    expect(res.body.accountEmail).toBe("intruder@elsewhere.test");
    // Nothing is bound until someone clicks Confirm; Cancel burns it.
    expect(rows.size).toBe(0);
    await cancel(craftedToken, bearer("admin-1")).expect(204);
    await confirm(craftedToken, bearer("admin-1"), adminTab.connectSecret).expect(400);
    expect(rows.size).toBe(0);
  });

  it("a state or grant minted before this change (no secret hash) can never be confirmed: fail closed", async () => {
    // A state nonce from before the upgrade: the callback refuses it, never exchanging.
    redisStore.set(
      "mailbox:oauth:legacy-state",
      JSON.stringify({
        tenantId: "tenant-a",
        userId: "admin-1",
        provider: "GOOGLE",
        verifier: "v",
      }),
    );
    const cb = await http()
      .get(`${BASE}/google/callback`)
      .query({ code: "code-1", state: "legacy-state" })
      .expect(302);
    expect(cb.headers.location).toBe("http://localhost:3001/settings?tab=email&mailbox_error=1");
    expect(mockOAuthClient.getToken).not.toHaveBeenCalled();

    // A pending grant from before the upgrade: preview and confirm refuse it with any secret.
    redisStore.set(
      "mailbox:pending:legacy-token",
      JSON.stringify({
        tenantId: "tenant-a",
        userId: "admin-1",
        provider: "GOOGLE",
        accountEmail: "owner@acme.test",
        externalSubject: "owner-sub",
        scopesGranted: ["https://www.googleapis.com/auth/gmail.send"],
        refreshTokenCipher: "x",
        accessTokenCipher: null,
        accessTokenExpiresAt: null,
      }),
    );
    await preview("legacy-token", bearer("admin-1"), "any-secret").expect(403);
    await confirm("legacy-token", bearer("admin-1"), "any-secret").expect(403);
    expect(rows.size).toBe(0);
  });
});
