import { showPerPieceColumn } from "./invoice-item-display-lines";

/** Owner ruling 2026-11-04: one gate for the Per piece column, honouring the business's hidePerPiece. */
const packLine = {
  qty: 48,
  boxes: 2,
  pieces: 0,
  unitsPerBox: 24,
  components: null,
  displayUnit: { kind: "legacy", label: null },
  perBaseUnit: { price: 2, unit: "pc" },
} as never;

describe("showPerPieceColumn — the hidePerPiece switch", () => {
  it("shows the column for a pack line by default", () => {
    expect(showPerPieceColumn([packLine])).toBe(true);
  });

  it("hides it when the business turned it off", () => {
    expect(showPerPieceColumn([packLine], { hide: true })).toBe(false);
  });

  it("an explicit hide false keeps it", () => {
    expect(showPerPieceColumn([packLine], { hide: false })).toBe(true);
  });
});
