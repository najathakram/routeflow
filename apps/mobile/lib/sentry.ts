import { Platform } from "react-native";

/**
 * Web-build-only Sentry init (the production mobile deployment is the Expo
 * web export). Inert unless EXPO_PUBLIC_SENTRY_DSN is set; native builds
 * skip entirely. Fire-and-forget: never block startup on the SDK.
 */
export function initSentry(): void {
  if (Platform.OS !== "web") return;
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  if (!dsn) return;
  void import("@sentry/react")
    .then((Sentry) => Sentry.init({ dsn, environment: "production" }))
    .catch(() => {});
}
