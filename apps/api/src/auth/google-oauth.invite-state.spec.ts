import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { GoogleOAuthService } from "./google-oauth.service";
import { AuthController } from "./auth.controller";
import { GoogleStartDto } from "./dto/google-start.dto";
import { decodeNonceValue, encodeNonceValue } from "./oauth-nonce-value";

/**
 * A seller invite's token is a secret. The signed OAuth `state` (visible in the browser URL,
 * history and every log on the way) carries only the nonce reference; the token is kept in the
 * server-side nonce entry and read back at the callback.
 */
describe("Google sign-in for an invite — the token never rides in the OAuth state", () => {
  const INVITE = "9f2c1d7a5b8e4f60a3c9d1e2b7a84c5d6e0f13a2b4c5d6e7f8091a2b3c4d5e6f";
  const CONFIG_VALUES: Record<string, string> = {
    GOOGLE_REDIRECT_URI_TENANT: "https://example.test/api/v1/auth/google/callback",
    GOOGLE_CLIENT_ID: "test-client-id",
  };

  function makeMockRedis() {
    const store = new Map<string, string>();
    return {
      store,
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
    };
  }

  function buildService() {
    const config = {
      get: (key: string) =>
        key === "jwt"
          ? { secret: "test-jwt-secret-for-oauth-state-0123456789" }
          : CONFIG_VALUES[key],
    } as unknown as ConfigService;
    const service = new GoogleOAuthService(
      {} as any,
      {} as unknown as JwtService,
      config,
      {} as any,
      { claimsFor: jest.fn().mockResolvedValue(null) } as any,
    );
    const redis = makeMockRedis();
    (service as any).redis = redis;
    // Hand back the whole URL the way Google would see it (state and all).
    (service as any).oauth2Client = {
      generateAuthUrl: jest.fn(
        (opts: { state: string }) =>
          `https://accounts.google.test/auth?state=${encodeURIComponent(opts.state)}`,
      ),
      getToken: jest.fn().mockResolvedValue({ tokens: { id_token: "id-token" } }),
      verifyIdToken: jest.fn().mockResolvedValue({
        getPayload: () => ({
          sub: "google-user",
          email: "buyer@example.com",
          email_verified: true,
          name: "Buyer",
          picture: "",
        }),
      }),
    };
    return { service, redis };
  }

  const stateOf = (url: string) => decodeURIComponent(url.split("state=")[1]);
  const decodedPayload = (state: string) =>
    Buffer.from(state.split(".")[0], "base64url").toString("utf-8");

  it("the state, the payload it decodes to and the Google URL hold no trace of the token", async () => {
    const { service } = buildService();

    const url = await service.generateAuthUrl("tenant", "acme", INVITE, "portal");
    const state = stateOf(url);

    expect(url).not.toContain(INVITE);
    expect(state).not.toContain(INVITE);
    expect(decodedPayload(state)).not.toContain(INVITE);
    expect(JSON.parse(decodedPayload(state))).not.toHaveProperty("inviteToken");
    expect(JSON.parse(decodedPayload(state))).toMatchObject({ context: "portal" });
  });

  it("the token is kept in the server-side nonce entry and read back at the callback", async () => {
    const { service, redis } = buildService();

    const state = stateOf(await service.generateAuthUrl("tenant", "acme", INVITE, "portal"));
    const { nonce } = JSON.parse(decodedPayload(state));
    expect(decodeNonceValue(redis.store.get(`oauth:nonce:${nonce}`)!).inviteSecret).toBe(INVITE);

    const profile = await service.verifyCallback("auth-code", state);

    expect(profile.inviteSecret).toBe(INVITE);
    expect(profile).not.toHaveProperty("inviteToken");
    // The entry is single-use: a replay finds nothing and fails closed.
    await expect(service.verifyCallback("auth-code", state)).rejects.toThrow("state_invalid");
  });

  it("a sign-in with no invite stores the bare payload hash and yields no invite", async () => {
    const { service, redis } = buildService();

    const state = stateOf(await service.generateAuthUrl("tenant", "acme", undefined, "staff"));
    const { nonce } = JSON.parse(decodedPayload(state));
    expect(redis.store.get(`oauth:nonce:${nonce}`)).toMatch(/^[0-9a-f]{64}$/);

    const profile = await service.verifyCallback("auth-code", state);
    expect(profile.inviteSecret).toBeUndefined();
  });

  it("a callback whose nonce entry is missing fails closed (no invite is ever taken from the state)", async () => {
    const { service, redis } = buildService();

    const state = stateOf(await service.generateAuthUrl("tenant", "acme", INVITE, "portal"));
    redis.store.clear();

    await expect(service.verifyCallback("auth-code", state)).rejects.toThrow("state_invalid");
  });

  it("an unreadable nonce entry fails closed", async () => {
    const { service, redis } = buildService();

    const state = stateOf(await service.generateAuthUrl("tenant", "acme", INVITE, "portal"));
    const { nonce } = JSON.parse(decodedPayload(state));
    redis.store.set(`oauth:nonce:${nonce}`, "{not json");

    await expect(service.verifyCallback("auth-code", state)).rejects.toThrow("state_invalid");
  });

  it("the nonce value codec round-trips and reads the original bare-hash format", () => {
    expect(decodeNonceValue(encodeNonceValue("abc"))).toEqual({ payloadHash: "abc" });
    expect(decodeNonceValue(encodeNonceValue("abc", "tok"))).toEqual({
      payloadHash: "abc",
      inviteSecret: "tok",
    });
  });
});

describe("POST /auth/google/start", () => {
  const WEB_URL = "https://app.routeflow.test";

  function buildController(configured = true) {
    const googleOAuth = {
      isConfigured: () => configured,
      generateAuthUrl: jest.fn().mockResolvedValue("https://accounts.google.test/o/oauth2/auth"),
    } as any;
    const controller = new AuthController(
      {} as any,
      {
        get: (k: string) =>
          ({ WEB_URL, MOBILE_WEB_URL: "https://m.routeflow.test", NODE_ENV: "test" })[k],
      } as unknown as ConfigService,
      {} as any,
      googleOAuth,
      {} as any,
      {} as any,
    );
    return { controller, googleOAuth };
  }

  it("takes the invite token from the body and returns the Google URL", async () => {
    const { controller, googleOAuth } = buildController();
    const res = { status: jest.fn() };

    const out = await controller.googleStart(
      { tenant: "acme", context: "portal", inviteToken: "tok-1" },
      res,
    );

    expect(out).toEqual({ url: "https://accounts.google.test/o/oauth2/auth" });
    expect(googleOAuth.generateAuthUrl).toHaveBeenCalledWith(
      "tenant",
      "acme",
      "tok-1",
      "portal",
      false,
      undefined,
      WEB_URL,
    );
  });

  it("answers 400 without a tenant (outside a standalone buyer sign-in) and 503 when unconfigured", async () => {
    const a = buildController();
    const res = { status: jest.fn() };
    await expect(a.controller.googleStart({ context: "portal" }, res)).resolves.toMatchObject({
      statusCode: 400,
    });
    expect(a.googleOAuth.generateAuthUrl).not.toHaveBeenCalled();

    const b = buildController(false);
    await expect(b.controller.googleStart({ tenant: "acme" }, res)).resolves.toMatchObject({
      statusCode: 503,
    });
  });

  it("the GET form no longer takes an invite token (no such parameter is read)", async () => {
    const { controller, googleOAuth } = buildController();
    const res = { status: jest.fn() };
    await controller.googleAuthUrl("acme", "portal", undefined, undefined, undefined, res);
    expect(googleOAuth.generateAuthUrl).toHaveBeenCalledWith(
      "tenant",
      "acme",
      undefined,
      "portal",
      false,
      undefined,
      WEB_URL,
    );
  });

  describe("GoogleStartDto", () => {
    const errorsFor = async (body: unknown) =>
      validate(plainToInstance(GoogleStartDto, body as object));

    it("accepts the invite body and an empty body", async () => {
      expect(await errorsFor({ tenant: "acme", context: "portal", inviteToken: "t" })).toHaveLength(
        0,
      );
      expect(await errorsFor({})).toHaveLength(0);
    });

    it.each([[{ context: "admin" }], [{ inviteToken: "" }], [{ tenant: 5 }]])(
      "rejects %j",
      async (body) => {
        expect((await errorsFor(body)).length).toBeGreaterThan(0);
      },
    );
  });
});
