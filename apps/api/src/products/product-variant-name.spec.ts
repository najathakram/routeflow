import { bareVariantNames, stripParentPrefix } from "./product-variant-name";

describe("stripParentPrefix (B1)", () => {
  it("strips one or many leading '<parent> - ' prefixes and nothing else", () => {
    expect(stripParentPrefix("Acme - Classic", "Acme")).toBe("Classic");
    expect(stripParentPrefix("Acme - Acme - Acme - Classic", "Acme")).toBe("Classic");
    expect(stripParentPrefix("Classic", "Acme")).toBe("Classic");
    expect(stripParentPrefix("Cool - Mint", "Acme")).toBe("Cool - Mint");
    expect(stripParentPrefix("Classic - Acme - Mint", "Acme")).toBe("Classic - Acme - Mint");
  });

  it("is case-sensitive, like the composer", () => {
    expect(stripParentPrefix("acme - Classic", "Acme")).toBe("acme - Classic");
  });

  it("never strips a value down to nothing", () => {
    expect(stripParentPrefix("Acme - ", "Acme")).toBe("Acme - ");
    expect(stripParentPrefix("Acme - Acme - ", "Acme")).toBe("Acme - ");
  });

  it("leaves everything alone with no parent name", () => {
    expect(stripParentPrefix("Acme - Classic", null)).toBe("Acme - Classic");
    expect(stripParentPrefix("Acme - Classic", "")).toBe("Acme - Classic");
  });
});

describe("bareVariantNames (B1)", () => {
  const db = (parentName: string | null) => ({
    product: { findFirst: jest.fn().mockResolvedValue(parentName ? { name: parentName } : null) },
  });

  it("rewrites name and variantName in place for a product with a parent", async () => {
    const dto = { name: "Acme - Mint", variantName: "Acme - Acme - Mint" };
    const lookup = db("Acme");
    await bareVariantNames(lookup, dto, "p1");
    expect(dto).toEqual({ name: "Mint", variantName: "Mint" });
    expect(lookup.product.findFirst).toHaveBeenCalledWith({
      where: { id: "p1" },
      select: { name: true },
    });
  });

  it("does not read the parent when there is no parent or no name field", async () => {
    const lookup = db("Acme");
    const standalone = { name: "Acme - Special" };
    await bareVariantNames(lookup, standalone, null);
    await bareVariantNames(lookup, {}, "p1");
    await bareVariantNames(lookup, { variantName: null }, "p1");
    expect(standalone.name).toBe("Acme - Special");
    expect(lookup.product.findFirst).not.toHaveBeenCalled();
  });

  it("leaves the dto alone when the parent is not readable in this tenant", async () => {
    const dto = { name: "Acme - Mint" };
    await bareVariantNames(db(null), dto, "foreign");
    expect(dto.name).toBe("Acme - Mint");
  });
});
