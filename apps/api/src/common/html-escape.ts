import { Logger } from "@nestjs/common";

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

const logger = new Logger("EmailLinks");
let refusedLinks = 0;

/** How many email links were rendered without an href because their URL was not http(s). */
export function refusedEmailLinkCount(): number {
  return refusedLinks;
}

/**
 * B809: the scheme guard for a link helper's href. Only an absolute http(s) URL may become a
 * clickable link, so a future tenant-supplied URL can never carry `javascript:` or `data:`.
 *
 * It never THROWS: a throw would fail a whole password-reset or verify email over a latent
 * config problem. It returns null instead, logs an error (naming the helper and the scheme,
 * never the URL, which carries a token), and counts it. The caller renders the button as plain
 * text, so the email still goes out.
 */
export function safeLinkHref(url: string, where: string): string | null {
  let protocol = "(not a URL)";
  try {
    protocol = new URL(url).protocol;
  } catch {
    // Relative or scheme-less: refused below.
  }
  if (protocol === "https:" || protocol === "http:") return url;
  refusedLinks += 1;
  logger.error(`${where}: refused an email link with scheme ${protocol}; rendered without href`);
  return null;
}

/** The env vars every email link is built from. A value without a scheme breaks every link. */
export const LINK_BASE_ENV_VARS = ["WEB_URL", "WEB_APP_URL", "NEXTAUTH_URL", "FRONTEND_URL"];

/**
 * B809: the boot-time check. Each LINK_BASE_ENV_VARS value that is set but does not start with
 * http:// or https://, as `NAME` (the value itself is never returned).
 */
export function schemelessLinkBaseVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return LINK_BASE_ENV_VARS.filter((name) => {
    const value = env[name];
    return value !== undefined && value !== "" && !/^https?:\/\//i.test(value);
  });
}
