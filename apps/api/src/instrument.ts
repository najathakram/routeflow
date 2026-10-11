import * as Sentry from "@sentry/node";
import { scrubSentryEvent } from "./common/sentry-scrub";

// DSN-optional: with SENTRY_DSN unset this init is a no-op and the SDK
// stays fully inert (enabled:false disables transport + instrumentation).
//
// `release` tags every event with the deployed commit sha so Sentry can group
// issues per-release for release-health comparisons (scripts/release-health.mjs).
// RAILWAY_GIT_COMMIT_SHA is injected by Railway into the running container of a
// GitHub-connected service (same var apps/api/src/app.service.ts's health check
// already reads, and apps/web/app/api/health/route.ts documents as verified live
// via `railway ssh`) — a plain runtime env read, no build-time wiring needed here.
// `|| undefined` (not `??`) also treats an empty string the same as unset, so a
// misconfigured-but-present var can't tag a release of "". A missing sha must
// never crash boot: Sentry.init() accepts `release: undefined` fine (untagged
// events), which is the deliberate fallback.
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: !!process.env.SENTRY_DSN,
  // Without a DSN, also skip the OTel tracer/context-manager registration the
  // Node SDK otherwise performs unconditionally — keeps the boot truly inert.
  skipOpenTelemetrySetup: !process.env.SENTRY_DSN,
  environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "development",
  release: process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
  tracesSampleRate: 0,
  // A request URL, query string, cookie, header or body can carry a single-use link token or a
  // credential: no incoming body is attached, and every event is scrubbed (common/sentry-scrub.ts)
  // down to the redacted route before it is sent.
  integrations: [Sentry.httpIntegration({ maxIncomingRequestBodySize: "none" })],
  beforeSend: scrubSentryEvent,
  beforeSendTransaction: scrubSentryEvent,
});
