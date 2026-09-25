import { readFileSync } from "fs";
import { join } from "path";

/**
 * ScanCamera.tsx uses expo-camera's CameraView, which isn't renderable in this jest lane
 * (pure-logic only — same reason the order/invoice detail screens are source-pinned rather
 * than RTL-rendered). The aim-box + steady-read pipeline (owner ruling 2026-09-24,
 * `project_scan_aimbox_hold_to_scan_2026-09-24`) itself is fully covered by
 * `packages/scanning`'s own jest specs; this file pins that ScanCamera actually WIRES those
 * functions in, and in the right order, rather than each check happening in isolation.
 */
describe("ScanCamera.tsx: aim-box + steady-read wiring (owner ruling 2026-09-24)", () => {
  const src = readFileSync(join(__dirname, "..", "components/ScanCamera.tsx"), "utf8");

  it("imports the aim-box + steady-read primitives from @routeflow/scanning", () => {
    expect(src).toMatch(/import\s*\{[^}]*isWithinAimBox[^}]*\}\s*from\s*"@routeflow\/scanning"/s);
    expect(src).toMatch(/import\s*\{[^}]*trackSteadyRead[^}]*\}\s*from\s*"@routeflow\/scanning"/s);
    expect(src).toMatch(
      /import\s*\{[^}]*createSteadyReadState[^}]*\}\s*from\s*"@routeflow\/scanning"/s,
    );
  });

  it("reads `bounds` off the barcode event, not just `data`", () => {
    expect(src).toMatch(/\{\s*data,\s*bounds,?\s*\}/);
  });

  it("checks the aim box, THEN steady-read, THEN the existing gate — in that order", () => {
    const aimBoxAt = src.indexOf("isWithinAimBox(");
    const steadyAt = src.indexOf("trackSteadyRead(");
    const gateAt = src.indexOf("gateScan(data,");
    expect(aimBoxAt).toBeGreaterThan(-1);
    expect(steadyAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(-1);
    expect(aimBoxAt).toBeLessThan(steadyAt);
    expect(steadyAt).toBeLessThan(gateAt);
  });

  it("rejects silently (an early return) when outside the aim box or not yet steady — never touches the gate", () => {
    expect(src).toMatch(/if\s*\(!isWithinAimBox\([^)]*\)\)\s*return;/);
    const steadyBlock = src.slice(src.indexOf("trackSteadyRead("), src.indexOf("gateScan(data,"));
    expect(steadyBlock).toMatch(/if\s*\(!steady\)\s*return;/);
  });

  it("only gates continuous mode — single-shot mode is unchanged (documented scope cut)", () => {
    const continuousBranch = src.indexOf("if (!continuous)");
    const aimBoxAt = src.indexOf("isWithinAimBox(");
    expect(continuousBranch).toBeGreaterThan(-1);
    expect(continuousBranch).toBeLessThan(aimBoxAt);
  });
});
