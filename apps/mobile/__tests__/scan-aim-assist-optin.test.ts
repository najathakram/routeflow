import { readFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

/**
 * Hybrid ruling 2026-09-29 + owner ruling 2026-09-24 (aim box + steady-read): the native scanners are shared by every role,
 * but only the DRIVER (still native) gets the aim assist. So it is OPT-IN (`aimAssist`, default OFF): the operator /
 * customer callers keep BYTE-IDENTICAL behaviour. ScanCamera.tsx uses expo-camera's CameraView (not renderable in this
 * pure-logic jest lane), so the wiring is source-pinned; the filters themselves are covered by packages/scanning's specs.
 */
const comp = (f: string) => readFileSync(join(__dirname, "..", "components", f), "utf8");
const camera = comp("ScanCamera.tsx");
const scanner = comp("BarcodeScanner.tsx");
const fab = comp("BarcodeFab.tsx");

describe("aimAssist is OPT-IN: the default is OFF", () => {
  it("ScanCamera declares aimAssist?: boolean and defaults it to false", () => {
    expect(camera).toMatch(/aimAssist\?:\s*boolean/);
    expect(camera).toMatch(/aimAssist\s*=\s*false/);
  });
  it("BarcodeScanner defaults aimAssist to false and only then passes an aim box", () => {
    expect(scanner).toMatch(/aimAssist\?:\s*boolean/);
    expect(scanner).toMatch(/aimAssist\s*=\s*false/);
    expect(scanner).toMatch(/aimBox=\{aimAssist \? AIM_BOX : undefined\}/);
    expect(scanner).toMatch(/aimAssist=\{aimAssist\}/);
  });
  it("BarcodeFab passes aimAssist through, defaulting to false", () => {
    expect(fab).toMatch(/aimAssist\?:\s*boolean/);
    expect(fab).toMatch(/aimAssist=\{aimAssist\}/);
    expect(fab).toMatch(/aimAssist\s*=\s*false/);
  });
  it("ONLY the driver adjust screen passes aimAssist (no other app/ screen opts in)", () => {
    const out = execSync(`grep -rl "aimAssist" "${join(__dirname, "..", "app")}" || true`, {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .map((f) => f.slice(join(__dirname, "..").length + 1));
    expect(out).toEqual(["app/(driver)/route/stop/[stopId]/adjust.tsx"]);
  });
});

describe("ScanCamera: the default path is the pre-existing one, the assisted path is gated", () => {
  it("the default continuous path still runs gateScan -> pushScan -> completeResolve (unchanged)", () => {
    expect(camera).toMatch(/\bgateScan\(/);
    expect(camera).toMatch(/\bpushScan\(/);
    expect(camera).toMatch(/\bcompleteResolve\(/);
  });
  it("the assisted path only runs behind `aimAssist`, and reads `bounds` off the event", () => {
    expect(camera).toMatch(/\{\s*data,\s*bounds,?\s*\}/);
    const at = camera.indexOf("if (aimAssist");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(camera.indexOf("continuousFrameScanned("));
    expect(at).toBeLessThan(camera.indexOf("isWithinAimBox("));
  });
  it("single-shot + aimAssist filters (aim box, then steady-read) BEFORE the one-shot latch", () => {
    const single = camera.slice(
      camera.indexOf("if (!continuous)"),
      camera.indexOf("firedRef.current = true"),
    );
    expect(single).toMatch(/isWithinAimBox\(/);
    expect(single).toMatch(/trackSteadyRead\(/);
  });
});

describe("BarcodeScanner: the enforced aim box is the EXACT rect it draws", () => {
  it("AIM_BOX uses the same WINDOW_SIZE and vertical offset as the drawn scan window", () => {
    const at = scanner.indexOf("const AIM_BOX");
    expect(at).toBeGreaterThan(-1);
    const decl = scanner.slice(at, scanner.indexOf("};", at) + 2);
    expect(decl).toMatch(/width:\s*WINDOW_SIZE/);
    expect(decl).toMatch(/height:\s*WINDOW_SIZE/);
    expect(decl).toMatch(/SCREEN_HEIGHT\s*-\s*WINDOW_SIZE\)\s*\/\s*2\s*-\s*40/);
  });
});
