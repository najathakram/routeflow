import { classifyLine } from "./classify-line";

const base = {
  itemName: null,
  description: null,
  quantity: null,
  unitPrice: null,
  total: null,
};

// T3 (SA-1295): the classifier never invents a quantity of 1.
describe("classifyLine (T3)", () => {
  it("a named item with price and total but NO quantity is a PRODUCT with qty null", () => {
    const r = classifyLine({ ...base, itemName: "Acme Widget", unitPrice: 4.5, total: 4.5 });
    expect(r.kind).toBe("PRODUCT");
    expect(r.quantity).toBeNull();
    expect(r.total).toBe(4.5);
  });

  it("a named item with quantity keeps that quantity and the file total", () => {
    const r = classifyLine({
      ...base,
      itemName: "Acme Widget",
      quantity: 3,
      unitPrice: 3.33,
      total: 10,
    });
    expect(r).toMatchObject({ kind: "PRODUCT", quantity: 3, total: 10 });
  });

  it("no item, total only, a shipping word -> SHIPPING", () => {
    expect(classifyLine({ ...base, description: "Shipping", total: 12 }).kind).toBe("SHIPPING");
    expect(classifyLine({ ...base, description: "Freight", total: 12 }).kind).toBe("SHIPPING");
  });

  it("no item, total only, a discount word or a negative total -> DISCOUNT", () => {
    expect(classifyLine({ ...base, description: "Discount", total: 5 }).kind).toBe("DISCOUNT");
    expect(classifyLine({ ...base, description: "Adjustment", total: -5 }).kind).toBe("DISCOUNT");
  });

  it("no item, total only, positive, unrecognised word -> OTHER, never guessed as shipping", () => {
    expect(classifyLine({ ...base, description: "Misc", total: 5 }).kind).toBe("OTHER");
  });

  it("no numbers at all -> NOTE", () => {
    const r = classifyLine({ ...base, description: "Please call before delivery" });
    expect(r).toMatchObject({ kind: "NOTE", quantity: null, total: null });
  });

  it("no item but a quantity or price -> OTHER, quantity untouched", () => {
    expect(classifyLine({ ...base, description: "x", quantity: 2, unitPrice: 1 }).kind).toBe(
      "OTHER",
    );
  });

  it("never rebuilds a missing total from quantity x price", () => {
    const r = classifyLine({ ...base, itemName: "Acme Widget", quantity: 3, unitPrice: 2 });
    expect(r.total).toBeNull();
  });
});
