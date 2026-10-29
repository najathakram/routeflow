// Visibility-window marker contract — pure ESM, no dependencies.
//
// The visibility watchdog (scripts/visibility-watchdog.mjs --window-marker) WRITES a small JSON
// marker to a private repo when it arms a public CI window; the Mac visibility timer
// (scripts/visibility-timer.mjs, run by launchd) READS it and flips the repo private once the
// deadline has passed. The marker lives off the machine that opened the window so a dead PC can
// no longer leave the repo public. See tools/visibility-timer/README.md.

export const MARKER_REPO = "najathakram/routeflow-specs";
export const MARKER_PATH = "ops/visibility-window.json";
/** A marker whose deadline is older than this is history, not a live window: take no action. */
export const STALE_MS = 6 * 3600_000;
/** The watchdog gets this long past the deadline to flip on its own before the timer steps in. */
export const GRACE_MS = 2 * 60_000;
/** No legitimate window is longer than this; a longer one is a corrupt or hostile marker. */
export const MAX_WINDOW_MS = 4 * 3600_000;

export function buildMarker({ repo, openedAt, deadline, opener }) {
  return { v: 1, repo, openedAt, deadline, opener };
}

const nonEmpty = (s) => typeof s === "string" && s.trim().length > 0;

/** {ok:true, marker} | {ok:false, reason}. Never throws. */
export function parseMarker(text) {
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not-json" };
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return { ok: false, reason: "not-object" };
  if (m.v !== 1) return { ok: false, reason: "bad-version" };
  if (!nonEmpty(m.repo)) return { ok: false, reason: "bad-repo" };
  if (!nonEmpty(m.opener)) return { ok: false, reason: "bad-opener" };
  const opened = typeof m.openedAt === "string" ? Date.parse(m.openedAt) : NaN;
  if (!Number.isFinite(opened)) return { ok: false, reason: "bad-openedAt" };
  const deadline = typeof m.deadline === "string" ? Date.parse(m.deadline) : NaN;
  if (!Number.isFinite(deadline)) return { ok: false, reason: "bad-deadline" };
  if (deadline < opened) return { ok: false, reason: "deadline-before-openedAt" };
  if (deadline - opened > MAX_WINDOW_MS) return { ok: false, reason: "window-too-long" };
  return {
    ok: true,
    marker: { v: 1, repo: m.repo, openedAt: m.openedAt, deadline: m.deadline, opener: m.opener },
  };
}

/**
 * What the timer should do. `markerText` is the raw file, or null when it does not exist.
 *   none  — nothing to do (missing | malformed | repo-mismatch | stale)
 *   wait  — a live window whose deadline (+ grace) has not passed
 *   check — past deadline + grace and not stale: the caller must read visibility and flip if PUBLIC
 */
export function decide({ markerText, repo, nowMs }) {
  if (markerText === null || markerText === undefined) {
    return { action: "none", reason: "no-marker" };
  }
  const parsed = parseMarker(markerText);
  if (!parsed.ok) return { action: "none", reason: `malformed:${parsed.reason}` };
  const { marker } = parsed;
  if (marker.repo !== repo) return { action: "none", reason: "repo-mismatch" };
  const deadline = Date.parse(marker.deadline);
  if (nowMs > deadline + STALE_MS) return { action: "none", reason: "stale" };
  if (nowMs < deadline + GRACE_MS) return { action: "wait", reason: "deadline-not-reached" };
  return { action: "check", reason: "past-deadline" };
}
