import {
  buildLadderOptions,
  defaultLadderOptionValue,
  ladderOptionLineTotal,
  ladderOptionPriceText,
  type LadderProduct,
  type LadderUnit,
} from "./index";

const row = (label: string, factorToBase: number, price: string | null = null, extra = {}) =>
  ({
    label,
    factorToBase,
    price,
    priceTier2: null,
    priceTier3: null,
    priceTier4: null,
    priceTier5: null,
    ...extra,
  }) as LadderUnit;
const money = (n: number) => `$${n.toFixed(2)}`;

const box24: LadderProduct = { unit: "Box", unitsPerBox: 24, pricePerUnit: "48.00" };
const pack3: LadderProduct = { unit: "Pack", unitsPerBox: 3, pricePerUnit: "10.00" };
const CASE72 = row("Case", 72);

describe("buildLadderOptions — shared by the web and mobile buildUnitOptions", () => {
  it("no rows: ONE pack option, byte-identical to master (no extra keys)", () => {
    expect(buildLadderOptions(box24, [], 1)).toEqual([
      { value: "", label: "Box", factorToBase: 24, kind: "pack", price: 48, listPrice: 48 },
    ]);
  });

  it("master parity with rows and no Piece row: pack, levels desc, implicit Piece", () => {
    const o = buildLadderOptions(box24, [row("Case", 288, "480.00"), row("Pallet", 5760)], 1);
    expect(o.map((x) => [x.value, x.factorToBase, x.kind, x.price, x.listPrice])).toEqual([
      ["", 24, "pack", 48, 48],
      ["Pallet", 5760, "level", 11520, 11520],
      ["Case", 288, "level", 480, 480],
      ["Piece", 1, "piece", 2, 2],
    ]);
  });

  it("24 @48, Case row, no Piece row: the Piece option is the derived $2.00 (exact)", () => {
    const piece = buildLadderOptions(box24, [CASE72], 1).find((o) => o.factorToBase === 1)!;
    expect(piece).toMatchObject({ value: "Piece", price: 2 });
    expect(piece.derived).toMatchObject({ exact: true, n: 24, packPrice: 48 });
    expect(ladderOptionPriceText(piece, money)).toBe("$2.00");
  });

  it('3-pack @10, Case row, no Piece row: "≈$3.33 (1/3 of $10.00)", and 2 pcs total $6.67', () => {
    const piece = buildLadderOptions(pack3, [CASE72], 1).find((o) => o.factorToBase === 1)!;
    expect(piece.price).toBe(3.33);
    expect(piece.derived?.exact).toBe(false);
    expect(ladderOptionPriceText(piece, money)).toBe("≈$3.33 (1/3 of $10.00)");
    expect(ladderOptionLineTotal(piece, 2)).toBe(6.67);
  });

  it("an explicit factor-1 base row folds into the ONE base option: own price, no derived info", () => {
    const o = buildLadderOptions(box24, [CASE72, row("Piece", 1, "2.50")], 1);
    expect(o.filter((x) => x.factorToBase === 1)).toHaveLength(1);
    const piece = o.find((x) => x.factorToBase === 1)!;
    expect(piece).toMatchObject({ value: "Piece", price: 2.5 });
    expect(piece.derived).toBeUndefined();
    expect(ladderOptionPriceText(piece, money)).toBe("$2.50");
    expect(ladderOptionLineTotal(piece, 1)).toBe(2.5);
  });

  it("a Piece row whose ONLY price is tier 3 is own-priced for a tier-3 customer", () => {
    const r = row("Piece", 1, null, { priceTier3: "2.10" });
    const t3 = buildLadderOptions(box24, [CASE72, r], 3).find((x) => x.factorToBase === 1)!;
    expect(t3).toMatchObject({ price: 2.1 });
    expect(t3.derived).toBeUndefined();
    const t1 = buildLadderOptions(box24, [CASE72, r], 1).find((x) => x.factorToBase === 1)!;
    expect(t1.derived).toBeDefined();
  });

  it("a tenant base label names the base option; the legacy Piece row still folds in", () => {
    const p = { ...box24, baseUnitLabel: "Each", packLabel: "Carton" };
    const o = buildLadderOptions(p, [CASE72, row("Piece", 1, "2.50")], 1);
    expect(o[0]).toMatchObject({ value: "", label: "Carton" });
    const base = o.find((x) => x.factorToBase === 1)!;
    expect(base).toMatchObject({ value: "Each", label: "Each", price: 2.5 });
  });

  it("a factor-1 base flagged isDefaultSelling is visible and is the default value", () => {
    const units = [CASE72, row("Piece", 1, "2.50", { isDefaultSelling: true })];
    expect(buildLadderOptions(box24, units, 1).some((x) => x.value === "Piece")).toBe(true);
    expect(defaultLadderOptionValue(box24, units, 1)).toBe("Piece");
    const each = { ...box24, baseUnitLabel: "Each" };
    expect(defaultLadderOptionValue(each, units, 1)).toBe("Each");
    expect(defaultLadderOptionValue(box24, [CASE72], 1)).toBe("");
  });

  it("ladderOptionLineTotal: a level bills count x price; a pack-derived Piece prorates", () => {
    const o = buildLadderOptions(pack3, [row("Case", 12, "30.00")], 1);
    expect(
      ladderOptionLineTotal(
        o.find((x) => x.value === "Case")!,
        2,
      ),
    ).toBe(60);
    expect(
      ladderOptionLineTotal(
        o.find((x) => x.factorToBase === 1)!,
        7,
      ),
    ).toBe(23.33);
  });
});

describe("S19b nit 8: a derived base option uses the customer-layer pack price (layerPackPrice), never packPrice", () => {
  const caseRow = row("Case", 72);
  it("tier price 48 but the layer pack price is 40: the Piece reads 1/24 of $40.00 and bills from $40", () => {
    const piece = buildLadderOptions(box24, [caseRow], 1, undefined, 40).find(
      (o) => o.kind === "piece",
    )!;
    expect(piece.derived).toMatchObject({ n: 24, packPrice: 40 });
    expect(ladderOptionPriceText(piece, money)).toBe("≈$1.67 (1/24 of $40.00)");
    expect(ladderOptionLineTotal(piece, 12)).toBe(20); // 12 pieces of a $40 24-pack
  });
  it("master semantics: packPrice (the line's CURRENT price, a $40 one-time override) moves only the pack option; the Piece stays on the tier ladder", () => {
    const options = buildLadderOptions(box24, [caseRow], 1, 40);
    expect(options[0].price).toBe(40);
    const piece = options.find((o) => o.kind === "piece")!;
    expect(piece.derived).toMatchObject({ n: 24, packPrice: 48 });
    expect(piece.price).toBe(2);
  });
  it("no packPrice given: unchanged (the tier ladder)", () => {
    const piece = buildLadderOptions(box24, [caseRow], 1).find((o) => o.kind === "piece")!;
    expect(piece.derived).toMatchObject({ n: 24, packPrice: 48 });
    expect(piece.price).toBe(2);
  });
});
