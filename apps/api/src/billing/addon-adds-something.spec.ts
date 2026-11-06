import {
  addonAlreadyIncludedRefusal,
  addonOfferState,
  isCapacityAddon,
  skuAddsSomething,
  type EffectiveByKey,
} from "./addon-adds-something";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { SELF_SERVICE_ADDON_SKUS } from "./plan-catalog.constants";
import { FEATURE_REGISTRY } from "./feature-registry";

/**
 * SA-1099 §6 (WP5, R22): the one rule for "would buying this SKU add anything". Pure; the enable call, the preview
 * and (as a mirror) the owner's report all follow it.
 */
const eff = (o: Record<string, boolean>): EffectiveByKey =>
  new Map(Object.entries(o).map(([k, v]) => [k, { effective: v }]));

const FORECASTING = {
  sku: "FORECASTING",
  name: "Forecasting",
  grantsFlags: ["flag.forecasting", "flag.analytics"],
};

describe("skuAddsSomething", () => {
  it("every granted flag already effective: adds nothing", () => {
    expect(
      skuAddsSomething(FORECASTING, eff({ "flag.forecasting": true, "flag.analytics": true })),
    ).toBe(false);
  });
  it("one granted flag not effective: adds something", () => {
    expect(
      skuAddsSomething(FORECASTING, eff({ "flag.forecasting": true, "flag.analytics": false })),
    ).toBe(true);
  });
  it("a flag the resolver has no verdict for: adds something (never refuse on a guess)", () => {
    expect(skuAddsSomething(FORECASTING, eff({ "flag.forecasting": true }))).toBe(true);
  });
  it('empty or missing grantsFlags: adds something ("all of nothing" is not "already held")', () => {
    expect(skuAddsSomething({ ...FORECASTING, grantsFlags: [] }, eff({}))).toBe(true);
    expect(skuAddsSomething({ ...FORECASTING, grantsFlags: undefined }, eff({}))).toBe(true);
    expect(skuAddsSomething({ ...FORECASTING, grantsFlags: null }, eff({}))).toBe(true);
  });
  it("a capacity SKU (meter key or per-unit capacity) always adds something, even over effective flags", () => {
    const all = eff({ "flag.forecasting": true, "flag.analytics": true });
    expect(skuAddsSomething({ ...FORECASTING, capacityPerUnit: 100 }, all)).toBe(true);
    expect(skuAddsSomething({ ...FORECASTING, meteredKey: "SCANS" }, all)).toBe(true);
    expect(isCapacityAddon({ meteredKey: null, capacityPerUnit: null })).toBe(false);
    expect(isCapacityAddon({ meteredKey: "SEATS", capacityPerUnit: null })).toBe(true);
  });
});

// SA-1099 A-4: the one state the add-on list (`alreadyHaveAddonSkus`) and the enable's refusal both read.
describe("addonOfferState", () => {
  const ALL = eff({ "flag.forecasting": true, "flag.analytics": true });
  it("every granted flag already effective and no row of its own: already-have", () => {
    expect(addonOfferState(FORECASTING, ALL, false)).toBe("already-have");
  });
  it("an active row of the SKU is the buy-more / disable path: buy, whatever is effective", () => {
    expect(addonOfferState(FORECASTING, ALL, true)).toBe("buy");
  });
  it("one flag still missing, or unknown to the resolver: buy", () => {
    expect(addonOfferState(FORECASTING, eff({ "flag.forecasting": true }), false)).toBe("buy");
  });
  it("a capacity SKU and an empty grantsFlags are always for sale", () => {
    expect(addonOfferState({ ...FORECASTING, capacityPerUnit: 100 }, ALL, false)).toBe("buy");
    expect(addonOfferState({ ...FORECASTING, meteredKey: "SCANS" }, ALL, false)).toBe("buy");
    expect(addonOfferState({ ...FORECASTING, grantsFlags: [] }, ALL, false)).toBe("buy");
  });
  it("agrees with skuAddsSomething wherever no row is held", () => {
    for (const e of [ALL, eff({}), eff({ "flag.forecasting": true })]) {
      expect(addonOfferState(FORECASTING, e, false) === "buy").toBe(
        skuAddsSomething(FORECASTING, e),
      );
    }
  });
});

describe("the refusal", () => {
  it("is a fixed code and sentence that names only the add-on", () => {
    expect(addonAlreadyIncludedRefusal("Forecasting")).toEqual({
      code: API_ERROR_CODES.ADDON_ALREADY_INCLUDED,
      message: "You already have Forecasting, so there is nothing to buy.",
    });
  });
});

describe("scope pin (SA-1099 §6): self-serve SKUs only", () => {
  it("the SKUs this refusal can reach are exactly SELF_SERVICE_ADDON_SKUS, and the registry bills no other self-serve SKU", () => {
    // The refusal sits behind isSelfServiceAddon in enableAddon; if a SKU joins the list it joins this review.
    expect([...SELF_SERVICE_ADDON_SKUS]).toEqual(["CUSTOMER_PACK_100", "FORECASTING"]);
    const billed = new Set(
      FEATURE_REGISTRY.filter((f) => f.billing.selfService).flatMap((f) => [...f.billing.skus]),
    );
    expect([...billed].sort()).toEqual([...SELF_SERVICE_ADDON_SKUS].sort());
  });
});
