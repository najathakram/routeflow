// Client-name masking. A live tenant's name or slug never leaves the machine: the list lives in
// <opsHome>/client-names.json (outside both repos, filled by the lead); online it comes from the
// CLIENT_NAMES_JSON secret variable. Every masked name becomes "a live business".
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { opsHome } from "./config.mjs";

export const MASK_LABEL = "a live business";
export const NAMES_FILE = "client-names.json";
/** The only line the brief prints when the names file is unreadable (never any item text). */
export const BRIEF_DISABLED_NOTE = "ops brief disabled: client-names.json unreadable";
const RECHECK_MS = 60_000;

const cleanList = (v) => {
  const list = Array.isArray(v) ? v : Array.isArray(v?.names) ? v.names : [];
  return list.filter((n) => typeof n === "string" && n.trim()).map((n) => n.trim());
};

/** Parses a names source. Returns { names, error }: unparsable or wrong-shaped -> error (never the text). */
function readSource(text, label) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { names: [], error: `${label} does not parse` };
  }
  if (!Array.isArray(parsed) && !Array.isArray(parsed?.names)) {
    return { names: [], error: `${label} does not hold a list of names` };
  }
  return { names: cleanList(parsed), error: null };
}

/** The file's path for this env/home. */
export const namesFile = (env = process.env, home) => join(home ?? opsHome(env), NAMES_FILE);

/**
 * Names to mask: the machine-local file (a JSON array, or { names: [...] }) wins; without the
 * file, CLIENT_NAMES_JSON (a JSON array in a secret variable, used online). Neither -> no names.
 * Returns { names, error }: a source that exists but does not parse is an ERROR (names: []), so
 * callers can refuse to publish rather than silently run unmasked. Never throws, never returns or
 * logs the source text.
 */
export function loadClientNames({ env = process.env, home } = {}) {
  let text = null;
  try {
    text = readFileSync(namesFile(env, home), "utf8");
  } catch {
    text = null;
  }
  if (text !== null) return readSource(text, NAMES_FILE);
  if (env.CLIENT_NAMES_JSON) return readSource(env.CLIENT_NAMES_JSON, "CLIENT_NAMES_JSON");
  return { names: [], error: null };
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Compiles the names into a text -> text function (longest name first, whole word, any case). */
export function makeMasker(names) {
  const list = cleanList(names).sort((a, b) => b.length - a.length);
  if (list.length === 0) return (t) => t;
  const re = new RegExp(`(?<![A-Za-z0-9])(?:${list.map(esc).join("|")})(?![A-Za-z0-9])`, "gi");
  return (t) => (typeof t === "string" ? t.replace(re, MASK_LABEL) : t);
}

/** Masks one string. Non-strings pass through. */
export function maskText(text, names) {
  return makeMasker(names)(text);
}

/** A deep masker built once: every string value masked, keys untouched. No names -> identity. */
export function deepMasker(names) {
  const mask = makeMasker(names);
  if (cleanList(names).length === 0) return (obj) => obj;
  const walk = (v) => {
    if (typeof v === "string") return mask(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk;
}

/** Deep copy with every string value masked (keys untouched). No names -> the input itself. */
export function maskDeep(obj, names) {
  return deepMasker(names)(obj);
}

/**
 * A cached name list that re-reads the file when its mtime changes, checking at most every
 * `intervalMs` (60 s). `now` is injectable for tests.
 */
export function createNameLoader({
  env = process.env,
  home,
  now = Date.now,
  intervalMs = RECHECK_MS,
} = {}) {
  const file = namesFile(env, home);
  let names = null;
  let error = null;
  let checkedAt = -Infinity;
  let stamp = null;
  const statStamp = () => {
    try {
      const s = statSync(file);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return "none";
    }
  };
  return {
    /** The last load's error (null when fine); call after get(). */
    error: () => error,
    get() {
      const t = now();
      if (names !== null && t - checkedAt < intervalMs) return names;
      checkedAt = t;
      const next = statStamp();
      if (names === null || next !== stamp) {
        stamp = next;
        const r = loadClientNames({ env, home });
        error = r.error;
        // A file that broke after a good load keeps the last good list (never silently unmasks).
        if (!(r.error && names && names.length)) names = r.names;
      }
      return names;
    },
  };
}
