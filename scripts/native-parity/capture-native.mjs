#!/usr/bin/env node
/**
 * #2338 (T0.10): the NATIVE half of the native-parity proof harness. On the iOS simulator
 * (iPhone at ~390pt, plus iPad 11-inch), it opens every screen in screens.json by deep link and
 * captures it with `xcrun simctl io <device> screenshot`, into
 *   local-assets/proofs/<PARITY_DATE>/native-parity/<role>/<screen>-<state>-{ios,ipad}.png
 *
 * The app must already be running on the simulator and signed in as the state's buyer: Expo Go
 * first (the lead's ruling), with `expo start` pointed at the local API, signed in by the dev-only
 * parity login (a separate, security-reviewed PR). This script never logs in and never taps.
 *
 *   node scripts/native-parity/capture-native.mjs --role buyer --state loaded [--surface ios|ipad|both]
 *        [--link-base exp://127.0.0.1:8081/--]   (Expo Go; `routeflow://` for a dev build)
 *   node scripts/native-parity/capture-native.mjs --self-test
 *
 * Needs Xcode (not only the Command Line Tools): DEVELOPER_DIR defaults to
 * /Applications/Xcode.app/Contents/Developer when that exists. macOS only (the Mac mini).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { captureFile } = require("./paths.cjs");

export const DEFAULT_LINK_BASE = "exp://127.0.0.1:8081/--";
export const DEVICES = {
  ios: process.env.PARITY_IOS_DEVICE || "iPhone 17e",
  ipad: process.env.PARITY_IPAD_DEVICE || "iPad Pro 11-inch (M5)",
};

/** Pure: the deep link for a native path. `exp://host:port/--` + `/home`, or `routeflow://` + `home`. */
export function deepLink(linkBase, nativePath) {
  if (!nativePath.startsWith("/"))
    throw new Error(`native path must start with "/": ${nativePath}`);
  if (linkBase.endsWith("://")) return `${linkBase}${nativePath.slice(1)}`;
  return `${linkBase.replace(/\/+$/, "")}${nativePath}`;
}

/** Pure: the (screen, surface) captures for one role and state. */
export function plan(manifest, role, state, surfaces) {
  const rows = manifest[role];
  if (!Array.isArray(rows)) throw new Error(`no "${role}" screens in screens.json`);
  return rows
    .filter((s) => s.states.includes(state))
    .flatMap((s) => surfaces.map((surface) => ({ screen: s.id, native: s.native, surface })));
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function simctl(...args) {
  return execFileSync("xcrun", ["simctl", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function bootDevice(name) {
  try {
    simctl("boot", name);
  } catch (e) {
    if (!/current state: Booted/i.test(String(e.stderr ?? e.message))) throw e;
  }
  simctl("bootstatus", name, "-b");
  // A fixed status bar, so iPhone captures compare across runs.
  simctl(
    "status_bar",
    name,
    "override",
    "--time",
    "9:41",
    "--batteryState",
    "charged",
    "--batteryLevel",
    "100",
    "--cellularBars",
    "4",
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function selfTest() {
  const cases = [
    [deepLink(DEFAULT_LINK_BASE, "/home"), "exp://127.0.0.1:8081/--/home"],
    [deepLink("exp://127.0.0.1:8081/--/", "/orders/cart"), "exp://127.0.0.1:8081/--/orders/cart"],
    [deepLink("routeflow://", "/home"), "routeflow://home"],
    [
      JSON.stringify(
        plan(
          {
            buyer: [
              { id: "home", native: "/home", states: ["loaded", "empty"] },
              { id: "cart", native: "/orders/cart", states: ["empty"] },
            ],
          },
          "buyer",
          "loaded",
          ["ios", "ipad"],
        ),
      ),
      JSON.stringify([
        { screen: "home", native: "/home", surface: "ios" },
        { screen: "home", native: "/home", surface: "ipad" },
      ]),
    ],
  ];
  let ok = true;
  for (const [got, want] of cases) {
    const pass = got === want;
    ok &&= pass;
    console.log(`${pass ? "ok  " : "FAIL"} ${want}${pass ? "" : ` (got ${got})`}`);
  }
  let threw = false;
  try {
    deepLink(DEFAULT_LINK_BASE, "home");
  } catch {
    threw = true;
  }
  console.log(`${threw ? "ok  " : "FAIL"} a native path without a leading slash is refused`);
  process.exit(ok && threw ? 0 : 1);
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  if (process.platform !== "darwin")
    throw new Error("the iOS simulator needs macOS (run on the Mac mini)");
  const xcode = "/Applications/Xcode.app/Contents/Developer";
  if (!process.env.DEVELOPER_DIR && existsSync(xcode)) process.env.DEVELOPER_DIR = xcode;

  const role = arg("--role", "buyer");
  const state = arg("--state", "loaded");
  const surfaceArg = arg("--surface", "both");
  const surfaces = surfaceArg === "both" ? ["ios", "ipad"] : [surfaceArg];
  const linkBase = arg("--link-base", DEFAULT_LINK_BASE);
  const settleMs = Number(process.env.PARITY_SETTLE_MS || 4000);
  const manifest = JSON.parse(readFileSync(join(here, "screens.json"), "utf8"));

  const shots = plan(manifest, role, state, surfaces);
  for (const surface of surfaces) bootDevice(DEVICES[surface]);
  for (const { screen, native, surface } of shots) {
    const device = DEVICES[surface];
    simctl("openurl", device, deepLink(linkBase, native));
    await sleep(settleMs);
    const file = captureFile(role, screen, state, surface);
    mkdirSync(dirname(file), { recursive: true });
    simctl("io", device, "screenshot", "--type=png", file);
    console.log(`captured ${surface} ${screen} (${state}) -> ${file}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
