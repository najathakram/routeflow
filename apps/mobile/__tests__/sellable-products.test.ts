import { sellableCatalogRows } from "../lib/sellable-products";

type Row = {
  id: string;
  name: string;
  kind?: "STANDARD" | "FAMILY" | "VARIANT" | "RECIPE";
  parentProductId?: string | null;
  variantName?: string | null;
  parent?: { id: string; name: string } | null;
  variants?: Row[] | null;
};

const plain: Row = { id: "p1", name: "Chips", kind: "STANDARD" };
const v1: Row = {
  id: "v1",
  name: "Grape",
  kind: "VARIANT",
  parentProductId: "f1",
  variantName: "Grape",
};
const v2: Row = {
  id: "v2",
  name: "Orange",
  kind: "VARIANT",
  parentProductId: "f1",
  variantName: "Orange",
};
const family: Row = { id: "f1", name: "Soda", kind: "FAMILY", variants: [v1, v2] };

describe("sellableCatalogRows", () => {
  it("never returns a FAMILY container as a row", () => {
    const out = sellableCatalogRows<Row>([family]);
    expect(out.some((r) => r.id === "f1")).toBe(false);
  });

  it("expands a family into its variants, carrying the parent for display names", () => {
    const out = sellableCatalogRows<Row>([family]);
    expect(out.map((r) => r.id)).toEqual(["v1", "v2"]);
    expect(out[0]!.parent).toEqual({ id: "f1", name: "Soda" });
  });

  it("leaves a plain product unchanged (same object)", () => {
    const out = sellableCatalogRows<Row>([plain]);
    expect(out).toEqual([plain]);
    expect(out[0]).toBe(plain);
  });

  it("does not duplicate a variant that also arrives as its own flat row", () => {
    const out = sellableCatalogRows<Row>([family, v1, plain]);
    expect(out.map((r) => r.id)).toEqual(["v1", "v2", "p1"]);
  });

  it("drops a family with no variants (nothing sellable)", () => {
    expect(sellableCatalogRows<Row>([{ id: "f2", name: "Empty", kind: "FAMILY" }])).toEqual([]);
  });

  it("keeps a flat variant row whose family was not in the page", () => {
    expect(sellableCatalogRows<Row>([v1]).map((r) => r.id)).toEqual(["v1"]);
  });
});
