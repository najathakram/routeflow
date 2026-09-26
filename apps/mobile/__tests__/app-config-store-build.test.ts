/**
 * #2312: the production (store) EAS profile must never build with an empty Google Maps key; every
 * other context (local dev, the Railway web export, internal APK profiles) is unaffected.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const appConfig = require("../app.config.js");

describe("app.config.js store-build guard (#2312)", () => {
  const { assertStoreBuildEnv } = appConfig;

  it("refuses the production profile without EXPO_PUBLIC_GOOGLE_MAPS_API_KEY", () => {
    expect(() => assertStoreBuildEnv({ EAS_BUILD_PROFILE: "production" })).toThrow(
      /EXPO_PUBLIC_GOOGLE_MAPS_API_KEY is not set for the production EAS profile/,
    );
    expect(() =>
      assertStoreBuildEnv({ EAS_BUILD_PROFILE: "production", EXPO_PUBLIC_GOOGLE_MAPS_API_KEY: "" }),
    ).toThrow();
  });

  it("passes the production profile once the key is set", () => {
    expect(() =>
      assertStoreBuildEnv({
        EAS_BUILD_PROFILE: "production",
        EXPO_PUBLIC_GOOGLE_MAPS_API_KEY: "test-key",
      }),
    ).not.toThrow();
  });

  it.each([["staging"], ["preview"], ["development"], [undefined]])(
    "never blocks the %s profile (or a non-EAS evaluation)",
    (profile) => {
      expect(() => assertStoreBuildEnv({ EAS_BUILD_PROFILE: profile })).not.toThrow();
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

  it("portrait-only iPad support declares UIRequiresFullScreen (ITMS-90474)", () => {
    expect(expo.orientation).toBe("portrait");
    expect(expo.ios.supportsTablet).toBe(true);
    expect(expo.ios.infoPlist.UIRequiresFullScreen).toBe(true);
  });
});
