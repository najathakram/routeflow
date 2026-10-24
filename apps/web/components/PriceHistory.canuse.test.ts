import { canUseHistoryPrice } from "./PriceHistory";

/** "Use this price" must never write a price from a different unit or pack onto a line. */
describe("canUseHistoryPrice", () => {
  const row = (unitLabel: string, unitsPerBox: number | null) => ({ unitLabel, unitsPerBox });

  it("same unit, same pack: allowed", () => {
    expect(canUseHistoryPrice(row("case", 24), "case", 24, 1)).toBe(true);
  });
  it("same unit, DIFFERENT pack (12-pack price on a 24-pack line after a repack): refused", () => {
    expect(canUseHistoryPrice(row("case", 12), "case", 24, 1)).toBe(false);
  });
  it("unknown pack on either side does not block a unit match", () => {
    expect(canUseHistoryPrice(row("case", null), "case", 24, 1)).toBe(true);
    expect(canUseHistoryPrice(row("case", 24), "case", null, 1)).toBe(true);
  });
  it("different unit: refused", () => {
    expect(canUseHistoryPrice(row("each", 1), "case", 24, 2)).toBe(false);
  });
  it("a line with NO unit hint is closed when the history spans more than one unit", () => {
    expect(canUseHistoryPrice(row("case", 24), null, null, 2)).toBe(false);
    expect(canUseHistoryPrice(row("case", 24), "", null, 2)).toBe(false);
  });
  it("a line with no unit hint may use a single-unit history", () => {
    expect(canUseHistoryPrice(row("each", 1), null, null, 1)).toBe(true);
  });

  describe("no unit hint: the pack must still match (12x overcharge guard)", () => {
    it("12-pack Box row on an each-priced line (pack 1 / unknown): refused", () => {
      expect(canUseHistoryPrice(row("Box", 12), null, 1, 1)).toBe(false);
      expect(canUseHistoryPrice(row("Box", 12), null, null, 1)).toBe(false);
    });
    it("row pack null or 1 on a pack-1 line: allowed", () => {
      expect(canUseHistoryPrice(row("each", null), null, 1, 1)).toBe(true);
      expect(canUseHistoryPrice(row("each", 1), null, 1, 1)).toBe(true);
    });
    it("equal packs: allowed", () => {
      expect(canUseHistoryPrice(row("Box", 12), null, 12, 1)).toBe(true);
    });
    it("pack known on exactly one side: refused", () => {
      expect(canUseHistoryPrice(row("each", null), null, 12, 1)).toBe(false);
      expect(canUseHistoryPrice(row("each", 1), null, 12, 1)).toBe(false);
      expect(canUseHistoryPrice(row("Box", 12), null, 1, 1)).toBe(false);
    });
  });
});
