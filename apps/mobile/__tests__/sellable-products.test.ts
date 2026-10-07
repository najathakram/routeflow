import { isFamilyProduct, sellableCatalogRows } from "../lib/sellable-products";

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

describe("sellableCatalogRows dedupe prefers the OUTER row", () => {
  type R = Row & { thumbnailUrl?: string; barcodes?: string[] };
  const outerV1: R = { ...v1, thumbnailUrl: "t.png", barcodes: ["111"] };
  it("keeps the outer variant (thumbnail + barcodes) over the nested copy, family listed first", () => {
    const fam: R = { ...family, variants: [v1, v2] };
    const out = sellableCatalogRows<R>([fam, outerV1]);
    const got = out.find((r) => r.id === "v1")!;
    expect(got.thumbnailUrl).toBe("t.png");
    expect(got.barcodes).toEqual(["111"]);
    expect(got.parent).toEqual({ id: "f1", name: "Soda" });
    expect(out.filter((r) => r.id === "v1")).toHaveLength(1);
  });
  it("keeps the outer variant when it is listed before its family", () => {
    const out = sellableCatalogRows<R>([outerV1, family]);
    expect(out.find((r) => r.id === "v1")!.thumbnailUrl).toBe("t.png");
    expect(out.map((r) => r.id).sort()).toEqual(["v1", "v2"]);
  });
});

describe("isFamilyProduct", () => {
  it("is true only for a FAMILY container", () => {
    expect(isFamilyProduct(family)).toBe(true);
    expect(isFamilyProduct(v1)).toBe(false);
    expect(isFamilyProduct(plain)).toBe(false);
    expect(isFamilyProduct(null)).toBe(false);
  });
});
