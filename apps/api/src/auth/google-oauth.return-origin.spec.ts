import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { GoogleOAuthService, peekOAuthStateReturnOrigin } from "./google-oauth.service";

/**
 * B825: a driver using Google sign-in in the installed (Expo web) driver app
 * looped back to the Next web dashboard instead of the app it started from,
 * because the OAuth state only ever knew "web" (WEB_URL) or "mobile deep
 * link" (routeflow://) — never "this OTHER browser origin". `returnOrigin`
 * closes that gap: minted into the signed state (never a bare query param
 * echoed back — see B349), round-tripped through `verifyCallback`.
 */
describe("GoogleOAuthService — B825 returnOrigin travels inside the signed state", () => {
  const CONFIG_VALUES: Record<string, string> = {
    GOOGLE_REDIRECT_URI_TENANT: "https://example.test/api/v1/auth/google/callback",
    GOOGLE_CLIENT_ID: "test-client-id",
  };

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
      {} as any, // prisma — not reached by generateAuthUrl/verifyCallback's state handling
      {} as unknown as JwtService,
      config,
      {} as any, // email
      { claimsFor: jest.fn().mockResolvedValue(null) } as any, // entitlements
    );
    (service as any).redis = makeMockRedis();
    // Return the raw state instead of a real Google URL — tests only need the state.
    (service as any).oauth2Client = {
      generateAuthUrl: jest.fn((opts: { state: string }) => opts.state),
      getToken: jest.fn().mockResolvedValue({ tokens: { id_token: "id-token" } }),
      verifyIdToken: jest.fn().mockResolvedValue({
        getPayload: () => ({
          sub: "google-user",
          email: "driver@example.com",
          email_verified: true,
          name: "Driver",
          picture: "",
        }),
      }),
    };
    return service;
  }

  it("REG-B825: a minted state carries returnOrigin through to the verified profile", async () => {
    const service = buildService();
    const state = await service.generateAuthUrl(
      "tenant",
      "acme",
      undefined,
      "staff",
      false,
      undefined,
      "https://routeflowmobile-production.up.railway.app",
    );
    const profile = await service.verifyCallback("auth-code", state);
    expect(profile.returnOrigin).toBe("https://routeflowmobile-production.up.railway.app");
  });

  it("REG-B825: no returnOrigin minted -> the verified profile carries none (WEB_URL fallback lives in the controller)", async () => {
    const service = buildService();
    const state = await service.generateAuthUrl("tenant", "acme", undefined, "staff", false);
    const profile = await service.verifyCallback("auth-code", state);
    expect(profile.returnOrigin).toBeUndefined();
  });

  it("REG-B825: tampering the signed state's returnOrigin after minting is rejected (B349's MAC covers this new field too)", async () => {
    const service = buildService();
    const state = await service.generateAuthUrl(
      "tenant",
      "acme",
      undefined,
      "staff",
      false,
      undefined,
      "https://routeflowmobile-production.up.railway.app",
    );
    const [payloadB64, macB64] = state.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8"));
    payload.returnOrigin = "https://evil.example";
    const tamperedPayloadB64 = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
    const tamperedState = `${tamperedPayloadB64}.${macB64}`;

    await expect(service.verifyCallback("auth-code", tamperedState)).rejects.toThrow(
      "state_invalid",
    );
  });

  // WP2A.0: an account link started on the second web address returns there.
  it("WP2A.0: a minted link state carries returnOrigin through to the verified profile", async () => {
    const service = buildService();
    const state = await service.generateLinkUrl("tenant", "user-1", "https://www.acme-next.test");
    const profile = await service.verifyCallback("auth-code", state);
    expect(profile.linkUserId).toBe("user-1");
    expect(profile.returnOrigin).toBe("https://www.acme-next.test");
  });

  it("WP2A.0: a link state minted without a return origin carries none (today's state)", async () => {
    const service = buildService();
    const state = await service.generateLinkUrl("tenant", "user-1");
    const payload = JSON.parse(
      Buffer.from(state.split(".")[0], "base64url").toString("utf-8"),
    ) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["linkUserId", "nonce", "type"]);
    const profile = await service.verifyCallback("auth-code", state);
    expect(profile.returnOrigin).toBeUndefined();
  });

  it("WP2A.0: peekOAuthStateReturnOrigin reads the payload segment and never throws", () => {
    const enc = (o: unknown) =>
      `${Buffer.from(JSON.stringify(o), "utf-8").toString("base64url")}.mac`;
    expect(peekOAuthStateReturnOrigin(enc({ returnOrigin: "https://www.acme-next.test" }))).toBe(
      "https://www.acme-next.test",
    );
    expect(peekOAuthStateReturnOrigin(enc({ returnOrigin: 7 }))).toBeUndefined();
    expect(peekOAuthStateReturnOrigin(enc({}))).toBeUndefined();
    expect(peekOAuthStateReturnOrigin("not-a-state")).toBeUndefined();
    expect(peekOAuthStateReturnOrigin("")).toBeUndefined();
    expect(peekOAuthStateReturnOrigin(undefined)).toBeUndefined();
  });
});
