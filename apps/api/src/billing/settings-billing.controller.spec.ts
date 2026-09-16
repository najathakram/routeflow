import { SettingsBillingController } from "./settings-billing.controller";
import { QuoteDto } from "./dto/quote.dto";

interface AuthUser {
  tenantId: string | null;
  sub?: string;
}

/** Instantiate the controller with mocked proration + mutations (+ billing) only (no
 *  Nest module needed). */
function make(opts: { change?: any; checkoutResult?: any } = {}) {
  const proration = {
    quote: jest.fn().mockResolvedValue({ subtotalMonthly: 173, lines: [] }),
  } as any;
  const mutations = {
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
  const controller = new SettingsBillingController(undefined as any, proration, mutations, billing);
  return { controller, proration, mutations, billing };
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
});
