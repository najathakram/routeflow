// US state/territory table + `normalizeUsState` — plain-JS VERBATIM MIRROR of
// packages/types/api/us-states.ts, for the standalone `.mjs` scripts that run under bare `node`
// (invoked via `railway run`) and therefore cannot import TypeScript.
//
// MIRROR, NOT SOURCE OF TRUTH — same convention as lib/feature-registry-mirror.cjs. Any change
// belongs in packages/types/api/us-states.ts FIRST, ported here in the SAME PR.
// `apps/api/src/common/us-states-script-mirror.parity.spec.ts` makes that promise mechanical: it
// imports the real TypeScript module and asserts this table is deep-equal and that
// `normalizeUsState` agrees on every code, name, case, padding and a set of junk inputs.
//
// Consumed by lib/address-state-normalize.mjs (the classifier behind
// apps/api/scripts/normalize-address-states.mjs).

export const US_STATES = [
  { code: "AL", name: "Alabama" },
  { code: "AK", name: "Alaska" },
  { code: "AZ", name: "Arizona" },
  { code: "AR", name: "Arkansas" },
  { code: "CA", name: "California" },
  { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" },
  { code: "DE", name: "Delaware" },
  { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" },
  { code: "HI", name: "Hawaii" },
  { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" },
  { code: "IN", name: "Indiana" },
  { code: "IA", name: "Iowa" },
  { code: "KS", name: "Kansas" },
  { code: "KY", name: "Kentucky" },
  { code: "LA", name: "Louisiana" },
  { code: "ME", name: "Maine" },
  { code: "MD", name: "Maryland" },
  { code: "MA", name: "Massachusetts" },
  { code: "MI", name: "Michigan" },
  { code: "MN", name: "Minnesota" },
  { code: "MS", name: "Mississippi" },
  { code: "MO", name: "Missouri" },
  { code: "MT", name: "Montana" },
  { code: "NE", name: "Nebraska" },
  { code: "NV", name: "Nevada" },
  { code: "NH", name: "New Hampshire" },
  { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" },
  { code: "NY", name: "New York" },
  { code: "NC", name: "North Carolina" },
  { code: "ND", name: "North Dakota" },
  { code: "OH", name: "Ohio" },
  { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" },
  { code: "PA", name: "Pennsylvania" },
  { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "South Carolina" },
  { code: "SD", name: "South Dakota" },
  { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" },
  { code: "UT", name: "Utah" },
  { code: "VT", name: "Vermont" },
  { code: "VA", name: "Virginia" },
  { code: "WA", name: "Washington" },
  { code: "WV", name: "West Virginia" },
  { code: "WI", name: "Wisconsin" },
  { code: "WY", name: "Wyoming" },
  { code: "DC", name: "District of Columbia" },
  { code: "PR", name: "Puerto Rico" },
  { code: "GU", name: "Guam" },
  { code: "VI", name: "U.S. Virgin Islands" },
  { code: "AS", name: "American Samoa" },
  { code: "MP", name: "Northern Mariana Islands" },
];

const CODE_SET = new Set(US_STATES.map((s) => s.code));
const NAME_TO_CODE = new Map(US_STATES.map((s) => [s.name.toLowerCase(), s.code]));

/**
 * Normalizes a free-text state value to a 2-letter USPS code, or `null` when it
 * cannot be resolved unambiguously (selling-restrictions plan §2.5: unresolved
 * ⇒ the caller treats it as INDETERMINATE, never a silently-assumed state).
 * Trims + case-folds; matches a bare code ("tx", " TX ") or a full name
 * ("Texas", "TEXAS"). `""`, `"Unknown"`, and anything else (e.g. "Tejas") ⇒ null.
 */
export function normalizeUsState(input) {
  if (input == null) return null;
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const upper = trimmed.toUpperCase();
  if (upper.length === 2 && CODE_SET.has(upper)) return upper;
  const byName = NAME_TO_CODE.get(trimmed.toLowerCase());
  return byName ?? null;
}
