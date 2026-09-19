import { displayProductName, orderLineName } from "./product-display";

describe("orderLineName — the composed name survives the read round-trip (order-ui spec §2, T5)", () => {
  it("a catalog variant reads as '<Parent> - <Variant>', not the bare flavor", () => {
    // What GET /orders/:id returns for a variant line once the select carries parent + variantName.
    const line = {
      product: {
        name: "Strawberry Banana",
        variantName: "Strawberry Banana",
        parentProductId: "p-parent",
        parent: { name: "Sample Pod" },
      },
      name: null,
    };
    expect(orderLineName(line)).toBe("Sample Pod - Strawberry Banana");
    // …and it is exactly what the create flow showed while the order was being built.
    expect(orderLineName(line)).toBe(displayProductName(line.product));
  });

  it("a variant whose parent was not loaded degrades to the bare variant name (old behaviour)", () => {
    expect(
      orderLineName({
        product: {
          name: "Strawberry Banana",
          variantName: "Strawberry Banana",
          parentProductId: "p",
        },
      }),
    ).toBe("Strawberry Banana");
  });

  it("a standalone product returns its own name unchanged", () => {
    expect(orderLineName({ product: { name: "Sample Chips 1oz" } })).toBe("Sample Chips 1oz");
  });

  it("an ad-hoc line (no product) returns its free-text label", () => {
    expect(orderLineName({ product: undefined, name: "Delivery surcharge" })).toBe(
      "Delivery surcharge",
    );
  });

  it("returns null when there is neither, so each caller keeps its own fallback", () => {
    expect(orderLineName({})).toBeNull();
    expect(orderLineName({ product: null, name: null })).toBeNull();
  });
});
