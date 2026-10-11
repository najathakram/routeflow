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

  function buildController(
    googleOAuthOverrides: Record<string, any> = {},
    configOverrides: Record<string, string | undefined> = {},
  ) {
    const configValues: Record<string, string | undefined> = {
      WEB_URL,
      MOBILE_WEB_URL,
      NODE_ENV: "test",
      ...configOverrides,
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
      {} as any, // staffHandoff (#2653) — unused by the google* methods under test
      {} as any, // appleOAuth — unused by the google* methods under test
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
      // SA-132/Opus round: exact `===` is never relaxed for the candidate,
      // even though `normalizeOrigin` now canonicalizes the CONFIGURED side.
      [
        "a userinfo trick (the real host is after the @, not before)",
        `${MOBILE_WEB_URL}@evil.example`,
        WEB_URL,
      ],
      [
        "an http: downgrade of the mobile-web origin",
        "http://routeflowmobile-production.up.railway.app",
        WEB_URL,
      ],
      ["a trailing slash on the mobile-web origin", `${MOBILE_WEB_URL}/`, WEB_URL],
      ["an uppercased mobile-web origin", MOBILE_WEB_URL.toUpperCase(), WEB_URL],
      ["an empty string", "", WEB_URL],
    ])("%s resolves to the expected origin", (_label, candidate, expected) => {
      const { controller } = buildController();
      expect((controller as any).resolveReturnOrigin(candidate)).toBe(expected);
    });

    it("REG-SA132: a repeated query param (bound as an array, not a string) is rejected, not coerced", () => {
      const { controller } = buildController();
      // NestJS binds `?return_origin=a&return_origin=b` as string[] at runtime
      // regardless of the controller's declared `string | undefined` type.
      expect((controller as any).resolveReturnOrigin([MOBILE_WEB_URL, MOBILE_WEB_URL])).toBe(
        WEB_URL,
      );
    });

    it("REG-SA132: logs only the parsed origin of a rejected candidate, never the raw string", () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      const { controller } = buildController();
      (controller as any).resolveReturnOrigin(`${MOBILE_WEB_URL}@evil.example/some/path?leak=1`);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("https://evil.example"));
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("leak=1"));
      warnSpy.mockRestore();
    });

    it("does not warn at all when there is no candidate (the Next web client's ordinary flow)", () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      const { controller } = buildController();
      warnSpy.mockClear(); // drop the constructor's own boot-time warnings, if any
      (controller as any).resolveReturnOrigin(undefined);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("REG-SA132: MOBILE_WEB_URL fails closed when unset or blank", () => {
    it.each([
      ["unset", undefined],
      ["blank", ""],
    ])(
      "%s MOBILE_WEB_URL: the allow-list accepts WEB_URL only, even the real prod origin is rejected",
      (_label, mobileWebUrlValue) => {
        const { controller } = buildController({}, { MOBILE_WEB_URL: mobileWebUrlValue });
        expect((controller as any).resolveReturnOrigin(MOBILE_WEB_URL)).toBe(WEB_URL);
        expect((controller as any).resolveReturnOrigin(undefined)).toBe(WEB_URL);
      },
    );

    it("warns exactly once at boot when MOBILE_WEB_URL is unset", () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      buildController({}, { MOBILE_WEB_URL: undefined });
      const mobileWarnCalls = warnSpy.mock.calls.filter((args) =>
        String(args[0]).includes("MOBILE_WEB_URL is not set"),
      );
      expect(mobileWarnCalls).toHaveLength(1);
      warnSpy.mockRestore();
    });

    it("warns exactly once at boot when MOBILE_WEB_URL is blank", () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      buildController({}, { MOBILE_WEB_URL: "" });
      const mobileWarnCalls = warnSpy.mock.calls.filter((args) =>
        String(args[0]).includes("MOBILE_WEB_URL is not set"),
      );
      expect(mobileWarnCalls).toHaveLength(1);
      warnSpy.mockRestore();
    });

    it("does NOT warn about MOBILE_WEB_URL when it's configured", () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      buildController();
      const mobileWarnCalls = warnSpy.mock.calls.filter((args) =>
        String(args[0]).includes("MOBILE_WEB_URL is not set"),
      );
      expect(mobileWarnCalls).toHaveLength(0);
      warnSpy.mockRestore();
    });
  });

  describe("REG-SA132: normalizeOrigin canonicalizes only the CONFIGURED side", () => {
    it("a trailing slash on the configured MOBILE_WEB_URL still matches the canonical candidate", () => {
      const { controller } = buildController({}, { MOBILE_WEB_URL: `${MOBILE_WEB_URL}/` });
      expect((controller as any).resolveReturnOrigin(MOBILE_WEB_URL)).toBe(MOBILE_WEB_URL);
    });

    it("an unparseable configured MOBILE_WEB_URL falls back to the raw value rather than crashing boot", () => {
      expect(() => buildController({}, { MOBILE_WEB_URL: "not a url" })).not.toThrow();
    });
  });

  describe("GET /auth/google — mints the resolved return_origin into the signed state", () => {
    it("REG-B825: no return_origin query param resolves to WEB_URL", async () => {
      const { controller, googleOAuth } = buildController();
      const res = { status: jest.fn() };
      await controller.googleAuthUrl("acme", "staff", undefined, undefined, undefined, res);
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
      await controller.googleAuthUrl("acme", "staff", undefined, undefined, MOBILE_WEB_URL, res);
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
      await controller.googleAuthUrl("acme", "staff", "1", undefined, MOBILE_WEB_URL, res);
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
