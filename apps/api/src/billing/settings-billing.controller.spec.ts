// Hoisted, file-wide: safe for every OTHER test here (they all use a non-invite-only planKey —
// STARTER/BUSINESS — which inviteOnlyCheckoutAllowed permits regardless of this lever). Only the
// REG-6 test below relies on the lever being off.
jest.mock("./plan-catalog.constants", () => ({
  ...jest.requireActual("./plan-catalog.constants"),
  INVITE_ONLY_PLAN_SELF_SERVE_CHECKOUT: false,
}));

import { SettingsBillingController } from "./settings-billing.controller";
import { QuoteDto } from "./dto/quote.dto";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { UserRole } from "@prisma/client";

interface AuthUser {
  tenantId: string | null;
  sub?: string;
}

/** Instantiate the controller with mocked proration + mutations (+ billing) only (no
 *  Nest module needed). */
function make(
  opts: {
    change?: any;
    checkoutResult?: any;
    planKey?: string;
    billing?: string;
    refusal?: { code: string; message: string } | null;
    /** SA-690: the tenant's status is TRIAL. */
    trial?: boolean;
  } = {},
) {
  const subscription = {
    getSubscription: jest
      .fn()
      .mockResolvedValue(
        opts.planKey !== undefined ? { planKey: opts.planKey } : { planKey: "STARTER" },
      ),
  } as any;
  const proration = {
    quote: jest.fn().mockResolvedValue({ subtotalMonthly: 173, lines: [] }),
    prorationPreview: jest.fn().mockResolvedValue({ sku: "FORECASTING", proratedToday: 6.4 }),
  } as any;
  const mutations = {
    addonBillingMode: jest.fn().mockResolvedValue(opts.billing ?? "STRIPE"),
    addonEnableRefusal: jest.fn().mockResolvedValue(opts.refusal ?? null),
    isTrialTenant: jest.fn().mockResolvedValue(opts.trial ?? false),
    planChangePreview: jest
      .fn()
      .mockResolvedValue(opts.change ?? { action: "UPGRADE", proratedNow: 12.3 }),
  } as any;
  const billing = {
    createCheckoutSession: jest
      .fn()
      .mockResolvedValue(
        opts.checkoutResult ?? { checkoutUrl: "https://checkout.stripe.com/x", sessionId: "cs_1" },
      ),
  } as any;
  const controller = new SettingsBillingController(subscription, proration, mutations, billing);
  return { controller, subscription, proration, mutations, billing };
}

describe("SettingsBillingController.quote (REG-B58 T3)", () => {
  it("REG-B58 T3 carries the plan-change preview, spread over the quote", async () => {
    const change = {
      action: "UPGRADE",
      proratedNow: 123.45,
      keepsRenewalAt: new Date("2026-10-01T00:00:00.000Z"),
    };
    const { controller, proration, mutations } = make({ change });
    const dto: QuoteDto = { planKey: "BUSINESS", cycle: "MONTHLY" } as QuoteDto;
    const user: AuthUser = { tenantId: "t1", sub: "u1" };

    const result = await controller.quote(user as any, dto);

    expect(result.change).toEqual(change);
    expect(result.subtotalMonthly).toBe(173); // still the underlying quote, not replaced
    expect(mutations.planChangePreview).toHaveBeenCalledWith("t1", dto.planKey, dto.cycle);
    expect(proration.quote).toHaveBeenCalledWith(dto);
  });

  it("REG-B58 T3 (Amendment 2) no tenant context (SUPER_ADMIN) resolves 200 with change: null", async () => {
    const { controller, proration, mutations } = make();
    const dto: QuoteDto = { planKey: "BUSINESS", cycle: "MONTHLY" } as QuoteDto;
    const user: AuthUser = { tenantId: null };

    const result = await controller.quote(user as any, dto);

    // `change` must be an explicit null, not an absent key — otherwise `undefined` (today's
    // wrong value) would be indistinguishable from the contract the Amendment-2 row asks for.
    expect(Object.prototype.hasOwnProperty.call(result, "change")).toBe(true);
    expect(result.change).toBeNull();
    expect(mutations.planChangePreview).not.toHaveBeenCalled();
    expect(proration.quote).toHaveBeenCalledWith(dto);
  });
});

describe("SettingsBillingController.createCheckout (WP3c, R2.9)", () => {
  const ORIGINAL_FRONTEND_URL = process.env.FRONTEND_URL;
  afterEach(() => {
    process.env.FRONTEND_URL = ORIGINAL_FRONTEND_URL;
  });

  it("starts a checkout session for the tenant's own pinned plan with success/cancel URLs, no body", async () => {
    process.env.FRONTEND_URL = "https://app.example.com";
    const { controller, billing } = make();
    const user: AuthUser = { tenantId: "t1", sub: "u1" };

    const result = await controller.createCheckout(user as any);

    expect(billing.createCheckoutSession).toHaveBeenCalledWith("t1", {
      successUrl: "https://app.example.com/settings/billing?checkout=success",
      cancelUrl: "https://app.example.com/settings/billing?checkout=cancelled",
    });
    expect(result).toEqual({ checkoutUrl: "https://checkout.stripe.com/x", sessionId: "cs_1" });
  });

  it("falls back to localhost:3001 when FRONTEND_URL is unset", async () => {
    delete process.env.FRONTEND_URL;
    const { controller, billing } = make();
    const user: AuthUser = { tenantId: "t1", sub: "u1" };

    await controller.createCheckout(user as any);

    expect(billing.createCheckoutSession).toHaveBeenCalledWith("t1", {
      successUrl: "http://localhost:3001/settings/billing?checkout=success",
      cancelUrl: "http://localhost:3001/settings/billing?checkout=cancelled",
    });
  });

  // R2.9: the endpoint accepts no request body at all — a caller cannot direct
  // checkout at any plan other than the tenant's own pinned one. This is a
  // compile-time/structural guarantee (no @Body() param exists on the handler), so
  // the runtime check here is that the handler's arity is exactly 1 (@CurrentUser only).
  it("R2.9 takes no request-body param — the tenant's own plan is structural, not client-supplied", () => {
    expect(SettingsBillingController.prototype.createCheckout.length).toBe(1);
  });

  it("REG-6 refuses checkout when the self-serve-checkout kill switch is off, even called directly", async () => {
    const { controller, billing } = make({ planKey: "LITE" });
    const user: AuthUser = { tenantId: "t1", sub: "u1" };

    await expect(controller.createCheckout(user as any)).rejects.toThrow(/disabled/i);
    expect(billing.createCheckoutSession).not.toHaveBeenCalled();
  });
});

// #2189 / SA-389a: the controller passes subscribe()'s 409 body through unchanged, so the web can
// offer "plan changed — retry" off the code (Nest serializes getResponse() as the JSON body).
describe("SettingsBillingController.subscribe — PLAN_CHANGED_DURING_SUBSCRIBE reaches the response", () => {
  it("rethrows the 409 with its code, retryable flag and message intact", async () => {
    const { ConflictException } = jest.requireActual("@nestjs/common");
    const { controller, mutations } = make();
    const body = {
      code: "PLAN_CHANGED_DURING_SUBSCRIBE",
      retryable: true,
      message: "Your plan changed while this was being processed — please try again.",
    };
    mutations.subscribe = jest.fn().mockRejectedValue(new ConflictException(body));
    const err = await controller
      .subscribe({ tenantId: "t1", sub: "u1" } as any, { planKey: "TEAM", cycle: "MONTHLY" } as any)
      .catch((e: any) => e);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toEqual(body);
  });
});

describe("SettingsBillingController.prorationPreview — says how the add-on is billed", () => {
  it("a Stripe-billed tenant: billing STRIPE / billed true next to the estimate", async () => {
    const { controller, mutations } = make({ billing: "STRIPE" });
    const res: any = await controller.prorationPreview({ tenantId: "t1" } as any, "FORECASTING");
    expect(res).toMatchObject({ proratedToday: 6.4, billing: "STRIPE", billed: true });
    expect(mutations.addonBillingMode).toHaveBeenCalledWith("t1");
  });

  it("a manually-invoiced tenant: billing MANUAL, still billed (it appears on the next invoice)", async () => {
    const { controller } = make({ billing: "MANUAL" });
    const res: any = await controller.prorationPreview({ tenantId: "t1" } as any, "FORECASTING");
    expect(res).toMatchObject({ billing: "MANUAL", billed: true });
  });

  it("a free pilot: billing UNBILLED / billed false, so the sheet says it is included at no charge", async () => {
    const { controller } = make({ billing: "UNBILLED" });
    const res: any = await controller.prorationPreview({ tenantId: "t1" } as any, "FORECASTING");
    expect(res).toMatchObject({ billing: "UNBILLED", billed: false });
  });

  it("a free pilot (billed false) carries NO proratedToday: there is nothing to charge", async () => {
    const { controller } = make({ billing: "UNBILLED" });
    const res: any = await controller.prorationPreview({ tenantId: "t1" } as any, "FORECASTING");
    expect(res.proratedToday).toBeNull();
    expect(res.refusal).toBeNull();
  });

  it("billed tenants keep the estimate and carry no refusal (additive field, unchanged otherwise)", async () => {
    for (const billing of ["STRIPE", "MANUAL"]) {
      const { controller } = make({ billing });
      const res: any = await controller.prorationPreview({ tenantId: "t1" } as any, "FORECASTING");
      expect(res).toMatchObject({ proratedToday: 6.4, billing, billed: true, refusal: null });
    }
  });

  describe("SA-690 — `trial` says the tenant is still on its trial (the add-on is billed at the card checkout)", () => {
    it("a TRIAL tenant: trial true, on every shape of the answer", async () => {
      for (const billing of ["UNBILLED", "STRIPE", "MANUAL"]) {
        const { controller, mutations } = make({ billing, trial: true });
        const res: any = await controller.prorationPreview(
          { tenantId: "t1" } as any,
          "FORECASTING",
        );
        expect(res.trial).toBe(true);
        expect(mutations.isTrialTenant).toHaveBeenCalledWith("t1");
      }
    });

    it("a tenant that is not on its trial: trial false", async () => {
      const { controller } = make({ billing: "STRIPE", trial: false });
      const res: any = await controller.prorationPreview({ tenantId: "t1" } as any, "FORECASTING");
      expect(res.trial).toBe(false);
    });

    it("a refused enable still carries trial (the confirm sheet reads it either way)", async () => {
      const { controller } = make({
        trial: true,
        refusal: {
          code: "ADDON_INCLUDED_IN_PLAN",
          message: "Forecasting is already included in your plan.",
        },
      });
      const res: any = await controller.prorationPreview({ tenantId: "t1" } as any, "FORECASTING");
      expect(res).toMatchObject({ billing: "REFUSED", trial: true });
    });
  });

  it.each([
    [
      "annual (the enable 409)",
      "ADDON_ANNUAL_NOT_SUPPORTED",
      "Add-ons can't be added to an annual plan online yet. Please contact support.",
    ],
    [
      "plan-included (the F3 refusal)",
      "ADDON_INCLUDED_IN_PLAN",
      "Forecasting is already included in your plan.",
    ],
  ])(
    "a refused enable (%s): REFUSED / billed false, the SAME code, no charge figure",
    async (_l, code, message) => {
      // The mode is still STRIPE underneath: the refusal, not the mode, must win.
      const { controller, mutations } = make({ billing: "STRIPE", refusal: { code, message } });
      const res: any = await controller.prorationPreview({ tenantId: "t1" } as any, "FORECASTING");
      expect(res).toMatchObject({
        sku: "FORECASTING",
        billing: "REFUSED",
        billed: false,
        proratedToday: null,
        refusal: { code, message },
      });
      expect(mutations.addonEnableRefusal).toHaveBeenCalledWith("t1", "FORECASTING");
    },
  );
});

// SA-733r6 (B4): only an admin opens the billing portal. The route is @Roles(TENANT_ADMIN) and an
// operator's POST is refused by RolesGuard before the handler; the guard allow-list lets it through a pause.
describe("SettingsBillingController.createPortal (B4: admin-only portal)", () => {
  it("is @Roles(TENANT_ADMIN) on the handler (an OPERATOR gets 403 from RolesGuard)", () => {
    const roles = Reflect.getMetadata(ROLES_KEY, SettingsBillingController.prototype.createPortal);
    expect(roles).toEqual([UserRole.TENANT_ADMIN]);
  });

  it("returns the portal URL and the open invoice's hosted URL for the pay button", async () => {
    const { controller, billing, subscription } = make();
    billing.createBillingPortalSession = jest
      .fn()
      .mockResolvedValue({ portalUrl: "https://billing.example/p/1" });
    subscription.openInvoiceUrl = jest.fn().mockResolvedValue("https://invoice.example/i/1");

    const out = await controller.createPortal({ tenantId: "t1", sub: "u1" } as any);

    expect(out).toEqual({
      portalUrl: "https://billing.example/p/1",
      hostedInvoiceUrl: "https://invoice.example/i/1",
    });
    expect(billing.createBillingPortalSession).toHaveBeenCalledWith("t1");
    expect(subscription.openInvoiceUrl).toHaveBeenCalledWith("t1");
  });

  it("has no tenant context (SUPER_ADMIN) -> 403, never a null tenant into the query layer", async () => {
    const { controller } = make();
    await expect(controller.createPortal({ tenantId: null } as any)).rejects.toThrow(
      "requires a tenant context",
    );
  });
});
