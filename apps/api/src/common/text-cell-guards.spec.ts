/** B964-1: the address / license / buyer-name wrappers over the one B956 guard, and the OAuth display-name neutraliser. */
import { BadRequestException } from "@nestjs/common";
import {
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
      expect(err?.getResponse()).toMatchObject({ code: "text_cell_formula_lead", field });
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
      code: "text_cell_formula_lead",
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
