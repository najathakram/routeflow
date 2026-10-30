import { heldLevelState, heldSnapshotPrices, ladderNames } from "./held-level";
import type { LadderProduct, LadderUnit } from "./unit-levels";

// SA-1044 G-6: the held-level truth table. First hit wins: unknown → gone → resized → live.

const product: LadderProduct = { unit: "Box", unitsPerBox: 12, pricePerUnit: 24 };
const caseRow = (factorToBase: number): LadderUnit => ({
  label: "Case",
  factorToBase,
  price: 90,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
});
const held = (over: Record<string, unknown> = {}) => ({
  unitLabel: "Case",
  unitsPerBox: 100,
  unitPrice: 45,
  ...over,
});

describe("heldLevelState", () => {
  it("live: same label, same factor", () => {
    expect(heldLevelState(held(), product, [caseRow(100)])).toBe("live");
  });

  it("resized: the ladder names the label at a different factor", () => {
    expect(heldLevelState(held(), product, [caseRow(200)])).toBe("resized");
  });

  it("gone: the ladder no longer names the label", () => {
    expect(heldLevelState(held(), product, [])).toBe("gone");
  });

  it("matches the label by NFC + case-fold key, not raw text", () => {
    const cafe = { ...caseRow(6), label: "Café" };
    expect(heldLevelState(held({ unitLabel: "CAFÉ", unitsPerBox: 6 }), product, [cafe])).toBe(
      "live",
    );
  });

  it("the base label resolves at factor 1 (live at 1, resized otherwise)", () => {
    expect(heldLevelState(held({ unitLabel: "Piece", unitsPerBox: 1 }), product, [])).toBe("live");
    expect(heldLevelState(held({ unitLabel: "piece", unitsPerBox: 6 }), product, [])).toBe(
      "resized",
    );
  });

  it("a legacy label that is now the pack word is judged at the pack factor", () => {
    expect(heldLevelState(held({ unitLabel: "Box", unitsPerBox: 12 }), product, [])).toBe("live");
    expect(heldLevelState(held({ unitLabel: "box", unitsPerBox: 10 }), product, [])).toBe(
      "resized",
    );
  });

  it.each([
    ["blank label", { unitLabel: "  " }],
    ["null label", { unitLabel: null }],
    ["null unitsPerBox", { unitsPerBox: null }],
    ["zero unitsPerBox", { unitsPerBox: 0 }],
    ["fractional unitsPerBox", { unitsPerBox: 1.5 }],
    ["NaN price", { unitPrice: Number.NaN }],
    ["negative price", { unitPrice: -1 }],
    ["null price", { unitPrice: null }],
  ])("unknown: %s (never silently live)", (_name, over) => {
    expect(heldLevelState(held(over), product, [caseRow(100)])).toBe("unknown");
  });

  it("unknown wins over gone (first hit)", () => {
    expect(heldLevelState(held({ unitsPerBox: null }), product, [])).toBe("unknown");
  });

  it("a zero price is a valid snapshot", () => {
    expect(heldLevelState(held({ unitPrice: 0 }), product, [caseRow(100)])).toBe("live");
  });

  it("rethrows anything that is not UnknownUnitError", () => {
    const broken = null as unknown as LadderUnit[];
    expect(() => heldLevelState(held(), product, broken)).toThrow(TypeError);
    expect(() => ladderNames(product, broken, "Case")).toThrow(TypeError);
  });
});

describe("ladderNames", () => {
  it("names the pack, the base and a row; not a missing label", () => {
    expect(ladderNames(product, [caseRow(100)], "box")).toBe(true);
    expect(ladderNames(product, [caseRow(100)], "Piece")).toBe(true);
    expect(ladderNames(product, [caseRow(100)], "case")).toBe(true);
    expect(ladderNames(product, [], "Case")).toBe(false);
  });
});

describe("heldSnapshotPrices", () => {
  it("tier = the held unitPrice, list = originalPrice, both rounded", () => {
    expect(heldSnapshotPrices({ unitPrice: 45.004, originalPrice: "50.005" })).toEqual({
      tierPrice: 45,
      listPrice: 50.01,
    });
  });

  it("list falls back to the unitPrice when no originalPrice was kept", () => {
    expect(heldSnapshotPrices({ unitPrice: 45, originalPrice: null })).toEqual({
      tierPrice: 45,
      listPrice: 45,
    });
  });
});
