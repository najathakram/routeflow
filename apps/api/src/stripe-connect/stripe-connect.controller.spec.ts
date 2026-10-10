/**
 * Unit tests for StripeConnectCallbackController — REG-2441's two new refusal
 * codes only. `completeOAuth`'s own behavior (which code it throws, when) is
 * covered in stripe-connect.service.spec.ts; this spec pins the controller's
 * OAUTH_ERROR_MESSAGES mapping — the exact, fixed, user-safe copy that
 * reaches the redirect URL for `platform_account_not_allowed` and
 * `platform_account_check_failed` (invariant 12: the public callback must
 * never leak internal exception text).
 *
 * Mock pattern (mockRes) mirrors payment-requests/connect-webhook.controller.spec.ts.
 */

import { BadRequestException } from "@nestjs/common";
import { StripeConnectCallbackController } from "./stripe-connect.controller";
import { StripeConnectService } from "./stripe-connect.service";

/** Minimal express Response double — records the redirect target only. */
function mockRes() {
  const res: any = { redirectedTo: null as string | null };
  res.redirect = jest.fn((url: string) => {
    res.redirectedTo = url;
  });
  return res;
}

describe("StripeConnectCallbackController", () => {
  let controller: StripeConnectCallbackController;
  const mockConnect = { completeOAuth: jest.fn() };

  beforeEach(() => {
    mockConnect.completeOAuth.mockReset();
    controller = new StripeConnectCallbackController(
      mockConnect as unknown as StripeConnectService,
    );
  });

  it("REG-2441: maps platform_account_not_allowed to its exact user-safe message", async () => {
    mockConnect.completeOAuth.mockRejectedValue(
      new BadRequestException("platform_account_not_allowed"),
    );
    const res = mockRes();

    await controller.callback("code", "state", undefined, res);

    const redirected = new URL(res.redirectedTo!);
    expect(redirected.searchParams.get("stripe")).toBe("error");
    expect(redirected.searchParams.get("reason")).toBe(
      "That's RouteFlow's own Stripe account — sign in to your business's Stripe account and try again.",
    );
  });

  it("REG-2441: maps platform_account_check_failed to its exact user-safe message", async () => {
    mockConnect.completeOAuth.mockRejectedValue(
      new BadRequestException("platform_account_check_failed"),
    );
    const res = mockRes();

    await controller.callback("code", "state", undefined, res);

    const redirected = new URL(res.redirectedTo!);
    expect(redirected.searchParams.get("stripe")).toBe("error");
    expect(redirected.searchParams.get("reason")).toBe(
      "Couldn't verify that Stripe account — try connecting again.",
    );
  });
});
