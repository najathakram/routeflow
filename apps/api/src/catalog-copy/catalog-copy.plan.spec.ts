import {
  isRegulatedSource,
  planCatalogCopy,
  type SourceProduct,
  type TargetCatalog,
} from "./catalog-copy.plan";

/** SA-1027 rules 3, 4, 6, 7: the pure decisions. Source and target data are `acme`-style placeholders. */
let seq = 0;
function src(over: Partial<SourceProduct> = {}): SourceProduct {
  seq += 1;
  return {
    id: `s${seq}`,
    name: `Item ${seq}`,
    sku: `SKU-${seq}`,
    unitSku: null,
    barcode: null,
    parentProductId: null,
    variantName: null,
    isTobacco: false,
    trackedCategoryId: null,
    trackedSubcategoryId: null,
    regItemType: null,
    regUomCase: null,
    regUomUnit: null,
    imageKeys: [],
    levelBarcodes: [],
    hasLadder: false,
    ...over,
  };
}
const target = (over: Partial<TargetCatalog> = {}): TargetCatalog => ({
  products: [],
  levelBarcodes: [],
  unitsV1: true,
  ...over,
});
const tp = (over: Partial<TargetCatalog["products"][number]>) => ({
  name: "Existing",
  sku: null,
  unitSku: null,
  barcode: null,
  parentProductId: null,
  ...over,
});
const createdIds = (plan: ReturnType<typeof planCatalogCopy>) =>
  plan.create.flatMap((f) => f.members.map((m) => m.sourceId));

describe("isRegulatedSource (SA-1027 rule 6, fail closed)", () => {
  it("is false for a plain product", () => {
    expect(isRegulatedSource(src())).toBe(false);
  });
  it.each([
    ["isTobacco", { isTobacco: true }],
    ["trackedCategoryId", { trackedCategoryId: "c1" }],
    ["trackedSubcategoryId", { trackedSubcategoryId: "c2" }],
    ["regItemType", { regItemType: "CIG" }],
    ["regUomCase", { regUomCase: "CASE" }],
    ["regUomUnit", { regUomUnit: "PACK" }],
  ])("is true when %s is set", (_n, over) => {
    expect(isRegulatedSource(src(over as Partial<SourceProduct>))).toBe(true);
  });
  it("counts an unreadable row (a field is undefined) as regulated", () => {
    expect(
      isRegulatedSource({ ...src(), regItemType: undefined } as unknown as SourceProduct),
    ).toBe(true);
    expect(isRegulatedSource(null as unknown as SourceProduct)).toBe(true);
  });
});

describe("planCatalogCopy", () => {
  it("creates a product the target lacks and counts its photos", () => {
    const a = src({ imageKeys: ["products/s/1.jpg", "products/s/2.jpg"] });
    const plan = planCatalogCopy([a], target());
    expect(createdIds(plan)).toEqual([a.id]);
    expect(plan.photos).toBe(2);
  });

  it("C-G1: a source SKU that is a target unitSku is skipped and listed", () => {
    const a = src({ sku: "X-100" });
    const plan = planCatalogCopy([a], target({ products: [tp({ unitSku: "X-100" })] }));
    expect(createdIds(plan)).toEqual([]);
    expect(plan.skippedBySku.map((s) => s.sourceId)).toEqual([a.id]);
  });

  it("a same-SKU product is skipped (the idempotent re-run)", () => {
    const a = src({ sku: "X-200" });
    const plan = planCatalogCopy([a], target({ products: [tp({ sku: "X-200" })] }));
    expect(createdIds(plan)).toEqual([]);
  });

  it("a product with no SKU is matched by active name, and listed as skipped by name", () => {
    const a = src({ sku: null, name: "Plain Widget" });
    const plan = planCatalogCopy([a], target({ products: [tp({ name: "Plain Widget" })] }));
    expect(createdIds(plan)).toEqual([]);
    expect(plan.skippedByName.map((s) => s.sourceId)).toEqual([a.id]);
  });

  it("C-G2: a family whose parent SKU exists in the target is skipped whole, no variant created", () => {
    const parent = src({ sku: "FAM-1" });
    const v1 = src({ parentProductId: parent.id, variantName: "Red", sku: "FAM-1-R" });
    const v2 = src({ parentProductId: parent.id, variantName: "Blue", sku: "FAM-1-B" });
    const plan = planCatalogCopy([parent, v1, v2], target({ products: [tp({ sku: "FAM-1" })] }));
    expect(createdIds(plan)).toEqual([]);
    expect(plan.skippedBySku.map((s) => s.sourceId)).toContain(parent.id);
  });

  it("a new family is created root first, and a variant whose SKU clashes is skipped and listed", () => {
    const parent = src({ sku: "FAM-2" });
    const ok = src({ parentProductId: parent.id, variantName: "Red", sku: "FAM-2-R" });
    const clash = src({ parentProductId: parent.id, variantName: "Blue", sku: "TAKEN" });
    const plan = planCatalogCopy([clash, ok, parent], target({ products: [tp({ sku: "TAKEN" })] }));
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0].members.map((m) => m.sourceId)).toEqual([parent.id, ok.id]);
    expect(plan.variantsSkipped.map((s) => s.sourceId)).toEqual([clash.id]);
  });

  it("C-G3: a target without flag.units_v1 gets a laddered product pack-only, and the dry run lists it", () => {
    const a = src({ hasLadder: true });
    const off = planCatalogCopy([a], target({ unitsV1: false }));
    expect(off.packOnly).toEqual([a.id]);
    expect(off.create[0].members[0].packOnly).toBe(true);
    const on = planCatalogCopy([a], target({ unitsV1: true }));
    expect(on.packOnly).toEqual([]);
    expect(on.create[0].members[0].packOnly).toBe(false);
  });

  it("C-G10: a family with one tobacco variant is left out whole with every member listed; a lone regItemType product too", () => {
    const parent = src();
    const v1 = src({ parentProductId: parent.id, variantName: "A" });
    const v2 = src({ parentProductId: parent.id, variantName: "B", isTobacco: true });
    const lone = src({ regItemType: "VAPE" });
    const plain = src();
    const plan = planCatalogCopy([parent, v1, v2, lone, plain], target());
    expect(createdIds(plan)).toEqual([plain.id]);
    expect(plan.regulated.map((r) => r.sourceId).sort()).toEqual(
      [parent.id, v1.id, v2.id, lone.id].sort(),
    );
  });

  it("C-G11: a barcode held as a target unitSku and a level barcode the target holds are dropped, the rest copy", () => {
    const a = src({
      barcode: "111",
      unitSku: "U-1",
      levelBarcodes: [
        { code: "222", level: "CASE" },
        { code: "333", level: "UNIT" },
      ],
    });
    const plan = planCatalogCopy(
      [a],
      target({
        products: [tp({ unitSku: "111" })],
        levelBarcodes: [{ code: "222", level: "CASE" }],
      }),
    );
    const m = plan.create[0].members[0];
    expect(m.dropBarcode).toBe(true);
    expect(m.dropUnitSku).toBe(false);
    expect(m.droppedLevels).toEqual([{ code: "222", level: "CASE" }]);
    expect(plan.codesDropped.map((c) => `${c.kind}:${c.code}`).sort()).toEqual([
      "barcode:111",
      "levelBarcode:222",
    ]);
  });

  it("a unitSku the target holds as a sku, barcode or unitSku is dropped", () => {
    for (const held of [{ sku: "U-9" }, { barcode: "U-9" }, { unitSku: "U-9" }]) {
      const a = src({ unitSku: "U-9" });
      const plan = planCatalogCopy([a], target({ products: [tp(held)] }));
      expect(plan.create[0].members[0].dropUnitSku).toBe(true);
    }
  });

  it("C-G12: a fresh barcode and two level barcodes are all kept", () => {
    const a = src({
      barcode: "900",
      levelBarcodes: [
        { code: "901", level: "CASE" },
        { code: "902", level: "UNIT" },
      ],
    });
    const plan = planCatalogCopy([a], target());
    const m = plan.create[0].members[0];
    expect(m.dropBarcode).toBe(false);
    expect(m.droppedLevels).toEqual([]);
    expect(plan.codesDropped).toEqual([]);
  });

  it("the create count is the number of products to create, family members included", () => {
    const parent = src();
    const v = src({ parentProductId: parent.id, variantName: "A" });
    const lone = src();
    expect(planCatalogCopy([parent, v, lone], target()).createCount).toBe(3);
  });
});
