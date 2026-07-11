/**
 * Every cart line must keep a visible row in the builder pick lists: a
 * scanned product outside the current category/page would otherwise live
 * only in the totals + cart sheet ("the item disappeared").
 */
import { withCartRows } from "../lib/visible-cart";

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
