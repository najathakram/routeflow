import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_TIER_RULES,
  buildLadderView,
  ladderPrice,
  normalizeTierRules,
  priceGrid,
  priceSource,
  refForLabel,
  validateSetPrice,
  type LadderViewUnit,
  type PriceTier,
} from "./price-ladder";
import { getTierPrice } from "./tier-pricing";
import {
  resolveLadderLevel,
  resolveUnitPrice,
  type LadderProduct,
  type LadderUnit,
} from "./unit-levels";

const lvl = (label: string, factorToBase: number, price: string | null = null, extra = {}) => ({
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
const priceAt = (
  product: LadderProduct,
  units: readonly LadderViewUnit[],
  label: string,
  tier: PriceTier,
  rules = DEFAULT_TIER_RULES,
) => ladderPrice(buildLadderView(product, units), refForLabel(product, units, label), tier, rules);

// ─── T1, T2: observed on master, kept ─────────────────────────────────────────────────────────
describe("T1/T2 guards (values observed on master with resolveUnitPrice)", () => {
  const box: LadderProduct = {
    unit: "Box",
    unitsPerBox: 12,
    pricePerUnit: "12.00",
    priceTier2: "11.00",
  };

  it("T1: Piece Auto from Box $12/12, Tier 2 $11 is $1.00 and $0.92", () => {
    expect(resolveUnitPrice(box, [], "Piece", 1)).toBe(1);
    expect(resolveUnitPrice(box, [], "Piece", 2)).toBe(0.92);
    expect(priceAt(box, [], "Piece", 1)).toBe(1);
    expect(priceAt(box, [], "Piece", 2)).toBe(0.92);
  });

  it("T2: Case(72) Auto is $72.00 and $66.00; Case set $66 gives Tier 2 $60.50", () => {
    const auto = [lvl("Case", 72)];
    expect(resolveUnitPrice(box, auto, "Case", 1)).toBe(72);
    expect(resolveUnitPrice(box, auto, "Case", 2)).toBe(66);
    expect(priceAt(box, auto, "Case", 1)).toBe(72);
    expect(priceAt(box, auto, "Case", 2)).toBe(66);
    const set = [lvl("Case", 72, "66.00")];
    expect(resolveUnitPrice(box, set, "Case", 2)).toBe(60.5);
    expect(priceAt(box, set, "Case", 2)).toBe(60.5);
  });
});

// ─── T3: parity with the committed master golden file, rules 0% ───────────────────────────────
describe("T3 parity: every Auto and set value equals master's, byte for byte, at 0%", () => {
  const PRODUCTS: Record<string, LadderProduct> = {
    boxed: { unit: "Case", unitsPerBox: 24, pricePerUnit: "48.00" },
    unboxed: { unit: null, unitsPerBox: 1, pricePerUnit: "2.50" },
    tiered: {
      unit: "Box",
      unitsPerBox: 12,
      pricePerUnit: "30.00",
      priceTier2: "27.00",
      priceTier3: "24.00",
    },
    fractional: { unit: "Pack", unitsPerBox: 3, pricePerUnit: "10.00" },
  };
  const ROWS: LadderUnit[] = [
    lvl("Piece", 1, "0.50"),
    lvl("Pallet", 240, null, { isDefaultSelling: true }),
    lvl("Inner", 6, "7.00", { priceTier2: "6.00" }),
  ];
  const master = JSON.parse(readFileSync(join(__dirname, "unit-parity.master.json"), "utf8"));

  it("matches unit-parity.master.json for every label that resolved on master", () => {
    let compared = 0;
    for (const [k, pr] of Object.entries(PRODUCTS)) {
      for (const [rk, units] of [
        ["none", []],
        ["rows", ROWS],
      ] as const) {
        for (const lab of [undefined, "", "Piece", "piece", "Pallet", pr.unit ?? "Box", "Inner"]) {
          for (const tier of [1, 2, 3] as PriceTier[]) {
            const m = master[`${k}|${rk}|${lab}|${tier}`];
            if (typeof m === "string") continue; // an ERR entry: the label is not on that ladder
            expect(priceAt(pr, units, lab as string, tier)).toBe(m.price);
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(100);
  });
});

// ─── T3 property: generated ladders, rules 0% ─────────────────────────────────────────────────
describe("T3 property: generated ladders equal resolveUnitPrice at 0%", () => {
  let seed = 20261016;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const money = () => (Math.floor(rnd() * 99900) + 1) / 100;
  const maybe = (p: number, v: () => string): string | null => (rnd() < p ? v() : null);

  it("1500 ladders: pack, set and Auto level cells, all five tiers", () => {
    let checked = 0;
    for (let i = 0; i < 1500; i++) {
      const upb = pick([1, 2, 6, 12, 24, 36, 48]);
      const product: LadderProduct = {
        unit: "Box",
        unitsPerBox: upb,
        pricePerUnit: money().toFixed(2),
        priceTier2: maybe(0.5, () => money().toFixed(2)),
        priceTier3: maybe(0.4, () => money().toFixed(2)),
        priceTier4: maybe(0.3, () => (rnd() < 0.3 ? "0" : money().toFixed(2))),
        priceTier5: maybe(0.2, () => money().toFixed(2)),
      };
      const units: LadderUnit[] = [];
      const labels = ["Piece", "Inner", "Case", "Pallet", "Layer"].filter(() => rnd() < 0.6);
      for (const label of labels) {
        const factor = label === "Piece" ? 1 : pick([2, 3, 4, 6, 12, 24, 72, 144, 288]);
        units.push(
          lvl(
            label,
            factor,
            maybe(0.5, () => money().toFixed(2)),
            {
              priceTier2: maybe(0.3, () => money().toFixed(2)),
              priceTier3: maybe(0.2, () => money().toFixed(2)),
              priceTier4: maybe(0.2, () => "0"),
              priceTier5: maybe(0.2, () => money().toFixed(2)),
            },
          ),
        );
      }
      const view = buildLadderView(product, units);
      for (const row of view.rows) {
        for (const tier of TIERS) {
          const got = ladderPrice(view, row.ref, tier, DEFAULT_TIER_RULES);
          const want = resolveUnitPrice(product, units, row.label, tier);
          expect({ label: row.label, tier, got }).toEqual({ label: row.label, tier, got: want });
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(8000);
  });

  it("the implicit Piece row exists exactly when the pack holds more than one piece", () => {
    const boxed = buildLadderView({ unit: "Box", unitsPerBox: 12, pricePerUnit: "12" }, []);
    expect(boxed.rows.map((r) => [r.kind, r.factor])).toEqual([
      ["pack", 12],
      ["base", 1],
    ]);
    const single = buildLadderView({ unit: "Each", unitsPerBox: 1, pricePerUnit: "3" }, []);
    expect(single.rows.map((r) => r.kind)).toEqual(["pack"]);
  });
});

// ─── T4, T5: tier rules ───────────────────────────────────────────────────────────────────────
describe("tier rules (default 0%)", () => {
  const box: LadderProduct = { unit: "Box", unitsPerBox: 12, pricePerUnit: "12.00" };

  it("T4: rule 8% on Tier 2, Box Tier 2 blank: master reads $12.00, the rules give $11.04", () => {
    expect(getTierPrice(box, 2)).toBe(12); // master: a blank tier follows the list price
    expect(resolveUnitPrice(box, [], "Box", 2)).toBe(12);
    expect(priceAt(box, [], "Box", 2, { 2: 8 })).toBe(11.04);
  });

  it("Auto tiers of the other units keep the tier discount (Piece Tier 2 at 8%: $0.92)", () => {
    expect(priceAt(box, [], "Piece", 2, { 2: 8 })).toBe(0.92);
    expect(priceAt(box, [lvl("Case", 72)], "Case", 2, { 2: 8 })).toBe(66.24);
    expect(priceAt(box, [], "Piece", 3, { 2: 8 })).toBe(1);
  });

  it("T5: a tier rule never moves a set tier", () => {
    const set: LadderProduct = { ...box, priceTier2: "11.00" };
    expect(priceAt(set, [], "Box", 2, { 2: 8, 3: 20 })).toBe(11);
    expect(priceAt(set, [], "Box", 3, { 2: 8, 3: 20 })).toBe(9.6);
    const own = [lvl("Case", 72, "70.00", { priceTier2: "65.00" })];
    expect(priceAt(set, own, "Case", 2, { 2: 50 })).toBe(65);
  });

  it("a rule applies to Retail of a set level cell as a proportion of the anchor's tier", () => {
    const own = [lvl("Case", 72, "70.00")]; // Retail set, Tier 2 Auto
    expect(priceAt(box, own, "Case", 2, { 2: 10 })).toBe(63);
  });

  it("normalizeTierRules is safe on any stored value and defaults to 0%", () => {
    expect(normalizeTierRules(undefined)).toEqual({});
    expect(normalizeTierRules({ 2: 8, 3: "12.5", 4: -3, 5: 100, 6: 9, 1: 4 })).toEqual({
      2: 8,
      3: 12.5,
    });
    expect(normalizeTierRules("junk")).toEqual({});
    expect(normalizeTierRules({ 2: "x", 3: null, 4: NaN })).toEqual({});
  });
});

// ─── priceSource, the grid ────────────────────────────────────────────────────────────────────
describe("priceSource and priceGrid", () => {
  const product: LadderProduct = {
    unit: "Box",
    unitsPerBox: 12,
    pricePerUnit: "12.00",
    priceTier2: "11.00",
    priceTier3: "0",
  };
  const units = [lvl("Case", 72, "66.00", { priceTier4: "50.00" })];

  it("reads both encodings: a positive value is Set, NULL and 0 are Auto, Retail of the anchor is always Set", () => {
    const view = buildLadderView(product, units);
    const pack = view.rows.find((r) => r.kind === "pack")!;
    expect(TIERS.map((t) => priceSource(pack, t))).toEqual(["set", "set", "auto", "auto", "auto"]);
    const c = view.rows.find((r) => r.label === "Case")!;
    expect(TIERS.map((t) => priceSource(c, t))).toEqual(["set", "auto", "auto", "set", "auto"]);
    const piece = view.rows.find((r) => r.kind === "base")!;
    expect(TIERS.map((t) => priceSource(piece, t))).toEqual([
      "auto",
      "auto",
      "auto",
      "auto",
      "auto",
    ]);
  });

  it("the grid lists rows largest first with one cell per tier", () => {
    const grid = priceGrid(buildLadderView(product, units), DEFAULT_TIER_RULES);
    expect(grid.map((r) => r.label)).toEqual(["Case", "Box", "Piece"]);
    expect(grid[0].cells.map((c) => c.value)).toEqual([66, 60.5, 66, 50, 66]);
    expect(grid[1].cells.map((c) => c.source)).toEqual(["set", "set", "auto", "auto", "auto"]);
  });

  it("P1: a product with no list price has no Auto Retail on the anchor", () => {
    const view = buildLadderView({ unit: "Box", unitsPerBox: 12, pricePerUnit: "0" }, []);
    expect(priceSource(view.rows[0], 1)).toBe("set");
    expect(ladderPrice(view, view.rows[1].ref, 1, DEFAULT_TIER_RULES)).toBe(0);
  });
});

// ─── T6, P6 ───────────────────────────────────────────────────────────────────────────────────
describe("T6/P6: a set price must be above $0.00", () => {
  it("refuses 0, negatives and junk with a plain message; blank means Auto", () => {
    for (const bad of [0, "0", "0.00", -1, "-2.50", "abc", 0.004, NaN]) {
      const r = validateSetPrice(bad);
      expect(r.ok).toBe(false);
      expect((r as { message: string }).message).toMatch(/\S/);
      expect((r as { message: string }).message).not.toContain("—");
    }
    for (const blank of [null, undefined, "", "  "]) {
      expect(validateSetPrice(blank)).toEqual({ ok: true, value: null });
    }
  });

  it("accepts a positive price and rounds it once to cents", () => {
    expect(validateSetPrice("12.5")).toEqual({ ok: true, value: 12.5 });
    expect(validateSetPrice("$1,234.567")).toEqual({ ok: true, value: 1234.57 });
    expect(validateSetPrice(0.01)).toEqual({ ok: true, value: 0.01 });
  });
});

// ─── view building ────────────────────────────────────────────────────────────────────────────
describe("buildLadderView", () => {
  it("includes a row only when the label resolves to it (the pack wins its own label)", () => {
    const product: LadderProduct = { unit: "Box", unitsPerBox: 12, pricePerUnit: "12.00" };
    const units = [lvl("Box", 6, "5.00"), lvl("Case", 72), lvl("Case", 70)];
    const view = buildLadderView(product, units);
    expect(view.rows.map((r) => [r.label, r.factor])).toEqual([
      ["Case", 72],
      ["Box", 12],
      ["Piece", 1],
    ]);
    expect(resolveLadderLevel(product, units, "Box").kind).toBe("pack");
  });

  it("refs are ProductUnit ids when present, else label based", () => {
    const view = buildLadderView({ unit: "Box", unitsPerBox: 12, pricePerUnit: "12" }, [
      { ...lvl("Case", 72), id: "u1" },
      lvl("Pallet", 720),
    ]);
    expect(view.rows.map((r) => r.ref)).toEqual(["label:Pallet", "u1", "pack", "base"]);
    expect(view.anchor).toBe("pack");
  });
});

describe("PF-5: a non-pack anchor with no typed Retail keeps the materialized pack Retail as its source", () => {
  it("Box $12 x 12 materialized from a Piece anchor with no price: every cell is priced, none is $0.00", () => {
    const product: LadderProduct = { unit: "Box", unitsPerBox: 12, pricePerUnit: "14.40" };
    const view = buildLadderView(product, [lvl("Piece", 1, null, { id: "piece-1" })], {
      orderUnit: "piece-1",
      packAuto: 0b00001,
    });
    for (const tier of TIERS) {
      expect(ladderPrice(view, "pack", tier)).toBe(14.4);
      expect(ladderPrice(view, "piece-1", tier)).toBe(1.2);
    }
  });
});
