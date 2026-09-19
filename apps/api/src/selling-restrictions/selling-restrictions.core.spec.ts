import {
  activeRuleWhere,
  compareRules,
  evaluateRestrictions,
  matchingRules,
  offEvaluation,
  resolveGoverningState,
  ruleBindsChannel,
  ruleIsActive,
  UNKNOWN_PRODUCT_NAME,
  UNRESOLVED_STATE,
  type CustomerAddressFacts,
  type EvaluateInput,
  type ProductFacts,
  type RestrictionRuleFacts,
} from "./selling-restrictions.core";

const AT = new Date("2026-09-19T12:00:00Z");
const day = (n: number) => new Date(AT.getTime() + n * 86_400_000);

const rule = (over: Partial<RestrictionRuleFacts> = {}): RestrictionRuleFacts => ({
  id: "r1",
  categoryId: "cat-thc",
  productId: null,
  jurisdiction: "STATE",
  states: ["TX"],
  surface: "ALL",
  effectiveFrom: day(-30),
  effectiveTo: null,
  liftedAt: null,
  reason: "State ban",
  ...over,
});

const product = (over: Partial<ProductFacts> = {}): ProductFacts => ({
  id: "p1",
  name: "Gummies",
  effectiveCategoryIds: new Set(["cat-thc"]),
  ...over,
});

const addr = (over: Partial<CustomerAddressFacts> = {}): CustomerAddressFacts => ({
  isDefault: true,
  addressType: "BILLING",
  stateCode: "TX",
  stateNeedsReview: false,
  ...over,
});

const input = (over: Partial<EvaluateInput> = {}): EvaluateInput => ({
  channel: "STAFF",
  at: AT,
  products: [product()],
  rules: [rule()],
  governingState: { resolved: true, state: "TX" },
  categoryNames: new Map([["cat-thc", "THC"]]),
  ...over,
});

describe("outcome: OFF", () => {
  it("is a first-class result with no reasons — distinct from ALLOW", () => {
    expect(offEvaluation()).toEqual({ outcome: "OFF", reasons: [] });
    expect(offEvaluation().outcome).not.toBe("ALLOW");
  });
});

describe("outcome: ALLOW (switch on, no matching rule)", () => {
  it("allows a product no rule touches, even when the customer's state is unknown", () => {
    const res = evaluateRestrictions(
      input({ rules: [rule({ categoryId: "cat-other" })], governingState: UNRESOLVED_STATE }),
    );
    expect(res).toEqual({ outcome: "ALLOW", reasons: [] });
  });

  it("allows a STATE rule that names a different state", () => {
    expect(evaluateRestrictions(input({ rules: [rule({ states: ["FL", "NY"] })] })).outcome).toBe(
      "ALLOW",
    );
  });

  it("allows with no rules at all", () => {
    expect(evaluateRestrictions(input({ rules: [] })).outcome).toBe("ALLOW");
  });
});

describe("outcome: BLOCK", () => {
  it("blocks a STATE rule in the customer's state, naming the state and rule", () => {
    const res = evaluateRestrictions(input());
    expect(res.outcome).toBe("BLOCK");
    expect(res.reasons).toHaveLength(1);
    expect(res.reasons[0]).toMatchObject({
      productId: "p1",
      productName: "Gummies",
      categoryName: "THC",
      ruleId: "r1",
      reason: "STATE_BAN",
      state: "TX",
    });
    expect(res.reasons[0].message).toContain("TX");
  });

  it("matches the state case-insensitively", () => {
    expect(evaluateRestrictions(input({ rules: [rule({ states: ["tx"] })] })).outcome).toBe(
      "BLOCK",
    );
  });

  it("FEDERAL rules ignore the address entirely — blocked with an unresolved state", () => {
    const res = evaluateRestrictions(
      input({
        rules: [rule({ jurisdiction: "FEDERAL", states: [] })],
        governingState: UNRESOLVED_STATE,
      }),
    );
    expect(res.outcome).toBe("BLOCK");
    expect(res.reasons[0].reason).toBe("FEDERAL_BAN");
    expect(res.reasons[0].state).toBeUndefined();
  });

  it("a STATE rule with NO states blocks everywhere (fail closed, never ignored)", () => {
    const res = evaluateRestrictions(
      input({ rules: [rule({ states: [] })], governingState: { resolved: true, state: "OR" } }),
    );
    expect(res.outcome).toBe("BLOCK");
    expect(res.reasons[0].reason).toBe("STATE_BAN");
  });

  it("a BUYER_PORTAL-surface rule reports BUYER_PORTAL_ONLY", () => {
    const res = evaluateRestrictions(
      input({ channel: "BUYER_PORTAL", rules: [rule({ surface: "BUYER_PORTAL" })] }),
    );
    expect(res.outcome).toBe("BLOCK");
    expect(res.reasons[0].reason).toBe("BUYER_PORTAL_ONLY");
  });

  it("a BUYER_PORTAL-surface rule does NOT block staff", () => {
    const res = evaluateRestrictions(
      input({ channel: "STAFF", rules: [rule({ surface: "BUYER_PORTAL" })] }),
    );
    expect(res.outcome).toBe("ALLOW");
  });

  it("an ALL-surface rule blocks the portal too", () => {
    expect(evaluateRestrictions(input({ channel: "BUYER_PORTAL" })).outcome).toBe("BLOCK");
  });

  it("reports every banned line, not just the first", () => {
    const res = evaluateRestrictions(
      input({
        products: [product(), product({ id: "p2", name: "Vape" })],
        rules: [rule(), rule({ id: "r2", categoryId: null, productId: "p2", states: ["TX"] })],
      }),
    );
    expect(res.reasons.map((r) => r.productId)).toEqual(["p1", "p2"]);
  });

  it("matches by product id as well as by label", () => {
    const res = evaluateRestrictions(
      input({
        products: [product({ effectiveCategoryIds: new Set() })],
        rules: [rule({ categoryId: null, productId: "p1" })],
      }),
    );
    expect(res.outcome).toBe("BLOCK");
  });
});

describe("outcome: INDETERMINATE (switch on, state unresolved) — fails closed", () => {
  it("a matching STATE rule + unresolved state is INDETERMINATE with an explaining reason", () => {
    const res = evaluateRestrictions(input({ governingState: UNRESOLVED_STATE }));
    expect(res.outcome).toBe("INDETERMINATE");
    expect(res.reasons[0]).toMatchObject({ reason: "INDETERMINATE_ADDRESS", ruleId: "r1" });
    expect(res.reasons[0].state).toBeUndefined();
    expect(res.reasons[0].message).toMatch(/address/i);
  });

  it("BLOCK outranks INDETERMINATE, and both lines are still reported", () => {
    const res = evaluateRestrictions(
      input({
        products: [product(), product({ id: "p2", name: "Vape" })],
        rules: [
          rule(),
          rule({
            id: "r2",
            categoryId: null,
            productId: "p2",
            jurisdiction: "FEDERAL",
            states: [],
          }),
        ],
        governingState: UNRESOLVED_STATE,
      }),
    );
    expect(res.outcome).toBe("BLOCK");
    expect(res.reasons.map((r) => r.reason).sort()).toEqual([
      "FEDERAL_BAN",
      "INDETERMINATE_ADDRESS",
    ]);
  });
});

describe("rule window", () => {
  it.each([
    ["not yet effective", rule({ effectiveFrom: day(1) }), false],
    ["effective from exactly now", rule({ effectiveFrom: AT }), true],
    ["open-ended", rule({ effectiveTo: null }), true],
    ["ended in the past", rule({ effectiveTo: day(-1) }), false],
    ["ends exactly now (exclusive)", rule({ effectiveTo: AT }), false],
    ["ends in the future", rule({ effectiveTo: day(1) }), true],
    ["lifted before now", rule({ liftedAt: day(-1) }), false],
    ["lift dated after the point in time", rule({ liftedAt: day(1) }), true],
  ])("%s", (_name, r, active) => {
    expect(ruleIsActive(r, AT)).toBe(active);
  });

  it("an inactive rule never blocks", () => {
    expect(evaluateRestrictions(input({ rules: [rule({ liftedAt: day(-1) })] })).outcome).toBe(
      "ALLOW",
    );
  });

  it("matchingRules honours the channel", () => {
    const r = rule({ surface: "BUYER_PORTAL" });
    expect(matchingRules([r], product(), "STAFF", AT)).toHaveLength(0);
    expect(matchingRules([r], product(), "BUYER_PORTAL", AT)).toHaveLength(1);
  });
});

describe("variant opt-out at the decision level", () => {
  it("an opted-out variant (label already removed from its effective set) is not blocked by the label rule", () => {
    expect(
      evaluateRestrictions(input({ products: [product({ effectiveCategoryIds: new Set() })] }))
        .outcome,
    ).toBe("ALLOW");
  });

  it("parent product DENY + variant opt-out = DENY: deny wins across the lineage; a variant can never ALLOW past a parent DENY", () => {
    // The variant opted out of the parent's label (no effective labels) — but a product-scoped
    // DENY on the PARENT still binds it through its lineage.
    const variant = product({
      id: "v1",
      name: "Sour",
      effectiveCategoryIds: new Set(),
      lineageIds: new Set(["v1", "p-parent"]),
    });
    const res = evaluateRestrictions(
      input({
        products: [variant],
        rules: [
          rule({ id: "cat-rule", categoryId: "cat-thc" }),
          rule({
            id: "parent-rule",
            categoryId: null,
            productId: "p-parent",
            jurisdiction: "FEDERAL",
            states: [],
          }),
        ],
      }),
    );
    expect(res.outcome).toBe("BLOCK");
    expect(res.reasons.map((r) => r.ruleId)).toEqual(["parent-rule"]);
  });
});

describe("resolveGoverningState (D4: the customer's DEFAULT address governs)", () => {
  it("uses the default billing address's state by default", () => {
    expect(resolveGoverningState([addr({ stateCode: "TX" })], "BILLING_FIRST")).toEqual({
      resolved: true,
      state: "TX",
    });
  });

  it("precedence only orders DEFAULTS: SHIPPING_FIRST prefers the default shipping over the default billing", () => {
    const addresses = [
      addr({ addressType: "BILLING", stateCode: "TX" }),
      addr({ addressType: "SHIPPING", stateCode: "FL" }),
    ];
    expect(resolveGoverningState(addresses, "SHIPPING_FIRST")).toEqual({
      resolved: true,
      state: "FL",
    });
    expect(resolveGoverningState(addresses, "BILLING_FIRST")).toEqual({
      resolved: true,
      state: "TX",
    });
  });

  it("DELIVERY counts as shipping", () => {
    const addresses = [
      addr({ addressType: "BILLING", stateCode: "TX" }),
      addr({ addressType: "DELIVERY", stateCode: "NY" }),
    ];
    expect(resolveGoverningState(addresses, "SHIPPING_FIRST")).toEqual({
      resolved: true,
      state: "NY",
    });
  });

  it("addressType matching is case/whitespace-insensitive (free-text column)", () => {
    const addresses = [
      addr({ addressType: "BILLING", stateCode: "TX" }),
      addr({ addressType: " shipping ", stateCode: "FL" }),
    ];
    expect(resolveGoverningState(addresses, "SHIPPING_FIRST")).toEqual({
      resolved: true,
      state: "FL",
    });
  });

  it("REGRESSION (review #1): a NON-default address of the preferred type never outranks the real default", () => {
    // BILLING_FIRST tenant; the only billing row is not default, the default is the CA shipping row.
    const addresses = [
      addr({ addressType: "BILLING", isDefault: false, stateCode: "TX" }),
      addr({ addressType: "SHIPPING", isDefault: true, stateCode: "CA" }),
    ];
    expect(resolveGoverningState(addresses, "BILLING_FIRST")).toEqual({
      resolved: true,
      state: "CA",
    });
  });

  it("non-default addresses are ignored when a default exists, whatever their state", () => {
    const addresses = [
      addr({ addressType: "BILLING", stateCode: "TX" }),
      addr({ addressType: "SHIPPING", isDefault: false, stateCode: "FL" }),
      addr({ addressType: "SHIPPING", isDefault: false, stateCode: "NY" }),
    ];
    expect(resolveGoverningState(addresses, "SHIPPING_FIRST")).toEqual({
      resolved: true,
      state: "TX",
    });
  });

  it("falls back to the other type's default when the preferred type has none", () => {
    expect(resolveGoverningState([addr({ stateCode: "TX" })], "SHIPPING_FIRST")).toEqual({
      resolved: true,
      state: "TX",
    });
  });

  it("several defaults that agree are fine; several that disagree are unresolved (never a guess)", () => {
    const agree = [addr({ stateCode: "TX" }), addr({ stateCode: "tx" })];
    const disagree = [addr({ stateCode: "TX" }), addr({ stateCode: "FL" })];
    expect(resolveGoverningState(agree, "BILLING_FIRST")).toEqual({ resolved: true, state: "TX" });
    expect(resolveGoverningState(disagree, "BILLING_FIRST")).toEqual(UNRESOLVED_STATE);
  });

  it("no default anywhere: a sole address governs; several addresses are unresolved", () => {
    expect(
      resolveGoverningState([addr({ isDefault: false, stateCode: "TX" })], "BILLING_FIRST"),
    ).toEqual({
      resolved: true,
      state: "TX",
    });
    expect(
      resolveGoverningState(
        [addr({ isDefault: false, stateCode: "TX" }), addr({ isDefault: false, stateCode: "FL" })],
        "BILLING_FIRST",
      ),
    ).toEqual(UNRESOLVED_STATE);
  });

  it("no addresses is unresolved", () => {
    expect(resolveGoverningState([], "BILLING_FIRST")).toEqual(UNRESOLVED_STATE);
  });

  it.each([
    ["null state code", addr({ stateCode: null })],
    ["flagged for review", addr({ stateNeedsReview: true })],
    ["unreadable code", addr({ stateCode: "Tejas" })],
    ["blank code", addr({ stateCode: "  " })],
  ])("%s is unresolved", (_n, a) => {
    expect(resolveGoverningState([a], "BILLING_FIRST")).toEqual(UNRESOLVED_STATE);
  });

  it("never falls through to a second address when the governing one has no state", () => {
    const addresses = [
      addr({ addressType: "BILLING", stateCode: null }),
      addr({ addressType: "SHIPPING", isDefault: false, stateCode: "FL" }),
    ];
    expect(resolveGoverningState(addresses, "BILLING_FIRST")).toEqual(UNRESOLVED_STATE);
  });

  it("normalises code case and whitespace", () => {
    expect(resolveGoverningState([addr({ stateCode: " tx " })], "BILLING_FIRST")).toEqual({
      resolved: true,
      state: "TX",
    });
  });
});

describe("review regressions in the decision", () => {
  it('REGRESSION (review #3): a padded rule state code ("TX ") still bans TX', () => {
    expect(evaluateRestrictions(input({ rules: [rule({ states: ["TX ", " fl"] })] })).outcome).toBe(
      "BLOCK",
    );
  });

  it("a rule whose states are all blank counts as EMPTY → blocks everywhere, not nowhere", () => {
    const res = evaluateRestrictions(
      input({
        rules: [rule({ states: [" ", ""] })],
        governingState: { resolved: true, state: "OR" },
      }),
    );
    expect(res.outcome).toBe("BLOCK");
  });

  it("REGRESSION (review #4): a product rule on the PARENT binds its variant via lineage", () => {
    const variant = product({
      id: "v1",
      name: "Sour",
      effectiveCategoryIds: new Set(),
      lineageIds: new Set(["v1", "p-parent"]),
    });
    const res = evaluateRestrictions(
      input({ products: [variant], rules: [rule({ categoryId: null, productId: "p-parent" })] }),
    );
    expect(res.outcome).toBe("BLOCK");
    expect(res.reasons[0].productId).toBe("v1");
  });

  it("a product rule on a SIBLING variant does not bind this one", () => {
    const variant = product({
      id: "v1",
      effectiveCategoryIds: new Set(),
      lineageIds: new Set(["v1", "p"]),
    });
    expect(
      evaluateRestrictions(
        input({ products: [variant], rules: [rule({ categoryId: null, productId: "v2" })] }),
      ).outcome,
    ).toBe("ALLOW");
  });

  it("REGRESSION (review #6/#8): an unresolvable product is INDETERMINATE (UNKNOWN_PRODUCT), never ALLOW", () => {
    const res = evaluateRestrictions(
      input({ products: [product({ unresolvable: true })], rules: [] }),
    );
    expect(res.outcome).toBe("INDETERMINATE");
    expect(res.reasons[0]).toMatchObject({
      reason: "UNKNOWN_PRODUCT",
      ruleId: null,
      productId: "p1",
    });
  });

  it("an unresolvable product plus a definite ban is BLOCK", () => {
    const res = evaluateRestrictions(
      input({
        products: [product({ unresolvable: true }), product({ id: "p2", name: "Vape" })],
        rules: [rule({ categoryId: null, productId: "p2", jurisdiction: "FEDERAL", states: [] })],
      }),
    );
    expect(res.outcome).toBe("BLOCK");
    expect(res.reasons.map((r) => r.reason).sort()).toEqual(["FEDERAL_BAN", "UNKNOWN_PRODUCT"]);
  });
});

describe("review round 2 regressions", () => {
  it.each([
    ["a full state name is read as its code", ["Texas"], "TX", "BLOCK"],
    ["a padded lower-case code", [" tx "], "TX", "BLOCK"],
  ])("rule states: %s", (_n, states, state, outcome) => {
    const res = evaluateRestrictions(
      input({ rules: [rule({ states })], governingState: { resolved: true, state } }),
    );
    expect(res.outcome).toBe(outcome);
  });

  it.each([["Tex"], ["TX, OK"], ["N.Y."], ["ZZ"]])(
    "REGRESSION (round 2 #1): a rule naming %j (not a state) is malformed → blocks EVERYWHERE, never nowhere",
    (bad) => {
      const res = evaluateRestrictions(
        input({
          rules: [rule({ states: [bad] })],
          governingState: { resolved: true, state: "OR" },
        }),
      );
      expect(res.outcome).toBe("BLOCK");
      expect(res.reasons[0].reason).toBe("STATE_BAN");
    },
  );

  it("one malformed entry poisons the whole rule (fail closed), even next to a valid state", () => {
    const res = evaluateRestrictions(
      input({
        rules: [rule({ states: ["FL", "Tex"] })],
        governingState: { resolved: true, state: "OR" },
      }),
    );
    expect(res.outcome).toBe("BLOCK");
  });

  it.each([["ZZ"], ["XX"], ["Tejas"]])(
    "REGRESSION (round 2 #2): a stored state code %j that is not a USPS state is UNRESOLVED",
    (code) => {
      expect(resolveGoverningState([addr({ stateCode: code })], "BILLING_FIRST")).toEqual(
        UNRESOLVED_STATE,
      );
    },
  );

  it("REGRESSION (round 2 #4): an unknown-typed default beside other defaults can't be ordered → UNRESOLVED", () => {
    const addresses = [
      addr({ addressType: "SHIPING", stateCode: "CA" }), // typo'd type
      addr({ addressType: "SHIPPING", stateCode: "TX" }),
    ];
    expect(resolveGoverningState(addresses, "BILLING_FIRST")).toEqual(UNRESOLVED_STATE);
  });

  it("a SOLE default of unknown type still governs", () => {
    expect(
      resolveGoverningState([addr({ addressType: "office", stateCode: "TX" })], "BILLING_FIRST"),
    ).toEqual({
      resolved: true,
      state: "TX",
    });
  });
});

describe("round 3", () => {
  it("a matched rule with an UNRECOGNISED jurisdiction blocks (fail closed on enum extension), never ALLOW", () => {
    const res = evaluateRestrictions(
      input({ rules: [rule({ jurisdiction: "PROVINCE" as unknown as "STATE" })] }),
    );
    expect(res.outcome).toBe("BLOCK");
  });
});

describe("D4 (PC-lead ruling): the customer's DEFAULT address governs — three explicit no-default cases", () => {
  it("no default address and exactly ONE address: that address governs (unambiguous)", () => {
    expect(
      resolveGoverningState([addr({ isDefault: false, stateCode: "TX" })], "BILLING_FIRST"),
    ).toEqual({ resolved: true, state: "TX" });
  });

  it("ZERO addresses: INDETERMINATE — fail closed", () => {
    expect(resolveGoverningState([], "BILLING_FIRST")).toEqual(UNRESOLVED_STATE);
    expect(resolveGoverningState([], "SHIPPING_FIRST")).toEqual(UNRESOLVED_STATE);
  });

  it("SEVERAL addresses and NO default: INDETERMINATE — fail closed, never a guess", () => {
    expect(
      resolveGoverningState(
        [
          addr({ isDefault: false, addressType: "BILLING", stateCode: "TX" }),
          addr({ isDefault: false, addressType: "SHIPPING", stateCode: "FL" }),
        ],
        "BILLING_FIRST",
      ),
    ).toEqual(UNRESOLVED_STATE);
  });
});

describe("round 4", () => {
  it("an unrecognised-jurisdiction rule on a BUYER_PORTAL surface reports BUYER_PORTAL_ONLY (like every other block)", () => {
    const res = evaluateRestrictions(
      input({
        channel: "BUYER_PORTAL",
        rules: [rule({ jurisdiction: "PROVINCE" as unknown as "STATE", surface: "BUYER_PORTAL" })],
      }),
    );
    expect(res.reasons[0].reason).toBe("BUYER_PORTAL_ONLY");
  });

  it("when a FEDERAL rule and an unrecognised rule both match, the FEDERAL rule is the one reported", () => {
    const res = evaluateRestrictions(
      input({
        rules: [
          rule({ id: "future", jurisdiction: "PROVINCE" as unknown as "STATE" }),
          rule({ id: "fed", jurisdiction: "FEDERAL", states: [] }),
        ],
      }),
    );
    expect(res.reasons).toHaveLength(1);
    expect(res.reasons[0]).toMatchObject({ ruleId: "fed", reason: "FEDERAL_BAN" });
  });
});

/** Every ordering of `items` (small inputs only). */
const permutations = <T>(items: readonly T[]): T[][] =>
  items.length <= 1
    ? [[...items]]
    : items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
      );

describe("review MAJOR 1: the cited rule is deterministic (effectiveFrom desc, id asc)", () => {
  const cited = (rules: RestrictionRuleFacts[], over: Partial<EvaluateInput> = {}) =>
    evaluateRestrictions(input({ rules, ...over })).reasons.map((r) => ({
      ruleId: r.ruleId,
      reason: r.reason,
      message: r.message,
    }));

  // Three rules per pick: an OLD one, and two NEWER ones sharing an effectiveFrom (tie → id).
  const trio = (over: Partial<RestrictionRuleFacts>) => [
    rule({ id: "r-old", effectiveFrom: day(-30), ...over }),
    rule({ id: "r-b", effectiveFrom: day(-5), ...over }),
    rule({ id: "r-a", effectiveFrom: day(-5), ...over }),
  ];

  it.each([
    ["FEDERAL rule", trio({ jurisdiction: "FEDERAL", states: [] }), {}],
    [
      "unrecognised-jurisdiction rule",
      trio({ jurisdiction: "PROVINCE" as unknown as "STATE" }),
      {},
    ],
    ["empty-states STATE rule (blocks everywhere)", trio({ states: [] }), {}],
    ["STATE rule that names the customer's state", trio({ states: ["TX"] }), {}],
    [
      "STATE rule cited by INDETERMINATE_ADDRESS",
      trio({ states: ["TX"] }),
      { governingState: UNRESOLVED_STATE },
    ],
  ])(
    "%s: identical citation in EVERY input order; newest first, tie broken by id",
    (_n, rules, over) => {
      const expected = cited(rules, over);
      expect(expected).toHaveLength(1);
      expect(expected[0].ruleId).toBe("r-a");
      for (const order of permutations(rules)) {
        expect(cited(order, over)).toEqual(expected);
      }
    },
  );

  it("a NEWER effectiveFrom beats an older rule regardless of id or input order", () => {
    const rules = [
      rule({ id: "a-old", effectiveFrom: day(-30) }),
      rule({ id: "z-new", effectiveFrom: day(-1) }),
    ];
    for (const order of permutations(rules)) {
      expect(cited(order).map((c) => c.ruleId)).toEqual(["z-new"]);
    }
  });

  it("a FEDERAL rule still outranks a newer STATE rule (the pick order is unchanged)", () => {
    const rules = [
      rule({ id: "state-new", effectiveFrom: day(-1) }),
      rule({ id: "fed-old", effectiveFrom: day(-30), jurisdiction: "FEDERAL", states: [] }),
    ];
    for (const order of permutations(rules)) {
      expect(cited(order).map((c) => c.ruleId)).toEqual(["fed-old"]);
    }
  });

  it("compareRules is a total order: newest effectiveFrom first, then id ascending", () => {
    const rules = [
      rule({ id: "c", effectiveFrom: day(-1) }),
      rule({ id: "b", effectiveFrom: day(-5) }),
      rule({ id: "a", effectiveFrom: day(-5) }),
    ];
    expect([...rules].sort(compareRules).map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect(compareRules(rules[0], rules[0])).toBe(0);
  });

  it("matchingRules returns the same sorted list for any input order and does not mutate its input", () => {
    const rules = [
      rule({ id: "b", effectiveFrom: day(-5) }),
      rule({ id: "c", effectiveFrom: day(-1) }),
      rule({ id: "a", effectiveFrom: day(-5) }),
    ];
    const snapshot = rules.map((r) => r.id);
    for (const order of permutations(rules)) {
      expect(matchingRules(order, product(), "STAFF", AT).map((r) => r.id)).toEqual([
        "c",
        "a",
        "b",
      ]);
    }
    expect(rules.map((r) => r.id)).toEqual(snapshot);
  });
});

describe("review MINOR 1: ruleBindsChannel fails CLOSED on an unknown surface", () => {
  const surfaceRule = (surface: string) => rule({ surface: surface as unknown as "ALL" });

  it.each([
    ["ALL", "STAFF", true],
    ["ALL", "BUYER_PORTAL", true],
    ["BUYER_PORTAL", "STAFF", false],
    ["BUYER_PORTAL", "BUYER_PORTAL", true],
    ["MOBILE_ONLY (a value this file has not learned)", "STAFF", true],
    ["MOBILE_ONLY (a value this file has not learned)", "BUYER_PORTAL", true],
    ["", "STAFF", true],
  ] as const)("surface %s on the %s channel binds: %s", (surface, channel, binds) => {
    expect(ruleBindsChannel(surfaceRule(surface), channel)).toBe(binds);
  });

  it("an unknown-surface rule blocks STAFF (not exempted) and reports the plain ban reason", () => {
    const res = evaluateRestrictions(
      input({ channel: "STAFF", rules: [rule({ surface: "FUTURE" as unknown as "ALL" })] }),
    );
    expect(res.outcome).toBe("BLOCK");
    expect(res.reasons[0].reason).toBe("STATE_BAN");
  });

  it("matchingRules binds an unknown surface on both channels, a BUYER_PORTAL surface only on the portal", () => {
    const unknown = rule({ surface: "FUTURE" as unknown as "ALL" });
    expect(matchingRules([unknown], product(), "STAFF", AT)).toHaveLength(1);
    expect(matchingRules([unknown], product(), "BUYER_PORTAL", AT)).toHaveLength(1);
    const portal = rule({ surface: "BUYER_PORTAL" });
    expect(matchingRules([portal], product(), "STAFF", AT)).toHaveLength(0);
    expect(matchingRules([portal], product(), "BUYER_PORTAL", AT)).toHaveLength(1);
  });
});

describe("review MINOR 2: ruleIsActive (JS) and activeRuleWhere (SQL twin) agree", () => {
  type Window = { effectiveFrom: Date; effectiveTo: Date | null; liftedAt: Date | null };

  /** A tiny interpreter for exactly the operators `activeRuleWhere` uses — anything else throws. */
  const matches = (row: Record<string, Date | null>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, cond]) => {
      if (key === "AND") return (cond as Record<string, unknown>[]).every((w) => matches(row, w));
      if (key === "OR") return (cond as Record<string, unknown>[]).some((w) => matches(row, w));
      const value = row[key];
      if (cond === null) return value === null;
      const c = cond as { lte?: Date; gt?: Date };
      if (c.lte !== undefined) return value !== null && value.getTime() <= c.lte.getTime();
      if (c.gt !== undefined) return value !== null && value.getTime() > c.gt.getTime();
      throw new Error(`activeRuleWhere uses an operator this spec cannot interpret on "${key}"`);
    });
  const sqlActive = (w: Window) => matches({ ...w }, activeRuleWhere(AT));

  const win = (over: Partial<Window> = {}): Window => ({
    effectiveFrom: day(-30),
    effectiveTo: null,
    liftedAt: null,
    ...over,
  });

  it("ruleIsActive accepts just the three window fields (reusable by other lanes)", () => {
    expect(ruleIsActive({ effectiveFrom: day(-1), effectiveTo: null, liftedAt: null }, AT)).toBe(
      true,
    );
  });

  it.each([
    ["effectiveFrom == at is included", win({ effectiveFrom: AT }), true],
    ["effectiveFrom after at is excluded", win({ effectiveFrom: day(1) }), false],
    ["effectiveTo == at is excluded", win({ effectiveTo: AT }), false],
    ["effectiveTo after at is included", win({ effectiveTo: day(1) }), true],
    ["effectiveTo before at is excluded", win({ effectiveTo: day(-1) }), false],
    ["liftedAt == at is excluded", win({ liftedAt: AT }), false],
    ["liftedAt before at is excluded", win({ liftedAt: day(-1) }), false],
    ["liftedAt after at is included", win({ liftedAt: day(1) }), true],
    ["open-ended, never lifted is included", win(), true],
    [
      "lifted in the future but already ended is excluded",
      win({ effectiveTo: day(-1), liftedAt: day(1) }),
      false,
    ],
  ])("%s — fragment and ruleIsActive agree", (_n, w, expected) => {
    expect(ruleIsActive(w, AT)).toBe(expected);
    expect(sqlActive(w)).toBe(expected);
  });

  it("agree on EVERY combination of from / to / lifted around the boundary (48 cases)", () => {
    const from = [day(-1), AT, day(1)];
    const to = [null, day(-1), AT, day(1)];
    const lifted = [null, day(-1), AT, day(1)];
    let n = 0;
    for (const effectiveFrom of from) {
      for (const effectiveTo of to) {
        for (const liftedAt of lifted) {
          const w = { effectiveFrom, effectiveTo, liftedAt };
          expect({ w, sql: sqlActive(w) }).toEqual({ w, sql: ruleIsActive(w, AT) });
          n++;
        }
      }
    }
    expect(n).toBe(48);
  });

  it("the fragment's exact structure (a change here must be a deliberate one)", () => {
    expect(activeRuleWhere(AT)).toEqual({
      effectiveFrom: { lte: AT },
      AND: [
        { OR: [{ effectiveTo: null }, { effectiveTo: { gt: AT } }] },
        { OR: [{ liftedAt: null }, { liftedAt: { gt: AT } }] },
      ],
    });
  });
});

describe("review MINOR 6: UNKNOWN_PRODUCT never shows a raw id to the buyer", () => {
  const ID = "3f2b8c1e-9d4a-4e7b-8a15-6c0d2f9e7a41";

  it.each([
    ["the loader's id fallback as the name", product({ id: ID, name: ID, unresolvable: true })],
    ["a known name whose parent is missing", product({ id: ID, name: "Sour", unresolvable: true })],
  ])(
    "%s: productName is generic, the message carries no id or name, productId keeps the id",
    (_n, p) => {
      const res = evaluateRestrictions(input({ products: [p], rules: [] }));
      expect(res.outcome).toBe("INDETERMINATE");
      const reason = res.reasons[0];
      expect(reason.reason).toBe("UNKNOWN_PRODUCT");
      expect(reason.productId).toBe(ID);
      expect(reason.productName).toBe(UNKNOWN_PRODUCT_NAME);
      expect(reason.productName).toBe("Unknown product");
      expect(reason.message).not.toContain(ID);
      expect(reason.message).not.toContain(p.name);
      expect(reason.message).toMatch(/can't be checked/);
    },
  );

  describe("round 1 (Opus): nameKnown", () => {
    it("an unresolvable product whose OWN name is known shows that name, never the id", () => {
      const res = evaluateRestrictions(
        input({
          products: [
            product({ id: "uuid-9", name: "Bourbon 750ml", unresolvable: true, nameKnown: true }),
          ],
          rules: [],
        }),
      );
      expect(res.reasons[0]).toMatchObject({
        reason: "UNKNOWN_PRODUCT",
        productId: "uuid-9",
        productName: "Bourbon 750ml",
      });
      expect(res.reasons[0].message).toContain("Bourbon 750ml");
      expect(res.reasons[0].message).not.toContain("uuid-9");
    });

    it("without nameKnown the name (which is the raw id) is never echoed", () => {
      const res = evaluateRestrictions(
        input({
          products: [product({ id: "uuid-9", name: "uuid-9", unresolvable: true })],
          rules: [],
        }),
      );
      expect(res.reasons[0].productName).toBe(UNKNOWN_PRODUCT_NAME);
      expect(res.reasons[0].message).not.toContain("uuid-9");
    });
  });
});
