/**
 * The bearer token of an `Authorization` header, read the way the JWT strategies read it.
 *
 * passport-jwt's `fromAuthHeaderAsBearerToken` takes the first two whitespace-separated tokens of the header, compares
 * the scheme case-insensitively and uses the second token as the JWT. Code that looks at the header BEFORE the
 * strategy runs (the global tenant-status guard, the impersonation audit guard) must use this exact reading, so
 * both agree on which requests carry a token. Returns null when the header is not a string or is not a bearer header.
 */
const AUTH_HEADER = /(\S+)\s+(\S+)/;

export function bearerTokenOf(header: unknown): string | null {
  if (typeof header !== "string") return null;
  const m = AUTH_HEADER.exec(header);
  return m && m[1].toLowerCase() === "bearer" ? m[2] : null;
}
