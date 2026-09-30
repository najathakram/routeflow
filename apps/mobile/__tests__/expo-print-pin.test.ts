/**
 * WP3 (R6.8) — `expo-print` must be pinned via `npx expo install expo-print`,
 * not hand-typed: the SDK-line pin only means something (see B203,
 * expo-file-system-pin.test.ts) if the resolved version actually came from
 * `expo install` against the SDK 55 line this app runs. Source-text pin — no
 * native module can be loaded under Jest.
 */
import { readFileSync } from "fs";
import { join } from "path";

describe("expo-print is pinned to the SDK 55 line (R6.8)", () => {
  it("apps/mobile/package.json pins expo-print to the same major as expo", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };

    const printRange = pkg.dependencies["expo-print"];
    const expoRange = pkg.dependencies["expo"];

    expect(printRange).toBeDefined();
    expect(expoRange).toBeDefined();

    const majorOf = (range: string) => range.match(/(\d+)\.\d+\.\d+/)?.[1];
    expect(majorOf(printRange)).toBe(majorOf(expoRange));
    expect(majorOf(printRange)).toBe("55");
  });

  it("the root package-lock.json carries a resolved expo-print entry (proof it went through npm install)", () => {
    const lock = readFileSync(join(__dirname, "..", "..", "..", "package-lock.json"), "utf8");
    expect(lock).toMatch(/"node_modules\/expo-print":/);
  });
});
