import { readFileSync } from "fs";
import { join } from "path";

/**
 * ScanCamera.tsx uses expo-camera's CameraView, which isn't renderable in this jest lane
 * (pure-logic only — same reason the order/invoice detail screens are source-pinned rather
 * than RTL-rendered). The aim-box + steady-read + gate composition (owner ruling
 * 2026-09-24, `project_scan_aimbox_hold_to_scan_2026-09-24`; recomposed into ONE pure call
 * — `continuousFrameScanned` — by the #2131 review round 1) itself is fully covered by
 * `packages/scanning`'s own jest specs; this file pins that ScanCamera actually WIRES that
 * function in, feeding it bounds + aimBox + the mobile-specific `candidatesOf`.
 */
describe("ScanCamera.tsx: continuous-mode filter wiring (#2131 review round 1)", () => {
  const src = readFileSync(join(__dirname, "..", "components/ScanCamera.tsx"), "utf8");

  it("imports the composed continuous-scan primitives from @routeflow/scanning", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*continuousFrameScanned[^}]*\}\s*from\s*"@routeflow\/scanning"/s,
    );
    expect(src).toMatch(
      /import\s*\{[^}]*createContinuousScanState[^}]*\}\s*from\s*"@routeflow\/scanning"/s,
    );
    expect(src).toMatch(/import\s*\{[^}]*scanSettled[^}]*\}\s*from\s*"@routeflow\/scanning"/s);
  });

  it("no longer hand-rolls the gate/buffer/steady sequencing ScanCamera used to own", () => {
    // The pre-#2131 version called these directly; the whole sequence is ONE call now.
    expect(src).not.toMatch(/\bgateScan\(/);
    expect(src).not.toMatch(/\bpushScan\(/);
    expect(src).not.toMatch(/\bcompleteResolve\(/);
    expect(src).not.toMatch(/\btrackSteadyRead\(/);
    expect(src).not.toMatch(/\bisWithinAimBox\(/);
  });

  it("reads `bounds` off the barcode event, not just `data`", () => {
    expect(src).toMatch(/\{\s*data,\s*bounds,?\s*\}/);
  });

  it("feeds bounds, aimBox and the mobile candidatesOf into ONE composed call", () => {
    const at = src.indexOf("continuousFrameScanned(");
    expect(at).toBeGreaterThan(-1);
    const call = src.slice(at, src.indexOf(");", at));
    expect(call).toMatch(/bounds/);
    expect(call).toMatch(/aimBox/);
    expect(call).toMatch(/candidatesOf:\s*normalizeScanCode/);
  });

  it("aimBox is passed through as-is, NEVER defaulted to a computed rect (#2131 review point 3)", () => {
    // A caller-computed default (centered on ScanCamera's OWN layout) is exactly what
    // drifted from BarcodeScanner's actual drawn box, and silently over-enforced on
    // ScanOrderSheet, which draws no box at all — omitted must mean no enforcement.
    expect(src).not.toMatch(/defaultAimBox/);
    expect(src).not.toMatch(/aimBox\s*\?\?/);
  });

  it("resolveCode drains the buffer through scanSettled, not a hand-rolled completeResolve", () => {
    const at = src.indexOf("const resolveCode");
    const body = src.slice(at, src.indexOf("}, []);", at));
    expect(body).toMatch(/scanSettled\(engineRef\.current\)/);
  });

  it("only gates continuous mode — single-shot mode is unchanged (documented scope cut)", () => {
    const continuousBranch = src.indexOf("if (!continuous)");
    const composedCallAt = src.indexOf("continuousFrameScanned(");
    expect(continuousBranch).toBeGreaterThan(-1);
    expect(continuousBranch).toBeLessThan(composedCallAt);
  });
});
