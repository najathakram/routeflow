/**
 * B202 (commit 3) — nobody can tell which build a phone (or a browser tab)
 * is running. That already produced a false bug report: a client screenshot
 * showing another tenant's branding was actually a stale browser context,
 * not a data bug. A visible build stamp on the login screen fixes both
 * problems at once: the retest note we send a client starts with "you're on
 * the new version when the login screen shows build <sha>", and it is also
 * how WE verify a Railway deploy actually carries a merge, without having to
 * trust the deploy dashboard's timestamp.
 *
 * `shortBuildSha`/`buildLabel` are the single source of truth for how the
 * sha is displayed — the login screen and any future About screen must both
 * go through here so they can never disagree on formatting.
 */

/**
 * Total: never throws, always returns a display-safe, non-empty string.
 *
 * - blank / undefined / null / whitespace-only -> `"dev"` (local dev — e.g.
 *   `expo start` or a plain `localhost` web build — never has a baked-in
 *   sha, so this is what those contexts show).
 * - a hex string of 7 or more characters (case-insensitive — this covers
 *   both a full 40-char git sha and an already-abbreviated one) -> its
 *   first 7 characters, lowercased.
 * - anything else — shorter than 7 characters, or containing any character
 *   that isn't a hex digit — is returned trimmed, AS-IS. This is what lets a
 *   human-set tag like `"local"` or `"v1.1.0"` survive rather than being
 *   mangled by a truncation rule meant only for git shas.
 */
export function shortBuildSha(raw?: string | null): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "dev";
  if (/^[0-9a-f]{7,}$/i.test(trimmed)) {
    return trimmed.slice(0, 7).toLowerCase();
  }
  return trimmed;
}

// Expo's babel plugin inlines `EXPO_PUBLIC_*` vars via a literal STATIC text
// replacement at build time — the exported web bundle has no real
// `process.env` at runtime. That inlining only recognizes a static member
// expression; a dynamic lookup like `process.env[someKey]` would not be
// rewritten and would read `undefined` in the shipped bundle, silently
// defeating the entire point of baking the sha in. Keep this a literal
// `process.env.EXPO_PUBLIC_BUILD_SHA` access, never a computed one.
export const BUILD_SHA: string = process.env.EXPO_PUBLIC_BUILD_SHA ?? "";

/**
 * The display string, e.g. "build 1234567" or "build dev". Defaults to the
 * live `BUILD_SHA` baked into this build when called with no argument, so
 * both the login screen and any future About screen can just call
 * `buildLabel()` and always agree. An explicit `raw` is accepted for callers
 * that already have a specific sha/tag in hand (and for tests).
 *
 * Sentence case, no trailing period — matches this app's copy conventions
 * (see the login screen's footer text).
 */
export function buildLabel(raw: string | null | undefined = BUILD_SHA): string {
  return `build ${shortBuildSha(raw)}`;
}
