import { unitsLabel } from "./units-label";

describe("unitsLabel", () => {
  it("shows the piece count with a box split for a boxed product", () => {
    expect(unitsLabel(1240, 24)).toBe("1,240 pcs (51 boxes + 16 pcs)");
  });
  it("keeps the product's own unit noun when not boxed", () => {
    expect(unitsLabel(45.5, null, "kg")).toBe("45.5 kg");
    expect(unitsLabel(45.5, 1, "kg")).toBe("45.5 kg");
  });
  it("falls back to pcs when no unit is known", () => {
    expect(unitsLabel(7)).toBe("7 pcs");
  });
  it("never uses the box noun for a boxed piece count", () => {
    expect(unitsLabel(0, 24, "case")).toBe("0 pcs");
  });
  it("accepts Decimal strings and degrades to a dash", () => {
    expect(unitsLabel("12", null, "kg")).toBe("12 kg");
    expect(unitsLabel(undefined)).toBe("—");
    expect(unitsLabel("abc")).toBe("—");
  });
});
