/** Denylist scan (spec §1.3): plane-denylist.json patterns plus a URL rule. Fails closed. */
import * as fs from "node:fs";
import * as path from "node:path";

interface Rule {
  name: string;
  re: RegExp;
}

const URL_RULE: Rule = { name: "url", re: /https?:\/\//i };
/** Built-in patterns applied alongside the shared file's (which misses `sk_live_...` shapes). */
const SUPPLEMENTAL: Rule[] = [
  { name: "api-key-live-test", re: /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}/ },
  { name: "webhook-secret", re: /\bwhsec_[A-Za-z0-9]{16,}/ },
];
const UNAVAILABLE = "denylist-unavailable";

const cache = new Map<string, Rule[] | null>();

function defaultPath(): string {
  return path.join(__dirname, "..", "..", "..", "..", "scripts", "campaign", "plane-denylist.json");
}

function load(file: string): Rule[] | null {
  if (cache.has(file)) return cache.get(file) ?? null;
  let rules: Rule[] | null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      patterns?: { name?: unknown; regex?: unknown; flags?: unknown }[];
    };
    if (!Array.isArray(parsed.patterns)) throw new Error("no patterns");
    rules = parsed.patterns.map((p) => {
      if (typeof p.name !== "string" || typeof p.regex !== "string") throw new Error("bad rule");
      const flags = typeof p.flags === "string" ? p.flags.replace(/[gy]/g, "") : "";
      return { name: p.name, re: new RegExp(p.regex, flags) };
    });
  } catch {
    rules = null;
  }
  cache.set(file, rules);
  return rules;
}

const INVISIBLE = /\p{Cf}/gu;
const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
const STOPS = /[\u3002\uFF61\uFF0E\u2024\uFE52]/g;

/** Fold look-alikes before scanning: NFKC, no format chars, one dash, defanged schemes restored. */
function normalise(text: string): string {
  return text
    .replace(INVISIBLE, "")
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(DASHES, "-")
    .replace(STOPS, ".")
    .replace(/hxxp(s?)(:\/\/)/gi, "http$1$2");
}

/** Every string (keys and values) of a parsed JSON value, so `\u0040` escapes are decoded. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v as unknown[]) strings(x, out);
  else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out.push(k);
      strings(x, out);
    }
  }
  return out;
}

/** True when the denylist file loads (boot refuses to start otherwise). */
export function denylistAvailable(): boolean {
  return load(process.env.CONTROL_DENYLIST || defaultPath()) !== null;
}

/** Name of the first rule the line matches, else null. Unreadable denylist => refuse everything. */
export function denylistHit(line: string): string | null {
  const rules = load(process.env.CONTROL_DENYLIST || defaultPath());
  if (rules === null) return UNAVAILABLE;
  const views = [normalise(line)];
  try {
    views.push(normalise(strings(JSON.parse(line) as unknown).join("\n")));
  } catch {
    /* not JSON: the raw view is enough */
  }
  for (const text of views) {
    for (const r of rules) if (r.re.test(text)) return r.name;
    for (const r of SUPPLEMENTAL) if (r.re.test(text)) return r.name;
    if (URL_RULE.re.test(text)) return URL_RULE.name;
  }
  return null;
}
