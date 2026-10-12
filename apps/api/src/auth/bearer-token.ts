/**
 * The bearer token of an `Authorization` header, read the way the JWT strategies read it.
 *
 * passport-jwt's `fromAuthHeaderAsBearerToken` takes the first two whitespace-separated tokens of the header, compares
 * the scheme case-insensitively and uses the second token as the JWT. Code that looks at the header BEFORE the
 * strategy runs (the global tenant-status guard, the impersonation audit guard) must use this exact reading, so
 * both agree on which requests carry a token. Returns null when the header is not a string or is not a bearer header.
 */
export function bearerTokenOf(header: unknown): string | null {
  if (typeof header !== "string") return null;
  // Linear on purpose: passport's /(\S+)\s+(\S+)/ is quadratic on a long header with no whitespace, and this runs for
  // every request (both global guards). The first two whitespace-separated tokens are the same answer.
  const parts = header.trim().split(/\s+/, 2);
  return parts.length === 2 && parts[0].toLowerCase() === "bearer" ? parts[1] : null;
}
