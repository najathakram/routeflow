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
import {
  StripeConnectCallbackController,
  StripeConnectController,
} from "./stripe-connect.controller";
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

describe("WP2A.0: the Stripe Connect legs return to the address the link started on", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  const stateWith = (ro: unknown) =>
    `h.${Buffer.from(JSON.stringify({ ro })).toString("base64url")}.s`;
  const redirectFor = async (state: string) => {
    const mockConnect = {
      completeOAuth: jest.fn().mockResolvedValue({ chargesEnabled: true }),
    };
    const controller = new StripeConnectCallbackController(
      mockConnect as unknown as StripeConnectService,
    );
    const res = mockRes();
    await controller.callback("code", state, undefined, res);
    return res.redirectedTo as string;
  };

  it("link hands the request Origin to buildAuthorizeUrl as its last argument", async () => {
    const connect = { buildAuthorizeUrl: jest.fn().mockResolvedValue("https://connect.test/x") };
    const controller = new StripeConnectController(connect as unknown as StripeConnectService);
    await controller.link(
      { tenantId: "t1", sub: "u1", username: "alice" } as any,
      "https://www.acme-next.test",
    );
    expect(connect.buildAuthorizeUrl).toHaveBeenCalledWith(
      "t1",
      "u1",
      "alice",
      "https://www.acme-next.test",
    );
  });

  it("a state carrying an extra origin redirects back to that origin", async () => {
    process.env.WEB_URL = "https://app.routeflow.test";
    process.env.WEB_ORIGINS = "https://www.acme-next.test";
    expect(await redirectFor(stateWith("https://www.acme-next.test"))).toBe(
      "https://www.acme-next.test/settings?stripe=connected&charges=enabled",
    );
  });

  it("a look-alike origin in the state falls back to WEB_URL", async () => {
    process.env.WEB_URL = "https://app.routeflow.test";
    process.env.WEB_ORIGINS = "https://www.acme-next.test";
    expect(await redirectFor(stateWith("https://www.acme-next.test.evil.test"))).toBe(
      "https://app.routeflow.test/settings?stripe=connected&charges=enabled",
    );
  });

  it("with WEB_ORIGINS empty the redirect is exactly today's WEB_URL one", async () => {
    process.env.WEB_URL = "https://app.routeflow.test";
    delete process.env.WEB_ORIGINS;
    expect(await redirectFor(stateWith("https://www.acme-next.test"))).toBe(
      "https://app.routeflow.test/settings?stripe=connected&charges=enabled",
    );
  });

  it("the error redirects use the same origin", async () => {
    process.env.WEB_URL = "https://app.routeflow.test";
    process.env.WEB_ORIGINS = "https://www.acme-next.test";
    const controller = new StripeConnectCallbackController({
      completeOAuth: jest.fn().mockRejectedValue(new BadRequestException("state_replayed")),
    } as unknown as StripeConnectService);
    const res = mockRes();
    await controller.callback("code", stateWith("https://www.acme-next.test"), undefined, res);
    expect(res.redirectedTo).toMatch(/^https:\/\/www\.acme-next\.test\/settings\?stripe=error/);
  });
});
