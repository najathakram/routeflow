"use strict";
// Pure helpers for campaign-check's forced `turbo run test --force` (no I/O, no spawning).
// A timed-out run proves nothing either way: it still refuses, but it is not a test failure.

const DEFAULT_FORCE_TIMEOUT_MIN = 45;

// RF_CAMPAIGN_FORCE_TIMEOUT_MIN: a positive integer; anything else is ignored.
function forceTimeoutMin(env) {
  const raw = env.RF_CAMPAIGN_FORCE_TIMEOUT_MIN;
  if (typeof raw === "string" && /^[1-9]\d*$/.test(raw.trim())) {
    return Number.parseInt(raw.trim(), 10);
  }
  return DEFAULT_FORCE_TIMEOUT_MIN;
}

function classifyForcedRun(res, minutes) {
  if (res.error && res.error.code === "ETIMEDOUT") {
    return { ok: false, reason: res.error.message, timedOut: true, minutes };
  }
  if (res.error) return { ok: false, reason: res.error.message };
  if (res.signal) {
    return { ok: false, reason: `killed by signal ${res.signal}`, timedOut: true, minutes };
  }
  return { ok: res.status === 0, reason: res.status === 0 ? null : `turbo exited ${res.status}` };
}

// `verb` is the call site's own phrase ("did not produce it" / "did not succeed").
function failureMessage(forced, pkg, dir, verb) {
  if (forced.timedOut) {
    return (
      `campaign-check: forced run for ${pkg} TIMED OUT after ${forced.minutes} min (host load?), ` +
      `not a test failure; re-push when the heavy-slot queue is quiet or raise ` +
      `RF_CAMPAIGN_FORCE_TIMEOUT_MIN`
    );
  }
  return (
    `campaign-check: forcing a real run for ${pkg} ${verb}` +
    (forced.reason ? ` (${forced.reason})` : "") +
    ` — this is a genuine failure, not a caching artifact. Run it yourself for the ` +
    `full output: cd ${dir} && npx jest --maxWorkers=2`
  );
}

module.exports = { DEFAULT_FORCE_TIMEOUT_MIN, forceTimeoutMin, classifyForcedRun, failureMessage };
