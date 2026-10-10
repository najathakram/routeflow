import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import axios from "axios";
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

const MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MS_GRAPH_ME_URL = "https://graph.microsoft.com/v1.0/me";
const SETTINGS = "http://localhost:3001/settings?tab=email";
const NONCE_PREFIX = "mailbox:oauth:";
const PENDING_PREFIX = "mailbox:pending:";

/**
 * #2115 / SA-215 (a), landing in #2114: the connect `state` is consumed on EVERY terminal
 * outcome, not just a successful exchange. Drives the REAL controller and the REAL
 * MailboxConnectionService over HTTP against an in-memory Redis. Only the provider boundary is
 * mocked: google-auth-library for Google, axios for Microsoft. The attack this closes: someone
 * holding the provider sign-in URL completes consent with THEIR OWN account after the admin
 * cancelled, redeeming the still-live state within its 600 s TTL. The grant would then be
 * minted for the admin's (tenant, user).
 */
describe("MailboxController + MailboxConnectionService: a callback consumes its state on every outcome", () => {
  let app: INestApplication;
  let service: MailboxConnectionService;
  const store = new Map<string, string>();

  const redis = {
    set: jest.fn(async (key: string, val: string) => {
      store.set(key, val);
      return "OK";
    }),
    getdel: jest.fn(async (key: string) => {
      const v = store.has(key) ? store.get(key)! : null;
      store.delete(key);
      return v;
    }),
    get: jest.fn(async (key: string) => (store.has(key) ? store.get(key)! : null)),
    eval: jest.fn(async () => null),
    on: jest.fn(),
    disconnect: jest.fn(),
  };

  const config = {
    get: (key: string) =>
      ({
        jwt: { secret: "state-lifecycle-spec-secret" },
        WEB_URL: "http://localhost:3001",
        ENCRYPTION_KEY: "e".repeat(64),
        GOOGLE_MAILBOX_CLIENT_ID: "g-client-id",
        GOOGLE_MAILBOX_CLIENT_SECRET: "g-client-secret",
        GOOGLE_MAILBOX_REDIRECT_URI: "https://api.acme.test/google/callback",
        MICROSOFT_MAILBOX_CLIENT_ID: "ms-client-id",
        MICROSOFT_MAILBOX_CLIENT_SECRET: "ms-client-secret",
        MICROSOFT_MAILBOX_REDIRECT_URI: "https://api.acme.test/microsoft/callback",
      })[key],
  } as unknown as ConfigService;

  beforeAll(async () => {
    service = new MailboxConnectionService(
      { mailboxConnection: {} } as any, // a callback never touches the database
      new EncryptionService(config),
      { log: jest.fn() } as any,
      config,
    );
    (service as any).redis = redis;

    // The callback routes are unguarded, but Nest still resolves the providers the controller's
    // OTHER routes reference: same fixture shape as mailbox.controller.google-callback.spec.ts.
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule, JwtModule.register({ secret: "state-lifecycle-spec-secret" })],
      controllers: [MailboxController],
      providers: [
        JwtStrategy,
        JwtAuthGuard,
        RolesGuard,
        AddonGuard,
        Reflector,
        { provide: ConfigService, useValue: config },
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

    app = moduleRef.createNestApplication();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    store.clear();
    // Every provider call succeeds: a refused replay can only be the state check's doing.
    mockOAuthClient.generateCodeVerifierAsync.mockResolvedValue({
      codeVerifier: "g-verifier",
      codeChallenge: "g-challenge",
    });
    mockOAuthClient.generateAuthUrl.mockImplementation(
      (opts: any) => `https://accounts.google.test/auth?state=${opts.state}`,
    );
    mockOAuthClient.getToken.mockResolvedValue({
      tokens: {
        refresh_token: "someone-elses-rt",
        access_token: "someone-elses-at",
        id_token: "g-id-token",
        expiry_date: Date.now() + 3_600_000,
        scope: "https://www.googleapis.com/auth/gmail.send",
      },
    });
    mockOAuthClient.verifyIdToken.mockResolvedValue({
      getPayload: () => ({ sub: "other-sub", email: "other@acme.test", email_verified: true }),
    });
    (axios.post as jest.Mock).mockImplementation(async (url: string) => {
      if (url !== MS_TOKEN_URL) throw new Error(`unexpected POST ${url}`);
      return {
        data: {
          access_token: "someone-elses-at",
          refresh_token: "someone-elses-rt",
          expires_in: 3600,
          scope: "https://graph.microsoft.com/Mail.Send offline_access",
        },
      };
    });
    (axios.get as jest.Mock).mockImplementation(async (url: string) => {
      if (url !== MS_GRAPH_ME_URL) throw new Error(`unexpected GET ${url}`);
      return { data: { id: "other-oid", mail: "other@acme.test" } };
    });
  });

  const stateOf = (url: string) => new URL(url).searchParams.get("state")!;
  const pendingGrants = () => [...store.keys()].filter((k) => k.startsWith(PENDING_PREFIX));

  const providers = [
    {
      name: "Google",
      path: "google",
      start: async () => (await service.startConnect("tenant-a", "admin-1")).url,
      exchanges: () => mockOAuthClient.getToken.mock.calls.length,
      cancelled: `${SETTINGS}&mailbox_cancelled=google`,
    },
    {
      name: "Microsoft",
      path: "microsoft",
      start: async () => (await service.startConnectMicrosoft("tenant-a", "admin-1")).url,
      exchanges: () =>
        (axios.post as jest.Mock).mock.calls.filter(([url]) => url === MS_TOKEN_URL).length,
      cancelled: `${SETTINGS}&mailbox_error=1`,
    },
  ];

  describe.each(providers)("$name", ({ path, start, exchanges, cancelled }) => {
    const callback = `/settings/email/mailbox/${path}/callback`;

    it("control: a live state with a code exchanges and mints a confirm token", async () => {
      const state = stateOf(await start());

      const res = await request(app.getHttpServer())
        .get(callback)
        .query({ code: "code-1", state })
        .expect(302);

      expect(res.headers.location).toMatch(/&mailbox_confirm=[A-Za-z0-9_-]+$/);
      expect(exchanges()).toBe(1);
      expect(store.has(`${NONCE_PREFIX}${state}`)).toBe(false);
    });

    it("cancel, then the SAME state with a code: refused, never exchanged, no grant minted", async () => {
      const state = stateOf(await start());
      expect(store.has(`${NONCE_PREFIX}${state}`)).toBe(true);

      const cancel = await request(app.getHttpServer())
        .get(callback)
        .query({ error: "access_denied", state })
        .expect(302);
      expect(cancel.headers.location).toBe(cancelled);
      expect(store.has(`${NONCE_PREFIX}${state}`)).toBe(false);

      const replay = await request(app.getHttpServer())
        .get(callback)
        .query({ code: "code-from-another-account", state })
        .expect(302);

      expect(replay.headers.location).toBe(`${SETTINGS}&mailbox_error=1`);
      expect(exchanges()).toBe(0);
      expect(pendingGrants()).toEqual([]);
    });

    it("any other provider error burns the state the same way", async () => {
      const state = stateOf(await start());

      await request(app.getHttpServer())
        .get(callback)
        .query({ error: "server_error", state })
        .expect(302);
      const replay = await request(app.getHttpServer())
        .get(callback)
        .query({ code: "code-1", state })
        .expect(302);

      expect(replay.headers.location).toBe(`${SETTINGS}&mailbox_error=1`);
      expect(exchanges()).toBe(0);
      expect(pendingGrants()).toEqual([]);
    });

    it("a callback that names the state but carries no code burns it too", async () => {
      const state = stateOf(await start());

      const bare = await request(app.getHttpServer()).get(callback).query({ state }).expect(302);
      expect(bare.headers.location).toBe(`${SETTINGS}&mailbox_error=1`);

      const replay = await request(app.getHttpServer())
        .get(callback)
        .query({ code: "code-1", state })
        .expect(302);

      expect(replay.headers.location).toBe(`${SETTINGS}&mailbox_error=1`);
      expect(exchanges()).toBe(0);
      expect(pendingGrants()).toEqual([]);
    });
  });

  it("the burn is provider-agnostic: a Google state named in the Microsoft callback's error redirect is dead too", async () => {
    const state = stateOf((await service.startConnect("tenant-a", "admin-1")).url);

    await request(app.getHttpServer())
      .get("/settings/email/mailbox/microsoft/callback")
      .query({ error: "access_denied", state })
      .expect(302);
    const replay = await request(app.getHttpServer())
      .get("/settings/email/mailbox/google/callback")
      .query({ code: "code-1", state })
      .expect(302);

    expect(replay.headers.location).toBe(`${SETTINGS}&mailbox_error=1`);
    expect(mockOAuthClient.getToken).not.toHaveBeenCalled();
  });

  it("an error redirect with no state (or an unknown one) still just redirects", async () => {
    await request(app.getHttpServer())
      .get("/settings/email/mailbox/google/callback")
      .query({ error: "access_denied" })
      .expect(302);
    const res = await request(app.getHttpServer())
      .get("/settings/email/mailbox/microsoft/callback")
      .query({ error: "access_denied", state: "never-issued" })
      .expect(302);

    expect(res.headers.location).toBe(`${SETTINGS}&mailbox_error=1`);
  });
});
