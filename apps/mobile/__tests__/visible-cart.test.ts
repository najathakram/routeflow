/**
 * Every cart line must keep a visible row in the builder pick lists: a
 * scanned product outside the current category/page would otherwise live
 * only in the totals + cart sheet ("the item disappeared").
 */
import {
  isCatalogHeader,
  partitionCatalog,
  visibleCatalogRows,
  withCartRows,
} from "../lib/visible-cart";

type P = { id: string; name: string };
const catalog: P[] = [
  { id: "a", name: "Apples" },
  { id: "b", name: "Bananas" },
];
const known = new Map<string, P>([
  ...catalog.map((p) => [p.id, p] as const),
  ["z", { id: "z", name: "Zucchini (scanned)" }],
]);
const lookup = (id: string) => known.get(id);

describe("withCartRows", () => {
  it("returns the base list untouched when every cart line is already visible", () => {
    const out = withCartRows(catalog, ["a"], lookup);
    expect(out).toBe(catalog); // same reference — no re-render churn
  });

  it("pins a cart line missing from the base list above it", () => {
    const out = withCartRows(catalog, ["z"], lookup);
    expect(out.map((p) => p.id)).toEqual(["z", "a", "b"]);
  });

  it("never duplicates a row that is both in the cart and the base list", () => {
    const out = withCartRows(catalog, ["a", "z"], lookup);
    expect(out.map((p) => p.id)).toEqual(["z", "a", "b"]);
  });

  it("skips cart ids the lookup cannot resolve (product still loading)", () => {
    const out = withCartRows(catalog, ["missing"], lookup);
    expect(out).toBe(catalog);
  });

  it("keeps cart order for multiple pinned rows and works on an empty base", () => {
    const known2 = new Map<string, P>([
      ["z", { id: "z", name: "Z" }],
      ["y", { id: "y", name: "Y" }],
    ]);
    const out = withCartRows<P>([], ["z", "y"], (id) => known2.get(id));
    expect(out.map((p) => p.id)).toEqual(["z", "y"]);
  });
});

describe("partitionCatalog (on-this-order top section)", () => {
  const P = (id: string) => ({ id, name: id });
  const base = [P("a"), P("b"), P("c"), P("d")];
  const lookup = (id: string) => (id === "z" ? P("z") : undefined);

  it("returns the plain list when nothing is on the order (no labels)", () => {
    expect(partitionCatalog(base, [], lookup)).toEqual(base);
  });

  it("floats on-order items to a labeled top section, catalogue-relative order", () => {
    const rows = partitionCatalog(base, ["c", "a"], lookup);
    expect(rows).toEqual([
      { __header: "on-order", label: "On this order (2)" },
      P("a"),
      P("c"),
      { __header: "catalogue", label: "Catalogue" },
      P("b"),
      P("d"),
    ]);
  });

  it("appends off-page cart snapshots to the top section", () => {
    const rows = partitionCatalog(base, ["z", "b"], lookup);
    expect(rows[0]).toEqual({ __header: "on-order", label: "On this order (2)" });
    expect(rows.slice(1, 3)).toEqual([P("b"), P("z")]);
  });

  it("drops unknown cart ids that cannot be looked up", () => {
    const rows = partitionCatalog(base, ["ghost"], lookup);
    expect(rows).toEqual(base);
  });

  it("isCatalogHeader discriminates header rows", () => {
    expect(isCatalogHeader({ __header: "on-order", label: "x" })).toBe(true);
    expect(isCatalogHeader(P("a"))).toBe(false);
  });
});

// ── Quiet catalogue (PR-2) ───────────────────────────────────────────────────
// The owner's report: scanning an item dumped the operator back on the FULL
// product list, because accepting a scan clears the search box.

describe("visibleCatalogRows", () => {
  const catalog = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const lookup = (id: string) => catalog.find((p) => p.id === id);
  const call = (over: Partial<Parameters<typeof visibleCatalogRows>[0]> = {}) =>
    visibleCatalogRows({
      base: catalog,
      cartIds: [],
      lookup,
      browsing: false,
      searchTerm: "",
      ...over,
    });

  it("searching shows flat results and hides browse affordances", () => {
    const v = call({ searchTerm: "coke" });
    expect(v.rows).toEqual(catalog);
    expect(v.showBrowseButton).toBe(false);
    expect(v.showCategoryChips).toBe(false);
    expect(v.emptyHint).toBeUndefined();
  });

  it("quiet with a cart shows ONLY the order — not the whole catalogue", () => {
    const v = call({ cartIds: ["b"] });
    const ids = v.rows.filter((r) => !isCatalogHeader(r)).map((r) => (r as { id: string }).id);
    expect(ids).toEqual(["b"]);
    expect(v.rows.some((r) => isCatalogHeader(r) && r.__header === "catalogue")).toBe(false);
    expect(v.showBrowseButton).toBe(true);
    expect(v.emptyHint).toBeUndefined();
  });

  it("quiet with an empty cart renders nothing but a hint and the way in", () => {
    const v = call();
    expect(v.rows).toEqual([]);
    expect(v.showBrowseButton).toBe(true);
    expect(v.emptyHint).toMatch(/scan, search, or browse/i);
  });

  it("browsing restores the sectioned catalogue and the category chips", () => {
    const v = call({ cartIds: ["b"], browsing: true });
    expect(v.rows).toEqual(partitionCatalog(catalog, ["b"], lookup));
    expect(v.showCategoryChips).toBe(true);
    expect(v.showBrowseButton).toBe(false);
  });

  it("keeps a row in the same position whether or not browse is open", () => {
    const quiet = call({ cartIds: ["b"] });
    const browsing = call({ cartIds: ["b"], browsing: true });
    const firstOf = (rows: ReturnType<typeof call>["rows"]) =>
      rows.filter((r) => !isCatalogHeader(r)).map((r) => (r as { id: string }).id)[0];
    expect(firstOf(quiet.rows)).toBe(firstOf(browsing.rows));
  });

  it("search wins over browse — a filtered list is never re-sectioned", () => {
    const v = call({ cartIds: ["b"], browsing: true, searchTerm: "co" });
    expect(v.rows).toEqual(catalog);
    expect(v.showCategoryChips).toBe(false);
  });
});
