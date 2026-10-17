/**
 * C0 part B: the `flag.units_prices_v2` registry row (units v2, SA-796 R-5).
 *
 * R-5 approves this key as a stated exception to the "a new plan flag ships dark" rule: it gates
 * a NEW route and UI with zero prior users, so the blast radius is 0 by construction, and "dark"
 * would allow it for every tenant (exposing the unfinished v2 grid). It therefore ships
 * ENFORCED-BUT-UNGRANTED, like `flag.units_v1`: invisible until an owner override GRANT.
 */
import { FEATURE_REGISTRY } from "./feature-registry";
import { DARK_PLAN_FLAGS, computeServedFlags, isDarkFlag } from "./plan-flag-policy";
import { FLAG_KEYS, FLAG_TO_ADDON_SKU } from "./plan-catalog.constants";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mirror = require("../../scripts/lib/feature-registry-mirror.cjs") as {
  FEATURE_REGISTRY_MIRROR: Array<{ key: string; via: string; state: string }>;
  DARK_PLAN_FLAGS: Set<string>;
  PREPIN_DARK_FLAGS: Set<string>;
};

const KEY = "flag.units_prices_v2";
const row = () => FEATURE_REGISTRY.find((f) => f.key === KEY);

describe("flag.units_prices_v2 (SA-796 R-5: enforced-but-ungranted, not dark)", () => {
  it("has a registry row with exactly the approved settings", () => {
    expect(row()).toEqual(
      expect.objectContaining({
        key: KEY,
        kind: "boolean",
        defaultGranted: false,
        billing: { skus: [], selfService: false },
        gate: {
          via: "RequirePlanFlag",
          state: "enforced",
          added: "2026-10-16",
          routes: [
            "GET /products/:productId/price-grid (product-pricing.controller.ts, class-level)",
            "POST /products/:productId/prices (product-pricing.controller.ts, class-level)",
            "POST /products/:productId/prices/undo (product-pricing.controller.ts, class-level)",
            "GET /customers/:customerId/unit-prices (customer-unit-prices.controller.ts, class-level)",
            "GET /customers/:customerId/price-layer (customer-price-layer.controller.ts, class-level)",
            "products.service.ts create and importFromZoho, product-families.service.ts createFamily and updateVariants (hasFlag, S4)",
            expect.stringContaining("S19 billing readers (customerPricing"),
          ],
          // SA-811: no grant until every customer-price reader is on the S19 helper (S19b)
          grantPath: expect.stringMatching(
            /^No grant until S19b: .*\(SA-811\)\. Then: owner override GRANT/,
          ),
          backfill: "New key: no tenant has used it, so there is nothing to backfill.",
        },
      }),
    );
  });

  it("sits directly after flag.pricing_tiers and not next to flag.units_v1", () => {
    const keys = FEATURE_REGISTRY.map((f) => f.key);
    expect(keys.indexOf(KEY)).toBe(keys.indexOf("flag.pricing_tiers") + 1);
    expect(Math.abs(keys.indexOf(KEY) - keys.indexOf("flag.units_v1"))).toBeGreaterThan(1);
  });

  it("is in no dark set: not DARK_PLAN_FLAGS, not PREPIN_DARK_FLAGS, not the mirror's", () => {
    expect(DARK_PLAN_FLAGS.has(KEY)).toBe(false);
    expect(mirror.DARK_PLAN_FLAGS.has(KEY)).toBe(false);
    expect(mirror.PREPIN_DARK_FLAGS.has(KEY)).toBe(false);
    // PREPIN_DARK_FLAGS is module-private; isDarkFlag folds it in regardless of the kill switch.
    expect(isDarkFlag(KEY, { PLAN_FLAG_ENFORCEMENT: "off" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isDarkFlag(KEY, {} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("is in no plan bundle (the flag keys, the add-on SKU map)", () => {
    expect((FLAG_KEYS as readonly string[]).includes(KEY)).toBe(false);
    expect(Object.keys(FLAG_TO_ADDON_SKU)).not.toContain(KEY);
  });

  it("the standalone mirror carries the row as RequirePlanFlag / enforced / not default-granted", () => {
    expect(mirror.FEATURE_REGISTRY_MIRROR.find((m) => m.key === KEY)).toEqual(
      expect.objectContaining({ via: "RequirePlanFlag", state: "enforced", defaultGranted: false }),
    );
  });

  describe("computeServedFlags", () => {
    const off = { PLAN_FLAG_ENFORCEMENT: "off" } as NodeJS.ProcessEnv;
    const on = { PLAN_FLAG_ENFORCEMENT: "on" } as NodeJS.ProcessEnv;

    it.each([
      ["kill switch off", off],
      ["kill switch on", on],
    ])("leaves the key out with no override (%s)", (_n, env) => {
      expect(computeServedFlags("SCALE", [], new Map(), env)).not.toContain(KEY);
    });

    it.each([
      ["kill switch off", off],
      ["kill switch on", on],
    ])("serves the key with an owner GRANT (%s)", (_n, env) => {
      expect(computeServedFlags("SCALE", [], new Map([[KEY, "GRANT" as const]]), env)).toContain(
        KEY,
      );
    });

    it("a DENY removes it again", () => {
      expect(
        computeServedFlags("SCALE", [KEY], new Map([[KEY, "DENY" as const]]), off),
      ).not.toContain(KEY);
    });
  });
});
