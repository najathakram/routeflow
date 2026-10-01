import { SCAN_MODE_STORAGE_KEY } from "@routeflow/scanning";
import { readScanMode, writeScanMode } from "./scan-mode-store";

/** Hold-to-scan (owner ruling 2026-09-24): an OPTIONAL per-device setting, default Continuous. */
describe("scan mode store (web, per device)", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to continuous when nothing is stored", () => {
    expect(readScanMode()).toBe("continuous");
  });
  it("round-trips hold under the shared key", () => {
    writeScanMode("hold");
    expect(localStorage.getItem(SCAN_MODE_STORAGE_KEY)).toBe("hold");
    expect(readScanMode()).toBe("hold");
    writeScanMode("continuous");
    expect(readScanMode()).toBe("continuous");
  });
  it("a corrupted stored value is continuous", () => {
    localStorage.setItem(SCAN_MODE_STORAGE_KEY, "{not json");
    expect(readScanMode()).toBe("continuous");
  });
  it("a storage that THROWS (private mode, blocked) never breaks the scanner: reads continuous, writes are swallowed", () => {
    const get = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const set = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readScanMode()).toBe("continuous");
    expect(() => writeScanMode("hold")).not.toThrow();
    get.mockRestore();
    set.mockRestore();
  });
});
