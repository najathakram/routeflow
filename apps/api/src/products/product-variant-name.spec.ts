import { bareRowNames, bareVariantNames, stripParentPrefix } from "./product-variant-name";

describe("stripParentPrefix (B1)", () => {
  it("strips one or many leading '<parent> - ' prefixes and nothing else", () => {
    expect(stripParentPrefix("Acme - Classic", "Acme")).toBe("Classic");
    expect(stripParentPrefix("Acme - Acme - Acme - Classic", "Acme")).toBe("Classic");
    expect(stripParentPrefix("Classic", "Acme")).toBe("Classic");
    expect(stripParentPrefix("Cool - Mint", "Acme")).toBe("Cool - Mint");
    expect(stripParentPrefix("Classic - Acme - Mint", "Acme")).toBe("Classic - Acme - Mint");
  });

  it("matches case-insensitively and keeps the remainder's own casing", () => {
    expect(stripParentPrefix("acme - Classic", "Acme")).toBe("Classic");
    expect(stripParentPrefix("ACME - classic", "Acme")).toBe("classic");
    expect(stripParentPrefix("Acme - acme - Classic", "Acme")).toBe("Classic");
    expect(stripParentPrefix("ACME - aCmE - ClAsSiC", "acme")).toBe("ClAsSiC");
  });

  it("collapses whitespace and NFC-normalises both sides before matching", () => {
    expect(stripParentPrefix("  Acme   -   Classic  ", "Acme")).toBe("Classic");
    expect(stripParentPrefix("Acme\t- \u00a0Classic", "Acme")).toBe("Classic");
    expect(stripParentPrefix("Big   Acme - Classic", "Big Acme")).toBe("Classic");
    expect(stripParentPrefix("Big Acme - Classic", " Big   Acme ")).toBe("Classic");
    // decomposed e + combining acute in the value, precomposed in the parent (and the reverse)
    expect(stripParentPrefix("Cafe\u0301 - Mocha", "Caf\u00e9")).toBe("Mocha");
    expect(stripParentPrefix("Caf\u00e9 - Mocha", "Cafe\u0301")).toBe("Mocha");
  });

  it("only the parent's FULL name plus the separator; never a partial word", () => {
    expect(stripParentPrefix("Acmeberry - X", "Acme")).toBe("Acmeberry - X");
    expect(stripParentPrefix("Acme-X", "Acme")).toBe("Acme-X");
    expect(stripParentPrefix("Acme Berry - X", "Acme")).toBe("Acme Berry - X");
    expect(stripParentPrefix("Big - Classic", "Big Acme")).toBe("Big - Classic");
    expect(stripParentPrefix("Cool - Mint - Acme - Berry", "Acme")).toBe(
      "Cool - Mint - Acme - Berry",
    );
  });

  it("never strips a value down to nothing", () => {
    expect(stripParentPrefix("Acme - ", "Acme")).toBe("Acme - ");
    expect(stripParentPrefix("Acme -", "Acme")).toBe("Acme -");
    expect(stripParentPrefix("Acme - Acme - ", "Acme")).toBe("Acme - Acme - ");
    expect(stripParentPrefix("ACME  -  ", "Acme")).toBe("ACME  -  ");
  });

  it("treats regex metacharacters in the parent name literally", () => {
    expect(stripParentPrefix("A.C+(M)E - Classic", "A.C+(M)E")).toBe("Classic");
    expect(stripParentPrefix("AxC+(M)E - Classic", "A.C+(M)E")).toBe("AxC+(M)E - Classic");
  });

  it("leaves everything alone with no parent name", () => {
    expect(stripParentPrefix("Acme - Classic", null)).toBe("Acme - Classic");
    expect(stripParentPrefix("Acme - Classic", "")).toBe("Acme - Classic");
    expect(stripParentPrefix("Acme - Classic", "   ")).toBe("Acme - Classic");
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

describe("bareRowNames (B1)", () => {
  it("rewrites the name of every row that has one, and leaves the rest", () => {
    const rows: Array<{ name?: string; sku?: string }> = [
      { name: "ACME - Mint" },
      { name: "Berry" },
      { sku: "x" },
    ];
    bareRowNames(rows, "Acme");
    expect(rows).toEqual([{ name: "Mint" }, { name: "Berry" }, { sku: "x" }]);
  });
});
