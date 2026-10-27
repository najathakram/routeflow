import { filingStatusLabel, isFiledOk } from "../lib/filing-status";

describe("filing status (B297 PR5 / B771)", () => {
  it("reads a LOCKED filing as Locked, never Failed", () => {
    expect(filingStatusLabel("LOCKED")).toBe("Locked");
    expect(filingStatusLabel("GENERATED")).toBe("Generated");
    expect(filingStatusLabel("FAILED")).toBe("Failed");
    expect(filingStatusLabel("SOMETHING_NEW")).toBe("Failed");
  });
  it("treats generated and locked as filed", () => {
    expect(isFiledOk("LOCKED")).toBe(true);
    expect(isFiledOk("GENERATED")).toBe(true);
    expect(isFiledOk("FAILED")).toBe(false);
  });
});
