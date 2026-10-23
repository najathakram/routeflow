import { productSaveErrorCopy, PRODUCT_SAVE_FALLBACK } from "../lib/product-save-error-copy";

const err = (data: unknown) => ({ response: { data } });

describe("productSaveErrorCopy (fixed copy, never the server message)", () => {
  it("maps FAMILY_PRICE_AUTHORITY", () => {
    const c = productSaveErrorCopy(
      err({ code: "FAMILY_PRICE_AUTHORITY", message: "RAW", familyId: "f1" }),
    );
    expect(c).toBe("This variant's price is set on its family. Change it on the family instead.");
  });
  it("maps the unsafe-name 400 with a field label", () => {
    expect(
      productSaveErrorCopy(
        err({ code: "TEXT_CELL_FORMULA_LEAD", field: "productName", message: "RAW" }),
      ),
    ).toBe("Product name can't start with =, +, -, @ or a tab/line break.");
    expect(productSaveErrorCopy(err({ code: "TEXT_CELL_FORMULA_LEAD", field: "category" }))).toBe(
      "Category can't start with =, +, -, @ or a tab/line break.",
    );
  });
  it("maps FAMILY_NOT_SELLABLE and FAMILY_ROWS_CONFLICT", () => {
    expect(productSaveErrorCopy(err({ code: "FAMILY_ROWS_CONFLICT" }))).toBe(
      "Some of those products changed. Reload and try again.",
    );
  });
  it("maps VARIANT_PARENT_INACTIVE to fixed copy that says what to do, never the server text", () => {
    const c = productSaveErrorCopy(err({ code: "VARIANT_PARENT_INACTIVE", message: "RAW SERVER" }));
    expect(c).toBe("Turn the family back on first, then reactivate this variant.");
    expect(c).not.toContain("RAW");
  });
  it("maps PRODUCT_PACK_STALE (SA-797) to the gate's reload sentence", () => {
    expect(productSaveErrorCopy(err({ code: "PRODUCT_PACK_STALE", message: "RAW" }))).toBe(
      "This product changed since you opened it. Reload to see the latest.",
    );
  });
  it("falls back to the blanket line, never raw text", () => {
    expect(productSaveErrorCopy(err({ code: "NOPE", message: "RAW SERVER TEXT" }))).toBe(
      PRODUCT_SAVE_FALLBACK,
    );
    expect(productSaveErrorCopy(new Error("boom"))).toBe(PRODUCT_SAVE_FALLBACK);
    expect(PRODUCT_SAVE_FALLBACK).toBe("Couldn't save. Try again.");
  });
});
