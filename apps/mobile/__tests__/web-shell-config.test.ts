/**
 * #2653 — the hybrid shell's config: on only with a usable EXPO_PUBLIC_WEB_URL, off on request,
 * never a hardcoded fallback; drivers are never shelled; one buyer entry constant.
 */
import {
  BUYER_SHELL_ENTRY,
  readShellConfig,
  shellEntryUrl,
  usesShell,
} from "../lib/web-shell/shell-config";

const WEB = "https://www.example-routeflow.test";

describe("readShellConfig", () => {
  it("is on with a usable https web URL (trailing path/slash dropped)", () => {
    expect(readShellConfig({ EXPO_PUBLIC_WEB_URL: `${WEB}/` })).toEqual({
      webBaseUrl: WEB,
      allowed: [WEB],
    });
    expect(
      readShellConfig({ EXPO_PUBLIC_WEB_URL: WEB, EXPO_PUBLIC_WEB_SHELL: "on" }),
    ).not.toBeNull();
  });

  it.each(["off", "OFF", "0", "false", " False "])(
    "is OFF when EXPO_PUBLIC_WEB_SHELL=%s (old native screens return)",
    (flag) => {
      expect(readShellConfig({ EXPO_PUBLIC_WEB_URL: WEB, EXPO_PUBLIC_WEB_SHELL: flag })).toBeNull();
    },
  );

  it.each([
    ["unset", undefined],
    ["empty", "  "],
    ["not a URL", "www.example-routeflow.test"],
    ["plain http on a public host", "http://www.example-routeflow.test"],
  ])("is OFF with no hardcoded fallback when the web URL is %s", (_l, url) => {
    expect(readShellConfig({ EXPO_PUBLIC_WEB_URL: url })).toBeNull();
  });
});

describe("usesShell / shellEntryUrl", () => {
  const config = readShellConfig({ EXPO_PUBLIC_WEB_URL: WEB });

  it("shells operators and buyers, never drivers", () => {
    expect(usesShell(config, "operator")).toBe(true);
    expect(usesShell(config, "buyer")).toBe(true);
    expect(usesShell(config, "driver")).toBe(false);
  });

  it("shells nobody when the config is off", () => {
    expect(usesShell(null, "operator")).toBe(false);
    expect(usesShell(null, "buyer")).toBe(false);
  });

  it("buyers enter at the single BUYER_SHELL_ENTRY (the web buyer login until the Q1 handoff)", () => {
    expect(BUYER_SHELL_ENTRY).toBe("/buyer/login");
    expect(shellEntryUrl(config!, "buyer")).toBe(`${WEB}/buyer/login`);
  });

  it("staff enter at the web's login, never the root (sim proof F1: '/' is the marketing page)", () => {
    expect(shellEntryUrl(config!, "operator")).toBe(`${WEB}/login`);
  });
});
