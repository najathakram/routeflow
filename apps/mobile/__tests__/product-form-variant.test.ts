/**
 * Locks the variant vs standalone branch of buildProductPayload — a variant
 * carries the flavor as its `name` (mirrors web) and sends parentProductId +
 * variantName; a standalone product never sends those.
 */
import { buildProductPayload, emptyProductForm } from "../lib/product-form-logic";

function base() {
  return { ...emptyProductForm(), pricePerUnit: "5" };
}

describe("buildProductPayload — variants", () => {
  it("standalone: name from the Name field, no variant fields sent", () => {
    const r = buildProductPayload({ ...base(), name: "Sourdough loaf" });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.name).toBe("Sourdough loaf");
    expect(r.parentProductId).toBeUndefined();
    expect(r.variantName).toBeUndefined();
  });

  it("variant: flavor becomes the name AND variantName, with parentProductId", () => {
    const r = buildProductPayload({
      ...base(),
      name: "", // Name field hidden for a variant
      parentProductId: "parent-123",
      variantName: "Strawberry",
    });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.name).toBe("Strawberry");
    expect(r.variantName).toBe("Strawberry");
    expect(r.parentProductId).toBe("parent-123");
  });

  it("variant requires a flavor", () => {
    const r = buildProductPayload({ ...base(), parentProductId: "parent-123", variantName: "  " });
    expect(r).toEqual({ error: "Enter a flavor / variety for the variant." });
  });

  it("variant still requires a valid price", () => {
    const r = buildProductPayload({
      ...base(),
      pricePerUnit: "",
      parentProductId: "parent-123",
      variantName: "Strawberry",
    });
    expect(r).toEqual({ error: "Enter a valid price." });
  });
});
