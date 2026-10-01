import { resolveLadderLevel, resolveUnitPrice } from "@routeflow/pricing";
import type { ProductUnitLevel } from "@routeflow/types";
import {
  buildUnitOptions,
  defaultUnitValue,
  unitLineSubtotal,
  unitOptionText,
} from "./unit-options";

const product = {
  unit: "Box",
  unitsPerBox: 24,
  pricePerUnit: "42.00",
  priceTier2: "21.00",
  priceTier3: "0",
};

const level = (
  over: Partial<ProductUnitLevel> & Pick<ProductUnitLevel, "label" | "factorToBase">,
) =>
  ({
    id: over.label,
    price: null,
    priceTier2: null,
    priceTier3: null,
    priceTier4: null,
    priceTier5: null,
    isDefaultSelling: false,
    sortOrder: 0,
    ...over,
  }) as ProductUnitLevel;

const CASE = level({ label: "Case", factorToBase: 288, price: "480.00" });
const PALLET = level({ label: "Pallet", factorToBase: 5760 });

describe("buildUnitOptions", () => {
  it("a product with no levels offers only the pack, sent as an empty unitLabel", () => {
    expect(buildUnitOptions(product, [])).toEqual([
      { value: "", label: "Box", factorToBase: 24, kind: "pack", price: 42, listPrice: 42 },
    ]);
  });

  it("lists pack, then levels largest to smallest, then the implicit Piece — priced by the server ladder", () => {
    const opts = buildUnitOptions(product, [CASE, PALLET]);
    expect(opts.map((o) => [o.value, o.factorToBase, o.kind, o.price])).toEqual([
      ["", 24, "pack", 42],
      ["Pallet", 5760, "level", 10080], // derived: 42 x 5760 / 24
      ["Case", 288, "level", 480], // explicit
      ["Piece", 1, "piece", 1.75], // 42 / 24
    ]);
  });

  it("prices each level at the customer's tier (base-only level scales by the pack tier ratio)", () => {
    const opts = buildUnitOptions(product, [CASE, PALLET], 2);
    expect(opts.find((o) => o.value === "Case")?.price).toBe(240); // 480 x 21 / 42
    expect(opts.find((o) => o.value === "Pallet")?.price).toBe(5040); // 21 x 5760 / 24
  });

  it("shadows a row named like the pack; a factor-1 Piece row is the Piece level (its explicit price wins, as on the server)", () => {
    const opts = buildUnitOptions(product, [
      level({ label: "box", factorToBase: 12 }),
      level({ label: "PIECE", factorToBase: 1, price: "9.99" }),
      CASE,
    ]);
    expect(opts.map((o) => o.value)).toEqual(["", "Case", "Piece"]);
    expect(opts.find((o) => o.value === "Piece")?.price).toBe(9.99);
  });

  it("a ladder whose ONLY row is the explicit Piece still offers it (the canonical singles-at-a-premium setup)", () => {
    const opts = buildUnitOptions(product, [
      level({ label: "Piece", factorToBase: 1, price: "2.00" }),
    ]);
    expect(opts.map((o) => [o.value, o.kind, o.price])).toEqual([
      ["", "pack", 42],
      ["Piece", "piece", 2],
    ]);
  });

  it("a pack price passed by the parent replaces the ladder's pack price only (levels stay ladder-priced)", () => {
    const opts = buildUnitOptions(product, [CASE], 1, 38);
    expect(opts.map((o) => [o.value, o.price])).toEqual([
      ["", 38],
      ["Case", 480],
      ["Piece", 1.75],
    ]);
  });

  it("ignores a corrupt (non-integer / sub-1) factor instead of pricing it", () => {
    const opts = buildUnitOptions(product, [level({ label: "Half", factorToBase: 0.5 }), CASE]);
    expect(opts.map((o) => o.value)).toEqual(["", "Case", "Piece"]);
  });

  it("a pack of one piece with a level offers no second single-piece option", () => {
    const opts = buildUnitOptions({ unit: "Bag", unitsPerBox: null, pricePerUnit: "5.00" }, [
      level({ label: "Case", factorToBase: 10 }),
    ]);
    expect(opts.map((o) => [o.value, o.factorToBase, o.price])).toEqual([
      ["", 1, 5],
      ["Case", 10, 50],
    ]);
  });
});

describe("defaultUnitValue", () => {
  it("is the level flagged isDefaultSelling, else the pack", () => {
    expect(defaultUnitValue(product, [CASE, PALLET])).toBe("");
    expect(defaultUnitValue(product, [CASE, { ...PALLET, isDefaultSelling: true }])).toBe("Pallet");
  });

  it("never names a label the picker does not offer (a shadowed row would hold the line unseen)", () => {
    expect(
      defaultUnitValue(product, [
        level({ label: "box", factorToBase: 12, isDefaultSelling: true }),
      ]),
    ).toBe("");
    expect(
      defaultUnitValue(product, [
        level({ label: "Piece", factorToBase: 1, isDefaultSelling: true }),
      ]),
    ).toBe("Piece");
  });

  it("#2784: skips a corrupt flagged row and takes the next valid one (one resolver, @routeflow/pricing)", () => {
    expect(
      defaultUnitValue(product, [
        level({ label: "Bad", factorToBase: 0, isDefaultSelling: true }),
        { ...PALLET, isDefaultSelling: true },
      ]),
    ).toBe("Pallet");
  });
});

describe("client/server agreement — every offered option is one the server accepts and prices the same", () => {
  const fixtures: Array<[string, Parameters<typeof buildUnitOptions>[0], ProductUnitLevel[]]> = [
    ["boxed + Case/Pallet", product, [CASE, PALLET]],
    ["boxed + Piece only", product, [level({ label: "Piece", factorToBase: 1, price: "2.00" })]],
    [
      "unboxed + Case",
      { unit: "Bag", unitsPerBox: null, pricePerUnit: "5.00" },
      [level({ label: "Case", factorToBase: 10 })],
    ],
    ["no levels", product, []],
  ];
  it.each(fixtures)("%s", (_name, prod, units) => {
    for (const tier of [1, 2, 3]) {
      const ladder = units.map((u) => ({ ...u }));
      for (const o of buildUnitOptions(prod, units, tier)) {
        const server = resolveLadderLevel(prod, ladder, o.value); // throws UnknownUnitError if rejected
        expect(server.factorToBase).toBe(o.factorToBase);
        expect(server.kind).toBe(o.kind);
        expect(resolveUnitPrice(prod, ladder, o.value, tier)).toBe(o.price);
      }
    }
  });
});

describe("unitOptionText", () => {
  it("shows the label, pieces per unit and the price; a single piece omits the count", () => {
    const [pack, , , piece] = buildUnitOptions(product, [CASE, PALLET]);
    expect(unitOptionText(pack)).toBe("Box · 24 pcs · $42.00");
    expect(unitOptionText(buildUnitOptions(product, [PALLET])[1])).toBe(
      "Pallet · 5760 pcs · $10,080.00",
    );
    expect(unitOptionText(piece)).toBe("Piece · $1.75");
  });
});

describe("unitLineSubtotal", () => {
  const opts = buildUnitOptions(product, [CASE, PALLET]);
  const by = (v: string) => opts.find((o) => o.value === v)!;

  it("counts the unit, never pieces x price", () => {
    expect(unitLineSubtotal(by("Case"), 3)).toBe(1440);
    expect(unitLineSubtotal(by("Piece"), 5)).toBe(8.75);
    expect(unitLineSubtotal(by(""), 2)).toBe(84);
  });

  it("honours a typed price and returns 0 for a non-positive count", () => {
    expect(unitLineSubtotal(by("Case"), 3, 400)).toBe(1200);
    expect(unitLineSubtotal(by("Case"), 0)).toBe(0);
    expect(unitLineSubtotal(by("Case"), Number.NaN)).toBe(0);
  });
});
