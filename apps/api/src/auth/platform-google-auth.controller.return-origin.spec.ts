/**
 * WP2A.0: a platform-admin Google sign-in or link started on the second web address (`WEB_ORIGINS`)
 * returns to it. With `WEB_ORIGINS` empty everything is byte-identical to before.
 */
import { PlatformGoogleAuthController } from "./platform-google-auth.controller";

const WEB_URL = "https://app.routeflow.test";
const SECOND = "https://www.acme-next.test";
const LOOKALIKE = "https://www.acme-next.test.evil.test";

function makeController(googleOAuth: any, webOrigins: string | undefined = SECOND) {
  const values: Record<string, string | undefined> = {
    WEB_URL,
    NODE_ENV: "test",
    WEB_ORIGINS: webOrigins,
  };
  const configService = { get: jest.fn((k: string) => values[k]) };
  return new PlatformGoogleAuthController(googleOAuth, configService as any);
}

function encodeState(payload: Record<string, unknown>): string {
  return `${Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url")}.unverified-mac`;
}

function makeGoogleOAuth(overrides: Record<string, unknown> = {}) {
  return {
    isConfigured: jest.fn().mockReturnValue(true),
    generateAuthUrl: jest.fn().mockResolvedValue("https://accounts.google.test/auth"),
    generateLinkUrl: jest.fn().mockResolvedValue("https://accounts.google.test/link"),
    verifyCallback: jest.fn().mockResolvedValue({
      googleId: "g-1",
      email: "sa@acme.test",
      type: "platform",
    }),
    findOrCreateUser: jest.fn().mockResolvedValue({
      kind: "platform",
      accessToken: "a",
      refreshToken: "r",
      user: { id: "u-1", username: "sa", role: "SUPER_ADMIN", tenantId: null, tenantSlug: null },
    }),
    linkGoogleAccount: jest.fn().mockResolvedValue(undefined),
    createExchangeCode: jest.fn().mockResolvedValue("x"),
    ...overrides,
  };
}

const makeReqRes = () => ({ req: { headers: {} } as any, res: { redirect: jest.fn() } as any });

describe("PlatformGoogleAuthController — WP2A.0 getAuthUrl", () => {
  it("passes an Origin on the list as the 7th argument of generateAuthUrl", async () => {
    const googleOAuth = makeGoogleOAuth();
    await makeController(googleOAuth).getAuthUrl(SECOND);
    expect(googleOAuth.generateAuthUrl).toHaveBeenCalledWith(
      "platform",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      SECOND,
    );
  });

  it.each([
    ["a look-alike", LOOKALIKE],
    ["WEB_URL itself", WEB_URL],
    ["no Origin", undefined],
    ["an array", [SECOND]],
  ])("%s stores no return origin", async (_label, origin) => {
    const googleOAuth = makeGoogleOAuth();
    await makeController(googleOAuth).getAuthUrl(origin as any);
    expect(googleOAuth.generateAuthUrl.mock.calls[0][6]).toBeUndefined();
  });

  it("with WEB_ORIGINS empty the second address stores nothing (today)", async () => {
    const googleOAuth = makeGoogleOAuth();
    await makeController(googleOAuth, "").getAuthUrl(SECOND);
    expect(googleOAuth.generateAuthUrl.mock.calls[0][6]).toBeUndefined();
  });
});

describe("PlatformGoogleAuthController — WP2A.0 getLinkUrl", () => {
  it("passes an Origin on the list to generateLinkUrl", async () => {
    const googleOAuth = makeGoogleOAuth();
    await makeController(googleOAuth).getLinkUrl({ sub: "u-1" }, SECOND);
    expect(googleOAuth.generateLinkUrl).toHaveBeenCalledWith("platform", "u-1", SECOND);
  });

  it.each([
    ["a look-alike", LOOKALIKE],
    ["no Origin", undefined],
  ])("%s stores no return origin", async (_label, origin) => {
    const googleOAuth = makeGoogleOAuth();
    await makeController(googleOAuth).getLinkUrl({ sub: "u-1" }, origin);
    expect(googleOAuth.generateLinkUrl).toHaveBeenCalledWith("platform", "u-1", undefined);
  });
});

describe("PlatformGoogleAuthController — WP2A.0 handleCallback", () => {
  it("success: a verified profile carrying the second address redirects there", async () => {
    const googleOAuth = makeGoogleOAuth({
      verifyCallback: jest.fn().mockResolvedValue({
        googleId: "g-1",
        email: "sa@acme.test",
        type: "platform",
        returnOrigin: SECOND,
      }),
    });
    const { req, res } = makeReqRes();
    await makeController(googleOAuth).handleCallback(
      "code",
      encodeState({ type: "platform", returnOrigin: SECOND }),
      "",
      req,
      res,
    );
    expect(res.redirect).toHaveBeenCalledWith(`${SECOND}/platform/auth/callback?code=x`);
  });

  it("link: a verified link profile carrying the second address redirects there", async () => {
    const googleOAuth = makeGoogleOAuth({
      verifyCallback: jest.fn().mockResolvedValue({
        googleId: "g-1",
        email: "sa@acme.test",
        type: "platform",
        linkUserId: "u-1",
        returnOrigin: SECOND,
      }),
    });
    const { req, res } = makeReqRes();
    await makeController(googleOAuth).handleCallback(
      "code",
      encodeState({ type: "platform", returnOrigin: SECOND, linkUserId: "u-1" }),
      "",
      req,
      res,
    );
    expect(res.redirect).toHaveBeenCalledWith(`${SECOND}/platform/auth/callback?action=linked`);
  });

  it("unauthorized (tenant-type state) goes back to the second address too", async () => {
    const googleOAuth = makeGoogleOAuth({
      verifyCallback: jest.fn().mockResolvedValue({
        googleId: "g-1",
        email: "b@acme.test",
        type: "tenant",
        returnOrigin: SECOND,
      }),
    });
    const { req, res } = makeReqRes();
    await makeController(googleOAuth).handleCallback(
      "code",
      encodeState({ type: "tenant", returnOrigin: SECOND }),
      "",
      req,
      res,
    );
    expect(res.redirect).toHaveBeenCalledWith(
      `${SECOND}/platform/auth/callback?error=unauthorized`,
    );
  });

  it("cancelled: a peeked second address bounces there", async () => {
    const { req, res } = makeReqRes();
    await makeController(makeGoogleOAuth()).handleCallback(
      "",
      encodeState({ type: "platform", returnOrigin: SECOND }),
      "access_denied",
      req,
      res,
    );
    expect(res.redirect).toHaveBeenCalledWith(
      `${SECOND}/platform/auth/callback?error=oauth_cancelled`,
    );
  });

  it("a verification failure bounces to the peeked second address with the same error code", async () => {
    const googleOAuth = makeGoogleOAuth({
      verifyCallback: jest.fn().mockRejectedValue(new Error("state_invalid")),
    });
    const { req, res } = makeReqRes();
    await makeController(googleOAuth).handleCallback(
      "code",
      encodeState({ type: "platform", returnOrigin: SECOND }),
      "",
      req,
      res,
    );
    expect(res.redirect).toHaveBeenCalledWith(
      `${SECOND}/platform/auth/callback?error=state_invalid`,
    );
  });

  it("a peeked look-alike bounces to WEB_URL", async () => {
    const { req, res } = makeReqRes();
    await makeController(makeGoogleOAuth()).handleCallback(
      "",
      encodeState({ type: "platform", returnOrigin: LOOKALIKE }),
      "access_denied",
      req,
      res,
    );
    expect(res.redirect).toHaveBeenCalledWith(
      `${WEB_URL}/platform/auth/callback?error=oauth_cancelled`,
    );
  });

  it("an unreadable state bounces to WEB_URL", async () => {
    const { req, res } = makeReqRes();
    await makeController(makeGoogleOAuth()).handleCallback(
      "",
      "garbage",
      "access_denied",
      req,
      res,
    );
    expect(res.redirect).toHaveBeenCalledWith(
      `${WEB_URL}/platform/auth/callback?error=oauth_cancelled`,
    );
  });

  it("with WEB_ORIGINS empty a state naming the second address still redirects to WEB_URL (today)", async () => {
    const googleOAuth = makeGoogleOAuth({
      verifyCallback: jest.fn().mockResolvedValue({
        googleId: "g-1",
        email: "sa@acme.test",
        type: "platform",
        returnOrigin: SECOND,
      }),
    });
    const { req, res } = makeReqRes();
    await makeController(googleOAuth, "").handleCallback(
      "code",
      encodeState({ type: "platform", returnOrigin: SECOND }),
      "",
      req,
      res,
    );
    expect(res.redirect).toHaveBeenCalledWith(`${WEB_URL}/platform/auth/callback?code=x`);
  });
});
