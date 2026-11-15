import { BillingController } from "./billing.controller";

/**
 * SA-1139 PR-1 case 5: the super admin's checkout link (`POST /billing/checkout`) names its surface, so an embedded
 * session (which has no url to hand on) can never be created for it, whatever BILLING_CHECKOUT_UI says.
 */
describe("BillingController.createCheckout (SA-1139: the admin link is always hosted)", () => {
  it("passes surface ADMIN_LINK and no return urls (the platform owns them)", async () => {
    const billingService = {
      createCheckoutSession: jest.fn().mockResolvedValue({ uiMode: "hosted" }),
    };
    const controller = new BillingController(billingService as any, {} as any);
    await controller.createCheckout({
      tenantId: "t1",
      successUrl: "https://elsewhere.test/ok",
      cancelUrl: "https://elsewhere.test/no",
    } as any);
    expect(billingService.createCheckoutSession).toHaveBeenCalledWith("t1", {
      surface: "ADMIN_LINK",
    });
  });
});
