import { addScannedProduct } from "./counter-sale-scan";

/** BUILD-BRIEF 1.5: a line built from a scanned or picked product carries the product's own pack word. */
const cola = {
  id: "prod-cola",
  name: "Cola 12oz Can",
  unit: "case",
  pricePerUnit: "18",
  unitsPerBox: 24,
};

describe("addScannedProduct carries the product's pack word", () => {
  it("a product with a pack label puts it on the line", () => {
    const [line] = addScannedProduct([], { ...cola, packLabel: "Case" }, "BOX", 1, 1);
    expect(line.packLabel).toBe("Case");
  });

  it("a blank or absent pack label adds no key, so the tenant default reads", () => {
    for (const packLabel of [undefined, null, "", "   "]) {
      const [line] = addScannedProduct([], { ...cola, packLabel }, "BOX", 1, 1);
      expect("packLabel" in line).toBe(false);
    }
  });

  it("a repeat scan keeps the line's pack word", () => {
    const once = addScannedProduct([], { ...cola, packLabel: "Case" }, "BOX", 1, 1);
    const twice = addScannedProduct(once, { ...cola, packLabel: "Case" }, "BOX", 1, 1);
    expect(twice).toHaveLength(1);
    expect(twice[0].packLabel).toBe("Case");
    expect(twice[0].boxes).toBe(2);
  });
});
