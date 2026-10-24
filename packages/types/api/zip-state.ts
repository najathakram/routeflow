// ZIP-prefix -> state SUGGESTION (state-restrictions-ux spec, Addendum D). Pure, no imports.
//
// THIS IS ONLY A SUGGESTION. It pre-fills the state picker on the "Customers without a state on
// file" card; a person always confirms it before anything is saved, and nothing ever stores a state
// from it on its own. Never use it to decide which jurisdiction's selling rules apply: that is
// `CustomerAddress.stateCode`, which a person (or the write-boundary resolver) sets.
//
// The table is the USPS 3-digit ZIP prefix allocation, one state per prefix: where a prefix serves
// more than one state (063 also covers Fishers Island NY, 201 is Dulles VA beside DC's 200/202-205,
// 733 is the Austin TX IRS prefix inside Oklahoma's range, 834 also covers Alta WY, 967 also covers
// American Samoa, 969 also covers the Northern Mariana Islands) it names the state that most of
// the prefix's addresses are in. Prefixes with no reliable state return null: military APO/FPO
// (090-099, 340, 962-966), agency-only prefixes (459, 569) and every unassigned prefix. Territories
// return their own code only where `US_STATES` carries it (PR, VI, GU).
//
// `apps/api/src/common/zip-state.ts` is the API's copy (the API never value-imports this
// package); `zip-state.parity.spec.ts` pins the two identical, and pins every suggestion to the
// write-boundary resolver's own ZIP3 table (`us-zip3.ts`): a suggestion is always one of the
// states that table allows for the prefix, and null exactly where that table has no answer.

/** [first prefix, last prefix, USPS state code], ascending and non-overlapping. */
// prettier-ignore
export const ZIP3_STATE_SUGGESTIONS: ReadonlyArray<readonly [string, string, string]> = [
  ["005", "005", "NY"], ["006", "007", "PR"], ["008", "008", "VI"], ["009", "009", "PR"],
  ["010", "027", "MA"], ["028", "029", "RI"], ["030", "038", "NH"], ["039", "049", "ME"],
  ["050", "054", "VT"], ["055", "055", "MA"], ["056", "059", "VT"], ["060", "069", "CT"],
  ["070", "089", "NJ"], ["100", "149", "NY"], ["150", "196", "PA"], ["197", "199", "DE"],
  ["200", "200", "DC"], ["201", "201", "VA"], ["202", "205", "DC"], ["206", "219", "MD"],
  ["220", "246", "VA"], ["247", "268", "WV"], ["270", "289", "NC"], ["290", "299", "SC"],
  ["300", "319", "GA"], ["320", "339", "FL"], ["341", "349", "FL"], ["350", "369", "AL"],
  ["370", "385", "TN"], ["386", "397", "MS"], ["398", "399", "GA"], ["400", "427", "KY"],
  ["430", "458", "OH"], ["460", "479", "IN"], ["480", "499", "MI"], ["500", "528", "IA"],
  ["530", "549", "WI"], ["550", "567", "MN"], ["570", "577", "SD"], ["580", "588", "ND"],
  ["590", "599", "MT"], ["600", "629", "IL"], ["630", "658", "MO"], ["660", "679", "KS"],
  ["680", "693", "NE"], ["700", "714", "LA"], ["716", "729", "AR"], ["730", "732", "OK"],
  ["733", "733", "TX"], ["734", "749", "OK"], ["750", "799", "TX"], ["800", "816", "CO"],
  ["820", "831", "WY"], ["832", "838", "ID"], ["840", "847", "UT"], ["850", "865", "AZ"],
  ["870", "884", "NM"], ["885", "885", "TX"], ["889", "898", "NV"], ["900", "961", "CA"],
  ["967", "968", "HI"], ["969", "969", "GU"], ["970", "979", "OR"], ["980", "994", "WA"],
  ["995", "999", "AK"],
];

const SUGGESTION_BY_PREFIX = new Map<string, string>();
for (const [low, high, state] of ZIP3_STATE_SUGGESTIONS)
  for (let n = Number(low); n <= Number(high); n++)
    SUGGESTION_BY_PREFIX.set(String(n).padStart(3, "0"), state);

/** A 5-digit ZIP, optionally followed by +4 (hyphen, space or nothing between). */
const ZIP = /^(\d{3})\d{2}(?:[-\s]?\d{4})?$/;

/**
 * The state a ZIP most likely belongs to, as a 2-letter USPS code, or null when there is no
 * reliable answer: not a 5-digit ZIP / ZIP+4 (surrounding whitespace is ignored; letters, fewer
 * than 5 digits or a bare prefix are null), or a prefix with no state (military, agency,
 * unassigned). A SUGGESTION for a person to confirm, never a stored state.
 */
export function suggestStateFromZip(zip: string | null | undefined): string | null {
  if (typeof zip !== "string") return null;
  const prefix = ZIP.exec(zip.trim())?.[1];
  return prefix ? (SUGGESTION_BY_PREFIX.get(prefix) ?? null) : null;
}
