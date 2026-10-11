import { formatQtySplit } from "./pricing";
import { pillLabel, plural, unitWords } from "./unit-words";

describe("plural", () => {
  it("returns the singular only for exactly 1", () => {
    expect(plural("Box", 1)).toBe("Box");
    expect(plural("Box", 0)).toBe("Boxes");
    expect(plural("Box", 2)).toBe("Boxes");
  });
  it.each([
    ["Box", "Boxes"],
    ["Pouch", "Pouches"],
    ["Dish", "Dishes"],
    ["Buzz", "Buzzes"],
    ["Battery", "Batteries"],
    ["Tray", "Trays"],
    ["Bottle", "Bottles"],
    ["Case", "Cases"],
    ["Piece", "Pieces"],
  ])("pluralises %s -> %s", (one, many) => {
    expect(plural(one, 2)).toBe(many);
  });
  it.each([
    "Cases",
    "Dozen",
    "dozen",
    "Gross",
    "kg",
    "g",
    "lb",
    "oz",
    "l",
    "ml",
    "ft",
    "m",
    "cm",
    "mm",
  ])("leaves %s unchanged", (w) => {
    expect(plural(w, 0)).toBe(w);
    expect(plural(w, 2)).toBe(w);
  });
  it("never doubles the s of an already plural label", () => {
    expect(plural("Cases", 2)).not.toBe("Casess");
  });
  it("trims whitespace", () => {
    expect(plural("  Tray ", 2)).toBe("Trays");
  });
});

describe("unitWords defaults", () => {
  const d = {
    pack: { one: "Box", other: "Boxes", lower: "box", lowerOther: "boxes" },
    base: { one: "Piece", other: "Pieces", lower: "piece", lowerOther: "pieces" },
  };
  it("matches the VU-1 words with no input", () => {
    const w = unitWords({});
    expect(w).toMatchObject(d);
    expect(w.base.short).toEqual({ one: "pc", other: "pcs" });
    expect(w.isDefaultPack).toBe(true);
    expect(w.isDefaultBase).toBe(true);
  });
  it("treats null, blank and whitespace as defaults", () => {
    for (const v of [null, undefined, "", "   "]) {
      const w = unitWords({ packLabel: v, baseUnitLabel: v });
      expect(JSON.stringify(w)).toBe(JSON.stringify(unitWords({})));
    }
    expect(JSON.stringify(unitWords())).toBe(JSON.stringify(unitWords({})));
  });
  it("ignores the product unit for the pack word in U-3a", () => {
    expect(unitWords({ unit: "case" }).pack.one).toBe("Box");
  });
});

describe("unitWords custom labels", () => {
  it.each([
    ["Bottle", "Bottles", "bottle", "bottles"],
    ["Case", "Cases", "case", "cases"],
    ["Cases", "Cases", "cases", "cases"],
    ["Dozen", "Dozen", "dozen", "dozen"],
    ["kg", "kg", "kg", "kg"],
  ])("pack %s", (label, other, lower, lowerOther) => {
    const w = unitWords({ packLabel: label });
    expect(w.pack.one).toBe(label);
    expect(w.pack.other).toBe(other);
    expect(w.pack.lower).toBe(lower);
    expect(w.pack.lowerOther).toBe(lowerOther);
    expect(w.isDefaultPack).toBe(false);
    expect(w.isDefaultBase).toBe(true);
  });
  it("custom base shows its full words, not pc/pcs", () => {
    const w = unitWords({ baseUnitLabel: "Bottle" });
    expect(w.base.short).toEqual({ one: "bottle", other: "bottles" });
    expect(w.base.lower).toBe("bottle");
    expect(w.isDefaultBase).toBe(false);
  });
  it("counts 0/1/2 via count helpers", () => {
    const w = unitWords({ packLabel: "Bottle", baseUnitLabel: "Tray" });
    expect([0, 1, 2].map((n) => w.packFor(n))).toEqual(["bottles", "bottle", "bottles"]);
    expect([0, 1, 2].map((n) => w.baseFor(n))).toEqual(["trays", "tray", "trays"]);
    expect([0, 1, 2].map((n) => w.baseShortFor(n))).toEqual(["trays", "tray", "trays"]);
  });
  it("default short only for the default base, exactly 1 is pc", () => {
    const w = unitWords({});
    expect([0, 1, 2].map((n) => w.baseShortFor(n))).toEqual(["pcs", "pc", "pcs"]);
    expect([0, 1, 2].map((n) => w.baseFor(n))).toEqual(["pieces", "piece", "pieces"]);
    expect([0, 1, 2].map((n) => w.packFor(n))).toEqual(["boxes", "box", "boxes"]);
  });
});

describe("formatQtySplit keeps its own (old) plural rule until U-5", () => {
  it("box -> boxes, a custom label just gets an s, never doubles it", () => {
    expect(formatQtySplit({ qty: 25, boxes: 2, pieces: 1 })).toBe("2 boxes + 1 pcs");
    expect(formatQtySplit({ qty: 25, boxes: 2, pieces: 1, boxLabel: "Cases" })).toBe(
      "2 Cases + 1 pcs",
    );
    expect(formatQtySplit({ qty: 25, boxes: 2, pieces: 1, boxLabel: "Case" })).toBe(
      "2 Cases + 1 pcs",
    );
    expect(formatQtySplit({ qty: 5, boxes: 2, pieces: 0, boxLabel: "Battery" })).toBe("2 Batterys");
  });
});

describe("pillLabel", () => {
  it("shows up to 12 characters whole", () => {
    expect(pillLabel("Box")).toBe("Box");
    expect(pillLabel("Twelve chars")).toBe("Twelve chars");
  });
  it("cuts a longer label to its first 11 characters plus a dot", () => {
    expect(pillLabel("Shrinkwrapped tray")).toBe("Shrinkwrapp.");
    expect(pillLabel("Thirteen char")).toBe("Thirteen ch.");
  });
});
