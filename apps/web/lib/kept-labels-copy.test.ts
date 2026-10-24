import { keptLabelsNote, keptLabelsNoteForBulk } from "./kept-labels-copy";

describe("keptLabelsNote (H2: a reparent keeps the labels the variant carried)", () => {
  it("is null when nothing was kept (absent, undefined or empty)", () => {
    expect(keptLabelsNote(undefined)).toBeNull();
    expect(keptLabelsNote(null)).toBeNull();
    expect(keptLabelsNote([])).toBeNull();
  });
  it("is fixed copy around the label names", () => {
    expect(keptLabelsNote(["CA ban"])).toBe('Kept the label "CA ban" on this product.');
    expect(keptLabelsNote(["CA ban", "NY ban"])).toBe(
      'Kept the labels "CA ban", "NY ban" on this product.',
    );
  });
  it("bulk: counts the products that kept labels", () => {
    expect(keptLabelsNoteForBulk(undefined)).toBeNull();
    expect(keptLabelsNoteForBulk([])).toBeNull();
    expect(keptLabelsNoteForBulk([{ id: "a", labels: ["CA ban"] }])).toBe(
      "1 product kept a label it had through its old parent.",
    );
    expect(
      keptLabelsNoteForBulk([
        { id: "a", labels: ["CA ban"] },
        { id: "b", labels: ["CA ban", "NY ban"] },
      ]),
    ).toBe("2 products kept labels they had through their old parent.");
  });
});
