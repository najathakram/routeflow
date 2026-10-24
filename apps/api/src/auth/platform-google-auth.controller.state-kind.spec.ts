/**
 * The platform authentication callback only completes platform-type sign-in states. A verified
 * state of any other type must be turned away BEFORE sign-in runs: no user lookup or creation,
 * no account link, no token pair, no exchange code — only the existing `error=unauthorized`
 * redirect.
 */
import { PlatformGoogleAuthController } from "./platform-google-auth.controller";

function makeController(googleOAuth: any) {
  const configService = {
    get: jest.fn((k: string) => (k === "WEB_URL" ? "http://localhost:3001" : undefined)),
  };
  return new PlatformGoogleAuthController(googleOAuth, configService as any);
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
      kind: "buyer",
      accessToken: "a",
      refreshToken: "r",
      sellerCount: 1,
    }),
    linkGoogleAccount: jest.fn().mockResolvedValue(undefined),
    createExchangeCode: jest.fn().mockResolvedValue("x"),
  };
}

const tenantProfile = {
  googleId: "g-1",
  email: "buyer@acme.test",
  type: "tenant",
  tenantSlug: "acme",
};

describe("PlatformGoogleAuthController.handleCallback — non-platform state", () => {
  it("redirects with error=unauthorized and never runs sign-in for a tenant-type state", async () => {
    const googleOAuth = makeGoogleOAuth(tenantProfile);
    const controller = makeController(googleOAuth);
    const { req, res } = makeReqRes();

    await controller.handleCallback("code", "state", "", req, res);

    expect(res.redirect).toHaveBeenCalledTimes(1);
    expect(res.redirect).toHaveBeenCalledWith(
      "http://localhost:3001/platform/auth/callback?error=unauthorized",
    );
    expect(googleOAuth.findOrCreateUser).not.toHaveBeenCalled();
    expect(googleOAuth.createExchangeCode).not.toHaveBeenCalled();
    expect(googleOAuth.linkGoogleAccount).not.toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it("does not link an account for a tenant-type link state either", async () => {
    const googleOAuth = makeGoogleOAuth({ ...tenantProfile, linkUserId: "u-1" });
    const controller = makeController(googleOAuth);
    const { req, res } = makeReqRes();

    await controller.handleCallback("code", "state", "", req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      "http://localhost:3001/platform/auth/callback?error=unauthorized",
    );
    expect(googleOAuth.linkGoogleAccount).not.toHaveBeenCalled();
    expect(googleOAuth.findOrCreateUser).not.toHaveBeenCalled();
    expect(googleOAuth.createExchangeCode).not.toHaveBeenCalled();
  });

  it("still completes a platform-type sign-in through the exchange code", async () => {
    const googleOAuth = makeGoogleOAuth({
      googleId: "g-2",
      email: "sa@acme.test",
      type: "platform",
    });
    googleOAuth.findOrCreateUser.mockResolvedValue({
      kind: "platform",
      accessToken: "a",
      refreshToken: "r",
      user: { id: "u-2", username: "sa", role: "SUPER_ADMIN", tenantId: null, tenantSlug: null },
    });
    const controller = makeController(googleOAuth);
    const { req, res } = makeReqRes();

    await controller.handleCallback("code", "state", "", req, res);

    expect(googleOAuth.findOrCreateUser).toHaveBeenCalledTimes(1);
    expect(googleOAuth.createExchangeCode).toHaveBeenCalledTimes(1);
    expect(res.redirect).toHaveBeenCalledWith(
      "http://localhost:3001/platform/auth/callback?code=x",
    );
  });
});
