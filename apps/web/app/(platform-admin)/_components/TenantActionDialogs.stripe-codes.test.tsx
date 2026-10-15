import { API_ERROR_CODES } from "@routeflow/types";
import { TENANT_ACTION_COPY, deleteFailureCopy, statusFailureCopy } from "./TenantActionDialogs";

const coded = (status: number, code: string) => ({
  response: { status, data: { code, message: "raw server text that must never be shown" } },
});

describe("tenant status / delete failures from the Stripe gate (fixed copy, never the server's text)", () => {
  it("TENANT_CANCEL_SUBSCRIPTION_FIRST on a status change says to end the subscription first", () => {
    const copy = statusFailureCopy(coded(409, API_ERROR_CODES.TENANT_CANCEL_SUBSCRIPTION_FIRST));
    expect(copy).toBe(TENANT_ACTION_COPY.cancelSubscriptionFirst);
    expect(copy).not.toMatch(/raw server text/);
  });

  it("CONCURRENT_UPDATE on a status change says to try again in a moment", () => {
    expect(statusFailureCopy(coded(409, API_ERROR_CODES.CONCURRENT_UPDATE))).toBe(
      TENANT_ACTION_COPY.subscriptionUnconfirmed,
    );
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
    expect(deleteFailureCopy(coded(409, API_ERROR_CODES.CONCURRENT_UPDATE))).toBe(
      TENANT_ACTION_COPY.subscriptionUnconfirmed,
    );
    // an uncoded 409 / 400 is still the suspended-first refusal
    expect(deleteFailureCopy({ response: { status: 409 } })).toBe(TENANT_ACTION_COPY.deleteRefused);
  });

  it("the new copy is fixed text with no placeholder for server data", () => {
    expect(TENANT_ACTION_COPY.cancelSubscriptionFirst).toMatch(/Stripe/);
    expect(TENANT_ACTION_COPY.subscriptionUnconfirmed).toMatch(/try again/i);
  });
});
