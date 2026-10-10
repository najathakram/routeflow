/**
 * #2312: babel.config.js puts apps/mobile/node_modules on Node's global resolution paths, so
 * babel-preset-expo (hoisted to the repo root) can find expo-router (nested under apps/mobile) and
 * keep its router plugin, on every build worker, with no hard-coded NODE_PATH. Without it an iOS
 * bundle dies with "Invalid call at line 2: process.env.EXPO_ROUTER_APP_ROOT" (EAS build 4cbd03bf).
 */
import * as path from "path";
import { spawnSync } from "child_process";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const babelConfig = require("../babel.config.js");

const appDir = path.resolve(__dirname, "..");
const appNodeModules = path.join(appDir, "node_modules");

describe("babel.config.js node_modules injection (#2312)", () => {
  const { withAppNodeModules } = babelConfig;

  it("puts the app's node_modules first, keeps what was there, and is idempotent", () => {
    expect(withAppNodeModules(undefined, appDir)).toBe(appNodeModules);
    expect(withAppNodeModules("/elsewhere", appDir)).toBe(
      [appNodeModules, "/elsewhere"].join(path.delimiter),
    );
    const once = withAppNodeModules("/elsewhere", appDir);
    expect(withAppNodeModules(once, appDir)).toBe(once);
  });

  it("loading the config puts the app's node_modules on NODE_PATH", () => {
    expect((process.env.NODE_PATH ?? "").split(path.delimiter)).toContain(appNodeModules);
  });

  it("in a real Node process, expo-router resolves FROM babel-preset-expo's own location (its hasModule probe)", () => {
    // Jest's resolver ignores a runtime NODE_PATH, so this runs in plain Node with NODE_PATH unset
    // (what an EAS worker now gets): load babel.config.js, then resolve expo-router the way the
    // hoisted preset does. Red if the injection is removed while npm nests expo-router under
    // apps/mobile/node_modules (it does).
    const script = [
      'require("./babel.config.js");',
      'const { createRequire } = require("module");',
      'createRequire(require.resolve("babel-preset-expo")).resolve("expo-router");',
    ].join("\n");
    const env = { ...process.env };
    delete env.NODE_PATH;
    const run = spawnSync(process.execPath, ["-e", script], { cwd: appDir, env, encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });
});
