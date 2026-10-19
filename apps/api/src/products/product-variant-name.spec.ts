import { BadRequestException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  bareRowNames,
  bareVariantLabel,
  bareVariantNames,
  isPrefixOnly,
  stripParentPrefix,
} from "./product-variant-name";

/** The coded 400 a prefix-only name is refused with (R3), or null when `fn` did not throw. */
function prefixOnlyRefusal(fn: () => unknown): Record<string, unknown> | null {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).getResponse() as Record<string, unknown>;
  }
  return null;
}
const PREFIX_ONLY_INPUTS = [
  "Acme - ",
  "Acme -",
  "acme - ",
  "  ACME   -   ",
  "Acme - Acme - ",
  "ACME - acme -",
  "Acme\t-\u00a0",
];

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

describe("prefix-only names are a coded 400 (B1 R3)", () => {
  it.each(PREFIX_ONLY_INPUTS)("isPrefixOnly(%j, 'Acme') is true", (v) => {
    expect(isPrefixOnly(v, "Acme")).toBe(true);
  });

  it.each(["Classic", "Acme - Classic", "Acmeberry - ", "Acme Berry -", "Cool - ", "", "Acme"])(
    "isPrefixOnly(%j, 'Acme') is false",
    (v) => {
      expect(isPrefixOnly(v, "Acme")).toBe(false);
    },
  );

  it("is false with no parent name (a standalone product keeps its full name)", () => {
    expect(isPrefixOnly("Acme - ", null)).toBe(false);
    expect(isPrefixOnly("Acme - ", "  ")).toBe(false);
  });

  it.each(PREFIX_ONLY_INPUTS)("bareVariantLabel(%j) throws VARIANT_NAME_PREFIX_ONLY", (v) => {
    const body = prefixOnlyRefusal(() => bareVariantLabel(v, "Acme"));
    expect(body).toMatchObject({ code: API_ERROR_CODES.VARIANT_NAME_PREFIX_ONLY, field: "name" });
    expect(typeof body?.message).toBe("string");
  });

  it("bareVariantLabel strips like stripParentPrefix when a label remains", () => {
    expect(bareVariantLabel("ACME - acme - Classic", "Acme")).toBe("Classic");
    expect(bareVariantLabel("Classic", "Acme")).toBe("Classic");
    expect(bareVariantLabel("Acme - ", null)).toBe("Acme - ");
  });

  it("bareVariantNames refuses a prefix-only name or variantName and writes nothing into the dto", async () => {
    const lookup = { product: { findFirst: jest.fn().mockResolvedValue({ name: "Acme" }) } };
    for (const field of ["name", "variantName"] as const) {
      const dto: { name?: string; variantName?: string | null } = { [field]: "Acme - " };
      await expect(bareVariantNames(lookup, dto, "p1")).rejects.toMatchObject({
        response: { code: API_ERROR_CODES.VARIANT_NAME_PREFIX_ONLY },
      });
      expect(dto[field]).toBe("Acme - ");
    }
  });

  it("bareRowNames refuses a prefix-only row and leaves every row untouched", () => {
    const rows = [{ name: "Acme - Mint" }, { name: "ACME -" }];
    const body = prefixOnlyRefusal(() => bareRowNames(rows, "Acme"));
    expect(body).toMatchObject({ code: API_ERROR_CODES.VARIANT_NAME_PREFIX_ONLY });
    expect(rows).toEqual([{ name: "Acme - Mint" }, { name: "ACME -" }]);
  });
});
