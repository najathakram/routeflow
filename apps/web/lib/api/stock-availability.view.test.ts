import { stockViewForLine } from "./stock-availability";

/**
 * A line sold in a NAMED unit ("Case" of 12) has a qty that counts those units, while the server's stock
 * is in PIECES. Comparing the two read "30 Case left, ok" for 3 cases (36 pieces) against 30 on hand
 * while the server sees 36 > 30. The web has no honest piece count for such a line, so it shows nothing
 * (the edit page already skips them) and the server stays the authority on save.
 */
const query = {
  data: { allowOversell: false, items: [{ productId: "p1", availablePieces: 30 }] },
  isError: false,
  isFetching: false,
};

describe("stockViewForLine: named-unit lines", () => {
  it("3 Cases of 12 (36 pieces) against 30 on hand shows NO stock note, never '30 Case left, ok'", () => {
    const view = stockViewForLine(query, {
      productId: "p1",
      qty: 3,
      unitLabel: "Case",
      unitsPerBox: 12,
      unit: "Case",
    });
    expect(view).toBeUndefined();
  });

  it("a plain piece line still compares in pieces: 36 against 30 is low and blocks", () => {
    const view = stockViewForLine(query, { productId: "p1", qty: 36, unit: "each" });
    expect(view).toMatchObject({ state: "ready", level: "low", blocksSubmit: true });
  });

  it("a boxed (unlabelled) line still counts cases through the pack: 3 cases of 12 = 36 > 30", () => {
    const view = stockViewForLine(query, { productId: "p1", qty: 36, boxes: 3, unitsPerBox: 12 });
    expect(view).toMatchObject({ state: "ready", level: "low", blocksSubmit: true });
  });
});
