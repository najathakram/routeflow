// USPS 3-digit-ZIP-prefix (ZIP3) -> state(s) table, for the standalone
// `normalize-address-states.mjs` backfill. Pure data plus one lookup; no I/O, no imports.
//
// WHY IT EXISTS. A free-text state that folds to a code can still be WRONG for the row: bare
// "Washington" resolves WA even when the zip is a DC 200xx one, and "L.A." folds to the alias `la`
// (Louisiana) for a Los Angeles row. The jurisdiction engine reads only `stateCode`, and a wrong
// state can make a banned sale look allowed, so a resolution that CONTRADICTS the row's own zip is
// listed for review instead of written (`UNRESOLVED:ZIP_CONFLICT` in address-state-normalize.mjs).
//
// THE ONE DESIGN RULE: a false CONFLICT is acceptable (the row is only listed for the owner); a
// false AGREEMENT is not (it would let a wrong state through). So:
//   - a ZIP3 that genuinely spans more than one state lists EVERY state it can belong to;
//   - a ZIP3 with NO reliable state (military APO/FPO 090-099, 340, 962-966, and every unassigned
//     prefix) is simply ABSENT, and `zip3States` returns `null` for it — "no data" is never
//     "conflicts with everything".
// Where a prefix is not certain, the allowed set is widened here rather than guessed narrow.
// Ranges are inclusive, sorted, and non-overlapping; the spec pins all three.

/** [low, high, allowed state codes] — every code is a member of lib/us-states.mjs's US_STATES. */
export const ZIP3_RANGES = [
  ["005", "005", ["NY"]], // Holtsville IRS
  ["006", "007", ["PR"]],
  ["008", "008", ["VI"]],
  ["009", "009", ["PR"]],
  ["010", "027", ["MA"]],
  ["028", "029", ["RI"]],
  ["030", "038", ["NH"]],
  ["039", "049", ["ME"]],
  ["050", "054", ["VT"]],
  ["055", "055", ["MA", "VT"]], // 055 is the Andover MA IRS center inside the VT block
  ["056", "059", ["VT"]],
  ["060", "062", ["CT"]],
  ["063", "063", ["CT", "NY"]], // Fishers Island NY sits in the CT block
  ["064", "069", ["CT"]],
  ["070", "089", ["NJ"]],
  // 090-099: military (AE) — deliberately absent
  ["100", "149", ["NY"]],
  ["150", "196", ["PA"]],
  ["197", "199", ["DE"]],
  ["200", "205", ["DC", "MD", "VA"]], // the DC block borders (and the Pentagon area overlaps) MD / VA
  ["206", "209", ["MD", "DC"]],
  ["210", "219", ["MD"]],
  ["220", "245", ["VA"]],
  ["246", "247", ["VA", "WV"]], // Bluefield straddles the VA / WV line
  ["248", "268", ["WV"]],
  ["270", "289", ["NC"]],
  ["290", "299", ["SC"]],
  ["300", "319", ["GA"]],
  ["320", "339", ["FL"]],
  // 340: AA military — deliberately absent
  ["341", "349", ["FL"]],
  ["350", "369", ["AL"]],
  ["370", "385", ["TN"]],
  ["386", "397", ["MS"]],
  ["398", "399", ["GA"]],
  ["400", "427", ["KY"]],
  ["430", "458", ["OH"]],
  // 459: IRS Cincinnati (45999) — an agency prefix, deliberately absent
  ["460", "479", ["IN"]],
  ["480", "499", ["MI"]],
  ["500", "528", ["IA"]],
  ["530", "549", ["WI"]],
  ["550", "567", ["MN"]],
  // 569: federal Washington DC — an agency prefix, deliberately absent
  ["570", "577", ["SD"]],
  ["580", "588", ["ND"]],
  ["590", "599", ["MT"]],
  ["600", "629", ["IL"]],
  ["630", "658", ["MO"]],
  ["660", "679", ["KS"]],
  ["680", "693", ["NE"]],
  ["700", "714", ["LA"]],
  ["716", "729", ["AR"]],
  ["730", "732", ["OK"]],
  ["733", "733", ["TX", "OK"]], // Austin IRS center sits in the OK block
  ["734", "749", ["OK"]],
  ["750", "799", ["TX"]],
  ["800", "816", ["CO"]],
  ["820", "831", ["WY"]],
  ["832", "833", ["ID"]],
  ["834", "834", ["ID", "WY"]], // Alta WY carries a 834 prefix
  ["835", "838", ["ID"]],
  ["840", "847", ["UT"]],
  ["850", "865", ["AZ"]],
  ["870", "884", ["NM"]],
  ["885", "885", ["TX"]], // El Paso
  ["889", "898", ["NV"]],
  ["900", "961", ["CA"]],
  // 962-966: military (AP) — deliberately absent
  ["967", "967", ["HI", "AS"]], // American Samoa is 96799
  ["968", "968", ["HI"]],
  ["969", "969", ["GU", "MP"]],
  ["970", "979", ["OR"]],
  ["980", "994", ["WA"]],
  ["995", "999", ["AK"]],
];

const ZIP3_MAP = new Map();
for (const [low, high, states] of ZIP3_RANGES) {
  for (let n = Number(low); n <= Number(high); n++) {
    ZIP3_MAP.set(String(n).padStart(3, "0"), Object.freeze([...states]));
  }
}

const FIVE_DIGIT_ZIP = /^(\d{3})\d{2}(?:-\d{4})?$/;
const THREE_DIGIT_PREFIX = /^\d{3}$/;

/**
 * The state codes a ZIP can belong to, or `null` when there is NO reliable answer — an unparseable
 * value, a blank, a military prefix, or an unassigned one. `null` means "do not check", never
 * "conflicts".
 *
 * @param {string|null|undefined} zip a 5-digit ZIP, a ZIP+4, or a bare 3-digit prefix (padding ok)
 * @returns {readonly string[]|null}
 */
export function zip3States(zip) {
  if (typeof zip !== "string") return null;
  const text = zip.trim();
  const prefix = THREE_DIGIT_PREFIX.test(text) ? text : FIVE_DIGIT_ZIP.exec(text)?.[1];
  return prefix ? (ZIP3_MAP.get(prefix) ?? null) : null;
}

/** The 3-digit prefix of a parseable 5-digit ZIP / ZIP+4, else `null`. */
export function zip3Prefix(zip) {
  if (typeof zip !== "string") return null;
  return FIVE_DIGIT_ZIP.exec(zip.trim())?.[1] ?? null;
}
