/**
 * #2495 Opus review fix: `google_account_mismatch` was missing from
 * `PlatformGoogleAuthController.handleCallback`'s `knownCodes` allow-list, so the platform Google
 * callback bounced it to `?error=unknown_error` AND logged it via `logError` as an unhandled
 * failure — noise for a well-understood, user-actionable 409, not a bug.
 */
import { ConflictException } from "@nestjs/common";
import { PlatformGoogleAuthController } from "./platform-google-auth.controller";

function makeController(googleOAuth: any) {
  const configService = {
    get: jest.fn((k: string) => (k === "WEB_URL" ? "http://localhost:3001" : undefined)),
  };
  return new PlatformGoogleAuthController(googleOAuth, configService as any);
}

function makeReqRes() {
  const req = { headers: {} } as any;
  const res = { redirect: jest.fn() } as any;
  return { req, res };
}

describe("PlatformGoogleAuthController.handleCallback — google_account_mismatch pass-through (#2495)", () => {
  it("redirects with error=google_account_mismatch, not unknown_error, and never logs it as unhandled", async () => {
    const googleOAuth = {
      verifyCallback: jest.fn().mockRejectedValue(new ConflictException("google_account_mismatch")),
    };
    const controller = makeController(googleOAuth);
    const { req, res } = makeReqRes();
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await controller.handleCallback("code", "state", "", req, res);

      expect(res.redirect).toHaveBeenCalledWith(
        expect.stringContaining("error=google_account_mismatch"),
      );
      expect(res.redirect).not.toHaveBeenCalledWith(expect.stringContaining("error=unknown_error"));
      // The regression: this used to fall through to logError as an "Unhandled callback error".
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
