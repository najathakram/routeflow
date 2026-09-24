import { ConfigService } from "@nestjs/config";
import { AuthController } from "./auth.controller";

/**
 * B825: a driver signing in with Google from the Expo mobile-web build was
 * always bounced back to the Next web dashboard, because the callback only
 * ever knew WEB_URL. `resolveReturnOrigin` closes that with an EXACT
 * allow-list match (WEB_URL / MOBILE_WEB_URL) — no prefix/substring match,
 * so a URL that merely starts with an allowed origin is still rejected.
 */
describe("AuthController — B825 resolveReturnOrigin allow-list", () => {
  const WEB_URL = "https://app.routeflow.test";
  const MOBILE_WEB_URL = "https://routeflowmobile-production.up.railway.app";

  function buildController(googleOAuthOverrides: Record<string, any> = {}) {
    const configValues: Record<string, string> = {
      WEB_URL,
      MOBILE_WEB_URL,
      NODE_ENV: "test",
    };
    const configService = {
      get: (key: string) => configValues[key],
    } as unknown as ConfigService;
    const googleOAuth = {
      isConfigured: () => true,
      generateAuthUrl: jest.fn().mockResolvedValue("https://accounts.google.test/o/oauth2/auth"),
      verifyCallback: jest.fn(),
      ...googleOAuthOverrides,
    } as any;
    const controller = new AuthController(
      {} as any, // authService — unused by the google* methods under test
      configService,
      {} as any, // tenantGoogleOAuth — unused (legacy path-param flow)
      googleOAuth,
    );
    return { controller, googleOAuth };
  }

  function encodeState(payload: Record<string, unknown>): string {
    const payloadB64 = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
    // The MAC segment is never read by peekReturnOrigin/peekMobileFlag — only the
    // payload segment is decoded pre-verification, so any placeholder works here.
    return `${payloadB64}.unverified-mac`;
  }

  describe("resolveReturnOrigin (private, exact allow-list)", () => {
    it.each([
      ["no origin", undefined, WEB_URL],
      ["the web origin itself", WEB_URL, WEB_URL],
      ["the mobile-web origin", MOBILE_WEB_URL, MOBILE_WEB_URL],
      ["an unrelated origin", "https://evil.example", WEB_URL],
      [
        "a suffix/prefix attack on the mobile-web origin",
        `${MOBILE_WEB_URL}.evil.example`,
        WEB_URL,
      ],
    ])("%s resolves to the expected origin", (_label, candidate, expected) => {
      const { controller } = buildController();
      expect((controller as any).resolveReturnOrigin(candidate)).toBe(expected);
    });
  });

  describe("GET /auth/google — mints the resolved return_origin into the signed state", () => {
    it("REG-B825: no return_origin query param resolves to WEB_URL", async () => {
      const { controller, googleOAuth } = buildController();
      const res = { status: jest.fn() };
      await controller.googleAuthUrl(
        "acme",
        "staff",
        undefined,
        undefined,
        undefined,
        undefined,
        res,
      );
      expect(googleOAuth.generateAuthUrl).toHaveBeenCalledWith(
        "tenant",
        "acme",
        undefined,
        "staff",
        false,
        undefined,
        WEB_URL,
      );
    });

    it("REG-B825: the mobile-web origin round-trips into generateAuthUrl unchanged", async () => {
      const { controller, googleOAuth } = buildController();
      const res = { status: jest.fn() };
      await controller.googleAuthUrl(
        "acme",
        "staff",
        undefined,
        undefined,
        undefined,
        MOBILE_WEB_URL,
        res,
      );
      expect(googleOAuth.generateAuthUrl).toHaveBeenCalledWith(
        "tenant",
        "acme",
        undefined,
        "staff",
        false,
        undefined,
        MOBILE_WEB_URL,
      );
    });

    it("REG-B825: an unrelated origin is rewritten to WEB_URL before it ever reaches the signed state", async () => {
      const { controller, googleOAuth } = buildController();
      const res = { status: jest.fn() };
      await controller.googleAuthUrl(
        "acme",
        "staff",
        undefined,
        undefined,
        undefined,
        "https://evil.example",
        res,
      );
      expect(googleOAuth.generateAuthUrl).toHaveBeenCalledWith(
        "tenant",
        "acme",
        undefined,
        "staff",
        false,
        undefined,
        WEB_URL,
      );
    });

    it("REG-B825: the native mobile deep-link flow (mobile=1) never resolves a return_origin", async () => {
      const { controller, googleOAuth } = buildController();
      const res = { status: jest.fn() };
      await controller.googleAuthUrl(
        "acme",
        "staff",
        undefined,
        "1",
        undefined,
        MOBILE_WEB_URL,
        res,
      );
      expect(googleOAuth.generateAuthUrl).toHaveBeenCalledWith(
        "tenant",
        "acme",
        undefined,
        "staff",
        true,
        undefined,
        undefined,
      );
    });
  });

  describe("GET /auth/google/callback — redirect target follows the verified/peeked origin", () => {
    it("REG-B825: success path redirects to the verified mobile-web returnOrigin", async () => {
      const { controller, googleOAuth } = buildController({
        verifyCallback: jest.fn().mockResolvedValue({
          returnOrigin: MOBILE_WEB_URL,
          mobile: false,
          linkUserId: undefined,
        }),
        findOrCreateUser: jest.fn().mockResolvedValue({
          kind: "staff",
          accessToken: "at",
          refreshToken: "rt",
          user: { role: "DRIVER", tenantSlug: "acme" },
        }),
        createExchangeCode: jest.fn().mockResolvedValue("one-time-code"),
      });
      const res = { redirect: jest.fn() };
      await controller.googleCallback(
        "auth-code",
        encodeState({ mobile: false, returnOrigin: MOBILE_WEB_URL }),
        undefined as any,
        {} as any,
        res as any,
      );
      expect(googleOAuth.verifyCallback).toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith(
        `${MOBILE_WEB_URL}/auth/google/callback?code=one-time-code`,
      );
    });

    it("REG-B825: success path with no returnOrigin on the profile falls back to WEB_URL (Next web client, unchanged)", async () => {
      const { controller } = buildController({
        verifyCallback: jest.fn().mockResolvedValue({
          returnOrigin: undefined,
          mobile: false,
          linkUserId: undefined,
        }),
        findOrCreateUser: jest.fn().mockResolvedValue({
          kind: "staff",
          accessToken: "at",
          refreshToken: "rt",
          user: { role: "OPERATOR", tenantSlug: "acme" },
        }),
        createExchangeCode: jest.fn().mockResolvedValue("one-time-code"),
      });
      const res = { redirect: jest.fn() };
      await controller.googleCallback(
        "auth-code",
        encodeState({ mobile: false }),
        undefined as any,
        {} as any,
        res as any,
      );
      expect(res.redirect).toHaveBeenCalledWith(
        `${WEB_URL}/auth/google/callback?code=one-time-code`,
      );
    });

    it("REG-B825: oauth_cancelled on an evil peeked returnOrigin still bounces to WEB_URL, never the attacker's origin", async () => {
      const { controller } = buildController();
      const res = { redirect: jest.fn() };
      // An attacker can craft an arbitrary UNSIGNED state for the pre-verification peek —
      // resolveReturnOrigin must re-validate it against the allow-list regardless.
      await controller.googleCallback(
        undefined as any,
        encodeState({ mobile: false, returnOrigin: "https://evil.example" }),
        "access_denied",
        {} as any,
        res as any,
      );
      expect(res.redirect).toHaveBeenCalledWith(
        `${WEB_URL}/auth/google/callback?error=oauth_cancelled`,
      );
    });

    it("REG-B825: oauth_cancelled on a legitimately peeked mobile-web returnOrigin bounces there", async () => {
      const { controller } = buildController();
      const res = { redirect: jest.fn() };
      await controller.googleCallback(
        undefined as any,
        encodeState({ mobile: false, returnOrigin: MOBILE_WEB_URL }),
        "access_denied",
        {} as any,
        res as any,
      );
      expect(res.redirect).toHaveBeenCalledWith(
        `${MOBILE_WEB_URL}/auth/google/callback?error=oauth_cancelled`,
      );
    });

    it("REG-B825: a suffix-attack peeked returnOrigin bounces to WEB_URL, not the attacker's lookalike domain", async () => {
      const { controller } = buildController();
      const res = { redirect: jest.fn() };
      await controller.googleCallback(
        undefined as any,
        encodeState({ mobile: false, returnOrigin: `${MOBILE_WEB_URL}.evil.example` }),
        "access_denied",
        {} as any,
        res as any,
      );
      expect(res.redirect).toHaveBeenCalledWith(
        `${WEB_URL}/auth/google/callback?error=oauth_cancelled`,
      );
    });

    it("REG-B825: missing code/state (state_invalid) also resolves through the same allow-list, not raw state", async () => {
      const { controller } = buildController();
      const res = { redirect: jest.fn() };
      await controller.googleCallback(
        undefined as any,
        undefined as any,
        undefined as any,
        {} as any,
        res as any,
      );
      expect(res.redirect).toHaveBeenCalledWith(
        `${WEB_URL}/auth/google/callback?error=state_invalid`,
      );
    });
  });
});
