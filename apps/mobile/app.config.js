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

/** @param {{ config: import('@expo/config-types').ExpoConfig }} ctx */
module.exports = ({ config }) => ({
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
