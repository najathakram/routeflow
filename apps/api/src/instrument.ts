import * as Sentry from "@sentry/node";

// DSN-optional: with SENTRY_DSN unset this init is a no-op and the SDK
// stays fully inert (enabled:false disables transport + instrumentation).
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: !!process.env.SENTRY_DSN,
  // Without a DSN, also skip the OTel tracer/context-manager registration the
  // Node SDK otherwise performs unconditionally — keeps the boot truly inert.
  skipOpenTelemetrySetup: !process.env.SENTRY_DSN,
  environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "development",
  tracesSampleRate: 0,
});
