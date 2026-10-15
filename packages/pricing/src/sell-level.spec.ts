import { defaultSellLevel } from "./sell-level";

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
