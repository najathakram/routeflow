import { nextProductPage, productSearchParams } from "../lib/product-search-params";

describe("productSearchParams", () => {
  it("keeps the category while browsing", () => {
    expect(productSearchParams({ term: "", category: "Snacks" })).toEqual({
      search: undefined,
      category: "Snacks",
    });
  });

  it("DROPS the category once a search term is live", () => {
    // The regression guard for the rule this move to server-side filtering
    // could silently lose: the chip row is hidden while searching, so a
    // category left applied would narrow results behind an invisible control.
    expect(productSearchParams({ term: "coke", category: "Snacks" })).toEqual({
      search: "coke",
      category: undefined,
    });
  });

  it('treats "All" as no category', () => {
    expect(productSearchParams({ term: "", category: "All" }).category).toBeUndefined();
  });

  it("treats a whitespace-only term as no term", () => {
    expect(productSearchParams({ term: "   ", category: "Snacks" })).toEqual({
      search: undefined,
      category: "Snacks",
    });
  });

  it("handles a missing category", () => {
    expect(productSearchParams({ term: "coke" })).toEqual({
      search: "coke",
      category: undefined,
    });
  });
});

describe("nextProductPage", () => {
  it("advances while pages remain", () => {
    expect(nextProductPage({ total: 120, page: 1, limit: 50, totalPages: 3 })).toBe(2);
  });

  it("stops on the last page", () => {
    expect(nextProductPage({ total: 120, page: 3, limit: 50, totalPages: 3 })).toBeUndefined();
  });

  it("stops on an empty result set", () => {
    expect(nextProductPage({ total: 0, page: 1, limit: 50, totalPages: 0 })).toBeUndefined();
  });

  it("stops on missing or malformed meta rather than looping", () => {
    expect(nextProductPage(undefined)).toBeUndefined();
    expect(
      nextProductPage({ total: 1, page: NaN, limit: 50, totalPages: 3 } as any),
    ).toBeUndefined();
  });
});
