import { parsePackSizeDetailed, suggestPackSize } from "@routeflow/types";

/**
 * Pack-size parser regression suite. This is the whole in-app pack-size
 * feature's foundation: every boxed affordance (boxed price proration, the
 * boxes/pieces inputs, box-aware scanning, stock-count denominations) is
 * dormant until `Product.unitsPerBox` is set, and this parser is the thing
 * proposing that value. A wrong proposal silently mis-prices every loose sale
 * of that product from then on — a false `null` only costs one prompt a human
 * answers — so this suite is weighted toward the REFUSAL cases, not the happy
 * path. `parsePackSizeDetailed` lives in `packages/types/pack-size.ts`, which
 * has no Jest runner of its own, so the spec lives here and imports the
 * package like any other consumer.
 */
describe("pack-size — parsePackSizeDetailed", () => {
  describe("explicit counts are read correctly", () => {
    it('"12/1.93OZ" reads 12 — N units of a given size, read before the OZ is stripped', () => {
      expect(parsePackSizeDetailed("Red Bull Energy 12/1.93OZ")).toEqual({
        packSize: 12,
        counts: [12],
      });
    });

    it('"24PK" reads 24', () => {
      expect(parsePackSizeDetailed("Widget 24PK")).toEqual({ packSize: 24, counts: [24] });
    });

    it('"12 CT" reads 12', () => {
      expect(parsePackSizeDetailed("Widget 12 CT")).toEqual({ packSize: 12, counts: [12] });
    });

    it('"10 COUNT" reads 10', () => {
      expect(parsePackSizeDetailed("Widget 10 COUNT")).toEqual({ packSize: 10, counts: [10] });
    });

    it('"12-CT" reads 12', () => {
      expect(parsePackSizeDetailed("Widget 12-CT")).toEqual({ packSize: 12, counts: [12] });
    });

    it("is case-insensitive on both the count suffix and the input casing", () => {
      expect(parsePackSizeDetailed("widget 24pk").packSize).toBe(24);
      expect(parsePackSizeDetailed("WIDGET 24PK").packSize).toBe(24);
    });

    // BLOCKER regression: the count regex's trailing `\b` used to make plural
    // suffixes (CTS/PKS/PACKS/COUNTS) invisible, so a name that only stated a
    // PLURAL count read as having no count at all there. Pin every plural
    // form alongside its singular so the suffix group can never silently
    // regress to capturing (and re-breaking `S?`) without failing loudly.
    it('"5cts" (plural CT) reads 5, same as singular "5CT"', () => {
      expect(parsePackSizeDetailed("Widget - 5cts")).toEqual({ packSize: 5, counts: [5] });
    });

    it('"24 PACKS" (plural PACK) reads 24', () => {
      expect(parsePackSizeDetailed("Widget 24 PACKS")).toEqual({ packSize: 24, counts: [24] });
    });

    it('"10 PKS" (plural PK) reads 10', () => {
      expect(parsePackSizeDetailed("Widget 10 PKS")).toEqual({ packSize: 10, counts: [10] });
    });

    it('"10 COUNTS" (plural COUNT) reads 10', () => {
      expect(parsePackSizeDetailed("Widget 10 COUNTS")).toEqual({ packSize: 10, counts: [10] });
    });

    it('"PCS" still reads via PC + optional S, not as its own alternative', () => {
      expect(parsePackSizeDetailed("Widget 6 PCS")).toEqual({ packSize: 6, counts: [6] });
      expect(parsePackSizeDetailed("Widget 6 PC")).toEqual({ packSize: 6, counts: [6] });
    });
  });

  describe("REFUSAL: measurements never read as counts", () => {
    it('"5 HOUR ENERGY" is a duration, not a count — packSize stays null', () => {
      expect(parsePackSizeDetailed("5 Hour Energy")).toEqual({ packSize: null, counts: [] });
    });

    it('"65MG" is a dosage, not a count — packSize stays null', () => {
      expect(parsePackSizeDetailed("Ibuprofen 65MG Tablets")).toEqual({
        packSize: null,
        counts: [],
      });
    });

    it("strips OZ/ML/LB/KG/G/L measurements before counting, so none of them leak through as a count", () => {
      expect(parsePackSizeDetailed("Juice 32OZ").packSize).toBeNull();
      expect(parsePackSizeDetailed("Water 500ML").packSize).toBeNull();
      expect(parsePackSizeDetailed("Flour 5LB Bag").packSize).toBeNull();
      expect(parsePackSizeDetailed("Sugar 2KG").packSize).toBeNull();
      expect(parsePackSizeDetailed("Rope 10FT").packSize).toBeNull();
    });
  });

  describe("REFUSAL: nested/ambiguous packaging — the single most important case", () => {
    it('"…5CT - 12Pack" NEVER resolves to 5 or 12 — packSize is null, both counts surface, AMBIGUOUS', () => {
      const r = parsePackSizeDetailed("Energy Shot 5CT - 12Pack");
      expect(r.packSize).toBeNull();
      expect(r.packSize).not.toBe(5);
      expect(r.packSize).not.toBe(12);
      expect(r.counts).toEqual([5, 12]);
    });

    it("stays ambiguous regardless of which count appears first in the name", () => {
      const r = parsePackSizeDetailed("12Pack of 5CT Energy Shot");
      expect(r.packSize).toBeNull();
      expect(r.counts.slice().sort((a, b) => a - b)).toEqual([5, 12]);
    });

    it("three or more distinct counts are still ambiguous, not just two", () => {
      const r = parsePackSizeDetailed("Widget 4CT 8PK 16 COUNT");
      expect(r.packSize).toBeNull();
      expect(r.counts.slice().sort((a, b) => a - b)).toEqual([4, 8, 16]);
    });

    it("a REPEATED identical count is not ambiguous — one distinct value still resolves", () => {
      expect(parsePackSizeDetailed("Widget 12CT 12 Pack")).toEqual({
        packSize: 12,
        counts: [12],
      });
    });

    // BLOCKER regression (2026-08-20): the count regex's trailing `\b` made
    // plural suffixes (CTS/PKS/PACKS/COUNTS) invisible, so a nested-packaging
    // name where the SECOND count used a plural suffix — "…5CT - 12Packs" —
    // only matched the "5" and returned packSize: 5 at HIGH confidence
    // instead of refusing as AMBIGUOUS. That defeated the parser's central
    // guarantee and would have mis-priced every loose sale of that product.
    // This is the case that must never regress.
    it('"…5CT - 12Packs" (plural on the SECOND count) is still AMBIGUOUS — never a confident 5', () => {
      const r = parsePackSizeDetailed("Energy Shot 5CT - 12Packs");
      expect(r.packSize).toBeNull();
      expect(r.packSize).not.toBe(5);
      expect(r.packSize).not.toBe(12);
      expect(r.counts).toEqual([5, 12]);
    });

    it('"…5CTS - 12Pack" (plural on the FIRST count) is also AMBIGUOUS', () => {
      const r = parsePackSizeDetailed("Energy Shot 5CTS - 12Pack");
      expect(r.packSize).toBeNull();
      expect(r.counts).toEqual([5, 12]);
    });

    it('"…5CTS - 12Packs" (both plural) is also AMBIGUOUS', () => {
      const r = parsePackSizeDetailed("Energy Shot 5CTS - 12Packs");
      expect(r.packSize).toBeNull();
      expect(r.counts).toEqual([5, 12]);
    });
  });

  describe("count bounds: 1, 0, and > 1000 are rejected", () => {
    it("rejects a count of exactly 1 (not a pack)", () => {
      expect(parsePackSizeDetailed("Widget 1 CT")).toEqual({ packSize: null, counts: [] });
    });

    it("rejects a count of 0", () => {
      expect(parsePackSizeDetailed("Widget 0 CT")).toEqual({ packSize: null, counts: [] });
    });

    it("rejects a count above 1000", () => {
      expect(parsePackSizeDetailed("Widget 1200 CT")).toEqual({ packSize: null, counts: [] });
    });

    it("accepts the boundary values 2 and 1000", () => {
      expect(parsePackSizeDetailed("Widget 2 CT").packSize).toBe(2);
      expect(parsePackSizeDetailed("Widget 1000 CT").packSize).toBe(1000);
    });
  });

  it("returns empty for null, undefined, and blank names", () => {
    expect(parsePackSizeDetailed(null)).toEqual({ packSize: null, counts: [] });
    expect(parsePackSizeDetailed(undefined)).toEqual({ packSize: null, counts: [] });
    expect(parsePackSizeDetailed("")).toEqual({ packSize: null, counts: [] });
  });

  it("returns empty for a name with no count-like token at all", () => {
    expect(parsePackSizeDetailed("Plain Widget")).toEqual({ packSize: null, counts: [] });
  });
});

describe("pack-size — suggestPackSize", () => {
  describe("REFUSAL: PIECE_UNIT never proposes, even with a clean count in the name", () => {
    it.each(["pcs", "pc", "each", "ea", "bottle", "can", "stick", "single", "unit"])(
      'unit "%s" refuses to propose despite an unambiguous count',
      (unit) => {
        const r = suggestPackSize({ name: "Widget 24 CT", unit });
        expect(r.confidence).toBe("PIECE_UNIT");
        expect(r.packSize).toBeNull();
        expect(r.reason).toEqual(expect.any(String));
      },
    );

    it("PIECE_UNIT wins even when the name ALSO looks packish (box-shaped name, piece-shaped unit)", () => {
      const r = suggestPackSize({ name: "Widget Box of 24 CT", unit: "each" });
      expect(r.confidence).toBe("PIECE_UNIT");
      expect(r.packSize).toBeNull();
    });

    it("PIECE_UNIT wins even with a piece-level unitSku present", () => {
      const r = suggestPackSize({ name: "Widget 24 CT", unit: "bottle", unitSku: "SKU-PIECE-1" });
      expect(r.confidence).toBe("PIECE_UNIT");
      expect(r.packSize).toBeNull();
    });
  });

  describe("REFUSAL: AMBIGUOUS — the single most important case", () => {
    it('"…5CT - 12Pack" is AMBIGUOUS with packSize null, never a guessed 5 or 12', () => {
      const r = suggestPackSize({ name: "Energy Shot 5CT - 12Pack", unit: "box" });
      expect(r.confidence).toBe("AMBIGUOUS");
      expect(r.packSize).toBeNull();
      expect(r.packSize).not.toBe(5);
      expect(r.packSize).not.toBe(12);
      expect(r.counts).toEqual([5, 12]);
    });

    it("the reason states the conflict and asks, rather than silently picking one", () => {
      const r = suggestPackSize({ name: "Energy Shot 5CT - 12Pack", unit: "box" });
      expect(r.reason).toMatch(/5/);
      expect(r.reason).toMatch(/12/);
      expect(r.reason).toMatch(/which/i);
    });

    it("stays AMBIGUOUS even with no unit noun at all", () => {
      const r = suggestPackSize({ name: "Energy Shot 5CT - 12Pack" });
      expect(r.confidence).toBe("AMBIGUOUS");
      expect(r.packSize).toBeNull();
    });

    it("stays AMBIGUOUS even with a piece-level unitSku present (unitSku only raises MEDIUM to HIGH, never resolves a conflict)", () => {
      const r = suggestPackSize({
        name: "Energy Shot 5CT - 12Pack",
        unit: "box",
        unitSku: "SKU-1",
      });
      expect(r.confidence).toBe("AMBIGUOUS");
      expect(r.packSize).toBeNull();
    });

    // BLOCKER regression: same nested-packaging name, but the second count
    // uses a PLURAL suffix ("12Packs" not "12Pack"). Before the regex fix
    // this returned confidence: "HIGH", packSize: 5 — a confident single
    // count for a name that actually states two different ones.
    it('"…5CT - 12Packs" (plural suffix on the second count) is AMBIGUOUS, never HIGH/5', () => {
      const r = suggestPackSize({ name: "Energy Shot 5CT - 12Packs", unit: "box" });
      expect(r.confidence).toBe("AMBIGUOUS");
      expect(r.packSize).toBeNull();
      expect(r.packSize).not.toBe(5);
      expect(r.counts).toEqual([5, 12]);
    });
  });

  describe("REFUSAL: measurements produce no proposal", () => {
    it('"5 Hour Energy" produces no count and no proposal', () => {
      const r = suggestPackSize({ name: "5 Hour Energy" });
      expect(r.packSize).toBeNull();
      expect(r.confidence).toBeNull();
      expect(r.reason).toBeNull();
    });

    it('"65MG" produces no count and no proposal', () => {
      const r = suggestPackSize({ name: "Ibuprofen 65MG Tablets" });
      expect(r.packSize).toBeNull();
      expect(r.confidence).toBeNull();
      expect(r.reason).toBeNull();
    });
  });

  describe("confidence ladder: HIGH vs MEDIUM vs LOW, same name where relevant", () => {
    it("HIGH: an explicit count AND a packish unit noun", () => {
      const r = suggestPackSize({ name: "Widget 12 CT", unit: "box" });
      expect(r.confidence).toBe("HIGH");
      expect(r.packSize).toBe(12);
    });

    it("HIGH: an explicit count AND a piece-level unitSku, even without a packish unit noun", () => {
      const r = suggestPackSize({ name: "Widget 12 CT", unit: "gallon", unitSku: "SKU-PIECE-1" });
      expect(r.confidence).toBe("HIGH");
      expect(r.packSize).toBe(12);
    });

    it("MEDIUM: the identical name and count, but no packish unit noun and no unitSku", () => {
      const r = suggestPackSize({ name: "Widget 12 CT", unit: "gallon" });
      expect(r.confidence).toBe("MEDIUM");
      expect(r.packSize).toBe(12);
    });

    it("LOW: a packish unit noun with no count anywhere in the name — never auto-proposed, packSize stays null", () => {
      const r = suggestPackSize({ name: "Widget Case", unit: "case" });
      expect(r.confidence).toBe("LOW");
      expect(r.packSize).toBeNull();
    });

    it("null: neither a count nor a packish unit noun — nothing to go on", () => {
      const r = suggestPackSize({ name: "Plain Widget", unit: "gallon" });
      expect(r.confidence).toBeNull();
      expect(r.packSize).toBeNull();
      expect(r.reason).toBeNull();
    });
  });

  describe("unitsPerBox already set — nothing to suggest", () => {
    it("returns confidence null, packSize null, reason null once unitsPerBox > 1, even for an otherwise HIGH/AMBIGUOUS name", () => {
      const high = suggestPackSize({ name: "Widget 12 CT", unit: "box", unitsPerBox: 12 });
      expect(high).toEqual({ packSize: null, counts: [], confidence: null, reason: null });

      const ambiguous = suggestPackSize({
        name: "Energy Shot 5CT - 12Pack",
        unit: "box",
        unitsPerBox: 6,
      });
      expect(ambiguous).toEqual({ packSize: null, counts: [], confidence: null, reason: null });
    });

    it("unitsPerBox of 1, 0, null, or undefined is treated as unset — still suggests", () => {
      expect(
        suggestPackSize({ name: "Widget 12 CT", unit: "box", unitsPerBox: 1 }).confidence,
      ).toBe("HIGH");
      expect(
        suggestPackSize({ name: "Widget 12 CT", unit: "box", unitsPerBox: 0 }).confidence,
      ).toBe("HIGH");
      expect(
        suggestPackSize({ name: "Widget 12 CT", unit: "box", unitsPerBox: null }).confidence,
      ).toBe("HIGH");
      expect(suggestPackSize({ name: "Widget 12 CT", unit: "box" }).confidence).toBe("HIGH");
    });
  });
});

// ─── REFUSAL: "N PACK(S) OF M" states two counts, only one suffixed ──────────
// Regression guard for a fix that caused a bug. Adding the plural `S?` to the
// count suffix made "2 PACKS OF 12" match where nothing matched before — so a
// name that previously produced a quiet empty ask became a pre-filled one-click
// proposal of 2, which prorates a loose piece at 12x its real price. Both
// numbers are counts; only the first carries a suffix, so the pair must be read
// explicitly or the AMBIGUOUS gate never sees the conflict.
describe("REFUSAL: 'N PACK(S) OF M' nested phrasing", () => {
  it.each([
    ["Bubble Gum 2 PACKS OF 12", [2, 12]],
    ["Gum 12 PACKS OF 5", [12, 5]],
    ["Gum 3 PKS OF 20", [3, 20]],
    ["Soda 4 CASES OF 24", [4, 24]],
    ["Candy 6 BOXES OF 10", [6, 10]],
  ])("%s refuses and surfaces both counts", (name, expected) => {
    const r = parsePackSizeDetailed(name);
    expect(r.packSize).toBeNull();
    expect(r.counts.sort((a, b) => a - b)).toEqual([...expected].sort((a, b) => a - b));
  });

  it("a genuine single count is still confident", () => {
    expect(parsePackSizeDetailed("Bubble Gum 24 PACKS").packSize).toBe(24);
    expect(parsePackSizeDetailed("Bubble Gum 24PK").packSize).toBe(24);
  });
});

// ─── REFUSAL: piece nouns the unit picker actually offers ────────────────────
// PIECE_UNIT originally listed only singular forms of a few nouns, so "bottles",
// "rolls", "sheets", "bags" and friends were classified as ordinary rows and got
// a pre-filled one-click pack size — which divides a piece price by the pack and
// undercharges every sale of that product.
describe("REFUSAL: PIECE_UNIT covers the real unit vocabulary", () => {
  it.each([
    "bottle",
    "bottles",
    "can",
    "cans",
    "stick",
    "sticks",
    "roll",
    "rolls",
    "sheet",
    "sheets",
    "strip",
    "strips",
    "bag",
    "bags",
    "jar",
    "jars",
    "tube",
    "tubes",
    "pouch",
    "pouches",
    "pc",
    "pcs",
    "piece",
    "pieces",
    "ea",
    "each",
    "unit",
    "units",
  ])("unit %s is never offered a pack size", (unit) => {
    const r = suggestPackSize({ name: "Widget 12CT", unit });
    expect(r.confidence).toBe("PIECE_UNIT");
    expect(r.packSize).toBeNull();
  });

  it("a packish unit still proposes", () => {
    expect(suggestPackSize({ name: "Widget 12CT", unit: "case" }).packSize).toBe(12);
  });
});
