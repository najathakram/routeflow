import { DISCOUNT_TAX_BASE_VALUES as PRICING_VALUES } from "@routeflow/pricing";
import { DISCOUNT_TAX_BASE_VALUES as WIRE_VALUES } from "@routeflow/types";

/** L-072 / SA-1141 R7: the wire union in packages/types mirrors the pricing union exactly (same members, same order). */
describe("DISCOUNT_TAX_BASE_VALUES parity", () => {
  it("packages/types mirrors @routeflow/pricing", () => {
    expect([...WIRE_VALUES]).toEqual([...PRICING_VALUES]);
  });
});
