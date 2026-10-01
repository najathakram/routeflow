import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

/**
 * Hold to scan on the DRIVER native scanner (owner ruling 2026-09-24; hybrid ruling 2026-09-29). It rides the SAME opt-in as
 * the aim assist: only a caller that passes `aimAssist` (driver adjust.tsx) can ever be in Hold mode, so operator /
 * customer scanners stay byte-identical. CameraView is not renderable in this pure-logic lane, so the wiring is
 * source-pinned; the decision and the parsing themselves are covered by packages/scanning's specs.
 */
const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("the per-device store", () => {
  it("exists, uses the ONE shared key + parser, and never throws out of storage", () => {
    expect(existsSync(join(root, "lib/scan-mode-store.ts"))).toBe(true);
    const src = read("lib/scan-mode-store.ts");
    expect(src).toMatch(/SCAN_MODE_STORAGE_KEY/);
    expect(src).toMatch(/parseScanMode\(/);
    expect(src).toMatch(/AsyncStorage/);
    expect((src.match(/catch/g) ?? []).length).toBeGreaterThanOrEqual(2); // read and write both guarded
    expect(src).toMatch(/export (async )?function readScanMode/);
    expect(src).toMatch(/export (async )?function writeScanMode/);
  });
  it("useScanMode only touches storage when ENABLED (default-off callers never read it)", () => {
    const src = read("lib/scan-mode-store.ts");
    expect(src).toMatch(/export function useScanMode\(enabled: boolean\)/);
    expect(src).toMatch(/if \(!enabled\) return/);
  });
});

describe("BarcodeScanner: Hold mode exists only behind aimAssist", () => {
  const src = read("components/BarcodeScanner.tsx");
  it("reads the mode through useScanMode(aimAssist) and treats non-assist as continuous", () => {
    expect(src).toMatch(/useScanMode\(aimAssist\)/);
    expect(src).toMatch(/const holdMode = aimAssist && scanMode === "hold"/);
  });
  it("decoding is gated by shouldDecode(mode, holding) on top of active/paused", () => {
    expect(src).toMatch(/shouldDecode\(holdMode \? "hold" : "continuous", holding\)/);
    expect(src).toMatch(/active=\{active && !paused && shouldDecode\(/);
  });
  it("draws the round hold button (press-in holds, press-out releases) only in Hold mode", () => {
    expect(src).toMatch(/holdMode \? \(/);
    expect(src).toMatch(/accessibilityLabel="Hold to scan"/);
    expect(src).toMatch(/onPressIn=\{/);
    expect(src).toMatch(/onPressOut=\{/);
  });
  it("the Scan mode toggle is rendered only when aimAssist is on", () => {
    expect(src).toMatch(/aimAssist \? \(/);
    expect(src).toMatch(/accessibilityLabel="Scan mode: Hold to scan"/);
    expect(src).toMatch(/accessibilityLabel="Scan mode: Continuous"/);
  });
});

describe("ScanCamera: a release drops the stale steady streak (assist only)", () => {
  const src = read("components/ScanCamera.tsx");
  it("resets the steady-read refs when the camera goes inactive under aimAssist", () => {
    expect(src).toMatch(/if \(!active && aimAssist\)/);
    expect(src).toMatch(/steadyRef\.current = createSteadyReadState\(\)/);
  });
});

describe("no screen other than the driver's reaches the store", () => {
  it("scan-mode-store is imported only by BarcodeScanner", () => {
    const out = execSync(
      `grep -rl "scan-mode-store" "${join(root, "app")}" "${join(root, "components")}" "${join(root, "lib")}" || true`,
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .map((f) => f.slice(root.length + 1))
      .sort();
    expect(out).toEqual(["components/BarcodeScanner.tsx"]);
  });
});
