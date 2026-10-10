/**
 * #2653 — every EAS build profile defines the hybrid shell's env. With EXPO_PUBLIC_WEB_URL unset
 * the shell is OFF (no hardcoded fallback), so a profile that forgot it would silently ship the
 * old native screens. Store profiles must point at an https web; every profile's URL must pass
 * the shell's own config check.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { readShellConfig } from "../lib/web-shell/shell-config";

const eas = JSON.parse(readFileSync(join(__dirname, "..", "eas.json"), "utf8")) as {
  build: Record<string, { env?: Record<string, string> }>;
};
const profiles = Object.entries(eas.build);

describe("eas.json: every build profile configures the hybrid shell (#2653)", () => {
  it("has profiles to check (guards a vacuous pass)", () => {
    expect(profiles.length).toBeGreaterThanOrEqual(4);
  });

  it.each(profiles.map(([name, p]) => [name, p]))(
    "%s defines EXPO_PUBLIC_WEB_URL and EXPO_PUBLIC_WEB_SHELL, and the shell config accepts them",
    (_name, p) => {
      const env = (p as { env?: Record<string, string> }).env ?? {};
      expect(env.EXPO_PUBLIC_WEB_URL).toBeTruthy();
      expect(env.EXPO_PUBLIC_WEB_SHELL).toBeTruthy();
      expect(readShellConfig(env)).not.toBeNull();
    },
  );

  it.each(["staging", "production"])("%s (a store-facing build) loads an https web", (name) => {
    expect(eas.build[name]?.env?.EXPO_PUBLIC_WEB_URL).toMatch(/^https:\/\//);
  });
});
