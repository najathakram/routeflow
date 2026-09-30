import { defaultSellLevel, resolveScanLevel } from "./sell-level";

// T7 (R7, #2717 M1, SA-572b Q8): the product's default sell level.
describe("defaultSellLevel (#2717 M1, SA-572b Q8)", () => {
  it("returns BOX when unitsPerBox > 1", () => {
    expect(defaultSellLevel({ unitsPerBox: 12 })).toBe("BOX");
  });

  // SA-572c QB pin: unitsPerBox 1 is UNIT, not BOX — newLineQty/mobile's add path deliberately
  // diverge from this in M1 (filed separately), so this pin guards the scan-resolution path only.
  it("returns UNIT when unitsPerBox is 1 (SA-572c QB pin)", () => {
    expect(defaultSellLevel({ unitsPerBox: 1 })).toBe("UNIT");
  });

  it("returns UNIT when unitsPerBox is null", () => {
    expect(defaultSellLevel({ unitsPerBox: null })).toBe("UNIT");
  });

  it("returns UNIT when unitsPerBox is omitted", () => {
    expect(defaultSellLevel({})).toBe("UNIT");
  });
});

// T7 (R7, SA-572a i): the level a scan resolves to when it lands on no existing line.
describe("resolveScanLevel (#2717 M1, SA-572a i)", () => {
  it("prefers the line's current sell unit: CASE -> BOX, when BOX is available", () => {
    expect(resolveScanLevel({ lineMode: "CASE", available: ["BOX", "UNIT"] })).toBe("BOX");
  });

  it("prefers the line's current sell unit: UNIT -> UNIT, when UNIT is available", () => {
    expect(resolveScanLevel({ lineMode: "UNIT", available: ["BOX", "UNIT"] })).toBe("UNIT");
  });

  it("falls back to the product's default sell level when there is no line mode", () => {
    expect(resolveScanLevel({ lineMode: null, unitsPerBox: 12, available: ["BOX", "UNIT"] })).toBe(
      "BOX",
    );
  });

  it("falls back to the product's default sell level (UNIT) when unitsPerBox is 1", () => {
    expect(resolveScanLevel({ unitsPerBox: 1, available: ["UNIT"] })).toBe("UNIT");
  });

  it("falls back to the code's only available level when the preferred level isn't offered", () => {
    expect(resolveScanLevel({ lineMode: "CASE", available: ["UNIT"] })).toBe("UNIT");
  });

  it("falls back to the code's only available level even when default would prefer UNIT", () => {
    expect(resolveScanLevel({ lineMode: "UNIT", unitsPerBox: 12, available: ["BOX"] })).toBe("BOX");
  });

  it("returns the preferred level when available is empty", () => {
    expect(resolveScanLevel({ lineMode: "CASE", available: [] })).toBe("BOX");
    expect(resolveScanLevel({ unitsPerBox: 1, available: [] })).toBe("UNIT");
  });
});
