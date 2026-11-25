/** B1383 (SA-1281 part 2): a boxed product's price is the BOX price, so its label names the box, never the piece. */
import { isPackUnitWord, pricedPerLabel } from "./priced-per-label";

describe("pricedPerLabel", () => {
  it("a piece word with a pack size names the box and the pieces in it (B1383's own value)", () => {
    const r = pricedPerLabel({ unit: "can", unitsPerBox: 12, price: 1.25 });
    expect(r.label).toBe("Price per box (12 cans)");
    expect(r.hint).toBe("≈ $0.10 / can");
    expect(r.perPiece).toEqual({ price: 0.1, word: "can" });
  });

  it("'piece' with 24 per box", () => {
    const r = pricedPerLabel({ unit: "piece", unitsPerBox: 24, price: 1.5 });
    expect(r.label).toBe("Price per box (24 pieces)");
    expect(r.hint).toBe("≈ $0.06 / piece");
  });

  it("a plain 'each' unit with a pack size reads pieces, never '12 each'", () => {
    expect(pricedPerLabel({ unit: "each", unitsPerBox: 12 }).label).toBe(
      "Price per box (12 pieces)",
    );
  });

  it("a tenant's own pack name wins the box word", () => {
    expect(pricedPerLabel({ unit: "can", unitsPerBox: 6, packLabel: "Tray" }).label).toBe(
      "Price per tray (6 cans)",
    );
  });

  it("a pack word is quoted per itself and still says how many pieces it holds", () => {
    const r = pricedPerLabel({ unit: "case", unitsPerBox: 12, price: 12 });
    expect(r.label).toBe("Price per case (12 pieces)");
    expect(r.perText).toBe("per case (12 pieces)");
    expect(r.hint).toBe("≈ $1.00 / pc");
  });

  it("each with no pack size reads 'Price each', never 'Price per each'", () => {
    const r = pricedPerLabel({ unit: "each", unitsPerBox: null, price: 3 });
    expect(r.label).toBe("Price each");
    expect(r.hint).toBeNull();
  });

  it("a product sold by the piece only (1 per pack) keeps its own unit word", () => {
    const r = pricedPerLabel({ unit: "can", unitsPerBox: 1, price: 2 });
    expect(r.label).toBe("Price per can");
    expect(r.hint).toBeNull();
    expect(pricedPerLabel({ unit: "lb", unitsPerBox: 1 }).label).toBe("Price per lb");
  });

  it.each([0, -3, null, undefined, NaN, Infinity * 0])(
    "a zero or missing pack count (%s) has no box and no '≈' line",
    (n) => {
      const r = pricedPerLabel({ unit: "can", unitsPerBox: n as number | null, price: 1.25 });
      expect(r.label).toBe("Price per can");
      expect(r.hint).toBeNull();
    },
  );

  it("a blank or 'unit' unit reads 'Price per unit'; only 'each' reads 'Price each'", () => {
    expect(pricedPerLabel({ unit: "  ", unitsPerBox: null }).label).toBe("Price per unit");
    expect(pricedPerLabel({ unit: null }).label).toBe("Price per unit");
    expect(pricedPerLabel({ unit: "unit", unitsPerBox: 6 }).label).toBe("Price per box (6 pieces)");
  });

  it("no price yet: the label stands, the hint is absent", () => {
    const r = pricedPerLabel({ unit: "can", unitsPerBox: 12 });
    expect(r.label).toBe("Price per box (12 cans)");
    expect(r.hint).toBeNull();
  });

  it("splits for callers that add a tier: short + detail", () => {
    const r = pricedPerLabel({ unit: "can", unitsPerBox: 12 });
    expect([r.short, r.detail]).toEqual(["Price per box", "12 cans"]);
    expect(pricedPerLabel({ unit: "case" }).detail).toBeNull();
    expect(pricedPerLabel({ unit: "case", unitsPerBox: 12 }).detail).toBe("12 pieces");
  });

  it("keeps the case the operator typed on a pack unit (order-line field)", () => {
    expect(pricedPerLabel({ unit: "Case" }).label).toBe("Price per Case");
  });
});

describe("the pack count rides every boxed label (SA note, B1383 PR-B)", () => {
  it.each([
    ["case", 12, "per case (12 pieces)"],
    ["case", 1, "per case"],
    ["case", null, "per case"],
    ["can", 12, "per box (12 cans)"],
    ["each", 12, "per box (12 pieces)"],
  ])("unit %s with %s per box reads %s", (unit, n, want) => {
    expect(pricedPerLabel({ unit, unitsPerBox: n }).perText).toBe(want);
  });

  it("a business base word names the pieces of a pack unit", () => {
    expect(pricedPerLabel({ unit: "case", unitsPerBox: 6, baseUnitLabel: "Bottle" }).perText).toBe(
      "per case (6 bottles)",
    );
  });
});

describe("the default unit and generic piece words are not pluralised (F1)", () => {
  it.each([
    ["ea", "12 pieces", "≈ $1.00 / piece"],
    ["pc", "12 pieces", "≈ $1.00 / piece"],
    ["piece", "12 pieces", "≈ $1.00 / piece"],
  ])("unit %s with 12 per box reads %s and %s", (unit, detail, hint) => {
    const r = pricedPerLabel({ unit, unitsPerBox: 12, price: 12 });
    expect(r.detail).toBe(detail);
    expect(r.label).toBe("Price per box (12 pieces)");
    expect(r.hint).toBe(hint);
  });
});

describe("compact forms for buyer tiles and mobile rows", () => {
  it("name the box for a boxed piece word, and the unit otherwise", () => {
    const boxed = pricedPerLabel({ unit: "can", unitsPerBox: 12 });
    expect([boxed.per, boxed.perText, boxed.word]).toEqual(["per box", "per box (12 cans)", "box"]);
    const lb = pricedPerLabel({ unit: "lb", unitsPerBox: null });
    expect([lb.per, lb.perText, lb.word]).toEqual(["per lb", "per lb", "lb"]);
    expect(pricedPerLabel({ unit: "each" }).word).toBe("each");
  });
});

describe("isPackUnitWord", () => {
  it("knows pack words and a tenant's own pack name, not piece words", () => {
    expect(isPackUnitWord("Box")).toBe(true);
    expect(isPackUnitWord("tray", "Tray")).toBe(true);
    expect(isPackUnitWord("can")).toBe(false);
    expect(isPackUnitWord("")).toBe(false);
  });
});
