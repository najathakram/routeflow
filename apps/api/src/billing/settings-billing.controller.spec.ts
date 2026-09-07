import { SettingsBillingController } from "./settings-billing.controller";
import { QuoteDto } from "./dto/quote.dto";

interface AuthUser {
  tenantId: string | null;
  sub?: string;
}

/** Instantiate the controller with mocked proration + mutations only (no Nest module
 *  needed) — `quote()` is the only method under test here. */
function make(opts: { change?: any } = {}) {
  const proration = {
    quote: jest.fn().mockResolvedValue({ subtotalMonthly: 173, lines: [] }),
  } as any;
  const mutations = {
    planChangePreview: jest
      .fn()
      .mockResolvedValue(opts.change ?? { action: "UPGRADE", proratedNow: 12.3 }),
  } as any;
  const controller = new SettingsBillingController(undefined as any, proration, mutations);
  return { controller, proration, mutations };
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
