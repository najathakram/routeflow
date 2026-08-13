/**
 * Every cart line must keep a visible row in the builder pick lists: a
 * scanned product outside the current category/page would otherwise live
 * only in the totals + cart sheet ("the item disappeared").
 */
import { isCatalogHeader, partitionCatalog, withCartRows } from "../lib/visible-cart";

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
