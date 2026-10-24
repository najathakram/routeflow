import {
  evaluateRestrictions,
  resolveGoverningState,
  ruleHidesFromBuyer,
  type RestrictionRuleFacts,
} from "../selling-restrictions/selling-restrictions.core";
import { placeUnknownState, type UnknownStateAddress } from "./unknown-state";

/**
 * Row 414, train pin (needs A's engine and B's buckets together): a needsDefault customer's state is
 * UNRESOLVED, so — exactly as the card's copy says — a legal ban (surface ALL) still hides the product
 * (fail closed), while a TX-only portal limit (surface BUYER_PORTAL) does not reach them (fail open,
 * owner ruling 2). If either the engine or the bucket definition drifts, this goes red with the copy.
 */
let seq = 0;
const addr = (over: Partial<UnknownStateAddress> = {}): UnknownStateAddress => {
  seq++;
  return {
    id: `a${seq}`,
    tenantId: "t",
    isDefault: false,
    addressType: "BILLING",
    stateCode: "TX",
    stateNeedsReview: false,
    line1: "1 Main St",
    line2: null,
    city: "Dallas",
    state: "TX",
    zip: "75201",
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)),
    ...over,
  };
};

const NEEDS_DEFAULT = {
  "no default": [addr(), addr({ stateCode: "NY", state: "NY", addressType: "SHIPPING" })],
  "conflicting defaults": [
    addr({ isDefault: true }),
    addr({ isDefault: true, stateCode: "NY", state: "NY" }),
  ],
  "untyped default among several": [
    addr({ isDefault: true }),
    addr({ isDefault: true, addressType: "" }),
  ],
};

const rule = (surface: RestrictionRuleFacts["surface"]): RestrictionRuleFacts => ({
  id: `r-${surface}`,
  categoryId: null,
  productId: "p1",
  jurisdiction: "STATE",
  states: ["TX"],
  surface,
  effectiveFrom: new Date(Date.UTC(2026, 0, 1)),
  effectiveTo: null,
  liftedAt: null,
  reason: surface === "ALL" ? "Legal ban" : "Portal limit",
});

const evaluate = (r: RestrictionRuleFacts, addresses: UnknownStateAddress[]) =>
  evaluateRestrictions({
    channel: "BUYER_PORTAL",
    at: new Date(Date.UTC(2026, 5, 1)),
    products: [{ id: "p1", name: "Acme pod", effectiveCategoryIds: new Set() }],
    rules: [r],
    governingState: resolveGoverningState(addresses, "BILLING_FIRST"),
  }).outcome;

describe.each(Object.entries(NEEDS_DEFAULT))(
  "needsDefault (%s) on the portal",
  (_name, addresses) => {
    it("is a needsDefault customer, and only that", () => {
      expect(
        Object.keys(
          placeUnknownState({ id: "c", businessName: "Acme", addresses }, "BILLING_FIRST"),
        ),
      ).toEqual(["needsDefault"]);
    });

    it("a TX-only portal limit does NOT hide the product (fail open)", () => {
      const gov = resolveGoverningState(addresses, "BILLING_FIRST");
      expect(ruleHidesFromBuyer(rule("BUYER_PORTAL"), gov)).toBe(false);
      expect(evaluate(rule("BUYER_PORTAL"), addresses)).toBe("ALLOW");
    });

    it("a TX legal ban (surface ALL) DOES hide it (fail closed)", () => {
      const gov = resolveGoverningState(addresses, "BILLING_FIRST");
      expect(ruleHidesFromBuyer(rule("ALL"), gov)).toBe(true);
      expect(evaluate(rule("ALL"), addresses)).toBe("INDETERMINATE");
    });
  },
);
