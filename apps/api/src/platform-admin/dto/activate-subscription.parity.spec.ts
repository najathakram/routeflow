/**
 * L-072 pattern: the API cannot value-import @routeflow/types, so the DTO keeps its own payment-method literal. The web
 * (tenant Billing tab and Create Tenant "Start active") reads the shared list in packages/types. They must stay set-equal.
 */
import { EXTERNAL_PAYMENT_METHODS } from "./activate-subscription.dto";

function shared(): readonly string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return ((require("@routeflow/types") as Record<string, unknown>)
      .EXTERNAL_PAYMENT_METHOD_VALUES ?? []) as readonly string[];
  } catch {
    return [];
  }
}

describe("EXTERNAL_PAYMENT_METHOD_VALUES parity (shared vs api DTO)", () => {
  it("packages/types is set-equal to the api's EXTERNAL_PAYMENT_METHODS", () => {
    expect(shared().length).toBeGreaterThan(0);
    expect([...shared()].sort()).toEqual([...EXTERNAL_PAYMENT_METHODS].sort());
  });
});
