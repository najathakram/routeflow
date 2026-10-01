import { SCAN_MODE_STORAGE_KEY, parseScanMode, shouldDecode } from "./scan-mode";

describe("shouldDecode", () => {
  it("always decodes in continuous mode, held or not", () => {
    expect(shouldDecode("continuous", false)).toBe(true);
    expect(shouldDecode("continuous", true)).toBe(true);
  });

  it("only decodes in hold mode while the button is held", () => {
    expect(shouldDecode("hold", true)).toBe(true);
    expect(shouldDecode("hold", false)).toBe(false);
  });
});

describe("parseScanMode (the stored per-device value; default Continuous)", () => {
  it("is 'hold' ONLY for the exact stored value", () => {
    expect(parseScanMode("hold")).toBe("hold");
  });
  it("falls back to 'continuous' for anything else: null, undefined, garbage, other casings, objects", () => {
    for (const raw of [
      null,
      undefined,
      "",
      "continuous",
      "HOLD",
      " hold",
      "held",
      1,
      true,
      {},
      [],
    ]) {
      expect(parseScanMode(raw)).toBe("continuous");
    }
  });
  it("uses one namespaced storage key for web and native", () => {
    expect(SCAN_MODE_STORAGE_KEY).toBe("routeflow.scanMode");
  });
});
