import {
  nextProductPage,
  productSearchEnabled,
  productSearchParams,
} from "../lib/product-search-params";

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

  it("REG-LC01: emits scanCode (not search) for a scan-shaped term", () => {
    // A wedge scan or typed barcode decodes to a digit-only string >= 8
    // chars (looksLikeScanCode). The server treats `search` and `scanCode`
    // as mutually exclusive and expands `scanCode` via normalizeScanCode so
    // an iOS 13-digit decode still matches a 12-digit stored UPC-A — a plain
    // ILIKE on `search` cannot do that.
    expect(productSearchParams({ term: "012345678905", category: "Snacks" })).toEqual({
      scanCode: "012345678905",
      category: undefined,
    });
  });

  it("REG-LC01: emits search (not scanCode) for a product-name term", () => {
    expect(productSearchParams({ term: "coca cola", category: "Snacks" })).toEqual({
      search: "coca cola",
      category: undefined,
    });
  });

  it("REG-LC01: category is dropped the same way for both the scanCode and search branches", () => {
    // Same rule, both branches: a live term (scan-shaped or not) always
    // drops the category, because the chip row is hidden while searching.
    const scanResult = productSearchParams({ term: "012345678905", category: "Snacks" });
    const searchResult = productSearchParams({ term: "coca cola", category: "Snacks" });
    expect(scanResult.category).toBeUndefined();
    expect(searchResult.category).toBeUndefined();
  });
});

describe("productSearchEnabled", () => {
  it("REG-LC02: false when nothing has been asked for", () => {
    expect(productSearchEnabled({})).toBe(false);
  });

  it("REG-LC02: true once a non-empty trimmed term is present", () => {
    expect(productSearchEnabled({ term: "cok" })).toBe(true);
  });

  it("REG-LC02: a whitespace-only term is not a term", () => {
    expect(productSearchEnabled({ term: "   " })).toBe(false);
  });

  it("REG-LC02: true while browsing, even with no term", () => {
    expect(productSearchEnabled({ browsing: true })).toBe(true);
  });

  it("REG-LC02: enabled:false is a hard veto over a live term", () => {
    expect(productSearchEnabled({ term: "cok", enabled: false })).toBe(false);
  });

  it("REG-LC02: enabled:false is a hard veto over browsing", () => {
    expect(productSearchEnabled({ browsing: true, enabled: false })).toBe(false);
  });

  it("REG-LC02: enabled:true alone never forces a fetch", () => {
    // This is what stops recurring-invoices' `enabled: open` from
    // re-opening the old "fetch as soon as the picker mounts" behaviour.
    expect(productSearchEnabled({ enabled: true })).toBe(false);
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
