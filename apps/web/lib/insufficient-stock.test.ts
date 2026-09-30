import { insufficientStockSentence, parseInsufficientStock } from "@routeflow/types";

const line = (name: string | undefined, available: number, requested = 9) => ({
  productId: `p-${name}`,
  name,
  available,
  requested,
});

describe("insufficientStockSentence", () => {
  it("names what is left", () => {
    expect(insufficientStockSentence([line("Mango 5ct", 4)])).toBe(
      "Only 4 pieces of Mango 5ct left.",
    );
  });
  it("says out of stock at zero (and at a negative count)", () => {
    expect(insufficientStockSentence([line("Mango 5ct", 0)])).toBe("Mango 5ct is out of stock.");
    expect(insufficientStockSentence([line("Mango 5ct", -2)])).toBe("Mango 5ct is out of stock.");
  });
  it("joins several lines", () => {
    expect(insufficientStockSentence([line("Mango 5ct", 4), line("Lime", 2)])).toBe(
      "Only 4 pieces of Mango 5ct and 2 pieces of Lime left.",
    );
    expect(insufficientStockSentence([line("Mango", 4), line("Lime", 2), line("Fig", 1)])).toBe(
      "Only 4 pieces of Mango, 2 pieces of Lime and 1 piece of Fig left.",
    );
  });
  it("mixes short and out-of-stock lines", () => {
    expect(insufficientStockSentence([line("Mango", 4), line("Lime", 0), line("Fig", 0)])).toBe(
      "Only 4 pieces of Mango left. Lime and Fig are out of stock.",
    );
  });
  it("uses the product's own unit label when it is not a generic piece", () => {
    expect(insufficientStockSentence([{ ...line("Rice", 4), unit: "lb" }])).toBe(
      "Only 4 lb of Rice left.",
    );
    expect(insufficientStockSentence([{ ...line("Mango 12ct", 10), unit: "each" }])).toBe(
      "Only 10 pieces of Mango 12ct left.",
    );
  });
  it("keeps decimal quantities", () => {
    expect(insufficientStockSentence([line("Rice", 2.5)])).toBe("Only 2.5 pieces of Rice left.");
  });
  it("falls back when a line has no name, and when there are no lines", () => {
    expect(insufficientStockSentence([line(undefined, 3)])).toBe("Only 3 pieces of an item left.");
    expect(insufficientStockSentence([line(undefined, 0)])).toBe("An item is out of stock.");
    expect(insufficientStockSentence([])).toMatch(/aren't available/);
  });
});

describe("parseInsufficientStock", () => {
  const body = {
    code: "INSUFFICIENT_STOCK",
    message: "Insufficient stock: raw",
    lines: [{ productId: "p1", name: "Mango", available: 4, requested: 6 }],
  };
  it("reads an axios-shaped error", () => {
    expect(parseInsufficientStock({ response: { data: body } })?.lines).toHaveLength(1);
  });
  it("reads a bare body", () => {
    expect(parseInsufficientStock(body)?.lines[0].available).toBe(4);
  });
  it("reads the edit path's legacy single-line shape", () => {
    const legacy = { code: "INSUFFICIENT_STOCK", productId: "p1", available: 2, requested: 8 };
    expect(parseInsufficientStock({ response: { data: legacy } })?.lines).toEqual([
      { productId: "p1", available: 2, requested: 8 },
    ]);
  });
  it("is null for any other 409 or non-error", () => {
    expect(
      parseInsufficientStock({ response: { data: { code: "PO_ALREADY_BILLED" } } }),
    ).toBeNull();
    expect(parseInsufficientStock(new Error("x"))).toBeNull();
    expect(parseInsufficientStock(null)).toBeNull();
  });
});
