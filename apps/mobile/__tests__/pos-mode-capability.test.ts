/**
 * POS mode is gated by the shared `staffMay(role, "USE_POS_MODE")` row, and the hand @routeflow/types
 * stub carries a copy of that table pinned to the real one here.
 */
import { STAFF_CAPABILITY_RULES, staffMay } from "../../../packages/types/api/staff-capabilities";
import { PREFERENCE_KEYS } from "../../../packages/types/api/preferences";
import * as stub from "@routeflow/types";
import { POS_MODE_PREF_KEY, canUsePosMode } from "../lib/pos-mode";

describe("USE_POS_MODE gate", () => {
  it("OPERATOR and TENANT_ADMIN may; DRIVER, CUSTOMER and unknown may not", () => {
    expect(canUsePosMode("OPERATOR")).toBe(true);
    expect(canUsePosMode("TENANT_ADMIN")).toBe(true);
    expect(canUsePosMode("DRIVER")).toBe(false);
    expect(canUsePosMode("CUSTOMER")).toBe(false);
    expect(canUsePosMode(undefined)).toBe(false);
  });
  it("the @routeflow/types stub's table equals the real one", () => {
    const s = stub as unknown as {
      STAFF_CAPABILITY_RULES: unknown;
      staffMay: typeof staffMay;
    };
    expect(s.STAFF_CAPABILITY_RULES).toEqual(STAFF_CAPABILITY_RULES);
    for (const role of ["OPERATOR", "TENANT_ADMIN", "SUPER_ADMIN", "DRIVER", "CUSTOMER", null]) {
      expect(s.staffMay(role, "USE_POS_MODE")).toBe(staffMay(role, "USE_POS_MODE"));
    }
  });
  it("the preference key is the shared PREFERENCE_KEYS entry", () => {
    expect(POS_MODE_PREF_KEY).toBe("orders.posMode");
    expect(PREFERENCE_KEYS).toContain(POS_MODE_PREF_KEY);
  });
});
