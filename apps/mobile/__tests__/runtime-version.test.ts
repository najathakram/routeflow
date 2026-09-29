/**
 * #2653 — the hybrid shell needs react-native-webview, a NATIVE module. app.json uses
 * `runtimeVersion.policy = "appVersion"`, so every binary with the same `version` shares one OTA
 * runtime. The last binaries without the webview shipped as 1.1.1; an OTA published from a tree that
 * imports the webview and delivered to them would crash on the missing native module. The webview
 * binary must therefore live on its own runtime: `version` must differ from 1.1.1 (and never go
 * backwards), and the policy must stay `appVersion` (a fixed runtime string would re-merge them).
 */
import { readFileSync } from "fs";
import { join } from "path";

const app = JSON.parse(readFileSync(join(__dirname, "..", "app.json"), "utf8")) as {
  expo: { version: string; runtimeVersion?: { policy?: string } };
};
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};
const PRE_WEBVIEW_RUNTIME = "1.1.1";
const semver = (v: string) => v.split(".").map(Number);

describe("app.json runtime version (#2653 hybrid shell)", () => {
  it("the webview dependency is present, so this guard is not vacuous", () => {
    expect(pkg.dependencies["react-native-webview"]).toBeTruthy();
  });

  it("the version differs from the last webview-less runtime", () => {
    expect(app.expo.version).not.toBe(PRE_WEBVIEW_RUNTIME);
  });

  it("the version is newer than the last webview-less runtime", () => {
    const [a, b, c] = semver(app.expo.version);
    const [x, y, z] = semver(PRE_WEBVIEW_RUNTIME);
    expect(a * 1e6 + b * 1e3 + c).toBeGreaterThan(x * 1e6 + y * 1e3 + z);
  });

  it("the runtime policy is still appVersion (so the new version is a new runtime)", () => {
    expect(app.expo.runtimeVersion?.policy).toBe("appVersion");
  });
});
