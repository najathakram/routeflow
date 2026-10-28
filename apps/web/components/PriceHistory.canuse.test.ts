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
  it("a line with no pack hint does not block a unit match", () => {
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

  /** W-986 (SA-1004): `salePack` null = the sale's pack is UNKNOWN, never "one piece". Fail closed. */
  describe("unknown sale pack (salePack null): refused on every path", () => {
    const sale = (unitLabel: string, salePack: number | null) => ({
      unitLabel,
      unitsPerBox: salePack != null && salePack > 1 ? salePack : null,
      salePack,
    });
    it("unit hint: an unknown-pack case row on a 24-pack case line is refused", () => {
      expect(canUseHistoryPrice(sale("case", null), "case", 24, 1)).toBe(false);
      expect(canUseHistoryPrice(sale("case", null), "case", null, 1)).toBe(false);
    });
    it("no unit hint: an unknown-pack row on a pack-1 or unknown line is refused", () => {
      expect(canUseHistoryPrice(sale("each", null), null, 1, 1)).toBe(false);
      expect(canUseHistoryPrice(sale("each", null), null, null, 1)).toBe(false);
    });
    it("a known piece sale (salePack 1) still matches a pack-1 line", () => {
      expect(canUseHistoryPrice(sale("each", 1), null, 1, 1)).toBe(true);
      expect(canUseHistoryPrice(sale("each", 1), "each", 1, 1)).toBe(true);
    });
    it("a known pack sale still matches only its own pack", () => {
      expect(canUseHistoryPrice(sale("case", 24), "case", 24, 1)).toBe(true);
      expect(canUseHistoryPrice(sale("case", 24), "case", 12, 1)).toBe(false);
    });
  });
});
