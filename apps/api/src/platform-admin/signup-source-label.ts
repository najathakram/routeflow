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

const SEARCH_ENGINES = ["google", "bing", "duckduckgo", "yahoo"];
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

export function signupSourceLabel(row: SignupSourceFields | null | undefined): string {
  if (!row) return SIGNUP_SOURCE_NOT_RECORDED;

  if (row.utmSource) {
    const source = row.utmSource.toLowerCase();
    return row.utmMedium ? `${source} / ${row.utmMedium}` : source;
  }
  if (row.gclid) return "google / paid (click id)";
  if (row.msclkid) return "bing / paid (click id)";
  if (row.fbclid) return "facebook (click id)";

  if (row.referrerHost) {
    const host = stripWww(row.referrerHost.toLowerCase());
    const ai = AI_HOSTS.find((h) => host === h);
    if (ai) return `ai answer: ${ai}`;
    const engine = SEARCH_ENGINES.find((e) => host.split(".").includes(e));
    if (engine) return `${engine} / organic`;
    return `referral: ${host}`;
  }
  return SIGNUP_SOURCE_DIRECT;
}
