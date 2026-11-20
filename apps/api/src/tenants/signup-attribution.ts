/**
 * Phase 1: what a trial sign-up keeps about the ad, page or site that brought it.
 * The web form sends an optional free-form object; this keeps only the allowed fields, trimmed and capped,
 * and returns null when nothing usable is left. No full URLs, no IP, no user agent are ever stored.
 */
export interface NormalizedSignupAttribution {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  gclid?: string;
  fbclid?: string;
  msclkid?: string;
  landingPath?: string;
  referrerHost?: string;
  firstSeenAt?: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const UTM_MAX = 200;
const CLICK_ID_MAX = 255;
const PATH_MAX = 200;
const HOST_MAX = 253;

const TEXT_FIELDS: Array<[keyof NormalizedSignupAttribution, number]> = [
  ["utmSource", UTM_MAX],
  ["utmMedium", UTM_MAX],
  ["utmCampaign", UTM_MAX],
  ["utmTerm", UTM_MAX],
  ["utmContent", UTM_MAX],
  ["gclid", CLICK_ID_MAX],
  ["fbclid", CLICK_ID_MAX],
  ["msclkid", CLICK_ID_MAX],
];

const UTM_FIELDS = new Set(["utmSource", "utmMedium", "utmCampaign", "utmTerm", "utmContent"]);
// SA-1179 K3: an address pasted into a campaign tag is a person's data, not a source name.
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

const HOST_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value
    // C0/C1 controls, DEL, zero-width and bidi marks, word joiners, BOM: nothing a source name needs.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, "")
    .trim()
    .slice(0, max)
    .trim();
  return text === "" ? null : text;
}

export function normalizeSignupAttribution(
  raw: unknown,
  now: Date = new Date(),
): NormalizedSignupAttribution | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const out: NormalizedSignupAttribution = {};

  for (const [key, max] of TEXT_FIELDS) {
    const text = clean(input[key], max);
    if (text && !(UTM_FIELDS.has(key) && EMAIL_LIKE.test(text))) {
      (out as Record<string, unknown>)[key] = text;
    }
  }

  const path = clean(input.landingPath, PATH_MAX + 1000)
    ?.split(/[?#]/)[0]
    .slice(0, PATH_MAX);
  // "//host/x" and "/\host/x" are a host in disguise (a browser reads both as "//host"), not a path on our site.
  if (path && path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\")) {
    out.landingPath = path;
  }

  // Read one past the cap so an over-long name is dropped whole: a cut name is another site's name (K3).
  const host = clean(input.referrerHost, HOST_MAX + 1)?.toLowerCase();
  // A name whose last label is all digits is an IP address, not a site name: dropped.
  if (host && host.length <= HOST_MAX && HOST_NAME.test(host) && !/(^|\.)\d+$/.test(host)) {
    out.referrerHost = host;
  }

  if (typeof input.firstSeenAt === "string") {
    const seen = new Date(input.firstSeenAt);
    const ms = seen.getTime();
    if (!Number.isNaN(ms) && ms >= now.getTime() - 90 * DAY_MS && ms <= now.getTime() + DAY_MS) {
      out.firstSeenAt = seen;
    }
  }

  return Object.keys(out).length === 0 ? null : out;
}
