/**
 * #2495 Opus review fix: `google_account_mismatch` (the 409 GoogleOAuthService throws when an
 * email match is already bound to a DIFFERENT Google sub) was missing from
 * `AuthController.mapErrorCode`'s allow-list, so the tenant Google callback bounced it to the
 * frontend as `?error=unknown_error` — losing the specific "sign in with your linked account or
 * your password" copy the web callback page shows for it.
 */
import { ConflictException } from "@nestjs/common";
import { AuthController } from "./auth.controller";

function makeController(googleOAuth: any) {
  const configService = {
    get: jest.fn((k: string) => (k === "WEB_URL" ? "http://localhost:3001" : undefined)),
  };
  return new AuthController(
    {} as any, // authService — not reached by googleCallback
    configService as any,
    googleOAuth,
    {} as any, // staffHandoff (#2653) — not reached by googleCallback
    {} as any, // appleOAuth — not reached by googleCallback
  );
}

function makeReqRes() {
  const req = { headers: {} } as any;
  const res = { redirect: jest.fn() } as any;
  return { req, res };
}

describe("AuthController.googleCallback — google_account_mismatch pass-through (#2495)", () => {
  it("redirects with error=google_account_mismatch, not unknown_error", async () => {
    const googleOAuth = {
      verifyCallback: jest.fn().mockRejectedValue(new ConflictException("google_account_mismatch")),
    };
    const controller = makeController(googleOAuth);
    const { req, res } = makeReqRes();

    await controller.googleCallback("code", "state", "", req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining("error=google_account_mismatch"),
    );
    expect(res.redirect).not.toHaveBeenCalledWith(expect.stringContaining("error=unknown_error"));
  });
});
