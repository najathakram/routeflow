/**
 * #2312: the production (store) EAS profile must never build with an empty Google Maps key; every
 * other context (local dev, the Railway web export, internal APK profiles) is unaffected.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const appConfig = require("../app.config.js");

describe("app.config.js store-build guard (#2312)", () => {
  const { assertStoreBuildEnv } = appConfig;

  const prod = (platform: string, key?: string) => ({
    EAS_BUILD_PROFILE: "production",
    EAS_BUILD_PLATFORM: platform,
    ...(key === undefined ? {} : { EXPO_PUBLIC_GOOGLE_MAPS_API_KEY: key }),
  });

  it("refuses an ANDROID production build without EXPO_PUBLIC_GOOGLE_MAPS_API_KEY", () => {
    expect(() => assertStoreBuildEnv(prod("android"))).toThrow(
      /EXPO_PUBLIC_GOOGLE_MAPS_API_KEY is not set for the production Android EAS build/,
    );
    expect(() => assertStoreBuildEnv(prod("android", ""))).toThrow();
  });

  it("passes an Android production build once the key is set", () => {
    expect(() => assertStoreBuildEnv(prod("android", "test-key"))).not.toThrow();
  });

  it("never blocks an iOS production build: iOS maps are Apple Maps (PROVIDER_DEFAULT), no key needed", () => {
    expect(() => assertStoreBuildEnv(prod("ios"))).not.toThrow();
  });

  it.each([["staging"], ["preview"], ["development"], [undefined]])(
    "never blocks the %s profile (or a non-EAS evaluation), on either platform",
    (profile) => {
      for (const platform of ["android", "ios", undefined]) {
        expect(() =>
          assertStoreBuildEnv({ EAS_BUILD_PROFILE: profile, EAS_BUILD_PLATFORM: platform }),
        ).not.toThrow();
      }
    },
  );

  it("the config function still merges the app.json config and injects the maps key plugin", () => {
    const out = appConfig({ config: { name: "RouteFlow", ios: {}, android: {}, plugins: [] } });
    expect(out.name).toBe("RouteFlow");
    expect(out.plugins.some((p: unknown) => Array.isArray(p) && p[0] === "react-native-maps")).toBe(
      true,
    );
  });
});

describe("app.json store decisions (#2312, owner)", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { expo } = require("../app.json");
  const location = (expo.plugins as unknown[]).find(
    (p) => Array.isArray(p) && p[0] === "expo-location",
  ) as [string, Record<string, unknown>];

  it("iOS background location matches Android, reusing the existing Always usage string", () => {
    expect(location[1].isIosBackgroundLocationEnabled).toBe(true);
    expect(location[1].isAndroidBackgroundLocationEnabled).toBe(true);
    expect(String(location[1].locationAlwaysAndWhenInUsePermission)).toMatch(/background/);
  });

  // #2311 PR 1: "orientation": "portrait" locks only the iPhone. `expo config --type introspect`
  // generates UISupportedInterfaceOrientations~ipad = all four orientations and
  // UIRequiresFullScreen = false, so iPad multitasking is valid (no ITMS-90474) with no override.
  // Forcing UIRequiresFullScreen: true would take split view / slide over away on iPad.
  it("iPad keeps multitasking: no UIRequiresFullScreen and no iPad orientation override", () => {
    expect(expo.orientation).toBe("portrait");
    expect(expo.ios.supportsTablet).toBe(true);
    expect(expo.ios.infoPlist.UIRequiresFullScreen).toBeUndefined();
    expect(expo.ios.infoPlist["UISupportedInterfaceOrientations~ipad"]).toBeUndefined();
  });
});
