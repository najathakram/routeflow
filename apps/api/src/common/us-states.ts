// API-local MIRROR of `packages/types/api/us-states.ts` — keep the two IDENTICAL (pinned by
// `us-states.parity.spec.ts`). The API cannot value-import `@routeflow/types`: that package's entry
// point is raw TypeScript, so `nest build` would emit a runtime `require` and `node dist/main.js`
// would die at boot (see `no-runtime-workspace-imports.spec.ts`; same convention as `shipping.ts`).
// US state/territory reference + normalizer (2026-09-19, selling restrictions R2).
// Pure, no imports — used by both the API's normalize-address-states.mjs write
// boundary and the web rule editor's state picker.

export const US_STATES: ReadonlyArray<{ code: string; name: string }> = [
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
 *
 * OUT OF SCOPE BY DESIGN (decision 2026-09-19): the military postal codes AA / AE / AP and the
 * FM / MH / PW / UM codes are deliberately NOT in `US_STATES`, so an APO/FPO (or Micronesia,
 * Marshall Islands, Palau, U.S. minor outlying islands) address normalizes to `null` and its
 * governing state stays UNRESOLVED ⇒ INDETERMINATE. That is fail-closed on purpose: the address is
 * listed for review, never silently assigned a state. Do not add these codes without a ruling on
 * which jurisdiction's ban governs them; `us-states.parity.spec.ts` pins the current behaviour.
 */
export function normalizeUsState(input: string | null | undefined): string | null {
  if (input == null) return null;
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const upper = trimmed.toUpperCase();
  if (upper.length === 2 && CODE_SET.has(upper)) return upper;
  const byName = NAME_TO_CODE.get(trimmed.toLowerCase());
  return byName ?? null;
}
