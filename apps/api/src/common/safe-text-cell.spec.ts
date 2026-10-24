/** B956 / SA-629f: the shared write-side formula-lead guard (one grammar, change-only, readable 400). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BadRequestException } from "@nestjs/common";
import { FORMULA_LEAD, PLAIN_DECIMAL } from "./csv";
import { assertSafeTextCell, firstFormulaLedField, isFormulaLedText } from "./safe-text-cell";
import {
  assertSafeCustomerNames,
  customerNameViolation,
  refusedCustomerNameField,
} from "../customers/customer-name-guard";

const REFUSED = [
  "=1+1",
  "+SUM(A1)",
  "-2+3+cmd|' /C calc'!A0",
  "@x",
  "-A1",
  "+1e5",
  "\tSUM(1)",
  "\r1",
  "\n1",
  "＝1",
  "＋1",
  "－1",
  "＠x",
  "-",
  "+",
];
const ACCEPTED = [
  "Acme Distribution",
  "A=B Foods",
  "Foods@home",
  "Smith - Jones",
  "+1 555 123 4567",
  "(555) 123-4567",
  "-12.50",
  "",
];

describe("isFormulaLedText", () => {
  it.each(REFUSED)("refuses %j", (v) => expect(isFormulaLedText(v)).toBe(true));
  it.each(ACCEPTED)("accepts %j", (v) => expect(isFormulaLedText(v)).toBe(false));
});

describe("assertSafeTextCell", () => {
  it("throws a readable 400 with code, field and message", () => {
    let err: BadRequestException | undefined;
    try {
      assertSafeTextCell({ businessName: "=HYPERLINK(1)" });
    } catch (e) {
      err = e as BadRequestException;
    }
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err?.getStatus()).toBe(400);
    expect(err?.getResponse()).toMatchObject({
      code: "TEXT_CELL_FORMULA_LEAD",
      field: "businessName",
      message: "businessName must not start with = + - @ or a tab/line break",
    });
  });

  it("an unchanged stored value passes even when formula-led (no block on an unrelated edit)", () => {
    expect(() =>
      assertSafeTextCell({ businessName: "=OLD" }, { businessName: "=OLD" }),
    ).not.toThrow();
  });

  it("a CHANGED value is checked against its own field only", () => {
    expect(() => assertSafeTextCell({ businessName: "=NEW" }, { businessName: "=OLD" })).toThrow(
      BadRequestException,
    );
    expect(() =>
      assertSafeTextCell({ businessName: "Safe" }, { businessName: "=OLD" }),
    ).not.toThrow();
  });

  it("null, undefined and omitted fields are skipped", () => {
    expect(firstFormulaLedField({ a: null, b: undefined })).toBeNull();
  });

  it("reports the first bad field in key order", () => {
    expect(firstFormulaLedField({ a: "ok", b: "@x", c: "=y" })).toBe("b");
  });
});

describe("customer name wrapper", () => {
  it("guards businessName, contactName and displayName and nothing else", () => {
    for (const field of ["businessName", "contactName", "displayName"] as const) {
      expect(() => assertSafeCustomerNames({ [field]: "=x" })).toThrow(BadRequestException);
    }
    expect(() =>
      assertSafeCustomerNames({ businessName: "Acme", contactName: "A B" }),
    ).not.toThrow();
  });

  it("refusedCustomerNameField returns the structured field (no message parsing), or null", () => {
    expect(refusedCustomerNameField({ businessName: "Acme", contactName: "-1+1" })).toBe(
      "contactName",
    );
    expect(refusedCustomerNameField({ displayName: "@x" })).toBe("displayName");
    expect(refusedCustomerNameField({ businessName: "Acme" })).toBeNull();
    expect(refusedCustomerNameField({ businessName: "=x" }, { businessName: "=x" })).toBeNull();
  });

  it("customerNameViolation returns the readable text, or null", () => {
    expect(customerNameViolation({ contactName: "-1+1" })).toBe(
      "contactName must not start with = + - @ or a tab/line break",
    );
    expect(customerNameViolation({ contactName: "Jo" })).toBeNull();
    expect(customerNameViolation({ displayName: "=x" }, { displayName: "=x" })).toBeNull();
  });
});

describe("report-unsafe-customer-names.mjs mirrors the csv.ts grammar (cannot drift)", () => {
  // A .mjs script cannot import TypeScript, so it carries the two `.source` strings; this pins them.
  const script = readFileSync(
    join(__dirname, "../../scripts/report-unsafe-customer-names.mjs"),
    "utf8",
  );
  const constant = (name: string) => {
    const m = new RegExp(`export const ${name} =\\s*("(?:[^"\\\\]|\\\\.)*");`).exec(script);
    if (!m) throw new Error(`${name} not found`);
    return JSON.parse(m[1]) as string;
  };

  it("FORMULA_LEAD_SOURCE and PLAIN_DECIMAL_SOURCE equal csv.ts's regex sources", () => {
    expect(constant("FORMULA_LEAD_SOURCE")).toBe(FORMULA_LEAD.source);
    expect(constant("PLAIN_DECIMAL_SOURCE")).toBe(PLAIN_DECIMAL.source);
  });
});
