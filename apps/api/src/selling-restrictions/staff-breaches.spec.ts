import {
  evaluateRestrictions,
  UNRESOLVED_STATE,
  type EvaluateInput,
  type GoverningState,
  type ProductFacts,
  type RestrictionRuleFacts,
} from "./selling-restrictions.core";
import { breachKeys, OVERRIDE_STATE_UNKNOWN, staffBreaches } from "./staff-breaches";

/**
 * Row 510: `staffBreaches` lists EVERY rule that breaches a staff sale, by the core's own predicates. The parity block
 * below runs it against `evaluateRestrictions` over a generated grid: a product is breached iff the engine reports it,
 * with the same BLOCK / INDETERMINATE outcome, and the engine's single cited rule is always among the listed ones.
 */
const AT = new Date("2026-10-13T12:00:00Z");
const rule = (over: Partial<RestrictionRuleFacts> = {}): RestrictionRuleFacts => ({
  id: "r1",
  categoryId: null,
  productId: "p1",
  jurisdiction: "STATE",
  states: ["CA"],
  surface: "ALL",
  effectiveFrom: new Date("2026-01-01T00:00:00Z"),
  effectiveTo: null,
  liftedAt: null,
  reason: "State ban",
  targets: null,
  ...over,
});
const product = (id: string, over: Partial<ProductFacts> = {}): ProductFacts => ({
  id,
  name: `Product ${id}`,
  effectiveCategoryIds: new Set<string>(),
  lineageIds: new Set([id]),
  nameKnown: true,
  ...over,
});
const input = (over: Partial<EvaluateInput> = {}): EvaluateInput => ({
  channel: "STAFF",
  at: AT,
  products: [product("p1")],
  rules: [],
  governingState: { resolved: true, state: "CA" },
  ...over,
});

describe("staffBreaches", () => {
  it("lists EVERY rule that blocks the product, not only the one the engine cites", () => {
    const rules = [
      rule({ id: "fed", jurisdiction: "FEDERAL", states: [] }),
      rule({ id: "ca", states: ["CA"] }),
      rule({ id: "tx", states: ["TX"] }), // does not bind a CA sale
    ];
    const [b] = staffBreaches(input({ rules }));
    expect(b).toMatchObject({ productId: "p1", outcome: "BLOCK" });
    expect([...b.ruleIds].sort()).toEqual(["ca", "fed"]);
    expect(b.rules.map((r) => r.kind).sort()).toEqual(["FEDERAL", "STATE_HIT"]);
  });

  it("a STATE rule that does not name the governing state is no breach", () => {
    expect(staffBreaches(input({ rules: [rule({ states: ["TX"] })] }))).toEqual([]);
  });

  it("an unresolved state with a legal STATE rule in play is INDETERMINATE and lists the in-play STATE rules", () => {
    const [b] = staffBreaches(
      input({
        governingState: UNRESOLVED_STATE,
        rules: [rule({ id: "a", states: ["CA"] }), rule({ id: "b", states: ["TX"] })],
      }),
    );
    expect(b.outcome).toBe("INDETERMINATE");
    expect([...b.ruleIds].sort()).toEqual(["a", "b"]);
    expect(b.rules.every((r) => r.kind === "STATE_UNRESOLVED")).toBe(true);
  });

  it("an unresolved state with a FEDERAL rule is still BLOCK (a federal ban does not need the state)", () => {
    const [b] = staffBreaches(
      input({
        governingState: UNRESOLVED_STATE,
        rules: [rule({ id: "fed", jurisdiction: "FEDERAL", states: [] }), rule({ id: "ca" })],
      }),
    );
    expect(b.outcome).toBe("BLOCK");
    expect(b.ruleIds).toEqual(["fed"]);
  });

  it("a malformed STATE rule (no readable states) blocks everywhere and is named", () => {
    const [b] = staffBreaches(input({ rules: [rule({ id: "bad", states: ["Tex"] })] }));
    expect(b).toMatchObject({ outcome: "BLOCK", ruleIds: ["bad"] });
    expect(b.rules[0].kind).toBe("MALFORMED_STATE");
  });

  it("an unresolvable product is INDETERMINATE with no rule ids and the engine's anonymous name", () => {
    const [b] = staffBreaches(
      input({ products: [product("ghost", { unresolvable: true, nameKnown: false })] }),
    );
    expect(b).toMatchObject({
      productId: "ghost",
      outcome: "INDETERMINATE",
      ruleIds: [],
      unknownProduct: true,
      productName: "Unknown product",
    });
  });

  it("a legal-ban flag: surface ALL is legal; a BUYER_PORTAL rule never binds the staff channel", () => {
    expect(staffBreaches(input({ rules: [rule({ surface: "BUYER_PORTAL" })] }))).toEqual([]);
    const [b] = staffBreaches(input({ rules: [rule({ surface: "ALL" })] }));
    expect(b.rules[0].legal).toBe(true);
  });

  it("records the governing state the STATE hits were judged at", () => {
    const [b] = staffBreaches(input({ rules: [rule()] }));
    expect(b.state).toBe("CA");
  });

  describe("breachKeys: a stamp is by (rule id, judged state)", () => {
    it("is ruleId:STATE for a resolved sale, one per listed rule", () => {
      const [b] = staffBreaches(
        input({
          rules: [rule({ id: "ca" }), rule({ id: "fed", jurisdiction: "FEDERAL", states: [] })],
        }),
      );
      expect([...breachKeys(b)].sort()).toEqual(["ca:CA", "fed:CA"]);
    });

    it("is ruleId:UNKNOWN when the state could not be resolved (an INDETERMINATE breach)", () => {
      const [b] = staffBreaches(
        input({ governingState: UNRESOLVED_STATE, rules: [rule({ id: "a" }), rule({ id: "b" })] }),
      );
      expect(b.outcome).toBe("INDETERMINATE");
      expect([...breachKeys(b)].sort()).toEqual(["a:UNKNOWN", "b:UNKNOWN"]);
      expect(OVERRIDE_STATE_UNKNOWN).toBe("UNKNOWN");
    });

    it("differs when the judged state differs, with the same rule", () => {
      const [ca] = staffBreaches(input({ rules: [rule({ id: "r", states: ["CA", "TX"] })] }));
      const [tx] = staffBreaches(
        input({
          governingState: { resolved: true, state: "TX" },
          rules: [rule({ id: "r", states: ["CA", "TX"] })],
        }),
      );
      expect(breachKeys(ca)).toEqual(["r:CA"]);
      expect(breachKeys(tx)).toEqual(["r:TX"]);
    });

    it("an unresolvable product has no keys (no rule could be matched)", () => {
      const [b] = staffBreaches(
        input({ products: [product("ghost", { unresolvable: true, nameKnown: false })] }),
      );
      expect(breachKeys(b)).toEqual([]);
    });
  });

  describe("parity with evaluateRestrictions (a product is breached iff the engine reports it)", () => {
    const ruleSets: Array<[string, RestrictionRuleFacts[]]> = [
      ["no rules", []],
      ["one CA state ban", [rule({ id: "a" })]],
      ["one TX state ban", [rule({ id: "a", states: ["TX"] })]],
      ["federal", [rule({ id: "a", jurisdiction: "FEDERAL", states: [] })]],
      ["federal + CA", [rule({ id: "a", jurisdiction: "FEDERAL", states: [] }), rule({ id: "b" })]],
      ["malformed", [rule({ id: "a", states: ["Tex"] })]],
      ["empty states", [rule({ id: "a", states: [] })]],
      ["portal-only CA", [rule({ id: "a", surface: "BUYER_PORTAL" })]],
      ["portal-only + legal CA", [rule({ id: "a", surface: "BUYER_PORTAL" }), rule({ id: "b" })]],
      ["lifted", [rule({ id: "a", liftedAt: new Date("2026-02-01T00:00:00Z") })]],
      ["not yet effective", [rule({ id: "a", effectiveFrom: new Date("2027-01-01T00:00:00Z") })]],
      [
        "targets (p1 only)",
        [
          rule({
            id: "a",
            productId: null,
            targets: { productIds: new Set(["p1"]), categoryIds: new Set() },
          }),
        ],
      ],
      [
        "two CA + one TX",
        [rule({ id: "a" }), rule({ id: "b" }), rule({ id: "c", states: ["TX"] })],
      ],
      ["unrecognised jurisdiction", [rule({ id: "a", jurisdiction: "COUNTY" as never })]],
    ];
    const states: Array<[string, GoverningState]> = [
      ["CA", { resolved: true, state: "CA" }],
      ["FL", { resolved: true, state: "FL" }],
      ["unresolved", UNRESOLVED_STATE],
    ];
    const products: ProductFacts[] = [
      product("p1"),
      product("p2"), // matched by no rule
      product("u1", { unresolvable: true, nameKnown: false }),
      product("u2", { unresolvable: true, nameKnown: true }),
    ];

    // L8 (merged with row 510): a counter / pickup sale is judged on the STORE's state (`storeJudged`), where a
    // missing store state is INDETERMINATE even for a portal-only rule; the breach list must follow the engine there too.
    for (const storeJudged of [false, true])
      for (const channel of ["STAFF", "BUYER_PORTAL"] as const) {
        for (const [ruleName, rules] of ruleSets) {
          for (const [stateName, governingState] of states) {
            it(`${channel} / ${ruleName} / ${stateName}${storeJudged ? " / store-judged" : ""}`, () => {
              const i = input({ channel, rules, governingState, products, storeJudged });
              const engine = evaluateRestrictions(i);
              const breaches = staffBreaches(i);
              expect(breaches.map((b) => b.productId).sort()).toEqual(
                engine.reasons.map((r) => r.productId).sort(),
              );
              for (const reason of engine.reasons) {
                const b = breaches.find((x) => x.productId === reason.productId)!;
                expect(b.outcome).toBe(
                  reason.reason === "INDETERMINATE_ADDRESS" || reason.reason === "UNKNOWN_PRODUCT"
                    ? "INDETERMINATE"
                    : "BLOCK",
                );
                // the rule the engine cites is always one of the listed ones
                if (reason.ruleId) expect(b.ruleIds).toContain(reason.ruleId);
              }
            });
          }
        }
      }
  });
});
