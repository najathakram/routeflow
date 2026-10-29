/**
 * W-830 leak 3 — fail closed. `readShellConfig` returns null (shell OFF, every old native screen
 * back) when EXPO_PUBLIC_WEB_URL is empty, and an `eas update` run from a shell without the vars
 * bakes exactly that. `scripts/assert-shell-env.cjs` refuses a store build / OTA publish without
 * BOTH vars; it is wired into the EAS build hook and the `ota:publish` script. Pinned here:
 * the verdicts, parity with readShellConfig, the real exit code, the wiring, and the Railway
 * web export's explicit decision (stays native: react-native-webview does not run on web).
 */
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { readShellConfig } from "../lib/web-shell/shell-config";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { checkShellEnv } = require("../scripts/assert-shell-env.cjs") as {
  checkShellEnv: (
    env: Record<string, string | undefined>,
    opts?: { allowLocalHttp?: boolean },
  ) => string[];
};

const root = join(__dirname, "..");
const SCRIPT = join(root, "scripts", "assert-shell-env.cjs");
const good = { EXPO_PUBLIC_WEB_URL: "https://www.example.test", EXPO_PUBLIC_WEB_SHELL: "on" };

describe("checkShellEnv", () => {
  it("accepts an https web URL with the shell on", () => {
    expect(checkShellEnv(good)).toEqual([]);
  });

  it("refuses a missing or blank EXPO_PUBLIC_WEB_URL (the silent old-native build)", () => {
    expect(checkShellEnv({ EXPO_PUBLIC_WEB_SHELL: "on" })).not.toEqual([]);
    expect(checkShellEnv({ ...good, EXPO_PUBLIC_WEB_URL: "  " })).not.toEqual([]);
  });

  it("refuses a missing EXPO_PUBLIC_WEB_SHELL, and an explicit off", () => {
    expect(checkShellEnv({ EXPO_PUBLIC_WEB_URL: good.EXPO_PUBLIC_WEB_URL })).not.toEqual([]);
    for (const off of ["off", "0", "false", "OFF"]) {
      expect(checkShellEnv({ ...good, EXPO_PUBLIC_WEB_SHELL: off })).not.toEqual([]);
    }
  });

  it("refuses a store/OTA URL that is not https, but a dev profile may use a LAN host", () => {
    const lan = { ...good, EXPO_PUBLIC_WEB_URL: "http://192.168.4.25:3001" };
    expect(checkShellEnv(lan)).not.toEqual([]);
    expect(checkShellEnv(lan, { allowLocalHttp: true })).toEqual([]);
    expect(
      checkShellEnv(
        { ...good, EXPO_PUBLIC_WEB_URL: "http://www.example.test" },
        { allowLocalHttp: true },
      ),
    ).not.toEqual([]);
  });

  it("agrees with readShellConfig on every URL (no drift between guard and app)", () => {
    for (const url of [
      "https://www.example.test",
      "https://www.example.test/",
      "http://localhost:3001",
      "http://10.0.2.2:3001",
      "http://www.example.test",
      "ftp://www.example.test",
      "not a url",
      "",
    ]) {
      const env = { EXPO_PUBLIC_WEB_URL: url, EXPO_PUBLIC_WEB_SHELL: "on" };
      const appOn = readShellConfig(env) !== null;
      expect(checkShellEnv(env, { allowLocalHttp: true }).length === 0).toBe(appOn);
    }
  });
});

describe("assert-shell-env CLI", () => {
  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
    });

  it("exits 1 and names the variable when the URL is missing", () => {
    const r = run(["--ota"], { EXPO_PUBLIC_WEB_SHELL: "on" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("EXPO_PUBLIC_WEB_URL");
  });

  it("exits 0 for a good --ota env", () => {
    expect(run(["--ota"], good).status).toBe(0);
  });

  it("--eas uses EAS_BUILD_PROFILE: preview may use a LAN http host, production may not", () => {
    const lan = { ...good, EXPO_PUBLIC_WEB_URL: "http://192.168.4.25:3001" };
    expect(run(["--eas"], { ...lan, EAS_BUILD_PROFILE: "preview" }).status).toBe(0);
    expect(run(["--eas"], { ...lan, EAS_BUILD_PROFILE: "production" }).status).toBe(1);
    expect(run(["--eas"], lan).status).toBe(1); // unknown profile is strict
  });
});

describe("wiring", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  it("the EAS build runs the guard after install", () => {
    expect(pkg.scripts["eas-build-post-install"]).toContain("assert-shell-env.cjs --eas");
  });

  it("ota:publish runs the guard BEFORE eas update", () => {
    const s = pkg.scripts["ota:publish"] ?? "";
    expect(s).toContain("assert-shell-env.cjs --ota");
    expect(s.indexOf("assert-shell-env.cjs")).toBeLessThan(s.indexOf("eas update"));
    expect(s).toContain("&&");
  });

  it("exposes the guard as a script the owner can run against any env", () => {
    expect(pkg.scripts["check:shell-env"]).toContain("assert-shell-env.cjs");
  });
});

describe("Railway mobile-web export (Dockerfile)", () => {
  const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");

  it("states the shell is off explicitly, so 'unset' is never the decision", () => {
    expect(dockerfile).toMatch(/^ENV EXPO_PUBLIC_WEB_SHELL=off$/m);
  });
});
