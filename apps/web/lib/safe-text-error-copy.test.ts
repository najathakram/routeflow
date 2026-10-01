import {
  SAFE_TEXT_FIELD_LABELS,
  safeTextBodyCopy,
  safeTextErrorCopy,
} from "./safe-text-error-copy";

const body = (field?: string) => ({
  statusCode: 400,
  code: "text_cell_formula_lead",
  field,
  message: "businessName must not start with = + - @ or a tab/line break",
});

describe("safeTextErrorCopy (B956)", () => {
  it.each([
    ["businessName", "Business name can't start with =, +, -, @ or a tab/line break."],
    ["contactName", "Contact name can't start with =, +, -, @ or a tab/line break."],
    ["displayName", "Display name can't start with =, +, -, @ or a tab/line break."],
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
    expect(safeTextBodyCopy("text_cell_formula_lead")).toBeNull();
  });

  it("labels exist for the three customer name fields only", () => {
    expect(Object.keys(SAFE_TEXT_FIELD_LABELS).sort()).toEqual([
      "businessName",
      "contactName",
      "displayName",
    ]);
  });
});
