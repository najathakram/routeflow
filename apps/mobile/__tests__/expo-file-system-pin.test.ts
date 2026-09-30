/**
 * REG-B203 — the native build crashed on launch (NoClassDefFoundError on
 * expo.modules.filesystem.FilePermissionModule): `expo-file-system` was
 * pinned to `~18.1.11`, a whole major line below the `~55.0.26` SDK 55
 * expects, so its native module predates the class expo-modules-core loads
 * at startup. Fixed in #565 (4046e669): the pin now tracks the SDK 55 line,
 * and `lib/share-pdf.ts` imports the legacy download/write API from
 * `expo-file-system/legacy` (SDK 54 moved it there).
 *
 * Source-text pin (no native module can be loaded under Jest) — a revert of
 * either half (the package.json pin, or the legacy import path) fails here.
 */
import { readFileSync } from "fs";
import { join } from "path";

describe("expo-file-system stays pinned to the SDK 55 line (B203)", () => {
  it("REG-B203 apps/mobile/package.json pins expo-file-system to the ~55 major, matching expo", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };

    const fileSystemRange = pkg.dependencies["expo-file-system"];
    const expoRange = pkg.dependencies["expo"];

    expect(fileSystemRange).toBeDefined();
    expect(expoRange).toBeDefined();

    // RED against a regression back to the ~18.x line (or any pin that drifts off
    // the SDK's major): both ranges must name the same major version number.
    const majorOf = (range: string) => range.match(/(\d+)\.\d+\.\d+/)?.[1];
    expect(majorOf(fileSystemRange)).toBe(majorOf(expoRange));
    expect(majorOf(fileSystemRange)).toBe("55");
  });

  it("share-pdf.ts imports the legacy download/write API from expo-file-system/legacy, not the package root", () => {
    const src = readFileSync(join(__dirname, "..", "lib", "share-pdf.ts"), "utf8");

    // SDK 54 rewrote expo-file-system's root module and moved
    // downloadAsync/writeAsStringAsync/cacheDirectory to the /legacy entry point —
    // importing from the package root here would silently lose those exports.
    expect(src).toMatch(/from ["']expo-file-system\/legacy["']/);
    expect(src).not.toMatch(/from ["']expo-file-system["']/);
  });
});
