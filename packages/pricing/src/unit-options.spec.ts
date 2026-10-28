import {
  buildLadderOptions,
  defaultLadderOptionValue,
  derivedPackSplit,
  heldSnapshotOption,
  ladderOptionDetail,
  ladderOptionLineTotal,
  ladderOptionPriceText,
  ladderOptionText,
  packPiecesSplit,
  withHeldOption,
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

describe("ladderOptionText / ladderOptionDetail: the ONE option text web and mobile both render (row 513)", () => {
  // Stand-in formatters (the package cannot import an app). The strings each app really renders, through its own
  // formatters, are pinned in apps/web/lib/unit-options.test.ts and apps/mobile/__tests__/unit-options.test.ts.
  const qty = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2))));
  const text = (o: Parameters<typeof ladderOptionText>[0]) => ladderOptionText(o, money, qty);
  const detail = (o: Parameters<typeof ladderOptionDetail>[0]) => ladderOptionDetail(o, money, qty);
  const options = buildLadderOptions(box24, [row("Case", 288, "480.00"), row("Pallet", 5760)], 1);

  it("a level or the pack reads label, pieces, price: 'Case · 288 pcs · $480.00'", () => {
    expect(text(options.find((o) => o.value === "Case")!)).toBe("Case · 288 pcs · $480.00");
    expect(detail(options.find((o) => o.value === "Case")!)).toBe("288 pcs · $480.00");
    expect(text(options.find((o) => o.kind === "pack")!)).toBe("Box · 24 pcs · $48.00");
  });

  it("a factor-1 unit omits the piece count: 'Piece · $2.00'", () => {
    const piece = options.find((o) => o.factorToBase === 1)!;
    expect(text(piece)).toBe("Piece · $2.00");
    expect(detail(piece)).toBe("$2.00");
  });

  it("a derived Piece that is not exact to the cent reads '≈$3.33 (1/3 of $10.00)'", () => {
    const piece = buildLadderOptions(pack3, [CASE72], 1).find((o) => o.factorToBase === 1)!;
    expect(text(piece)).toBe("Piece · ≈$3.33 (1/3 of $10.00)");
  });

  it("a fractional factor keeps up to 2 dp", () => {
    const o = { ...options[0], factorToBase: 2.5 };
    expect(detail(o)).toBe(`2.5 pcs · ${money(o.price)}`);
  });
});

describe("derivedPackSplit: the pack-pieces shape of N pieces of a DERIVED base option (row 513)", () => {
  const derived = buildLadderOptions(pack3, [CASE72], 1).find((o) => o.factorToBase === 1)!;
  it("splits on the pack size and rolls over at a full pack", () => {
    expect(derivedPackSplit(derived, 2)).toEqual({ qty: 2, boxes: 0, pieces: 2, unitsPerBox: 3 });
    expect(derivedPackSplit(derived, 3)).toEqual({ qty: 3, boxes: 1, pieces: 0, unitsPerBox: 3 });
    expect(derivedPackSplit(derived, 7)).toEqual({ qty: 7, boxes: 2, pieces: 1, unitsPerBox: 3 });
  });
  it("is null for an option that is not a derived base (the pack, a level, an own-priced Piece)", () => {
    const own = buildLadderOptions(box24, [CASE72, row("Piece", 1, "2.50")], 1);
    for (const o of own) expect(derivedPackSplit(o, 2)).toBeNull();
  });
});

describe("packPiecesSplit: the one pieces-to-pack shape derivedPackSplit and the server share (row 513)", () => {
  it("rolls whole packs into boxes and keeps the remainder as pieces", () => {
    expect(packPiecesSplit(3, 7)).toEqual({ qty: 7, boxes: 2, pieces: 1, unitsPerBox: 3 });
    expect(packPiecesSplit(12, 12)).toEqual({ qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12 });
    expect(packPiecesSplit(12, 5)).toEqual({ qty: 5, boxes: 0, pieces: 5, unitsPerBox: 12 });
  });
  it("keeps several whole packs as boxes with no remainder, and one piece short of a pack as pieces", () => {
    expect(packPiecesSplit(12, 24)).toEqual({ qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 });
    expect(packPiecesSplit(12, 25)).toEqual({ qty: 25, boxes: 2, pieces: 1, unitsPerBox: 12 });
    expect(packPiecesSplit(12, 11)).toEqual({ qty: 11, boxes: 0, pieces: 11, unitsPerBox: 12 });
  });
  it("is an all-zero split for a zero or negative count, never a negative line", () => {
    const zero = { qty: 0, boxes: 0, pieces: 0, unitsPerBox: 12 };
    expect(packPiecesSplit(12, 0)).toEqual(zero);
    expect(packPiecesSplit(12, -3)).toEqual(zero);
  });
  it("truncates a fractional count to whole pieces", () => {
    expect(packPiecesSplit(12, 2.7)).toEqual({ qty: 2, boxes: 0, pieces: 2, unitsPerBox: 12 });
  });
  it("is an all-zero split when the pack is not a real pack (1 or less)", () => {
    expect(packPiecesSplit(1, 5)).toEqual({ qty: 0, boxes: 0, pieces: 0, unitsPerBox: 1 });
    expect(packPiecesSplit(0, 5)).toEqual({ qty: 0, boxes: 0, pieces: 0, unitsPerBox: 0 });
  });
  it("derivedPackSplit and packPiecesSplit agree for every count of a derived base", () => {
    const base = buildLadderOptions(pack3, [CASE72], 1).find((o) => o.factorToBase === 1)!;
    for (const c of [1, 2, 3, 4, 6, 7, 30]) {
      expect(derivedPackSplit(base, c)).toEqual(packPiecesSplit(base.derived!.n, c));
    }
  });
});

describe("heldSnapshotOption / withHeldOption (SA-1044 rule 4)", () => {
  const snap = heldSnapshotOption({
    unitLabel: "Case",
    unitsPerBox: 100,
    unitPrice: 45,
    listPrice: 50,
  });

  it("is the line's own snapshot, labelled with its size", () => {
    expect(snap).toMatchObject({
      value: "Case",
      label: "Case of 100 (as ordered)",
      factorToBase: 100,
    });
    expect(snap).toMatchObject({ kind: "level", price: 45, listPrice: 50, held: true });
    expect(ladderOptionText(snap, (n) => `$${n.toFixed(2)}`, String)).toBe(
      "Case of 100 (as ordered) · $45.00",
    );
  });

  it("list falls back to the held price", () => {
    expect(heldSnapshotOption({ unitLabel: "Case", unitsPerBox: 12, unitPrice: 9 }).listPrice).toBe(
      9,
    );
  });

  it("replaces the live option of the same label, or is added after the rest", () => {
    const live = [
      {
        value: "",
        label: "Box",
        factorToBase: 12,
        kind: "pack" as const,
        price: 24,
        listPrice: 24,
      },
      {
        value: "case",
        label: "case",
        factorToBase: 200,
        kind: "level" as const,
        price: 90,
        listPrice: 90,
      },
    ];
    expect(withHeldOption(live, snap).map((o) => o.label)).toEqual([
      "Box",
      "Case of 100 (as ordered)",
    ]);
    expect(withHeldOption(live.slice(0, 1), snap).map((o) => o.label)).toEqual([
      "Box",
      "Case of 100 (as ordered)",
    ]);
    expect(withHeldOption(live, null)).toEqual(live);
  });
});
