import { getTierPrice } from "./tier-pricing";
import {
  DEFAULT_TIER_RULES,
  buildLadderView,
  ladderPrice,
  priceSource,
  refForLabel,
  type LadderViewUnit,
  type PriceTier,
  type UnitRef,
} from "./price-ladder";
import {
  customerPrice,
  materializePack,
  planOrderUnitSwitch,
  type CustomerPricing,
} from "./price-anchor";
import { PACK_WRITE_PATH_COMPLETE, tierRulesAboveZero } from "./pack-write-path";
import type { LadderProduct } from "./unit-levels";

const lvl = (
  label: string,
  factorToBase: number,
  price: string | null = null,
  extra: Record<string, unknown> = {},
): LadderViewUnit => ({
  label,
  factorToBase,
  price,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  ...extra,
});
const TIERS: PriceTier[] = [1, 2, 3, 4, 5];
const box12: LadderProduct = { unit: "Box", unitsPerBox: 12, pricePerUnit: "12.00" };
const ref = (p: LadderProduct, u: LadderViewUnit[], label: string): UnitRef =>
  refForLabel(p, u, label);
const priceOf = (
  view: ReturnType<typeof buildLadderView>,
  p: LadderProduct,
  u: LadderViewUnit[],
  label: string,
  tier: PriceTier,
) => ladderPrice(view, ref(p, u, label), tier, DEFAULT_TIER_RULES);

describe("T7: switching the order unit", () => {
  it("Box -> Piece with Box $12 set, Piece set $1.20, Case(72) Auto: Case moves $72.00 -> $86.40; set prices stay; only the Case row is listed", () => {
    const units = [lvl("Piece", 1, "1.20"), lvl("Case", 72)];
    const view = buildLadderView(box12, units);
    const plan = planOrderUnitSwitch(view, { kind: "product" }, ref(box12, units, "Piece"));
    const caseRef = ref(box12, units, "Case");
    expect(plan.changes.every((c) => c.ref === caseRef)).toBe(true);
    expect(plan.changes.find((c) => c.tier === 1)).toMatchObject({
      from: 72,
      to: 86.4,
      label: "Case",
    });
    expect(plan.pins).toEqual([]); // the Piece's Retail was already set
    expect(priceOf(plan.view, box12, units, "Box", 1)).toBe(12);
    expect(priceOf(plan.view, box12, units, "Piece", 1)).toBe(1.2);
    expect(plan.view.anchor).toBe(ref(box12, units, "Piece"));
  });

  it("T7a: Box $10/12 -> Piece (Auto $0.83): the Piece is kept as set $0.83; Case $60.00 -> $59.76 is listed; Keep pins $60.00", () => {
    const p: LadderProduct = { unit: "Box", unitsPerBox: 12, pricePerUnit: "10.00" };
    const units = [lvl("Case", 72)];
    const view = buildLadderView(p, units);
    const piece = ref(p, units, "Piece");
    expect(priceOf(view, p, units, "Piece", 1)).toBe(0.83);
    const plan = planOrderUnitSwitch(view, { kind: "product" }, piece);
    expect(plan.pins).toEqual([{ ref: piece, tier: 1, value: 0.83 }]);
    expect(
      priceSource(
        plan.view.rows.find((r) => r.ref === piece)!,
        1,
      ),
    ).toBe("set");
    expect(plan.changes.filter((c) => c.tier === 1)).toEqual([
      { ref: ref(p, units, "Case"), label: "Case", tier: 1, from: 60, to: 59.76 },
    ]);
    // The Case's Auto tiers follow its Retail, so they are listed too; nothing else moves.
    expect(plan.changes.every((c) => c.label === "Case" && c.to === 59.76)).toBe(true);
    const keepCase = TIERS.map((tier) => ({ ref: ref(p, units, "Case"), tier }));
    const kept = planOrderUnitSwitch(view, { kind: "product" }, piece, { keep: keepCase });
    expect(kept.changes).toEqual([]);
    expect(kept.pins.map((x) => [x.tier, x.value])).toEqual([
      [1, 0.83],
      [1, 60],
      [2, 60],
      [3, 60],
      [4, 60],
      [5, 60],
    ]);
    expect(priceOf(kept.view, p, units, "Case", 1)).toBe(60);
  });

  it("T7b: with Box Tier 2 set $11, Piece Tier 2 $0.92 -> $1.00 and Case Tier 2 $66.00 -> $72.00 are listed; Keep all = no value changes", () => {
    const p: LadderProduct = { ...box12, priceTier2: "11.00" };
    const units = [lvl("Case", 72)];
    const view = buildLadderView(p, units);
    const piece = ref(p, units, "Piece");
    const caseRef = ref(p, units, "Case");
    const plan = planOrderUnitSwitch(view, { kind: "product" }, piece);
    const t2 = plan.changes.filter((c) => c.tier === 2);
    expect(t2).toEqual([
      { ref: caseRef, label: "Case", tier: 2, from: 66, to: 72 },
      { ref: piece, label: "Piece", tier: 2, from: 0.92, to: 1 },
    ]);
    const keepAll = planOrderUnitSwitch(view, { kind: "product" }, piece, {
      keep: plan.changes.map((c) => ({ ref: c.ref, tier: c.tier })),
    });
    expect(keepAll.changes).toEqual([]);
  });

  it("a business-style no-op: switching to the unit that already anchors changes nothing", () => {
    const view = buildLadderView(box12, []);
    const plan = planOrderUnitSwitch(view, { kind: "product" }, "pack");
    expect(plan.pins).toEqual([]);
    expect(plan.changes).toEqual([]);
  });

  it("T7c property: any switch keeps every set price byte-identical and pins only Auto cells", () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const money = () => ((Math.floor(rnd() * 90000) + 100) / 100).toFixed(2);
    for (let i = 0; i < 400; i++) {
      const upb = [2, 6, 12, 24][Math.floor(rnd() * 4)];
      const p: LadderProduct = {
        unit: "Box",
        unitsPerBox: upb,
        pricePerUnit: money(),
        priceTier2: rnd() < 0.5 ? money() : null,
        priceTier3: rnd() < 0.3 ? money() : null,
      };
      const units = [
        lvl("Piece", 1, rnd() < 0.5 ? money() : null, { priceTier2: rnd() < 0.3 ? money() : null }),
        lvl("Case", upb * 6, rnd() < 0.5 ? money() : null),
      ];
      const view = buildLadderView(p, units);
      for (const target of view.rows) {
        const plan = planOrderUnitSwitch(view, { kind: "product" }, target.ref);
        for (const row of view.rows) {
          const after = plan.view.rows.find((r) => r.ref === row.ref)!;
          row.set.forEach((v, idx) => {
            if (v != null) expect(after.set[idx]).toBe(v); // a set price never changes
          });
        }
        for (const pin of plan.pins) {
          expect(
            priceSource(
              view.rows.find((r) => r.ref === pin.ref)!,
              pin.tier,
            ),
          ).toBe("auto");
        }
        for (const c of plan.changes) {
          expect(
            priceSource(
              view.rows.find((r) => r.ref === c.ref)!,
              c.tier,
            ),
          ).toBe("auto");
        }
      }
    }
  });
});

describe("tier and customer scopes (owner Q2b)", () => {
  it("T24b: tier 3 orders by the Piece, Piece Tier 3 set $0.80 (Box $12/12): Case Tier 3 $72.00 -> $57.60, Box Tier 3 $12.00 -> $9.60", () => {
    const units = [lvl("Case", 72), lvl("Piece", 1, null, { priceTier3: "0.80" })];
    const before = buildLadderView(box12, units);
    expect(priceOf(before, box12, units, "Case", 3)).toBe(72);
    const piece = ref(box12, units, "Piece");
    const plan = planOrderUnitSwitch(before, { kind: "tier", tier: 3 }, piece);
    expect(plan.view.tierAnchors[3]).toBe(piece);
    expect(plan.pins).toEqual([]); // a tier's new anchor price is not auto-pinned
    expect(priceOf(plan.view, box12, units, "Case", 3)).toBe(57.6);
    expect(priceOf(plan.view, box12, units, "Box", 3)).toBe(9.6);
    expect(priceOf(plan.view, box12, units, "Box", 1)).toBe(12); // other columns untouched
    // The pack's Auto Tier 3 is materialized as $9.60 (a number, since it differs from the list price).
    const m = materializePack(plan.view, DEFAULT_TIER_RULES);
    expect(m.priceTier3).toBe(9.6);
    expect(m.packAuto & 0b00100).toBe(0b00100);
  });

  it("T24: a customer orders by the Box and has Box set $10 (Box $12), Piece Retail set $1.20: Piece $1.00 (proportional)", () => {
    const units = [lvl("Piece", 1, "1.20")];
    const view = buildLadderView(box12, units);
    const c: CustomerPricing = { tier: 1, orderUnit: "pack", set: { pack: 10 } };
    expect(customerPrice(view, ref(box12, units, "Piece"), c)).toBe(1);
    expect(customerPrice(view, "pack", c)).toBe(10);
  });

  it("T24a: a customer orders by the Case, Case set $60 (Case Retail Auto $72): Box $10.00, Piece $0.83", () => {
    const units = [lvl("Case", 72)];
    const view = buildLadderView(box12, units);
    const caseRef = ref(box12, units, "Case");
    const c: CustomerPricing = { tier: 1, orderUnit: caseRef, set: { [caseRef]: 60 } };
    expect(customerPrice(view, "pack", c)).toBe(10);
    expect(customerPrice(view, ref(box12, units, "Piece"), c)).toBe(0.83);
  });

  it("T24c: a tier-2 customer with no own prices who orders by the Piece (Piece Tier 2 set $0.95, Box Tier 2 set $11): Case $68.40, Box stays $11.00", () => {
    const p: LadderProduct = { ...box12, priceTier2: "11.00" };
    const units = [lvl("Case", 72), lvl("Piece", 1, null, { priceTier2: "0.95" })];
    const view = buildLadderView(p, units);
    const piece = ref(p, units, "Piece");
    const c: CustomerPricing = { tier: 2, orderUnit: piece };
    expect(customerPrice(view, ref(p, units, "Case"), c)).toBe(68.4);
    expect(customerPrice(view, "pack", c)).toBe(11);
    expect(ladderPrice(view, ref(p, units, "Case"), 2)).toBe(66); // the plain tier column is unchanged
  });

  it("T24d (fold A1): a tier-2 customer, Piece Tier 2 set $0.95, Box Tier 2 $11, C's Box set $10: Piece $0.86, not the Retail shape's $1.00", () => {
    const p: LadderProduct = { ...box12, priceTier2: "11.00" };
    const units = [lvl("Piece", 1, "1.20", { priceTier2: "0.95" })];
    const view = buildLadderView(p, units);
    const c: CustomerPricing = { tier: 2, orderUnit: "pack", set: { pack: 10 } };
    expect(customerPrice(view, ref(p, units, "Piece"), c)).toBe(0.86);
    const tier1: CustomerPricing = { tier: 1, orderUnit: "pack", set: { pack: 10 } };
    expect(customerPrice(view, ref(p, units, "Piece"), tier1)).toBe(1); // for tier 1 A1 equals the plan's formula
  });

  it("T24e (fold A1, PF-1): a tier-2 customer orders by the Case (Tier 2 set $60) and sets their Case at $55: Box $9.17, Piece $0.76, not $11.00 / $0.92", () => {
    const units = [lvl("Case", 72, null, { priceTier2: "60.00" })];
    const view = buildLadderView(box12, units);
    const caseRef = ref(box12, units, "Case");
    const c: CustomerPricing = { tier: 2, orderUnit: caseRef, set: { [caseRef]: 55 } };
    expect(customerPrice(view, "pack", c)).toBe(9.17);
    expect(customerPrice(view, ref(box12, units, "Piece"), c)).toBe(0.76);
  });

  it("a customer's own set price for a unit always wins; a deleted order-unit ref follows the tier's anchor", () => {
    const units = [lvl("Piece", 1, "1.20")];
    const view = buildLadderView(box12, units);
    const piece = ref(box12, units, "Piece");
    expect(customerPrice(view, piece, { tier: 1, set: { [piece]: 0.9 } })).toBe(0.9);
    expect(customerPrice(view, piece, { tier: 1, orderUnit: "gone" })).toBe(1.2);
  });

  it("a customer scope switch lists the customer's moved Auto prices and Keep pins them as that customer's set prices", () => {
    const units = [lvl("Case", 72)];
    const view = buildLadderView(box12, units);
    const caseRef = ref(box12, units, "Case");
    const start: CustomerPricing = { tier: 1, orderUnit: "pack", set: { pack: 10 } };
    const next: CustomerPricing = {
      ...start,
      orderUnit: caseRef,
      set: { ...start.set, [caseRef]: 100 },
    };
    expect(customerPrice(view, caseRef, start)).toBe(60); // proportional to the Box's $10
    const plan = planOrderUnitSwitch(view, { kind: "customer", customer: next }, "pack");
    expect(plan.customer?.orderUnit).toBe("pack");
    expect(plan.changes).toEqual([
      { ref: ref(box12, units, "Piece"), label: "Piece", tier: 1, from: 1.39, to: 0.83 },
    ]);
  });
});

describe("T7e / P8 / A2: materializePack", () => {
  it("T7e: Piece anchor $1.20, Box cleared to Auto: pricePerUnit is materialized as $14.40 and getTierPrice reads it unchanged", () => {
    const units = [lvl("Piece", 1, "1.20", { id: "piece-1" })];
    const stored = { ...box12, pricePerUnit: "12.00" };
    const view = buildLadderView(stored, units, { orderUnit: "piece-1", packAuto: 0b00001 });
    expect(ladderPrice(view, "pack", 1)).toBe(14.4);
    const m = materializePack(view, DEFAULT_TIER_RULES);
    expect(m.pricePerUnit).toBe(14.4);
    expect(m.packAuto & 1).toBe(1);
    expect(getTierPrice({ pricePerUnit: m.pricePerUnit, priceTier2: m.priceTier2 }, 1)).toBe(14.4);
    expect(getTierPrice({ pricePerUnit: m.pricePerUnit, priceTier2: m.priceTier2 }, 2)).toBe(14.4);
  });

  it("a materialized pack tier that holds a number but has its Auto bit set reads as Auto", () => {
    const p = { ...box12, priceTier2: "11.04" };
    const view = buildLadderView(p, [], { packAuto: 0b00010 });
    expect(
      priceSource(
        view.rows.find((r) => r.ref === "pack")!,
        2,
      ),
    ).toBe("auto");
    expect(ladderPrice(view, "pack", 2)).toBe(12);
    expect(ladderPrice(view, "pack", 2, { 2: 8 })).toBe(11.04);
  });

  it("A2 property: rules 0% and the pack anchor: every Auto tier is stored as 0 with its bit, pricePerUnit is untouched, set tiers keep their value", () => {
    let seed = 99;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const money = () => ((Math.floor(rnd() * 90000) + 100) / 100).toFixed(2);
    for (let i = 0; i < 500; i++) {
      const p: LadderProduct = {
        unit: "Box",
        unitsPerBox: [1, 6, 12, 24][Math.floor(rnd() * 4)],
        pricePerUnit: money(),
        priceTier2: rnd() < 0.5 ? money() : rnd() < 0.5 ? "0" : null,
        priceTier3: rnd() < 0.4 ? money() : null,
        priceTier4: rnd() < 0.3 ? money() : null,
        priceTier5: rnd() < 0.2 ? money() : null,
      };
      const view = buildLadderView(p, []);
      const m = materializePack(view, DEFAULT_TIER_RULES);
      expect(m.pricePerUnit).toBe(Number(p.pricePerUnit));
      const cols = [p.priceTier2, p.priceTier3, p.priceTier4, p.priceTier5];
      const out = [m.priceTier2, m.priceTier3, m.priceTier4, m.priceTier5];
      cols.forEach((v, idx) => {
        const set = Number(v) > 0;
        expect(out[idx]).toBe(set ? Number(v) : 0);
        expect(((m.packAuto >> (idx + 1)) & 1) === 1).toBe(!set);
      });
      expect(m.packAuto & 1).toBe(0);
      for (const t of TIERS) {
        // reading the materialized pack through today's getTierPrice gives today's value
        expect(
          getTierPrice(
            {
              pricePerUnit: m.pricePerUnit,
              priceTier2: m.priceTier2,
              priceTier3: m.priceTier3,
              priceTier4: m.priceTier4,
              priceTier5: m.priceTier5,
            },
            t,
          ),
        ).toBe(getTierPrice(p, t));
      }
    }
  });

  it("a tier rule above 0% stores the number (it differs from the list price) with its bit", () => {
    const view = buildLadderView(box12, []);
    const m = materializePack(view, { 2: 8, 3: 0 });
    expect(m.priceTier2).toBe(11.04);
    expect(m.priceTier3).toBe(0);
    expect(m.packAuto).toBe(0b11110);
  });
});

describe("(h): rules above 0% and switches stay off until the write path is complete", () => {
  it("is off, and a tier rule is 'above zero' only when some percent is positive", () => {
    expect(PACK_WRITE_PATH_COMPLETE).toBe(false);
    expect(tierRulesAboveZero({})).toBe(false);
    expect(tierRulesAboveZero({ 2: 0, 3: "0" })).toBe(false);
    expect(tierRulesAboveZero({ 2: 0, 3: 8 })).toBe(true);
    expect(tierRulesAboveZero(null)).toBe(false);
  });
});
