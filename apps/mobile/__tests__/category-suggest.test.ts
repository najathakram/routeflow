import { filterCategorySuggestions } from "../lib/category-suggest";

const CATEGORIES = ["Bakery", "Beverages", "Dairy", "Drinks", "Frozen", "Produce", "Snacks"];

describe("filterCategorySuggestions", () => {
  it("matches case-insensitively by substring", () => {
    expect(filterCategorySuggestions(CATEGORIES, "dr")).toEqual(["Drinks"]);
    expect(filterCategorySuggestions(CATEGORIES, "AKER")).toEqual(["Bakery"]);
  });

  it("returns everything (capped) for an empty query", () => {
    expect(filterCategorySuggestions(CATEGORIES, "")).toEqual(CATEGORIES);
    expect(filterCategorySuggestions(CATEGORIES, "   ")).toEqual(CATEGORIES);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 20 }, (_, i) => `Cat ${i}`);
    expect(filterCategorySuggestions(many, "cat")).toHaveLength(8);
    expect(filterCategorySuggestions(many, "cat", 3)).toHaveLength(3);
  });

  it("hides an exact match — the field already holds it", () => {
    expect(filterCategorySuggestions(CATEGORIES, "Drinks")).toEqual([]);
    expect(filterCategorySuggestions(CATEGORIES, "drinks")).toEqual([]);
  });

  it("tolerates an undefined list (query still loading)", () => {
    expect(filterCategorySuggestions(undefined, "ba")).toEqual([]);
  });
});
