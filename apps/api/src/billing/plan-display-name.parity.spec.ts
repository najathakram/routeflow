import { PLAN_DISPLAY_NAMES, planDisplayName as sharedPlanDisplayName } from "@routeflow/pricing";
import { planDisplayName as denialPlanDisplayName } from "./denial-text";
import {
  LITE_PLAN_DISPLAY_NAME,
  PLAN_KEYS,
  LEGACY_PLAN_KEY_ALIASES,
} from "./plan-catalog.constants";

/**
 * SA-1254 V7 (P-45): ONE display-name helper. The refusal sentence (denial-text) reads the shared
 * helper, every plan key has a name, and the Lite constant agrees with the map. A subset check, so
 * a PLAN_KEYS member added without a name fails here in the same diff.
 */
describe("plan display names: one helper (SA-1254 V7, P-45)", () => {
  it("every PLAN_KEYS member has a display name", () => {
    const missing = PLAN_KEYS.filter((key) => sharedPlanDisplayName(key) === undefined);
    expect(missing).toEqual([]);
  });

  it("the shared map names CORE Essentials and ALL_IN Pro", () => {
    expect(PLAN_DISPLAY_NAMES.CORE).toBe("Essentials");
    expect(PLAN_DISPLAY_NAMES.ALL_IN).toBe("Pro");
  });

  it("the refusal sentence's helper is the shared helper, key for key", () => {
    const probes = [
      ...Object.keys(PLAN_DISPLAY_NAMES),
      ...PLAN_KEYS,
      ...Object.keys(LEGACY_PLAN_KEY_ALIASES),
      "PLUS",
      "custom_acme",
      "constructor",
      "",
      null,
      undefined,
    ];
    for (const key of probes) {
      expect(`${String(key)}: ${denialPlanDisplayName(key)}`).toBe(
        `${String(key)}: ${sharedPlanDisplayName(key)}`,
      );
    }
  });

  it("LITE_PLAN_DISPLAY_NAME is the map's Lite", () => {
    expect(LITE_PLAN_DISPLAY_NAME).toBe(PLAN_DISPLAY_NAMES.LITE);
  });
});
