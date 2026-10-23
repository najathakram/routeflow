import { readFileSync } from "fs";
import { join } from "path";
import { clearableField, optionalText } from "../lib/clearable-field";

describe("clearableField (row 285)", () => {
  it("returns the trimmed value when present", () => {
    expect(clearableField("  555 ", "123")).toBe("555");
  });
  it("returns null when a loaded value is emptied", () => {
    expect(clearableField("  ", "123")).toBeNull();
  });
  it("returns undefined when nothing was loaded and nothing typed", () => {
    expect(clearableField("", "")).toBeUndefined();
    expect(clearableField("", null)).toBeUndefined();
  });
});

describe("optionalText", () => {
  it("create omits empty, edit clears loaded", () => {
    expect(optionalText("create", " ", "x")).toBeUndefined();
    expect(optionalText("create", " a ", undefined)).toBe("a");
    expect(optionalText("edit", "", "x")).toBeNull();
    expect(optionalText("edit", "", "")).toBeUndefined();
  });
});

describe("CustomerForm clears optional fields on edit (source-pinned)", () => {
  const src = readFileSync(join(__dirname, "..", "components", "CustomerForm.tsx"), "utf8");
  it.each(["phone", "currency", "notes", "taxId"])("%s uses optionalText", (f) => {
    expect(src).not.toMatch(new RegExp(`form\\.${f}\\.trim\\(\\) \\|\\| undefined`));
    expect(src).toMatch(new RegExp(`optionalText\\(mode, form\\.${f}, initial\\.${f}\\)`));
  });
  it("delivery window clears on edit", () => {
    expect(src).not.toMatch(/form\.deliveryWindow(Start|End)\.trim\(\) \|\| undefined/);
  });
});
