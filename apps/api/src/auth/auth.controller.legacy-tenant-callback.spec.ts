/**
 * The legacy tenant sign-in callback (`GET /auth/google/:tenantSlug/callback`) hands tokens to
 * the browser through a one-time code: it stores the same staff bundle the main Google callback
 * stores, redirects to the web page that already redeems codes via `POST /auth/google/exchange`,
 * and never puts a token in the redirect URL. A failed sign-in redirects with a fixed error code.
 */
import { AuthController } from "./auth.controller";

const WEB_URL = "https://app.routeflow.test";
const ACCESS = "access-token-value-123";
const REFRESH = "refresh-token-value-456";
const EXCHANGE_CODE = "one-time-code-789";

function makeController(opts: {
  exchangeCode?: jest.Mock;
  login?: jest.Mock;
  createExchangeCode?: jest.Mock;
}) {
  const configService = {
    get: jest.fn((k: string) => (k === "WEB_URL" ? WEB_URL : undefined)),
  };
  const tenantGoogleOAuth = {
    exchangeCode:
      opts.exchangeCode ??
      jest.fn().mockResolvedValue({
        id: "u-1",
        username: "ops",
        email: "ops@acme.test",
        role: "OPERATOR",
        status: "ACTIVE",
        tenantId: "t-1",
      }),
  };
  const authService = {
    login:
      opts.login ??
      jest.fn().mockResolvedValue({
        accessToken: ACCESS,
        refreshToken: REFRESH,
        user: { id: "u-1", username: "ops", role: "OPERATOR", tenantId: "t-1", tenantSlug: "acme" },
      }),
  };
  const googleOAuth = {
    createExchangeCode: opts.createExchangeCode ?? jest.fn().mockResolvedValue(EXCHANGE_CODE),
  };
  const controller = new AuthController(
    authService as any,
    configService as any,
    tenantGoogleOAuth as any,
    googleOAuth as any,
    {} as any, // staffHandoff — not reached by the legacy callback
    {} as any, // appleOAuth — not reached by the legacy callback
  );
  return { controller, authService, tenantGoogleOAuth, googleOAuth };
}

function makeRes() {
  return { redirect: jest.fn(), cookie: jest.fn() } as any;
}

function redirectTarget(res: any): string {
  expect(res.redirect).toHaveBeenCalledTimes(1);
  return String(res.redirect.mock.calls[0][0]);
}

function expectNoTokenIn(target: string) {
  expect(target).not.toContain(ACCESS);
  expect(target).not.toContain(REFRESH);
  expect(target).not.toContain("accessToken=");
  expect(target).not.toContain("refreshToken=");
}

describe("AuthController.tenantGoogleCallback — one-time code handoff", () => {
  it("redirects with a one-time code and no token in the URL", async () => {
    const { controller, googleOAuth } = makeController({});
    const res = makeRes();

    await controller.tenantGoogleCallback("acme", { query: { code: "g-code" } }, res);

    const target = redirectTarget(res);
    expect(target).toContain(`code=${EXCHANGE_CODE}`);
    expectNoTokenIn(target);
    expect(googleOAuth.createExchangeCode).toHaveBeenCalledTimes(1);
  });

  it("stores the same staff bundle the main Google callback stores", async () => {
    const { controller, googleOAuth } = makeController({});
    const res = makeRes();

    await controller.tenantGoogleCallback("acme", { query: { code: "g-code" } }, res);

    expect(googleOAuth.createExchangeCode).toHaveBeenCalledWith({
      accessToken: ACCESS,
      refreshToken: REFRESH,
      role: "OPERATOR",
      tenantSlug: "acme",
    });
  });

  it("targets the web page that redeems the code", async () => {
    const { controller } = makeController({});
    const res = makeRes();

    await controller.tenantGoogleCallback("acme", { query: { code: "g-code" } }, res);

    expect(res.redirect).toHaveBeenCalledWith(
      `${WEB_URL}/auth/google/callback?code=${EXCHANGE_CODE}`,
    );
  });

  it("keeps the oauth_cancelled redirect when Google returns no code", async () => {
    const { controller, tenantGoogleOAuth, googleOAuth } = makeController({});
    const res = makeRes();

    await controller.tenantGoogleCallback("acme", { query: {} }, res);

    expect(res.redirect).toHaveBeenCalledWith(`${WEB_URL}/auth/error?message=oauth_cancelled`);
    expect(tenantGoogleOAuth.exchangeCode).not.toHaveBeenCalled();
    expect(googleOAuth.createExchangeCode).not.toHaveBeenCalled();
  });

  it("redirects with a fixed error code when the Google code exchange fails", async () => {
    const { controller, authService, googleOAuth } = makeController({
      exchangeCode: jest.fn().mockRejectedValue(new Error("internal detail that must not leak")),
    });
    const res = makeRes();

    await controller.tenantGoogleCallback("acme", { query: { code: "g-code" } }, res);

    const target = redirectTarget(res);
    expect(target).toBe(`${WEB_URL}/auth/google/callback?error=unknown_error`);
    expect(target).not.toContain("internal detail");
    expectNoTokenIn(target);
    expect(authService.login).not.toHaveBeenCalled();
    expect(googleOAuth.createExchangeCode).not.toHaveBeenCalled();
  });

  it("passes a known sign-in rejection through as its fixed code", async () => {
    const { controller, authService } = makeController({
      exchangeCode: jest.fn().mockRejectedValue(new Error("unauthorized")),
    });
    const res = makeRes();

    await controller.tenantGoogleCallback("acme", { query: { code: "g-code" } }, res);

    expect(redirectTarget(res)).toBe(`${WEB_URL}/auth/google/callback?error=unauthorized`);
    expect(authService.login).not.toHaveBeenCalled();
  });

  it("redirects with a fixed error code when the session cannot be issued", async () => {
    const { controller, googleOAuth } = makeController({
      login: jest.fn().mockRejectedValue(new Error("Tenant not found")),
    });
    const res = makeRes();

    await controller.tenantGoogleCallback("acme", { query: { code: "g-code" } }, res);

    const target = redirectTarget(res);
    expect(target).toBe(`${WEB_URL}/auth/google/callback?error=unknown_error`);
    expect(googleOAuth.createExchangeCode).not.toHaveBeenCalled();
  });

  it("redirects with a fixed error code when the one-time code cannot be stored", async () => {
    const { controller } = makeController({
      createExchangeCode: jest.fn().mockRejectedValue(new Error("store unavailable")),
    });
    const res = makeRes();

    await controller.tenantGoogleCallback("acme", { query: { code: "g-code" } }, res);

    const target = redirectTarget(res);
    expect(target).toBe(`${WEB_URL}/auth/google/callback?error=unknown_error`);
    expectNoTokenIn(target);
  });
});
