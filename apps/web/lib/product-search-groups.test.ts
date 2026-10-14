import {
  groupOffered,
  groupRowPick,
  groupSearchRows,
  isFamilyProduct,
  isGroupExpanded,
  pickerProductName,
  sellableFlat,
  sellableOnly,
} from "./product-search-groups";

interface Row {
  id: string;
  name: string;
  kind?: string;
  variantName?: string;
  parentProductId?: string | null;
  parent?: { id: string; name: string; kind?: string } | null;
  variants?: Row[];
}

const family = (id: string, name: string, variants: Row[] = []): Row => ({
  id,
  name,
  kind: "FAMILY",
  parentProductId: null,
  variants,
});
const variant = (id: string, parentId: string, parentName: string, flavor: string): Row => ({
  id,
  name: flavor,
  kind: "VARIANT",
  variantName: flavor,
  parentProductId: parentId,
  parent: { id: parentId, name: parentName },
});

describe("groupSearchRows (B1215 C6)", () => {
  it("re-attaches the parent of a variant-only hit and expands it", () => {
    const hit = variant("v1", "f1", "Sample Pod", "Strawberry");
    const { rows, expandedIds } = groupSearchRows([hit]);
    expect(rows.map((r) => r.id)).toEqual(["f1"]);
    expect(rows[0].name).toBe("Sample Pod");
    expect(rows[0].variants?.map((v) => v.id)).toEqual(["v1"]);
    expect(expandedIds.has("f1")).toBe(true);
  });

  it("keeps the real kind of a re-attached parent that is not a FAMILY", () => {
    const hit: Row = {
      ...variant("v1", "s1", "Sample Std", "Strawberry"),
      parent: { id: "s1", name: "Sample Std", kind: "STANDARD" },
    };
    const { rows } = groupSearchRows([hit]);
    expect(rows[0].id).toBe("s1");
    expect(rows[0].kind).toBe("STANDARD");
  });

  it("merges several matching variants of one missing parent into one group", () => {
    const { rows } = groupSearchRows([
      variant("v1", "f1", "Sample Pod", "Strawberry"),
      variant("v2", "f1", "Sample Pod", "Strawberry Kiwi"),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].variants?.map((v) => v.id)).toEqual(["v1", "v2"]);
  });

  it("keeps a matched parent collapsed with its own nested variants", () => {
    const v1 = variant("v1", "f1", "Sample Pod", "Strawberry");
    const { rows, expandedIds } = groupSearchRows([family("f1", "Sample Pod", [v1])]);
    expect(rows.map((r) => r.id)).toEqual(["f1"]);
    expect(expandedIds.size).toBe(0);
  });

  it("does not duplicate a variant that arrives both nested and as its own row", () => {
    const v1 = variant("v1", "f1", "Sample Pod", "Strawberry");
    const { rows } = groupSearchRows([family("f1", "Sample Pod", [v1]), v1]);
    expect(rows).toHaveLength(1);
    expect(rows[0].variants).toHaveLength(1);
  });

  it("passes standalone products through untouched and in order", () => {
    const a = { id: "a", name: "Sample Cola", kind: "STANDARD" };
    const b = { id: "b", name: "Sample Chips", kind: "STANDARD" };
    expect(groupSearchRows([a, b]).rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("drops a FAMILY with nothing selectable under it (C7)", () => {
    expect(groupSearchRows([family("f9", "Empty Family")]).rows).toEqual([]);
  });

  it("leaves a variant with no parent info selectable on its own", () => {
    const orphan = { id: "v7", name: "Mint", kind: "VARIANT", parentProductId: "gone" };
    expect(groupSearchRows([orphan]).rows.map((r) => r.id)).toEqual(["v7"]);
  });
});

describe("family guard and labels", () => {
  it("isFamilyProduct / sellableOnly never let a FAMILY through", () => {
    expect(isFamilyProduct({ kind: "FAMILY" })).toBe(true);
    expect(isFamilyProduct({ kind: "VARIANT" })).toBe(false);
    expect(isFamilyProduct(undefined)).toBe(false);
    const rows = [{ id: "1", kind: "FAMILY" }, { id: "2", kind: "STANDARD" }, { id: "3" }];
    expect(sellableOnly(rows).map((r) => r.id)).toEqual(["2", "3"]);
  });

  it("isGroupExpanded: operator toggle wins, else auto-expanded", () => {
    const auto = new Set(["f1"]);
    expect(isGroupExpanded(null, auto, "f1")).toBe(true);
    expect(isGroupExpanded(null, auto, "f2")).toBe(false);
    expect(isGroupExpanded("", auto, "f1")).toBe(false); // operator closed it
    expect(isGroupExpanded("f2", auto, "f2")).toBe(true);
  });

  it("pickerProductName composes <Parent> - <Variant>", () => {
    expect(pickerProductName(variant("v1", "f1", "Sample Pod", "Strawberry"))).toBe(
      "Sample Pod - Strawberry",
    );
    expect(pickerProductName({ id: "a", name: "Sample Cola" })).toBe("Sample Cola");
  });
});

describe("sellableFlat (typeahead lists, C7)", () => {
  it("lists a family's variants under the parent name and never the family", () => {
    const v1 = {
      id: "v1",
      name: "Mint",
      kind: "VARIANT",
      variantName: "Mint",
      parentProductId: "f1",
    };
    const out = sellableFlat([family("f1", "Sample Pod", [v1]), { id: "a", name: "Cola" }]);
    expect(out.map((r) => r.id)).toEqual(["v1", "a"]);
    expect(pickerProductName(out[0])).toBe("Sample Pod - Mint");
  });

  it("de-duplicates a variant that is both nested and its own row", () => {
    const v1 = variant("v1", "f1", "Sample Pod", "Mint");
    expect(sellableFlat([family("f1", "Sample Pod", [v1]), v1]).map((r) => r.id)).toEqual(["v1"]);
  });
});

describe("row 503 groupRowPick / groupOffered", () => {
  const fam = {
    id: "f",
    name: "Pod",
    kind: "FAMILY",
    parentProductId: null,
    variants: [
      { id: "v1", name: "Mint", kind: "VARIANT", parentProductId: "f" },
      { id: "v2", name: "Lime", kind: "VARIANT", parentProductId: "f" },
    ],
  };
  const parent = { ...fam, id: "p", name: "Bar", kind: "STANDARD" };
  const plain = { id: "s", name: "Water", parentProductId: null };

  it("a FAMILY row stands for its first variant, named under it; any other row for itself", () => {
    expect(groupRowPick<any>(fam)).toMatchObject({ id: "v1", parent: { id: "f", name: "Pod" } });
    expect(groupRowPick<any>(parent)!.id).toBe("p");
    expect(groupRowPick<any>(plain)!.id).toBe("s");
    expect(groupRowPick<any>({ ...fam, variants: [] })).toBeUndefined();
    expect(groupRowPick<any>(undefined)).toBeUndefined();
  });

  it("offers every sellable row and its variants in display order, never a FAMILY", () => {
    expect(groupOffered<any>([fam, parent, plain]).map((p) => p.id)).toEqual([
      "v1",
      "v2",
      "p",
      "v1",
      "v2",
      "s",
    ]);
  });
});
