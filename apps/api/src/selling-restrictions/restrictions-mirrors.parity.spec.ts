import { RESTRICTION_ADDRESS_PRECEDENCE_VALUES as SHARED } from "@routeflow/types";
import { RESTRICTION_ADDRESS_PRECEDENCE_VALUES } from "./selling-restrictions.service";

describe("API-local mirrors of shared restriction constants", () => {
  it("RESTRICTION_ADDRESS_PRECEDENCE_VALUES is set-equal to the shared array", () => {
    expect(SHARED.length).toBeGreaterThan(0);
    expect(new Set(RESTRICTION_ADDRESS_PRECEDENCE_VALUES)).toEqual(new Set(SHARED));
    expect(RESTRICTION_ADDRESS_PRECEDENCE_VALUES).toHaveLength(SHARED.length);
  });
});
