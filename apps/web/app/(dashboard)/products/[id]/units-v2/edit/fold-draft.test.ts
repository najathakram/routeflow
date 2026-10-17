import type {
  CustomerChange,
  CustomerPricingWithId,
  PricePlan,
  PriceTier,
} from "@routeflow/pricing";
import type { CustomerPriceMove } from "@routeflow/types";
import { emptyPlan } from "../change-prices/plan.test-utils";
import { staleKeepMoves, staleOfferEntries, type DraftEntry } from "./fold-draft";

const move = (over: Partial<CustomerPriceMove> = {}): CustomerPriceMove => ({
  customerId: "c1",
  ref: "case",
  tier: 2,
  from: 13,
  to: 14,
  ...over,
});
const offerEntry = (over: Partial<Extract<DraftEntry, { kind: "offer" }>> = {}): DraftEntry => ({
  kind: "offer",
  id: "k#customer",
  planKey: "k",
  title: "t",
  patches: [],
  moves: [move()],
  ...over,
});
const planWith = (moves: CustomerPriceMove[]): PricePlan =>
  emptyPlan({
    offers: [
      {
        kind: "customer",
        ticked: false,
        title: "t",
        moves: moves.map((m) => ({
          ...m,
          tier: m.tier as PriceTier,
          from: m.from!,
          to: m.to!,
          against: false,
        })),
      },
    ],
  });

describe("staleOfferEntries", () => {
  it("an offer whose moves are exactly the fresh offer's (any order) is not stale", () => {
    const a = move();
    const b = move({ customerId: "c2" });
    const e = offerEntry({ moves: [a, b] });
    expect(staleOfferEntries([e], new Map([["k", planWith([b, a])]]))).toEqual([]);
  });

  it("any difference in customer, unit, tier, from or to is stale", () => {
    const fresh = (m: Partial<CustomerPriceMove>) => new Map([["k", planWith([move(m)])]]);
    for (const m of [
      { customerId: "c9" },
      { ref: "piece" },
      { tier: 3 },
      { from: 12 },
      { to: 15 },
    ]) {
      expect(staleOfferEntries([offerEntry()], fresh(m))).toHaveLength(1);
    }
  });

  it("a fresh plan with no customer offer left is stale", () => {
    expect(staleOfferEntries([offerEntry()], new Map([["k", emptyPlan()]]))).toHaveLength(1);
  });

  it("a baked offer whose plan is missing is stale (nothing says it still holds), never kept silently", () => {
    expect(staleOfferEntries([offerEntry()], new Map())).toHaveLength(1);
  });

  it("tier offers (no moves) and other entries are never stale", () => {
    const tier = offerEntry({ moves: [], patches: [{ ref: "case", tier: 3, to: 5 }] });
    expect(
      staleOfferEntries([tier, { kind: "cell", key: "case|2", text: "5" }], new Map()),
    ).toEqual([]);
  });
});

describe("staleKeepMoves", () => {
  const keep = move({ from: null, to: 7.56 });
  const row: CustomerChange = {
    customerId: "c1",
    ref: "case",
    tier: 2,
    from: 7.56,
    to: 7.88,
    against: false,
    cause: "shape",
  };
  const plans = (rows: CustomerChange[]) => new Map([["k", emptyPlan({ customerChanges: rows })]]);
  const customer: CustomerPricingWithId = {
    customerId: "c1",
    tier: 2,
    orderUnit: "piece",
    set: { piece: 0.5 },
  };

  it("a Keep the panel still shows (same customer, unit, tier; from is its pinned price; no price of their own) stays", () => {
    expect(staleKeepMoves([keep], plans([row]), [customer])).toEqual([]);
  });

  it.each([
    ["the row is gone", plans([]), [customer]],
    ["the row now starts from another price", plans([{ ...row, from: 9.07 }]), [customer]],
    ["the customer changed tier", plans([{ ...row, tier: 3 }]), [customer]],
    [
      "the customer has a price on the unit now",
      plans([row]),
      [{ ...customer, set: { piece: 0.5, case: 9 } }],
    ],
  ] as [string, ReturnType<typeof plans>, CustomerPricingWithId[]][])(
    "%s: the Keep is stale",
    (_n, p, cs) => {
      expect(staleKeepMoves([keep], p, cs)).toEqual([keep]);
    },
  );

  it("a row in any of the draft's plans counts", () => {
    const two = new Map([
      ["a", emptyPlan()],
      ["b", emptyPlan({ customerChanges: [row] })],
    ]);
    expect(staleKeepMoves([keep], two, [customer])).toEqual([]);
  });
});
