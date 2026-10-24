/**
 * Unit tests for StripeConnectCallbackController — REG-2441's two new refusal
 * codes only. `completeOAuth`'s own behavior (which code it throws, when) is
 * covered in stripe-connect.service.spec.ts; this spec pins the controller's
 * OAUTH_ERROR_MESSAGES mapping — the exact, fixed, user-safe copy that
 * reaches the redirect URL for `platform_account_not_allowed` and
 * `platform_account_check_failed`, plus the three workspace-status refusals
 * `workspace_read_only` / `workspace_suspended` / `workspace_cancelled`, each
 * mapped to the SHARED sentence for its status (invariant 12: the public
 * callback must never leak internal exception text).
 *
 * Mock pattern (mockRes) mirrors payment-requests/connect-webhook.controller.spec.ts.
 */

import { BadRequestException } from "@nestjs/common";
import {
  CANCELLED_SENTENCE,
  READ_ONLY_SENTENCE,
  SUSPENDED_SENTENCE,
} from "../../../../packages/types/read-only-copy";
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

  // The API never value-imports @routeflow/types at runtime, so the controller holds literal copies of the
  // shared sentences; asserting against the shared constants here is what pins them byte-equal.
  it.each([
    ["workspace_read_only", READ_ONLY_SENTENCE],
    ["workspace_suspended", SUSPENDED_SENTENCE],
    ["workspace_cancelled", CANCELLED_SENTENCE],
  ])("maps %s to the shared sentence for that status", async (code, sentence) => {
    mockConnect.completeOAuth.mockRejectedValue(new BadRequestException(code));
    const res = mockRes();

    await controller.callback("code", "state", undefined, res);

    const redirected = new URL(res.redirectedTo!);
    expect(redirected.searchParams.get("stripe")).toBe("error");
    expect(redirected.searchParams.get("reason")).toBe(sentence);
  });

  it("the three workspace-status refusals show three distinct sentences", async () => {
    const reasons: string[] = [];
    for (const code of ["workspace_read_only", "workspace_suspended", "workspace_cancelled"]) {
      mockConnect.completeOAuth.mockRejectedValue(new BadRequestException(code));
      const res = mockRes();
      await controller.callback("code", "state", undefined, res);
      reasons.push(new URL(res.redirectedTo!).searchParams.get("reason")!);
    }
    expect(new Set(reasons).size).toBe(3);
    // amount-free, and no tenant / user names
    for (const r of reasons) expect(r).not.toMatch(/[$\d]/);
  });

  it("an unknown code, or a non-BadRequest error, falls back to the generic copy (never echoed)", async () => {
    for (const err of [
      new BadRequestException("workspace_on_fire: acme secret detail"),
      new Error("Stripe SDK blew up: sk_live_nope"),
    ]) {
      mockConnect.completeOAuth.mockRejectedValue(err);
      const res = mockRes();
      await controller.callback("code", "state", undefined, res);
      const redirected = new URL(res.redirectedTo!);
      expect(redirected.searchParams.get("stripe")).toBe("error");
      expect(redirected.searchParams.get("reason")).toBe(
        "Could not connect Stripe — try again from Settings.",
      );
    }
  });
});
