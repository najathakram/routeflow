/** B964-1: the address / license / buyer-name wrappers over the one B956 guard, and the OAuth display-name neutraliser. */
import { BadRequestException } from "@nestjs/common";
import {
  productNameViolation,
  assertSafePersonName,
  personNameViolation,
  assertSafeProductNames,
  addressViolation,
  assertSafeAddress,
  assertSafeBuyerName,
  assertSafeLicense,
  licenseViolation,
  safeBuyerDisplayName,
} from "./text-cell-guards";
import { TEXT_CELL_FIELD_LABELS, formulaLeadMessage } from "./safe-text-cell";

describe("TEXT_CELL_FIELD_LABELS: the readable 400 text names the field by a human label", () => {
  it.each([
    ["line1", "Address line 1"],
    ["line2", "Address line 2"],
    ["city", "City"],
    ["state", "State"],
    ["zip", "ZIP code"],
    ["label", "Address label"],
    ["tobaccoLicenseNo", "Tobacco license number"],
    ["licenseNumber", "License number"],
    ["buyerName", "Name"],
    ["category", "Category"],
    ["categoryName", "Category name"],
    ["subcategoryName", "Subcategory name"],
    ["salutation", "Salutation"],
    ["firstName", "First name"],
    ["lastName", "Last name"],
    ["productName", "Product name"],
    ["variantName", "Variant name"],
  ])("%s -> %s", (field, label) => {
    expect(TEXT_CELL_FIELD_LABELS[field]).toBe(label);
    expect(formulaLeadMessage(field)).toBe(
      `${label} can't start with =, +, -, @ or a tab/line break`,
    );
  });

  it("a field with no label keeps B956's text (the three customer name fields' messages are unchanged)", () => {
    expect(formulaLeadMessage("businessName")).toBe(
      "businessName must not start with = + - @ or a tab/line break",
    );
  });
});

describe("assertSafeAddress", () => {
  it.each(["label", "line1", "line2", "city", "state", "zip"] as const)(
    "refuses a formula-led %s with a coded 400 naming the field",
    (field) => {
      let err: BadRequestException | undefined;
      try {
        assertSafeAddress({ [field]: "=HYPERLINK(1)" });
      } catch (e) {
        err = e as BadRequestException;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err?.getResponse()).toMatchObject({ code: "TEXT_CELL_FORMULA_LEAD", field });
    },
  );

  it("accepts ordinary addresses, a numeric ZIP like -5 and ZIP+4, and omitted fields", () => {
    expect(() =>
      assertSafeAddress({
        line1: "12 Main St",
        line2: "Apt #4",
        city: "Austin",
        zip: "78701-1234",
      }),
    ).not.toThrow();
    expect(() => assertSafeAddress({ zip: "-5" })).not.toThrow(); // numeric-only is exempt (csv.ts PLAIN_DECIMAL)
    expect(() => assertSafeAddress({})).not.toThrow();
  });

  it("is change-only: a LEGACY formula-led stored value echoed back does not block", () => {
    expect(() => assertSafeAddress({ line1: "=OLD" }, { line1: "=OLD" })).not.toThrow();
    expect(() => assertSafeAddress({ line1: "=NEW" }, { line1: "=OLD" })).toThrow(
      BadRequestException,
    );
  });

  it("addressViolation is the non-throwing form for importers (the readable text, or null)", () => {
    expect(addressViolation({ city: "-Springfield" })).toBe(
      "City can't start with =, +, -, @ or a tab/line break",
    );
    expect(addressViolation({ city: "Springfield" })).toBeNull();
  });
});

describe("assertSafeLicense", () => {
  it.each([["tobaccoLicenseNo"], ["licenseNumber"]] as const)(
    "refuses a formula-led %s",
    (field) => {
      expect(() => assertSafeLicense({ [field]: "@SUM(A1)" })).toThrow(BadRequestException);
    },
  );
  it("accepts normal license numbers and a numeric-only one, and is change-only", () => {
    expect(() => assertSafeLicense({ tobaccoLicenseNo: "TX-123456" })).not.toThrow();
    expect(() => assertSafeLicense({ licenseNumber: "-12345" })).not.toThrow();
    expect(() =>
      assertSafeLicense({ tobaccoLicenseNo: "=OLD" }, { tobaccoLicenseNo: "=OLD" }),
    ).not.toThrow();
  });
  it("licenseViolation returns the readable text", () => {
    expect(licenseViolation({ tobaccoLicenseNo: "=1" })).toBe(
      "Tobacco license number can't start with =, +, -, @ or a tab/line break",
    );
  });
});

describe("assertSafeBuyerName (user- or staff-typed buyer names)", () => {
  it("refuses a formula-led name as field buyerName", () => {
    let err: BadRequestException | undefined;
    try {
      assertSafeBuyerName("=cmd");
    } catch (e) {
      err = e as BadRequestException;
    }
    expect(err?.getResponse()).toMatchObject({
      code: "TEXT_CELL_FORMULA_LEAD",
      field: "buyerName",
    });
  });
  it("accepts a normal name, and is change-only", () => {
    expect(() => assertSafeBuyerName("Pat O'Neil")).not.toThrow();
    expect(() => assertSafeBuyerName("=OLD", "=OLD")).not.toThrow();
  });
});

describe("safeBuyerDisplayName (OAuth: never block a sign-in, neutralise the name)", () => {
  it("keeps a safe provider name, trimmed", () => {
    expect(safeBuyerDisplayName("  Pat Lee ", "pat@example.com")).toBe("Pat Lee");
  });
  it("a formula-led provider name falls back to the email local-part", () => {
    expect(safeBuyerDisplayName("=cmd|' /C calc'!A0", "pat.lee@example.com")).toBe("pat.lee");
  });
  it("if the local-part is ITSELF formula-led, the fallback is 'Customer'", () => {
    expect(safeBuyerDisplayName("=x", "=evil@example.com")).toBe("Customer");
    expect(safeBuyerDisplayName("+x", "-9a@example.com")).toBe("Customer");
  });
  it("an empty / missing provider name also falls back (local-part, then 'Customer')", () => {
    expect(safeBuyerDisplayName("", "sam@example.com")).toBe("sam");
    expect(safeBuyerDisplayName(null, null)).toBe("Customer");
  });
});

describe("assertSafeProductNames (B964-2)", () => {
  it.each([
    ["name", "productName"],
    ["variantName", "variantName"],
  ] as const)("refuses a formula-led %s as field %s", (key, field) => {
    let err: BadRequestException | undefined;
    try {
      assertSafeProductNames({ [key]: "=HYPERLINK(1)" });
    } catch (e) {
      err = e as BadRequestException;
    }
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err?.getResponse()).toMatchObject({ code: "TEXT_CELL_FORMULA_LEAD", field });
  });

  it("accepts ordinary product names, including '=' / '@' / '-' / '+' INSIDE the text and numeric-only", () => {
    for (const name of ["Coke - 12oz", "A=B Foods", "Foods@home", "7-Up", "-12"]) {
      expect(() => assertSafeProductNames({ name, variantName: name })).not.toThrow();
    }
  });

  it("refuses a leading + or = even on a plausible product ('+1 Energy', '=Value Pack')", () => {
    expect(() => assertSafeProductNames({ name: "+1 Energy" })).toThrow(BadRequestException);
    expect(() => assertSafeProductNames({ name: "=Value Pack" })).toThrow(BadRequestException);
  });

  it("is change-only: a LEGACY formula-led stored name echoed back never blocks; a changed one does", () => {
    expect(() => assertSafeProductNames({ name: "=OLD" }, { name: "=OLD" })).not.toThrow();
    expect(() => assertSafeProductNames({ name: "=NEW" }, { name: "=OLD" })).toThrow(
      BadRequestException,
    );
  });

  it("productNameViolation is the non-throwing readable text for importers, or null", () => {
    expect(productNameViolation({ name: "-2+3" })).toBe(
      "Product name can't start with =, +, -, @ or a tab/line break",
    );
    expect(productNameViolation({ name: "Cola" })).toBeNull();
  });
});

describe("person-name guard (B984)", () => {
  it.each(["salutation", "firstName", "lastName"] as const)(
    "refuses a formula-led %s with a labelled 400",
    (field) => {
      const err: any = (() => {
        try {
          assertSafePersonName({ [field]: "=HYPERLINK(1)" });
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({ code: "TEXT_CELL_FORMULA_LEAD", field });
    },
  );

  it("is change-only, leaves email/phone alone, and has a non-throwing importer form", () => {
    expect(() => assertSafePersonName({ lastName: "=OLD" }, { lastName: "=OLD" })).not.toThrow();
    expect(() => assertSafePersonName({ lastName: "=NEW" }, { lastName: "=OLD" })).toThrow(
      BadRequestException,
    );
    expect(() =>
      assertSafePersonName({ firstName: "Jo", phone: "+1 555 0100" } as never),
    ).not.toThrow();
    expect(personNameViolation({ firstName: "@x" })).toBe(
      "First name can't start with =, +, -, @ or a tab/line break",
    );
    expect(personNameViolation({ firstName: "Jo", lastName: "Lee" })).toBeNull();
  });
});
