import { ConflictException, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { NO_IMPERSONATION_KEY } from "../auth/guards/no-impersonation.guard";
import { SettingsBillingController } from "./settings-billing.controller";
import { SELF_PAY_REASONS } from "./self-checkout-eligibility";

/**
 * SA-1547 PR-3 (ruling 2026-11-26, section 2): the checkout route is driven by the eligibility the server already
 * computed (`selfPay`), not by the plan key alone. R1 (TRIAL with days left gets no session), R2 (a trial-expired
 * business gets one), R4 (the wire carries `selfPay`), R5 (an operator or a support session never sees Pay now).
 */
const SELF_PAY_OK = {
  eligible: true,
  reason: "trial_expired",
  planKey: "STARTER",
  planName: "Starter",
  monthly: 99,
  addons: [],
  firstFullChargeAt: new Date("2026-12-01T12:00:00.000Z"),
};
const SELF_PAY_TRIAL = { ...SELF_PAY_OK, eligible: false, reason: "trial_active" };

function make(selfPay: unknown, planKey = "STARTER", cardFirst?: boolean) {
  const subscription = {
    getSubscription: jest.fn().mockResolvedValue({ planKey, selfPay }),
  } as any;
  const billing = {
    createCheckoutSession: jest
      .fn()
      .mockResolvedValue({ uiMode: "hosted", checkoutUrl: "https://checkout.stripe.test/x" }),
  } as any;
  const controller = new SettingsBillingController(
    subscription,
    {} as any,
    {} as any,
    billing,
    {} as any,
    cardFirst === undefined ? undefined : ({ isEnabled: async () => cardFirst } as any),
  );
  return { controller, subscription, billing };
}

describe("SettingsBillingController.createCheckout: Pay now follows selfPay (R1, R2)", () => {
  it("R1: a TRIAL business with days left calls the route and is refused; no session is opened", async () => {
    const { controller, billing } = make(SELF_PAY_TRIAL);
    await expect(controller.createCheckout({ tenantId: "t1", sub: "u1" } as any)).rejects.toThrow();
    expect(billing.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("R2: a trial-expired business opens a TENANT_SELF session for its own pinned plan", async () => {
    const { controller, billing } = make(SELF_PAY_OK);
    const out = await controller.createCheckout({ tenantId: "t1", sub: "u1" } as any);
    expect(billing.createCheckoutSession).toHaveBeenCalledWith("t1", { surface: "TENANT_SELF" });
    expect(out).toEqual({ uiMode: "hosted", checkoutUrl: "https://checkout.stripe.test/x" });
  });

  it("a view with no selfPay (an unreadable state) is refused, never allowed by default", async () => {
    const { controller, billing } = make(undefined);
    await expect(controller.createCheckout({ tenantId: "t1" } as any)).rejects.toThrow();
    expect(billing.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("the refusal names the coded reason so a client can print the right sentence", async () => {
    const { controller } = make(SELF_PAY_TRIAL);
    await expect(controller.createCheckout({ tenantId: "t1" } as any)).rejects.toMatchObject({
      response: expect.objectContaining({ reason: "trial_active" }),
    });
  });

  it("the route still takes no request body (a plan pick is PR-5)", () => {
    expect(SettingsBillingController.prototype.createCheckout.length).toBe(1);
  });
});

describe("SettingsBillingController.getSubscription: selfPay on the wire (R4, R5)", () => {
  it("R4: a TENANT_ADMIN gets selfPay whole: plan name, price, add-ons, the anchor", async () => {
    const { controller } = make(SELF_PAY_OK);
    const view: any = await controller.getSubscription({
      tenantId: "t1",
      role: "TENANT_ADMIN",
    } as any);
    expect(view.selfPay).toEqual(SELF_PAY_OK);
  });

  it("R5: an OPERATOR never sees eligible true", async () => {
    const { controller } = make(SELF_PAY_OK);
    const view: any = await controller.getSubscription({ tenantId: "t1", role: "OPERATOR" } as any);
    expect(view.selfPay.eligible).toBe(false);
  });

  it("R5: an impersonating super admin never sees eligible true", async () => {
    const { controller } = make(SELF_PAY_OK);
    const view: any = await controller.getSubscription({
      tenantId: "t1",
      role: "TENANT_ADMIN",
      impersonatedBy: "sa1",
    } as any);
    expect(view.selfPay.eligible).toBe(false);
  });
});

describe("the checkout route's guards (R5 guard: already true on master)", () => {
  const reflector = new Reflector();
  const handler = SettingsBillingController.prototype.createCheckout;
  it("is TENANT_ADMIN only and refused in a support session", () => {
    expect(reflector.get(ROLES_KEY, handler)).toEqual(["TENANT_ADMIN"]);
    expect(reflector.get(NO_IMPERSONATION_KEY, handler)).toBe("billing");
  });
});

const rejects = async (p: Promise<unknown>): Promise<any> => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
};

describe("SA-1547 PR-5a: the checkout route says ask-for-a-link for an ACTIVE business with no card", () => {
  const ACTIVE_NO_CARD = { ...SELF_PAY_OK, eligible: false, reason: "active_no_card" };
  const call = (selfPay: unknown, flag?: boolean) => {
    const { controller, billing } = make(selfPay, "STARTER", flag);
    return { billing, run: () => controller.createCheckout({ tenantId: "t1" } as any) };
  };

  it("flag ON: a coded 409 PLAN_PICK_ASK_FOR_LINK, not a bare 403; no session is opened", async () => {
    const { run, billing } = call(ACTIVE_NO_CARD, true);
    const e = await rejects(run());
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toEqual({
      code: API_ERROR_CODES.PLAN_PICK_ASK_FOR_LINK,
      message: "Ask us for a payment link.",
    });
    expect(billing.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("flag OFF or absent: the 403 it is today, reason kept", async () => {
    for (const flag of [false, undefined]) {
      const e = await rejects(call(ACTIVE_NO_CARD, flag).run());
      expect(e).toBeInstanceOf(ForbiddenException);
      expect(e.getResponse()).toMatchObject({ reason: "active_no_card" });
    }
  });

  it("every other ineligible reason keeps its 403 and reason, flag ON or OFF", async () => {
    // in-lane MINOR: every reason but active_no_card, so a new reason cannot silently change its 403
    for (const reason of SELF_PAY_REASONS.filter((r) => r !== "active_no_card")) {
      for (const flag of [true, false]) {
        const e = await rejects(call({ ...SELF_PAY_OK, eligible: false, reason }, flag).run());
        expect(e).toBeInstanceOf(ForbiddenException);
        expect(e.getResponse()).toMatchObject({ reason });
      }
    }
  });

  it("an eligible business opens its session as before, flag ON or OFF", async () => {
    for (const flag of [true, false]) {
      const { run, billing } = call(SELF_PAY_OK, flag);
      await run();
      expect(billing.createCheckoutSession).toHaveBeenCalledWith("t1", { surface: "TENANT_SELF" });
    }
  });
});
