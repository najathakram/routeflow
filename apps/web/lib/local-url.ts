/**
 * True when a URL points at this machine (localhost / loopback). Fails closed: an unset value, an
 * unparseable one, a lookalike host, or any remote host is NOT local. The e2e buyer setup step
 * uses it to refuse to log in a committed-password fixture on a non-local base URL — an unset
 * PLAYWRIGHT_BASE_URL resolves to the production site.
 */
export function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}
