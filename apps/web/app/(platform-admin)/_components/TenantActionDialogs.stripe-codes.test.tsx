import { API_ERROR_CODES } from "@routeflow/types";
import { TENANT_ACTION_COPY, deleteFailureCopy, statusFailureCopy } from "./TenantActionDialogs";

const coded = (status: number, code: string, reason?: string) => ({
  response: {
    status,
    data: {
      code,
      ...(reason ? { reason } : {}),
      message: "raw server text that must never be shown",
    },
  },
});

describe("tenant status / delete failures from the Stripe gate (fixed copy, never the server's text)", () => {
  it("TENANT_CANCEL_SUBSCRIPTION_FIRST on a status change says to end the subscription first", () => {
    const copy = statusFailureCopy(coded(409, API_ERROR_CODES.TENANT_CANCEL_SUBSCRIPTION_FIRST));
    expect(copy).toBe(TENANT_ACTION_COPY.cancelSubscriptionFirst);
    expect(copy).not.toMatch(/raw server text/);
  });

  it("CONCURRENT_UPDATE from a failed Stripe read (reason STRIPE_UNCONFIRMED) says to try again in a moment", () => {
    const e = coded(409, API_ERROR_CODES.CONCURRENT_UPDATE, "STRIPE_UNCONFIRMED");
    expect(statusFailureCopy(e)).toBe(TENANT_ACTION_COPY.subscriptionUnconfirmed);
    expect(deleteFailureCopy(e)).toBe(TENANT_ACTION_COPY.subscriptionUnconfirmed);
  });

  it("any OTHER CONCURRENT_UPDATE gets the generic 'tenant changed' text, not the Stripe one", () => {
    const e = coded(409, API_ERROR_CODES.CONCURRENT_UPDATE);
    expect(statusFailureCopy(e)).toBe(TENANT_ACTION_COPY.tenantChanged);
    expect(deleteFailureCopy(e)).toBe(TENANT_ACTION_COPY.tenantChanged);
    expect(TENANT_ACTION_COPY.tenantChanged).not.toBe(TENANT_ACTION_COPY.subscriptionUnconfirmed);
    expect(TENANT_ACTION_COPY.tenantChanged).not.toMatch(/Stripe/);
  });

  it("STRIPE_NOT_CONFIGURED says Stripe isn't connected here, on a status change and a delete", () => {
    const e = coded(409, API_ERROR_CODES.STRIPE_NOT_CONFIGURED);
    expect(statusFailureCopy(e)).toBe(TENANT_ACTION_COPY.stripeNotConfigured);
    expect(deleteFailureCopy(e)).toBe(TENANT_ACTION_COPY.stripeNotConfigured);
    expect(TENANT_ACTION_COPY.stripeNotConfigured).not.toMatch(/raw server text/);
  });

  it("STRIPE_ACCOUNT_MISMATCH tells the admin to check the Stripe key and mode, on a status change and a delete", () => {
    const e = coded(409, API_ERROR_CODES.STRIPE_ACCOUNT_MISMATCH);
    expect(statusFailureCopy(e)).toBe(TENANT_ACTION_COPY.stripeAccountMismatch);
    expect(deleteFailureCopy(e)).toBe(TENANT_ACTION_COPY.stripeAccountMismatch);
    expect(TENANT_ACTION_COPY.stripeAccountMismatch).toMatch(/Stripe key and mode/);
  });

  it("STRIPE_SUBSCRIPTION_OWNER_MISMATCH says the subscription belongs to another Stripe customer, on a status change and a delete", () => {
    const e = coded(409, API_ERROR_CODES.STRIPE_SUBSCRIPTION_OWNER_MISMATCH);
    expect(statusFailureCopy(e)).toBe(TENANT_ACTION_COPY.stripeSubscriptionOwnerMismatch);
    expect(deleteFailureCopy(e)).toBe(TENANT_ACTION_COPY.stripeSubscriptionOwnerMismatch);
    expect(TENANT_ACTION_COPY.stripeSubscriptionOwnerMismatch).toMatch(/different Stripe customer/);
    expect(TENANT_ACTION_COPY.stripeSubscriptionOwnerMismatch).not.toBe(
      TENANT_ACTION_COPY.stripeAccountMismatch,
    );
  });

  it("STRIPE_SUBSCRIPTION_OWNER_MISMATCH with reason NO_STORED_CUSTOMER says the tenant has no Stripe customer on file, not 'a different customer'", () => {
    const e = coded(409, API_ERROR_CODES.STRIPE_SUBSCRIPTION_OWNER_MISMATCH, "NO_STORED_CUSTOMER");
    expect(statusFailureCopy(e)).toBe(TENANT_ACTION_COPY.stripeNoStoredCustomer);
    expect(deleteFailureCopy(e)).toBe(TENANT_ACTION_COPY.stripeNoStoredCustomer);
    expect(TENANT_ACTION_COPY.stripeNoStoredCustomer).toMatch(/no Stripe customer/);
    expect(TENANT_ACTION_COPY.stripeNoStoredCustomer).not.toBe(
      TENANT_ACTION_COPY.stripeSubscriptionOwnerMismatch,
    );
    expect(statusFailureCopy(e)).not.toMatch(/raw server text/);
  });

  it("any other failure keeps the plain status copy", () => {
    expect(statusFailureCopy(coded(409, "SOMETHING_ELSE"))).toBe(TENANT_ACTION_COPY.statusFailed);
    expect(statusFailureCopy(new Error("boom"))).toBe(TENANT_ACTION_COPY.statusFailed);
    expect(statusFailureCopy(null)).toBe(TENANT_ACTION_COPY.statusFailed);
  });

  it("delete: the coded 409s win over the generic 'only a suspended tenant' sentence", () => {
    expect(deleteFailureCopy(coded(409, API_ERROR_CODES.TENANT_CANCEL_SUBSCRIPTION_FIRST))).toBe(
      TENANT_ACTION_COPY.cancelSubscriptionFirst,
    );
    // an uncoded 409 / 400 is still the suspended-first refusal
    expect(deleteFailureCopy({ response: { status: 409 } })).toBe(TENANT_ACTION_COPY.deleteRefused);
  });

  it("the new copy is fixed text with no placeholder for server data", () => {
    expect(TENANT_ACTION_COPY.cancelSubscriptionFirst).toMatch(/Stripe/);
    expect(TENANT_ACTION_COPY.subscriptionUnconfirmed).toMatch(/try again/i);
    // "it changed meanwhile" is the tenantChanged case, not a failed Stripe read
    expect(TENANT_ACTION_COPY.subscriptionUnconfirmed).not.toMatch(/changed/i);
  });
});
