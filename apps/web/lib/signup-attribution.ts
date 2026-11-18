/**
 * Phase 1: what the sign-up form tells the API about where the visitor came from.
 * Built from, in this order: the sign-up page's own URL, the site's first-touch record in
 * `sessionStorage["rf_first_touch"]`, then `document.referrer` (same-origin: its tracked params and the
 * first path segment; cross-origin: ONLY its hostname). Campaign keys come together from the first source
 * that has any; landing path, referrer host and first-seen time fill one by one. Never a full URL, a query string beyond the tracked keys, an IP or a
 * user agent. A missing or malformed first-touch record is ignored.
 */
export interface SignupAttribution {
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
  firstSeenAt?: string;
}

export const FIRST_TOUCH_KEY = "rf_first_touch";

/** Query-string / first-touch key to the field the API takes. */
const TRACKED: Array<[string, keyof SignupAttribution]> = [
  ["utm_source", "utmSource"],
  ["utm_medium", "utmMedium"],
  ["utm_campaign", "utmCampaign"],
  ["utm_term", "utmTerm"],
  ["utm_content", "utmContent"],
  ["gclid", "gclid"],
  ["fbclid", "fbclid"],
  ["msclkid", "msclkid"],
];

const CAMPAIGN_FIELDS = TRACKED.map(([, field]) => field);
const CONTEXT_FIELDS: Array<keyof SignupAttribution> = [
  "landingPath",
  "referrerHost",
  "firstSeenAt",
];

const MAX_LEN = 255;

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim().slice(0, MAX_LEN);
  return t === "" ? undefined : t;
}

function fromParams(params: URLSearchParams): SignupAttribution {
  const out: SignupAttribution = {};
  for (const [key, field] of TRACKED) {
    const v = text(params.get(key));
    if (v) out[field] = v;
  }
  return out;
}

function fromFirstTouch(raw: string | null): SignupAttribution {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const rec = parsed as Record<string, unknown>;
  const out: SignupAttribution = {};
  for (const [key, field] of TRACKED) {
    const v = text(rec[key]);
    if (v) out[field] = v;
  }
  const path = text(rec.landingPath)?.split(/[?#]/)[0];
  if (path) out.landingPath = path;
  const host = text(rec.referrerHost);
  if (host) out.referrerHost = host;
  const seen = text(rec.firstSeenAt);
  if (seen) out.firstSeenAt = seen;
  return out;
}

function fromReferrer(referrer: string, origin: string): SignupAttribution {
  if (!referrer) return {};
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return {};
  }
  if (url.origin === origin) {
    // First path segment only: an app path past it can carry a token (e.g. /buyer/invite/<token>).
    const first = url.pathname.split("/")[1];
    return { ...fromParams(url.searchParams), ...(first ? { landingPath: `/${first}` } : {}) };
  }
  return url.hostname ? { referrerHost: url.hostname } : {};
}

export function buildSignupAttribution(input: {
  search: string;
  firstTouch: string | null;
  referrer: string;
  origin: string;
}): SignupAttribution | undefined {
  const layers = [
    fromParams(new URLSearchParams(input.search)),
    fromFirstTouch(input.firstTouch),
    fromReferrer(input.referrer, input.origin),
  ];
  const merged: SignupAttribution = {};
  // Campaign keys (utm_*, click ids) all come from the FIRST layer that has any, so one sign-up never
  // mixes two campaigns (e.g. the URL's source with the first touch's medium).
  const campaign = layers.find((l) => CAMPAIGN_FIELDS.some((f) => l[f] !== undefined));
  if (campaign) for (const f of CAMPAIGN_FIELDS) if (campaign[f]) merged[f] = campaign[f];
  // Context fields fill one by one, in layer order.
  for (const f of CONTEXT_FIELDS) {
    const hit = layers.find((l) => l[f] !== undefined);
    if (hit) merged[f] = hit[f];
  }
  return Object.keys(merged).length === 0 ? undefined : merged;
}

/** The attribution for the page the visitor is on now; undefined outside a browser. */
export function readSignupAttribution(): SignupAttribution | undefined {
  if (typeof window === "undefined") return undefined;
  let firstTouch: string | null = null;
  try {
    firstTouch = window.sessionStorage.getItem(FIRST_TOUCH_KEY);
  } catch {
    firstTouch = null; // storage blocked: the URL and the referrer still count
  }
  return buildSignupAttribution({
    search: window.location.search,
    firstTouch,
    referrer: document.referrer,
    origin: window.location.origin,
  });
}
