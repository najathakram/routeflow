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
  const src = readFileSync(join(__dirname, "..", "lib", "customer-payload.ts"), "utf8");
  it.each(["phone", "notes", "taxId"])("%s uses optionalText", (f) => {
    expect(src).not.toMatch(new RegExp(`form\\.${f}\\.trim\\(\\) \\|\\| undefined`));
    expect(src).toMatch(new RegExp(`optionalText\\(mode, form\\.${f}, initial\\.${f}\\)`));
  });
  it("delivery window clears on edit", () => {
    expect(src).not.toMatch(/form\.deliveryWindow(Start|End)\.trim\(\) \|\| undefined/);
  });
});

describe("currency is NOT NULL server-side (row 285)", () => {
  const src = readFileSync(join(__dirname, "..", "lib", "customer-payload.ts"), "utf8");
  it("clearing a loaded currency sends undefined (no change), never null", () => {
    expect(src).toMatch(/currency: form\.currency\.trim\(\) \|\| undefined/);
    expect(src).not.toMatch(/optionalText\(mode, form\.currency/);
    const form = readFileSync(join(__dirname, "..", "components", "CustomerForm.tsx"), "utf8");
    expect(form).toMatch(/\n {2}currency\?: string;/);
  });
});
