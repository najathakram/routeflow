/**
 * Phase 1: the plain-words source of one sign-up, worked out when the dashboard is read (the raw
 * fields are what is stored, so a new bucket never needs a migration).
 * Precedence: utm source, then a click id, then the referring host, then "Direct or unknown".
 */
export interface SignupSourceFields {
  utmSource?: string | null;
  utmMedium?: string | null;
  gclid?: string | null;
  fbclid?: string | null;
  msclkid?: string | null;
  referrerHost?: string | null;
  landingPath?: string | null;
}

export const SIGNUP_SOURCE_NOT_RECORDED = "Not recorded";
export const SIGNUP_SOURCE_DIRECT = "Direct or unknown";

// SA-1179 K1: an engine counts only as its registrable name (after "www."), never as any one label of a
// host, so google.evil.com is a referral. Country forms: .<tld>, .co.<cc>, .com.<cc>.
const TLD = String.raw`(?:[a-z]{2,6}|co\.[a-z]{2}|com\.[a-z]{2})`;
const SEARCH_ENGINES: Array<[string, RegExp]> = [
  ["google", new RegExp(String.raw`^google\.${TLD}$`)],
  ["bing", /^bing\.com$/],
  ["duckduckgo", /^duckduckgo\.com$/],
  ["yahoo", new RegExp(String.raw`^(?:search\.)?yahoo\.${TLD}$`)],
];
const AI_HOSTS = [
  "chatgpt.com",
  "chat.openai.com",
  "perplexity.ai",
  "gemini.google.com",
  "copilot.microsoft.com",
];

function stripWww(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

function searchEngine(host: string): string | undefined {
  return SEARCH_ENGINES.find(([, name]) => name.test(host))?.[0];
}

/** The card's order: the biggest source first, a tie by label, so rows never shuffle between reads (K4). */
export function bySignupsThenLabel(
  a: { source: string; signups: number },
  b: { source: string; signups: number },
): number {
  return b.signups - a.signups || a.source.localeCompare(b.source, "en");
}

export function signupSourceLabel(row: SignupSourceFields | null | undefined): string {
  if (!row) return SIGNUP_SOURCE_NOT_RECORDED;

  if (row.utmSource) {
    const source = row.utmSource.toLowerCase();
    return row.utmMedium ? `${source} / ${row.utmMedium.toLowerCase()}` : source;
  }
  if (row.gclid) return "google / paid (click id)";
  if (row.msclkid) return "bing / paid (click id)";
  if (row.fbclid) return "facebook (click id)";

  if (row.referrerHost) {
    const host = stripWww(row.referrerHost.toLowerCase());
    const ai = AI_HOSTS.find((h) => host === h);
    if (ai) return `ai answer: ${ai}`;
    // An engine's mail host is a link in an email, not a search.
    if (host.startsWith("mail.") && searchEngine(host.slice(5))) return `email: ${host}`;
    const engine = searchEngine(host);
    if (engine) return `${engine} / organic`;
    return `referral: ${host}`;
  }
  return SIGNUP_SOURCE_DIRECT;
}
