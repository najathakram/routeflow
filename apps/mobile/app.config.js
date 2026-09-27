/**
 * Expo dynamic config.
 * Merges everything from app.json and injects secrets from env vars so they
 * are never hard-coded in the repository.
 *
 * Required env vars for native builds (EAS Build secrets / local .env):
 *   EXPO_PUBLIC_GOOGLE_MAPS_API_KEY  — Google Maps API key
 *     Android: injected as com.google.android.geo.API_KEY in AndroidManifest
 *     iOS:     passed to GMSServices.provideAPIKey()
 *
 * For the Railway web build the key is not needed (react-native-maps falls
 * back to UnimplementedView on web).
 */

const googleMapsApiKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";

/**
 * #2312: an ANDROID store build must never ship with an empty maps key (Google Maps would render
 * blank for reviewers and customers). iOS draws maps with Apple Maps (components/MapView.tsx uses
 * PROVIDER_DEFAULT) and needs no key, so an iOS production build is never blocked. EAS sets
 * EAS_BUILD_PROFILE and EAS_BUILD_PLATFORM while it evaluates this config; local `expo start`, the
 * Railway web export and the internal APK profiles are unaffected. The owner sets the key as an EAS environment variable
 * (docs/runbooks/mobile-store-release.md).
 *
 * #2312 decisions (owner, recorded on #2312): app.json sets expo-location
 * `isIosBackgroundLocationEnabled: true` (match Android: lib/location-tracker.native.ts starts
 * background updates on iOS too). #2311 PR 1 removed the `UIRequiresFullScreen: true` #2312 added:
 * Expo's own introspection already writes every iPad orientation (portrait locks only the iPhone),
 * so ITMS-90474 never applied, and the key only took iPad multitasking away.
 */
function assertStoreBuildEnv(env = process.env) {
  if (
    env.EAS_BUILD_PROFILE === "production" &&
    env.EAS_BUILD_PLATFORM === "android" &&
    !env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY
  ) {
    throw new Error(
      "EXPO_PUBLIC_GOOGLE_MAPS_API_KEY is not set for the production Android EAS build. Set it as an EAS " +
        "environment variable (see docs/runbooks/mobile-store-release.md) before a store build.",
    );
  }
}

/** @param {{ config: import('@expo/config-types').ExpoConfig }} ctx */
module.exports = ({ config }) => {
  assertStoreBuildEnv();
  return buildConfig(config);
};
module.exports.assertStoreBuildEnv = assertStoreBuildEnv;

/** @param {import('@expo/config-types').ExpoConfig} config */
const buildConfig = (config) => ({
  ...config,

  // ── iOS ──────────────────────────────────────────────────────────────────
  ios: {
    ...config.ios,
    config: {
      ...(config.ios?.config ?? {}),
      googleMapsApiKey,
    },
  },

  // ── Android ──────────────────────────────────────────────────────────────
  android: {
    ...config.android,
    config: {
      ...(config.android?.config ?? {}),
      googleMaps: {
        apiKey: googleMapsApiKey,
      },
    },
  },

  // ── Plugins ──────────────────────────────────────────────────────────────
  // Inject the key via the react-native-maps config plugin so it is written
  // into AndroidManifest.xml (com.google.android.geo.API_KEY meta-data).
  plugins: [
    ...(config.plugins ?? []),
    [
      "react-native-maps",
      {
        googleMapsApiKey, // iOS AppDelegate
        androidGoogleMapsApiKey: googleMapsApiKey, // Android manifest
      },
    ],
    "expo-web-browser", // Required for Google OAuth flow via expo-auth-session
  ],
});
