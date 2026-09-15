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
