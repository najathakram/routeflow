/**
 * SEC-4 / F11-002 — httpOnly refresh-cookie behaviour on the staff auth
 * controller. The cookie is purely ADDITIVE: the body still carries the refresh
 * token (so mobile + the current web client are unaffected), and the refresh
 * endpoint reads the cookie FIRST but falls back to the body.
 */
import { UnauthorizedException } from "@nestjs/common";
import { AuthController } from "./auth.controller";

function makeController(authService: any) {
  const configService = {
    get: jest.fn((k: string) => (k === "WEB_URL" ? "http://localhost:3001" : undefined)),
  };
  return new AuthController(authService, configService as any, {} as any, {} as any);
}

function makeRes() {
  return { cookie: jest.fn(), clearCookie: jest.fn(), status: jest.fn() } as any;
}

const USER = { id: "user-1" };

describe("AuthController — refresh cookie (SEC-4 / F11-002)", () => {
  it("login sets rf_refresh as httpOnly/Secure/SameSite=Lax scoped to /api/v1/auth", async () => {
    const authService = {
      login: jest
        .fn()
        .mockResolvedValue({ accessToken: "a", refreshToken: "REFRESH_TOK", user: USER }),
    };
    const controller = makeController(authService);
    const res = makeRes();

    const result = await controller.login(USER, {} as any, { headers: {} }, res);

    // Body still carries the token — nothing removed.
    expect(result).toMatchObject({ accessToken: "a", refreshToken: "REFRESH_TOK" });
    expect(res.cookie).toHaveBeenCalledWith(
      "rf_refresh",
      "REFRESH_TOK",
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/api/v1/auth",
      }),
    );
  });

  it("refresh reads the token from the cookie when the body is empty", async () => {
    const authService = {
      refresh: jest
        .fn()
        .mockResolvedValue({ accessToken: "a2", refreshToken: "ROTATED", user: USER }),
    };
    const controller = makeController(authService);
    const res = makeRes();
    const req = { headers: { cookie: "other=x; rf_refresh=COOKIE_TOK; foo=bar" } };

    await controller.refresh({} as any, req, res);

    expect(authService.refresh).toHaveBeenCalledWith("COOKIE_TOK", expect.anything());
    // Rotated token is written back to the cookie.
    expect(res.cookie).toHaveBeenCalledWith("rf_refresh", "ROTATED", expect.any(Object));
  });

  it("refresh falls back to the body token (mobile path — no cookie)", async () => {
    const authService = {
      refresh: jest.fn().mockResolvedValue({ accessToken: "a3", refreshToken: "r3", user: USER }),
    };
    const controller = makeController(authService);
    const res = makeRes();
    const req = { headers: {} };

    await controller.refresh({ refreshToken: "BODY_TOK" }, req, res);

    expect(authService.refresh).toHaveBeenCalledWith("BODY_TOK", expect.anything());
  });

  it("refresh prefers the cookie over a body token when both are present", async () => {
    const authService = {
      refresh: jest.fn().mockResolvedValue({ accessToken: "a4", refreshToken: "r4", user: USER }),
    };
    const controller = makeController(authService);
    const req = { headers: { cookie: "rf_refresh=COOKIE_TOK" } };

    await controller.refresh({ refreshToken: "BODY_TOK" }, req, makeRes());

    expect(authService.refresh).toHaveBeenCalledWith("COOKIE_TOK", expect.anything());
  });

  it("refresh throws Unauthorized when neither cookie nor body carries a token", async () => {
    const authService = { refresh: jest.fn() };
    const controller = makeController(authService);

    await expect(controller.refresh({} as any, { headers: {} }, makeRes())).rejects.toThrow(
      UnauthorizedException,
    );
    expect(authService.refresh).not.toHaveBeenCalled();
  });

  it("logout clears the refresh cookie and revokes server-side", async () => {
    const authService = { logout: jest.fn().mockResolvedValue({ message: "Logged out" }) };
    const controller = makeController(authService);
    const res = makeRes();

    await controller.logout(USER, res);

    expect(res.clearCookie).toHaveBeenCalledWith(
      "rf_refresh",
      expect.objectContaining({ path: "/api/v1/auth", httpOnly: true }),
    );
    expect(authService.logout).toHaveBeenCalledWith("user-1");
  });
});

describe("AuthController.logout under impersonation (B138)", () => {
  it("REG-B138 an impersonated caller's logout clears the cookie and revokes NOTHING", async () => {
    const authService = {
      logout: jest.fn().mockResolvedValue({ message: "Logged out successfully" }),
    };
    const controller = makeController(authService);
    const res = makeRes();

    const result = await controller.logout({ id: "ta1", impersonatedBy: "sa1" } as any, res);

    expect(res.clearCookie).toHaveBeenCalledWith(
      "rf_refresh",
      expect.objectContaining({ path: "/api/v1/auth" }),
    );
    expect(authService.logout).not.toHaveBeenCalled();
    expect(result).toEqual({ message: "Impersonation session ended" });
  });

  it("pin (B138): an ordinary logout still revokes the caller's refresh tokens", async () => {
    const authService = {
      logout: jest.fn().mockResolvedValue({ message: "Logged out successfully" }),
    };
    const controller = makeController(authService);
    const res = makeRes();

    await controller.logout({ id: "u1" } as any, res);

    expect(authService.logout).toHaveBeenCalledTimes(1);
    expect(authService.logout).toHaveBeenCalledWith("u1");
    expect(res.clearCookie).toHaveBeenCalledWith("rf_refresh", expect.anything());
  });
});
