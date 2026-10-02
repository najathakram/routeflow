import { readFileSync } from "fs";
import { join } from "path";
import {
  SAFE_TEXT_FIELD_LABELS,
  safeTextBodyCopy,
  safeTextErrorCopy,
} from "../lib/safe-text-error-copy";

const body = (field?: string) => ({
  statusCode: 400,
  code: "TEXT_CELL_FORMULA_LEAD",
  field,
  message: "businessName must not start with = + - @ or a tab/line break",
});

describe("safeTextErrorCopy (B956: no raw server strings)", () => {
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
    ["salutation", "Salutation can't start with =, +, -, @ or a tab/line break."],
    ["firstName", "First name can't start with =, +, -, @ or a tab/line break."],
    ["lastName", "Last name can't start with =, +, -, @ or a tab/line break."],
  ])("%s → human label copy", (field, expected) => {
    expect(safeTextErrorCopy({ response: { data: body(field) } })).toBe(expected);
    expect(safeTextBodyCopy(body(field))).toBe(expected);
  });

  it("never shows the camelCase key or the server message", () => {
    expect(safeTextErrorCopy({ response: { data: body("businessName") } })).not.toMatch(
      /businessName|must not start/,
    );
  });

  it("an unknown field gets the generic label; another code or no response returns null", () => {
    expect(safeTextErrorCopy({ response: { data: body("x") } })).toBe(
      "This field can't start with =, +, -, @ or a tab/line break.",
    );
    expect(safeTextErrorCopy({ response: { data: { code: "ADDON_GATE" } } })).toBeNull();
    expect(safeTextErrorCopy(new Error("Network Error"))).toBeNull();
    expect(safeTextErrorCopy(null)).toBeNull();
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
        "salutation",
        "firstName",
        "lastName",
      ].sort(),
    );
  });
});

/** The customer create/edit screens route a refused name through the helper before any raw message. */
describe("customer create/edit screens use safeTextErrorCopy", () => {
  it.each(["app/(operator)/customers/new.tsx", "app/(operator)/customers/[id]/edit.tsx"])(
    "%s calls safeTextErrorCopy first",
    (file) => {
      const src = readFileSync(join(__dirname, "..", file), "utf8");
      expect(src).toContain(
        'from "../../../lib/safe-text-error-copy"'.replace(
          "../../../",
          file.includes("[id]") ? "../../../../" : "../../../",
        ),
      );
      expect(src).toMatch(/showToast\(\s*safeTextErrorCopy\(e\)/);
    },
  );
});
