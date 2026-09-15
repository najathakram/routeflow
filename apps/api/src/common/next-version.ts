/**
 * REG-B352: major-line-tolerant version check used by next-version.spec.ts.
 *
 * Accepts a bare (`"15.6.0"`) or caret-ranged (`"^15.6.0"`) semver string pinned to the given
 * major line; rejects any other major. Mirrors the fix applied in PR #745 for the sibling
 * React-version pin guard — tolerate routine patch/minor bumps, still catch a major downgrade.
 */
export function pinnedToMajorLine(version: string, major: number): boolean {
  return new RegExp(`^\\^?${major}\\.`).test(version);
}

/**
 * T1: minimum-version-aware guard on top of the major-line check.
 *
 * `pinnedToMajorLine` alone accepts ANY version on the given major line, including e.g.
 * `15.0.0` — but the two CRITICAL npm-audit advisories this guard exists to keep cleared are
 * only fixed in `15.5.24+`, so a major-line-only check would pass on a downgrade within the
 * major line that silently loses that protection. This checks the version is on `major` AND is
 * >= `minMinor.minPatch` (parsed and compared numerically, not lexicographically as strings).
 */
export function meetsMinimumOnMajorLine(
  version: string,
  major: number,
  minMinor: number,
  minPatch: number,
): boolean {
  const parts = version
    .replace(/^\^/, "")
    .split(".")
    .map((p) => Number(p));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return false;
  const [maj, min, patch] = parts;
  if (maj !== major) return false;
  if (min !== minMinor) return min > minMinor;
  return patch >= minPatch;
}
