/**
 * B809: the ONE HTML escaper for server-built email bodies. Four copies used to exist
 * (email.service, billing-notification.templates, demo-booking, messaging), and one of them
 * skipped `'`. Tenant-, buyer- and request-supplied text reaches recipients' inboxes, so any
 * dynamic value interpolated into email HTML goes through this.
 * `html-interpolation.spec.ts` scans every api source file and fails on a raw `${…}` in HTML.
 */
export function escapeHtml(value: string | number): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * B809: the scheme guard for a link helper's href. Only an absolute http(s) URL may become a
 * clickable link, so a future tenant-supplied URL can never carry `javascript:` or `data:`.
 * Every CTA href is server-built today (web URL + token), so a refusal is a programming error:
 * it throws rather than silently sending a dead button.
 */
export function assertHttpUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Refusing a non-URL link target in an email: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Refusing a ${parsed.protocol} link in an email; only http(s) is allowed`);
  }
  return url;
}
