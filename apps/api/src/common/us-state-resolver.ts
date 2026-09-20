import { US_STATES, normalizeUsState } from "./us-states";

/**
 * The TEXT half of resolving a free-text US state to a code — an API-side port of the lifted rules in
 * `apps/api/scripts/lib/address-state-normalize.mjs` (`classifyLocal`, the owner-run backfill), pinned to
 * it by `us-state-resolver.parity.spec.ts`, which runs the script's own functions over a generated
 * corpus and requires identical results. The strict `normalizeUsState` (exact code / full name) stays
 * the rule editor's and the engine's; this adds what the backfill has always resolved — punctuated /
 * GPO-AP abbreviations ("Calif.", "N.Y."), ONE trailing zip and/or country token ("TX 77001",
 * "Texas, USA") — and FLAGS the texts that are also a city's name (`ambiguous`), which must never
 * resolve without a confirming zip (lead ruling, #988). Nothing is fuzzy: "Tejas" stays unresolved.
 * The zip half (cross-check / confirmation) is a separate module.
 */

/** The traditional GPO/AP abbreviations, FOLDED (lowercase, no periods), and nothing else. */
// prettier-ignore
export const US_STATE_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["ala", "AL"], ["ariz", "AZ"], ["ark", "AR"], ["calif", "CA"],
  ["colo", "CO"], ["conn", "CT"], ["del", "DE"], ["fla", "FL"],
  ["ga", "GA"], ["ill", "IL"], ["ind", "IN"], ["kan", "KS"],
  ["ky", "KY"], ["la", "LA"], ["mass", "MA"], ["md", "MD"],
  ["mich", "MI"], ["minn", "MN"], ["miss", "MS"], ["mo", "MO"],
  ["mont", "MT"], ["neb", "NE"], ["nev", "NV"], ["nh", "NH"],
  ["nj", "NJ"], ["nm", "NM"], ["ny", "NY"], ["nc", "NC"],
  ["nd", "ND"], ["okla", "OK"], ["ore", "OR"], ["pa", "PA"],
  ["penn", "PA"], ["penna", "PA"], ["ri", "RI"], ["sc", "SC"],
  ["sd", "SD"], ["tenn", "TN"], ["tex", "TX"], ["vt", "VT"],
  ["va", "VA"], ["wash", "WA"], ["wva", "WV"], ["wis", "WI"],
  ["wyo", "WY"], ["dc", "DC"],
];

/**
 * FOLDED state texts that free-text entry also uses for a CITY or town ("Washington" is a city in a
 * dozen states and the capital; "Kansas" is the Kansas City metro's shorthand; "L.A." is Los Angeles).
 * Such a text never resolves on its own: a wrong `stateCode` silently changes which jurisdiction's
 * selling rules apply, so a guess is worse than leaving it unset. Same set as the script's.
 */
// prettier-ignore
export const AMBIGUOUS_STATE_TEXTS: ReadonlySet<string> = new Set([
  "washington", "wash", "kansas", "indiana", "delaware",
  "oregon", "nevada", "wyoming", "virginia", "california",
  "louisiana", "florida", "georgia", "la",
]);

// A Map, never an object: `constructor` / `__proto__` must miss.
const ALIAS_MAP = new Map(US_STATE_ALIASES);
const CODE_SET = new Set(US_STATES.map((s) => s.code));

/** Lowercase, `.` deleted (`N.Y.` -> `ny`), `,` -> space, whitespace collapsed; no Unicode folding. */
export function foldState(raw: string): string {
  return String(raw)
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const FOLDED_NAME_MAP = new Map(US_STATES.map((s) => [foldState(s.name), s.code]));

export type StateTextRule = "exact" | "folded-code" | "folded-name" | "alias" | "stripped";

function lookupFolded(folded: string): { code: string; rule: StateTextRule } | null {
  const upper = folded.toUpperCase();
  if (upper.length === 2 && CODE_SET.has(upper)) return { code: upper, rule: "folded-code" };
  const byName = FOLDED_NAME_MAP.get(folded);
  if (byName) return { code: byName, rule: "folded-name" };
  const byAlias = ALIAS_MAP.get(folded);
  if (byAlias) return { code: byAlias, rule: "alias" };
  return null;
}

const ZIP_TOKEN = /^\d{5}(?:-\d{4})?$/;
const COUNTRY_PHRASES = [
  ["united", "states", "of", "america"],
  ["united", "states"],
  ["usa"],
  ["us"],
];

/** Drops ONE trailing zip and/or ONE trailing country token (either order) from a FOLDED string.
 *  `remainder` is `null` when nothing was removed or nothing is left; `zip` is the removed zip token. */
export function splitTrailingZipCountry(folded: string): {
  remainder: string | null;
  zip: string | null;
} {
  const tokens = folded === "" ? [] : folded.split(" ");
  let zipDone = false;
  let countryDone = false;
  let removed = false;
  let zip: string | null = null;
  for (let guard = 0; guard < 2 && tokens.length > 0; guard++) {
    const last = tokens[tokens.length - 1] ?? "";
    if (!zipDone && ZIP_TOKEN.test(last)) {
      zip = tokens.pop() ?? null;
      zipDone = true;
      removed = true;
      continue;
    }
    const phrase = countryDone
      ? undefined
      : COUNTRY_PHRASES.find(
          (p) =>
            tokens.length >= p.length &&
            p.every((word, i) => tokens[tokens.length - p.length + i] === word),
        );
    if (phrase) {
      tokens.splice(tokens.length - phrase.length, phrase.length);
      countryDone = true;
      removed = true;
      continue;
    }
    break;
  }
  return { remainder: removed && tokens.length > 0 ? tokens.join(" ") : null, zip };
}

export interface StateTextResolution {
  code: string;
  rule: StateTextRule;
  /** The text is also a city's name: the caller must demand a confirming zip. A bare 2-letter code never is. */
  ambiguous: boolean;
  /** A zip written INSIDE the state text ("Washington 20001"), for the zip cross-check. */
  embeddedZip: string | null;
}

/**
 * A free-text state -> its code and how it was reached, or `null` when nothing resolves (blank,
 * "Unknown", a misspelling, a territory the table does not carry). Precedence, first hit wins: the
 * strict `normalizeUsState`; the folded text as a code / name / alias; the same after stripping ONE
 * trailing zip and/or country token.
 */
export function resolveStateText(raw: string | null | undefined): StateTextResolution | null {
  const text = typeof raw === "string" ? raw : "";
  if (text.trim() === "") return null;
  const exact = normalizeUsState(text);
  if (exact) {
    const key = foldState(text);
    return {
      code: exact,
      rule: "exact",
      ambiguous: key.length > 2 && AMBIGUOUS_STATE_TEXTS.has(key),
      embeddedZip: null,
    };
  }
  const folded = foldState(text);
  const viaFold = lookupFolded(folded);
  if (viaFold)
    return { ...viaFold, ambiguous: AMBIGUOUS_STATE_TEXTS.has(folded), embeddedZip: null };
  const { remainder, zip } = splitTrailingZipCountry(folded);
  const viaStrip = remainder === null ? null : lookupFolded(remainder);
  return viaStrip && remainder !== null
    ? {
        code: viaStrip.code,
        rule: "stripped",
        ambiguous: AMBIGUOUS_STATE_TEXTS.has(remainder),
        embeddedZip: zip,
      }
    : null;
}
