/**
 * The tenant authentication callback never completes a platform-type sign-in state. Platform
 * accounts sign in only through the platform callback, so a verified state of platform type must be
 * turned away BEFORE sign-in runs: no user lookup, no account link, no token pair, no exchange
 * code, no cookie — only the existing `error=unauthorized` redirect on the rejection target.
 */
import { AuthController } from "./auth.controller";

const WEB_URL = "http://localhost:3001";

function makeController(googleOAuth: any) {
  const configService = {
    get: jest.fn((k: string) => (k === "WEB_URL" ? WEB_URL : undefined)),
  };
  return new AuthController(
    {} as any, // authService — not reached by googleCallback
    configService as any,
    googleOAuth,
    {} as any, // staffHandoff — not reached by googleCallback
    {} as any, // appleOAuth — not reached by googleCallback
  );
}

function makeReqRes() {
  const req = { headers: {} } as any;
  const res = { redirect: jest.fn(), cookie: jest.fn() } as any;
  return { req, res };
}

function makeGoogleOAuth(profile: Record<string, unknown>) {
  return {
    verifyCallback: jest.fn().mockResolvedValue(profile),
    findOrCreateUser: jest.fn().mockResolvedValue({
      kind: "staff",
      accessToken: "a",
      refreshToken: "r",
      user: { id: "u-1", username: "ops", role: "OPERATOR", tenantId: "t-1", tenantSlug: "acme" },
    }),
    linkGoogleAccount: jest.fn().mockResolvedValue(undefined),
    createExchangeCode: jest.fn().mockResolvedValue("x"),
  };
}

function expectNothingMinted(googleOAuth: ReturnType<typeof makeGoogleOAuth>, res: any) {
  expect(googleOAuth.findOrCreateUser).not.toHaveBeenCalled();
  expect(googleOAuth.linkGoogleAccount).not.toHaveBeenCalled();
  expect(googleOAuth.createExchangeCode).not.toHaveBeenCalled();
  expect(res.cookie).not.toHaveBeenCalled();
}

const platformProfile = { googleId: "g-1", email: "sa@acme.test", type: "platform" };

describe("AuthController.googleCallback — platform-type state", () => {
  it("redirects with error=unauthorized and never runs sign-in for a platform-type state", async () => {
    const googleOAuth = makeGoogleOAuth(platformProfile);
    const controller = makeController(googleOAuth);
    const { req, res } = makeReqRes();

    await controller.googleCallback("code", "state", "", req, res);

    expect(googleOAuth.verifyCallback).toHaveBeenCalledTimes(1);
    expect(res.redirect).toHaveBeenCalledTimes(1);
    expect(res.redirect).toHaveBeenCalledWith(`${WEB_URL}/auth/google/callback?error=unauthorized`);
    expectNothingMinted(googleOAuth, res);
  });

  it("does not link an account for a platform-type link state either", async () => {
    const googleOAuth = makeGoogleOAuth({ ...platformProfile, linkUserId: "u-1" });
    const controller = makeController(googleOAuth);
    const { req, res } = makeReqRes();

    await controller.googleCallback("code", "state", "", req, res);

    expect(res.redirect).toHaveBeenCalledWith(`${WEB_URL}/auth/google/callback?error=unauthorized`);
    expectNothingMinted(googleOAuth, res);
  });

  it("issues no deep-link tokens for a platform-type state on the mobile flow", async () => {
    const googleOAuth = makeGoogleOAuth({ ...platformProfile, mobile: true });
    const controller = makeController(googleOAuth);
    const { req, res } = makeReqRes();

    await controller.googleCallback("code", "state", "", req, res);

    expect(res.redirect).toHaveBeenCalledTimes(1);
    const target = String(res.redirect.mock.calls[0][0]);
    expect(target).toContain("error=unauthorized");
    expect(target).not.toContain("accessToken");
    expectNothingMinted(googleOAuth, res);
  });

  it("still completes a tenant-type sign-in through the exchange code", async () => {
    const googleOAuth = makeGoogleOAuth({
      googleId: "g-2",
      email: "ops@acme.test",
      type: "tenant",
      tenantSlug: "acme",
    });
    const controller = makeController(googleOAuth);
    const { req, res } = makeReqRes();

    await controller.googleCallback("code", "state", "", req, res);

    expect(googleOAuth.findOrCreateUser).toHaveBeenCalledTimes(1);
    expect(googleOAuth.createExchangeCode).toHaveBeenCalledTimes(1);
    expect(res.redirect).toHaveBeenCalledWith(`${WEB_URL}/auth/google/callback?code=x`);
  });
});
