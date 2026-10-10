import { refusedTextField } from "./refused-text-field";

describe("refusedTextField (B984: focus the refused input)", () => {
  const body = (data: object) => ({ response: { status: 400, data } });
  it("returns the field of a formula-lead refusal", () => {
    expect(refusedTextField(body({ code: "TEXT_CELL_FORMULA_LEAD", field: "lastName" }))).toBe(
      "lastName",
    );
  });
  it("is null for any other error, a missing field, or a non-object", () => {
    expect(refusedTextField(body({ code: "SOMETHING", field: "lastName" }))).toBeNull();
    expect(refusedTextField(body({ code: "TEXT_CELL_FORMULA_LEAD" }))).toBeNull();
    expect(refusedTextField(new Error("x"))).toBeNull();
    expect(refusedTextField(undefined)).toBeNull();
  });
});
