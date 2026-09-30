/** Denylist scan (spec §1.3): plane-denylist.json patterns plus a URL rule. Fails closed. */
import * as fs from "node:fs";
import * as path from "node:path";

interface Rule {
  name: string;
  re: RegExp;
}

const URL_RULE: Rule = { name: "url", re: /https?:\/\//i };
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

/** Name of the first rule the line matches, else null. Unreadable denylist => refuse everything. */
export function denylistHit(line: string): string | null {
  const rules = load(process.env.CONTROL_DENYLIST || defaultPath());
  if (rules === null) return UNAVAILABLE;
  for (const r of rules) if (r.re.test(line)) return r.name;
  return URL_RULE.re.test(line) ? URL_RULE.name : null;
}
