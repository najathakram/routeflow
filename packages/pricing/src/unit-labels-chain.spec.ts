import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeLineSubtotal, normalizeBoxesPieces } from "./pricing";
import {
  UnknownUnitError,
  baseLabelOf,
  defaultSellingLabel,
  deriveChainFactors,
  describeBaseOption,
  fromBaseQty,
  packLabelOf,
  planBaseBilling,
  resolveExistingLadderLevel,
  resolveExistingUnitPrice,
  resolveLadderLevel,
  resolveUnitPrice,
  validateUnitChain,
  type LadderProduct,
  type LadderUnit,
} from "./index";

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

// ─── PARITY: no rows + null labels are byte-identical to master ──────────────────────────────
// `unit-parity.master.json` was generated from the pre-P0b code (master) with exactly this loop.
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

describe("P0b parity: null labels + no new data == master, byte for byte", () => {
  const master = JSON.parse(readFileSync(join(__dirname, "unit-parity.master.json"), "utf8"));
  it("resolveLadderLevel / resolveUnitPrice / defaultSellingLabel / computeLineSubtotal", () => {
    const out: Record<string, unknown> = {};
    for (const [k, pr] of Object.entries(PRODUCTS)) {
      for (const [rk, units] of [
        ["none", []],
        ["rows", ROWS],
      ] as const) {
        for (const lab of [undefined, "", "Piece", "piece", "Pallet", pr.unit ?? "Box", "Inner"]) {
          for (const tier of [1, 2, 3]) {
            let r: unknown;
            try {
              const l = resolveLadderLevel(pr, units, lab);
              r = {
                l: l.label,
                f: l.factorToBase,
                k: l.kind,
                price: resolveUnitPrice(pr, units, lab, tier),
              };
            } catch (e) {
              r = "ERR:" + (e as Error).name;
            }
            out[`${k}|${rk}|${lab}|${tier}`] = r;
          }
        }
        out[`${k}|${rk}|default`] = defaultSellingLabel(pr, units);
      }
      out[`${k}|sub`] = [
        [3, 0],
        [1, 5],
        [0, 7],
        [2, 11],
      ].map(([b, pc]) =>
        computeLineSubtotal({
          unitPrice: Number(pr.pricePerUnit),
          qty: b * Number(pr.unitsPerBox) + pc,
          boxes: b,
          pieces: pc,
          unitsPerBox: Number(pr.unitsPerBox),
        }),
      );
    }
    expect(JSON.parse(JSON.stringify(out))).toEqual(master);
  });
});

describe("baseLabelOf / packLabelOf", () => {
  it("baseLabelOf: custom name, blank/null fall back to Piece", () => {
    expect(baseLabelOf({ baseUnitLabel: "Each" })).toBe("Each");
    expect(baseLabelOf({ baseUnitLabel: "  Each " })).toBe("Each");
    expect(baseLabelOf({ baseUnitLabel: null })).toBe("Piece");
    expect(baseLabelOf({ baseUnitLabel: "   " })).toBe("Piece");
    expect(baseLabelOf({})).toBe("Piece");
  });
  it("packLabelOf: packLabel, else legacy unit text, else Box", () => {
    expect(packLabelOf({ packLabel: "Carton", unit: "Case" })).toBe("Carton");
    expect(packLabelOf({ packLabel: null, unit: "Case" })).toBe("Case");
    expect(packLabelOf({ packLabel: " ", unit: " " })).toBe("Box");
    expect(packLabelOf({})).toBe("Box");
  });
});

describe("resolveLadderLevel with tenant labels", () => {
  const p: LadderProduct = {
    baseUnitLabel: "Each",
    packLabel: "Carton",
    unit: "Case",
    unitsPerBox: 12,
    pricePerUnit: "24.00",
  };
  it('treats the base label AND legacy "Piece" (any case) as the base', () => {
    for (const l of ["Each", "each", "Piece", "PIECE"]) {
      const r = resolveLadderLevel(p, [], l);
      expect(r).toMatchObject({ label: "Each", factorToBase: 1, kind: "piece" });
    }
  });
  it("matches the pack by packLabel OR the legacy unit text", () => {
    for (const l of ["Carton", "carton", "Case", "case"]) {
      expect(resolveLadderLevel(p, [], l)).toMatchObject({
        label: "Carton",
        factorToBase: 12,
        kind: "pack",
      });
    }
    expect(resolveLadderLevel(p, [], "")).toMatchObject({ label: "Carton", kind: "pack" });
  });
  it("an unrelated label is still unknown", () => {
    expect(() => resolveLadderLevel(p, [], "Pallet")).toThrow(UnknownUnitError);
  });
  it("a factor-1 row supplies the base's explicit price", () => {
    expect(resolveUnitPrice(p, [lvl("Each", 1, "2.50")], "Each", 1)).toBe(2.5);
    expect(resolveUnitPrice(p, [lvl("Each", 1, "2.50")], "Piece", 1)).toBe(2.5);
  });
  it("fromBaseQty names the implicit base with the base label", () => {
    expect(fromBaseQty(14, p, [])).toEqual([
      { label: "Carton", factorToBase: 12, qty: 1 },
      { label: "Each", factorToBase: 1, qty: 2 },
    ]);
  });
});

describe("validateUnitChain", () => {
  const A = { key: "a", factorToBase: 1, parentKey: null, perParent: null }; // base
  const B = { key: "b", factorToBase: 5, parentKey: "a", perParent: 5 };
  const C = { key: "c", factorToBase: 50, parentKey: "b", perParent: 10 };
  const codes = (r: { violations: Array<{ code: string }> }) => r.violations.map((v) => v.code);

  it("5 A = 1 B and 10 B = 1 C -> 5 / 50 is valid", () => {
    expect(validateUnitChain([A, B, C]).ok).toBe(true);
  });
  it("non-divisible levels (Case 50, Inner 12) are siblings under the base", () => {
    const r = validateUnitChain([
      A,
      { key: "case", factorToBase: 50, parentKey: null, perParent: null },
      { key: "inner", factorToBase: 12, parentKey: null, perParent: null },
    ]);
    expect(r.ok).toBe(true);
  });
  it("rejects perParent 1 (a level equal to its parent)", () => {
    const r = validateUnitChain([A, { ...B, factorToBase: 1, perParent: 1 }]);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("PER_PARENT_INVALID");
  });
  it("rejects a non-integer perParent", () => {
    const r = validateUnitChain([A, { ...B, perParent: 2.5, factorToBase: 2.5 }]);
    expect(codes(r)).toContain("PER_PARENT_INVALID");
  });
  it("rejects a factor over 1,000,000", () => {
    const r = validateUnitChain([
      A,
      { key: "x", factorToBase: 1_000_001, parentKey: null, perParent: null },
    ]);
    expect(codes(r)).toContain("OVER_CAP");
  });
  it("rejects a duplicate factor", () => {
    const r = validateUnitChain([
      A,
      B,
      { ...C, factorToBase: 5, parentKey: null, perParent: null },
    ]);
    expect(codes(r)).toContain("DUPLICATE_FACTOR");
  });
  it("rejects a factor that is not perParent x parent factor", () => {
    const r = validateUnitChain([A, B, { ...C, factorToBase: 49 }]);
    expect(codes(r)).toContain("FACTOR_MISMATCH");
  });
  it("rejects an unknown parent and a parent that is not smaller", () => {
    expect(codes(validateUnitChain([A, { ...B, parentKey: "zzz" }]))).toContain("PARENT_UNKNOWN");
    expect(
      codes(validateUnitChain([A, { ...B, parentKey: "c" }, { ...C, parentKey: "b" }])),
    ).toContain("CYCLE");
  });
  it("a parent edit recomputes descendants (B 5 -> 6 makes C 60)", () => {
    const edited = deriveChainFactors([A, { ...B, perParent: 6, factorToBase: 6 }, C]);
    expect(edited.map((l) => l.factorToBase)).toEqual([1, 6, 60]);
    expect(validateUnitChain(edited).ok).toBe(true);
  });
  it("a recompute that pushes a descendant over the cap is reported as OVER_CAP", () => {
    const big = deriveChainFactors([
      A,
      { key: "b", factorToBase: 5000, parentKey: "a", perParent: 5000 },
      { key: "c", factorToBase: 0, parentKey: "b", perParent: 500 },
    ]);
    expect(codes(validateUnitChain(big))).toContain("OVER_CAP");
  });
});

describe("snapshot fallback helpers", () => {
  const p: LadderProduct = { unit: "Box", unitsPerBox: 12, pricePerUnit: "24.00" };
  const snap = { unitsPerBox: 6, unitPrice: 11.5 };
  it("a label that no longer matches re-resolves from the line's own snapshot", () => {
    const r = resolveExistingLadderLevel(p, [], "Carton", snap);
    expect(r).toMatchObject({ label: "Carton", factorToBase: 6, kind: "level" });
    expect(resolveExistingUnitPrice(p, [], "Carton", 1, snap)).toBe(11.5);
  });
  it("a label that still resolves uses the live ladder", () => {
    const rows = [lvl("Carton", 6, "12.00")];
    expect(resolveExistingUnitPrice(p, rows, "Carton", 1, snap)).toBe(12);
  });
  it("without a usable snapshot an unknown label still throws", () => {
    expect(() => resolveExistingLadderLevel(p, [], "Carton", { unitsPerBox: null })).toThrow(
      UnknownUnitError,
    );
    expect(() => resolveExistingUnitPrice(p, [], "Carton", 1, { unitPrice: null })).toThrow(
      UnknownUnitError,
    );
  });
});

describe("SA-728 base billing", () => {
  const box24: LadderProduct = { unit: "Box", unitsPerBox: 24, pricePerUnit: "48.00" };
  const pack3: LadderProduct = { unit: "Pack", unitsPerBox: 3, pricePerUnit: "10.00" };

  it("Box 24 @48 + Piece @2.50: 1 pc is a unit line at $2.50", () => {
    const b = planBaseBilling(box24, [lvl("Piece", 1, "2.50")], 1, 1);
    expect(b).toMatchObject({ mode: "unit", unitLabel: "Piece", unitPrice: 2.5, subtotal: 2.5 });
  });
  it("no row, 3-pack @10: 2 pcs bill as pack pieces = $6.67 (not 2 x 3.33)", () => {
    const b = planBaseBilling(pack3, [], 1, 2);
    expect(b).toMatchObject({
      mode: "pack",
      boxes: 0,
      pieces: 2,
      qty: 2,
      packUnitPrice: 10,
      subtotal: 6.67,
    });
    expect(b.subtotal).toBe(
      computeLineSubtotal({ unitPrice: 10, qty: 2, boxes: 0, pieces: 2, unitsPerBox: 3 }),
    );
  });
  it("pieces roll over at the pack size (7 pcs of a 3-pack = 2 boxes + 1)", () => {
    const b = planBaseBilling(pack3, [], 1, 7);
    expect(b).toMatchObject({ mode: "pack", boxes: 2, pieces: 1, qty: 7 });
    expect(normalizeBoxesPieces({ boxes: 0, pieces: 7, unitsPerBox: 3 })).toMatchObject({
      boxes: 2,
      pieces: 1,
    });
    expect(b.subtotal).toBe(23.33);
  });
  it("a Piece row WITHOUT its own price is still derived (pack pieces)", () => {
    expect(planBaseBilling(pack3, [lvl("Piece", 1, null)], 1, 2).mode).toBe("pack");
  });
  it("a tier-3 Piece row is own-priced for a tier-3 customer only", () => {
    const row = lvl("Piece", 1, null, { priceTier3: "2.10" });
    expect(planBaseBilling(box24, [row], 3, 5)).toMatchObject({
      mode: "unit",
      unitPrice: 2.1,
      subtotal: 10.5,
    });
    expect(planBaseBilling(box24, [row], 1, 5).mode).toBe("pack");
  });
  it("describeBaseOption: exact derived, inexact derived, own", () => {
    expect(describeBaseOption(box24, [], 1)).toEqual({
      price: 2,
      source: "derived",
      exact: true,
      fractionOf: { n: 24, packPrice: 48 },
    });
    expect(describeBaseOption(pack3, [], 1)).toEqual({
      price: 3.33,
      source: "derived",
      exact: false,
      fractionOf: { n: 3, packPrice: 10 },
    });
    expect(describeBaseOption(box24, [lvl("Piece", 1, "2.50")], 1)).toEqual({
      price: 2.5,
      source: "own",
      exact: true,
      fractionOf: null,
    });
  });
});
