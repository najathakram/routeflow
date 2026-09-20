/**
 * USPS 3-digit-ZIP-prefix (ZIP3) -> state(s) table: an API-side port of `apps/api/scripts/lib/us-zip3.mjs`
 * (the owner-run backfill's table), pinned to it by `us-address-state.parity.spec.ts`. THE ONE DESIGN
 * RULE: a false CONFLICT is acceptable (the row is only listed for review); a false AGREEMENT is not. So a
 * ZIP3 that spans several states lists EVERY state it can belong to, and a ZIP3 with NO reliable state
 * (military APO/FPO 090-099, 340, 962-966, agency prefixes 459 / 569, every unassigned prefix) is ABSENT:
 * `zip3States` returns `null` for it — "no data" is never "conflicts with everything". Widening a range
 * widens what CONFIRMS a state as well as what conflicts; narrowing weakens neither.
 */
// prettier-ignore
export const ZIP3_RANGES: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ["005", "005", ["NY"]], ["006", "007", ["PR"]], ["008", "008", ["VI"]],
  ["009", "009", ["PR"]], ["010", "027", ["MA"]], ["028", "029", ["RI"]],
  ["030", "038", ["NH"]], ["039", "049", ["ME"]], ["050", "054", ["VT"]],
  ["055", "055", ["MA", "VT"]], ["056", "059", ["VT"]], ["060", "062", ["CT"]],
  ["063", "063", ["CT", "NY"]], ["064", "069", ["CT"]], ["070", "089", ["NJ"]],
  ["100", "149", ["NY"]], ["150", "196", ["PA"]], ["197", "199", ["DE"]],
  ["200", "205", ["DC", "MD", "VA"]], ["206", "209", ["MD", "DC"]], ["210", "219", ["MD"]],
  ["220", "245", ["VA"]], ["246", "247", ["VA", "WV"]], ["248", "268", ["WV"]],
  ["270", "289", ["NC"]], ["290", "299", ["SC"]], ["300", "319", ["GA"]],
  ["320", "339", ["FL"]], ["341", "349", ["FL"]], ["350", "369", ["AL"]],
  ["370", "385", ["TN"]], ["386", "397", ["MS"]], ["398", "399", ["GA"]],
  ["400", "427", ["KY"]], ["430", "458", ["OH"]], ["460", "479", ["IN"]],
  ["480", "499", ["MI"]], ["500", "528", ["IA"]], ["530", "549", ["WI"]],
  ["550", "567", ["MN"]], ["570", "577", ["SD"]], ["580", "588", ["ND"]],
  ["590", "599", ["MT"]], ["600", "629", ["IL"]], ["630", "658", ["MO"]],
  ["660", "679", ["KS"]], ["680", "693", ["NE"]], ["700", "714", ["LA"]],
  ["716", "729", ["AR"]], ["730", "732", ["OK"]], ["733", "733", ["TX", "OK"]],
  ["734", "749", ["OK"]], ["750", "799", ["TX"]], ["800", "816", ["CO"]],
  ["820", "831", ["WY"]], ["832", "833", ["ID"]], ["834", "834", ["ID", "WY"]],
  ["835", "838", ["ID"]], ["840", "847", ["UT"]], ["850", "865", ["AZ"]],
  ["870", "884", ["NM"]], ["885", "885", ["TX"]], ["889", "898", ["NV"]],
  ["900", "961", ["CA"]], ["967", "967", ["HI", "AS"]], ["968", "968", ["HI"]],
  ["969", "969", ["GU", "MP"]], ["970", "979", ["OR"]], ["980", "994", ["WA"]],
  ["995", "999", ["AK"]],
];

const ZIP3_MAP = new Map<string, readonly string[]>();
for (const [low, high, states] of ZIP3_RANGES)
  for (let n = Number(low); n <= Number(high); n++)
    ZIP3_MAP.set(String(n).padStart(3, "0"), Object.freeze([...states]));

const FIVE_DIGIT_ZIP = /^(\d{3})\d{2}(?:-\d{4})?$/;
const THREE_DIGIT_PREFIX = /^\d{3}$/;

/** The 3-digit prefix of a parseable 5-digit ZIP / ZIP+4, else `null`. */
export function zip3Prefix(zip: string | null | undefined): string | null {
  if (typeof zip !== "string") return null;
  return FIVE_DIGIT_ZIP.exec(zip.trim())?.[1] ?? null;
}

/** The state codes a ZIP (5-digit, ZIP+4 or a bare 3-digit prefix) can belong to, or `null` when there
 *  is NO reliable answer. `null` means "do not check", never "conflicts". */
export function zip3States(zip: string | null | undefined): readonly string[] | null {
  if (typeof zip !== "string") return null;
  const text = zip.trim();
  const prefix = THREE_DIGIT_PREFIX.test(text) ? text : FIVE_DIGIT_ZIP.exec(text)?.[1];
  return prefix ? (ZIP3_MAP.get(prefix) ?? null) : null;
}
