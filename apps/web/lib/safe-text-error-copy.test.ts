import {
  SAFE_TEXT_FIELD_LABELS,
  safeTextBodyCopy,
  safeTextErrorCopy,
} from "./safe-text-error-copy";

const body = (field?: string) => ({
  statusCode: 400,
  code: "TEXT_CELL_FORMULA_LEAD",
  field,
  message: "businessName must not start with = + - @ or a tab/line break",
});

describe("safeTextErrorCopy (B956)", () => {
  it.each([
    ["businessName", "Business name can't start with =, +, -, @ or a tab/line break."],
    ["contactName", "Contact name can't start with =, +, -, @ or a tab/line break."],
    ["displayName", "Display name can't start with =, +, -, @ or a tab/line break."],
    ["label", "Address label can't start with =, +, -, @ or a tab/line break."],
    ["line1", "Address line 1 can't start with =, +, -, @ or a tab/line break."],
    ["line2", "Address line 2 can't start with =, +, -, @ or a tab/line break."],
    ["city", "City can't start with =, +, -, @ or a tab/line break."],
    ["state", "State can't start with =, +, -, @ or a tab/line break."],
    ["zip", "ZIP code can't start with =, +, -, @ or a tab/line break."],
    ["tobaccoLicenseNo", "Tobacco license number can't start with =, +, -, @ or a tab/line break."],
    ["licenseNumber", "License number can't start with =, +, -, @ or a tab/line break."],
    ["buyerName", "Name can't start with =, +, -, @ or a tab/line break."],
    ["productName", "Product name can't start with =, +, -, @ or a tab/line break."],
    ["variantName", "Variant name can't start with =, +, -, @ or a tab/line break."],
    ["category", "Category can't start with =, +, -, @ or a tab/line break."],
    ["categoryName", "Category name can't start with =, +, -, @ or a tab/line break."],
    ["subcategoryName", "Subcategory name can't start with =, +, -, @ or a tab/line break."],
    ["salutation", "Salutation can't start with =, +, -, @ or a tab/line break."],
    ["firstName", "First name can't start with =, +, -, @ or a tab/line break."],
    ["lastName", "Last name can't start with =, +, -, @ or a tab/line break."],
    ["shippingCarrier", "Carrier can't start with =, +, -, @ or a tab/line break."],
    ["shippingTrackingNumber", "Tracking number can't start with =, +, -, @ or a tab/line break."],
  ])("%s → human label copy", (field, expected) => {
    expect(safeTextErrorCopy({ response: { data: body(field) } })).toBe(expected);
    expect(safeTextBodyCopy(body(field))).toBe(expected);
  });

  it("never shows the camelCase key or the server message", () => {
    const text = safeTextErrorCopy({ response: { data: body("businessName") } }) ?? "";
    expect(text).not.toMatch(/businessName|must not start/);
  });

  it("an unknown or missing field gets the generic label", () => {
    expect(safeTextErrorCopy({ response: { data: body("somethingElse") } })).toBe(
      "This field can't start with =, +, -, @ or a tab/line break.",
    );
    expect(safeTextErrorCopy({ response: { data: body(undefined) } })).toBe(
      "This field can't start with =, +, -, @ or a tab/line break.",
    );
  });

  it("another code, no code, no response or a non-object returns null", () => {
    expect(safeTextErrorCopy({ response: { data: { code: "ADDON_GATE" } } })).toBeNull();
    expect(safeTextErrorCopy({ response: { data: { message: "x" } } })).toBeNull();
    expect(safeTextErrorCopy(new Error("Request failed with status code 400"))).toBeNull();
    expect(safeTextErrorCopy(null)).toBeNull();
    expect(safeTextBodyCopy("TEXT_CELL_FORMULA_LEAD")).toBeNull();
  });

  it("labels exist for the customer name fields (B956) and the B964 address / license / buyer-name fields", () => {
    expect(Object.keys(SAFE_TEXT_FIELD_LABELS).sort()).toEqual(
      [
        "businessName",
        "contactName",
        "displayName",
        "label",
        "line1",
        "line2",
        "city",
        "state",
        "zip",
        "tobaccoLicenseNo",
        "licenseNumber",
        "buyerName",
        "productName",
        "variantName",
        "category",
        "categoryName",
        "subcategoryName",
        "salutation",
        "firstName",
        "lastName",
        "shippingCarrier",
        "shippingTrackingNumber",
      ].sort(),
    );
  });
});
