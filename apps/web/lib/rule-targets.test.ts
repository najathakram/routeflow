import {
  appliesToLine,
  countsOf,
  ruleCardTarget,
  targetCountText,
  targetsToInput,
  type PickedTarget,
} from "./rule-targets";

const p = (id: string, name = id, over: Partial<PickedTarget> = {}): PickedTarget => ({
  kind: "PRODUCT",
  id,
  name,
  ...over,
});
const c = (id: string, name = id): PickedTarget => ({ kind: "CATEGORY", id, name });

describe("rule target helpers", () => {
  it("splits picks into the wire shape and omits an empty side", () => {
    expect(targetsToInput([p("p1"), c("c1"), p("p2")])).toEqual({
      productIds: ["p1", "p2"],
      categoryIds: ["c1"],
    });
    expect(targetsToInput([p("p1")])).toEqual({ productIds: ["p1"] });
    expect(targetsToInput([c("c1")])).toEqual({ categoryIds: ["c1"] });
  });

  it("counts products and labels", () => {
    expect(countsOf([p("p1"), c("c1"), p("p2")])).toEqual({ products: 2, labels: 1 });
    expect(countsOf([])).toEqual({ products: 0, labels: 0 });
  });

  it("says the count in plain words, singular and plural", () => {
    expect(targetCountText(12, 0)).toBe("12 products");
    expect(targetCountText(1, 0)).toBe("1 product");
    expect(targetCountText(12, 2)).toBe("12 products · 2 labels");
    expect(targetCountText(0, 1)).toBe("1 label");
    expect(targetCountText(0, 0)).toBe("");
    expect(targetCountText(2, 1, " and ")).toBe("2 products and 1 label");
  });

  it("words the live sentence by where the rule applies", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => p(`p${i}`));
    expect(appliesToLine(twelve, "STATE", ["TX", "CA"])).toBe("Applies to 12 products in TX, CA");
    expect(appliesToLine([p("a"), c("c")], "STATE", ["TX"])).toBe(
      "Applies to 1 product and 1 label in TX",
    );
    expect(appliesToLine([p("a")], "FEDERAL", [])).toBe("Applies to 1 product everywhere");
    expect(appliesToLine([p("a")], "STATE", [])).toBe("Applies to 1 product");
    expect(appliesToLine([], "STATE", ["TX"])).toBe("");
  });

  describe("ruleCardTarget", () => {
    const base = { categoryName: null, productName: null };
    it("falls back to the single legacy target when the server sent no summary", () => {
      expect(ruleCardTarget({ ...base, categoryName: "Hemp" })).toMatchObject({
        name: "Hemp",
        kind: "Category",
        names: null,
        total: null,
      });
    });

    it("a single-target summary keeps the target's own name and kind", () => {
      const r = ruleCardTarget({
        ...base,
        productName: "Gummies",
        targetSummary: {
          products: 1,
          categories: 0,
          preview: [{ kind: "PRODUCT", id: "p1", name: "Gummies" }],
        },
      });
      expect(r).toMatchObject({ name: "Gummies", kind: "Product", total: 1 });
    });

    it("a many-target summary reads 12 products plus the label, with the first three names", () => {
      const r = ruleCardTarget({
        ...base,
        targetSummary: {
          products: 12,
          categories: 1,
          preview: [
            { kind: "CATEGORY", id: "c1", name: "Vapes" },
            { kind: "PRODUCT", id: "p1", name: "Sample Pod" },
            { kind: "PRODUCT", id: "p2", name: "Gummies" },
          ],
        },
      });
      expect(r.name).toBe("12 products · Vapes label");
      expect(r.total).toBe(13);
      expect(r.names).toBe("Vapes, Sample Pod, Gummies, +10 more");
    });

    it("several labels read as a count", () => {
      const r = ruleCardTarget({
        ...base,
        targetSummary: { products: 0, categories: 2, preview: [] },
      });
      expect(r.name).toBe("2 labels");
    });
  });
});
