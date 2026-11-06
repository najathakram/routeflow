import type {
  CustomerChange,
  CustomerPricingWithId,
  FamilyCell,
  LadderView,
  PricePlan,
  PriceTier,
} from "@routeflow/pricing";
import type { CustomerPriceMove } from "@routeflow/types";
import { emptyPlan, VIEW } from "../change-prices/plan.test-utils";
import {
  cellKey,
  foldDraft,
  staleKeepMoves,
  staleOfferEntries,
  type DraftEntry,
} from "./fold-draft";

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

describe("foldDraft: a refused cell is refused only until a later entry writes it", () => {
  const bad: DraftEntry = { kind: "cell", key: "case|1", text: "abc" };
  const plan = (to: number): DraftEntry => {
    const p = emptyPlan({ patches: [{ ref: "case", tier: 1, to }] });
    return { kind: "plan", key: "plan:0", plan: p, replan: () => p };
  };
  const offer: DraftEntry = {
    kind: "offer",
    id: "k#tier:case|1",
    planKey: "k",
    title: "t",
    patches: [{ ref: "case", tier: 1, to: 33 }],
    moves: [],
  };

  it("keeps the problem while nothing later patches the cell", () => {
    const r = foldDraft(VIEW, {}, [bad], null, []);
    expect(r.problems).toEqual([expect.objectContaining({ ref: "case", tier: 1 })]);
    expect(r.patches).toEqual([]);
  });

  it.each([
    ["a later plan", plan(33)],
    ["a later ticked offer", offer],
  ])("drops it when %s patches the cell, and the later value is the patch", (_n, later) => {
    const r = foldDraft(VIEW, {}, [bad, later], null, []);
    expect(r.problems).toEqual([]);
    expect(r.patches).toEqual([{ ref: "case", tier: 1, to: 33 }]);
  });

  it("keeps it when the plan patches another cell", () => {
    const other = emptyPlan({ patches: [{ ref: "case", tier: 2, to: 14 }] });
    const r = foldDraft(
      VIEW,
      {},
      [bad, { kind: "plan", key: "plan:0", plan: other, replan: () => other }],
      null,
      [],
    );
    expect(r.problems).toHaveLength(1);
  });

  it("keeps a refusal typed AFTER the plan", () => {
    const r = foldDraft(VIEW, {}, [plan(33), bad], null, []);
    expect(r.problems).toHaveLength(1);
  });
});

describe("SA-1082 rulings 6 and 7: the draft on a variant's family row", () => {
  const family: FamilyCell[] = [
    { value: 24, follows: true },
    { value: 22, follows: true },
    { value: null, follows: true },
    { value: null, follows: true },
    { value: null, follows: true },
  ];
  const ladder = (set: (number | null)[]): LadderView => ({
    rows: [{ ref: "pack", label: "Case", factor: 12, kind: "pack", set }],
    anchor: "pack",
    tierAnchors: {},
  });
  const cell = (tier: number, text: string): DraftEntry => ({
    kind: "cell",
    key: cellKey("pack", tier),
    text,
  });
  const fold = (
    set: (number | null)[],
    entries: DraftEntry[],
    cells: FamilyCell[] | null = family,
  ) => foldDraft(ladder(set), {}, entries, null, [], (n) => `Tier ${n}`, [], cells);
  const setOf = (r: ReturnType<typeof fold>) => r.view.rows[0]?.set;

  it("clearing Retail takes the family's number in the same write, not a refusal", () => {
    const r = fold(
      [30, null, null, null, null],
      [cell(1, "")],
      [
        { value: 24, follows: false },
        { value: 22, follows: false },
        { value: null, follows: false },
        { value: null, follows: false },
        { value: null, follows: false },
      ],
    );
    expect(r.problems).toEqual([]);
    expect(setOf(r)?.[0]).toBe(24);
  });

  it("clearing Retail with no usable family Retail keeps today's refusal", () => {
    const none = family.map(() => ({ value: null, follows: false }));
    const withFamily = fold([30, null, null, null, null], [cell(1, "")], none);
    const noFamily = fold([30, null, null, null, null], [cell(1, "")], null);
    expect(withFamily.problems.map((p) => [p.ref, p.tier])).toEqual([["pack", 1]]);
    expect(withFamily.problems).toEqual(noFamily.problems);
  });

  it("clearing a tier while Retail follows takes the family's number", () => {
    const r = fold([24, 20, null, null, null], [cell(2, "")]);
    expect(r.problems).toEqual([]);
    expect(setOf(r)?.[1]).toBe(22);
  });

  it("clearing a tier the family has blank leaves it blank", () => {
    const r = fold([24, 22, 20, null, null], [cell(3, "")]);
    expect(setOf(r)?.[2]).toBeNull();
  });

  it("typing an own Retail blanks the tiers at the family's value, in the draft", () => {
    const r = fold([24, 22, null, null, null], [cell(1, "30")]);
    expect(r.problems).toEqual([]);
    expect(setOf(r)?.[0]).toBe(30);
    expect(setOf(r)?.[1]).toBeNull();
  });

  it("a tier typed in the same draft wins", () => {
    const r = fold([24, 22, null, null, null], [cell(1, "30"), cell(2, "25")]);
    expect(setOf(r)?.[1]).toBe(25);
  });

  it("typing a Retail equal to the family's blanks nothing", () => {
    const r = fold([24, 22, null, null, null], [cell(1, "24")]);
    expect(setOf(r)?.[1]).toBe(22);
  });

  it("a variant that doesn't follow keeps every tier when Retail changes", () => {
    const off = family.map((c) => ({ ...c, follows: false }));
    const r = fold([30, 28, null, null, null], [cell(1, "31")], off);
    expect(setOf(r)?.[1]).toBe(28);
  });

  it("text that isn't a price keeps its own refusal, and takes nothing from the family", () => {
    const r = fold([24, 20, null, null, null], [cell(1, "abc"), cell(2, "")]);
    expect(r.problems.map((p) => [p.ref, p.tier])).toContainEqual(["pack", 1]);
    expect(setOf(r)?.[1]).not.toBe(22);
  });
});
