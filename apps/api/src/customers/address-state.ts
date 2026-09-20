import { normalizeUsState } from "../common/us-states";

/**
 * FOLDED state NAMES that free-text entry also uses for a CITY or town ("Washington" is a city in a
 * dozen states and the capital; "Kansas" is the Kansas City metro's shorthand). Lead ruling (#988,
 * `AMBIGUOUS_STATE_TEXTS`): such a text never resolves on its own, because a wrong `stateCode` silently
 * changes which jurisdiction's selling rules apply — a guess is worse than leaving it unset.
 * CRITERION: a state name is here when a real municipality of that name exists in ANOTHER state and the
 * text is plausibly typed for it.
 *
 * This is a HAND COPY of #988's set, minus its "wash" and "la" members: the strict normalizer never
 * resolves "Wash." / "L.A.", and a bare `LA` is Louisiana, so they cannot matter here. It is meant to be
 * DELETED and imported from the shared resolver once #988 lands and the zip-confirmed change ports it;
 * until then the two copies can drift, which is why the specs pin the BEHAVIOUR per name, not the array.
 */
export const AMBIGUOUS_STATE_TEXTS: ReadonlySet<string> = new Set([
  "washington",
  "kansas",
  "indiana",
  "delaware",
  "oregon",
  "nevada",
  "wyoming",
  "virginia",
  "california",
  "louisiana",
  "florida",
  "georgia",
]);

/**
 * The two `CustomerAddress` columns the selling-restrictions engine reads, derived from the
 * free-text `state` at the WRITE boundary. The engine reads ONLY `stateCode` (never `state`), so a
 * writer that stores a state without deriving it leaves the customer unresolved (INDETERMINATE —
 * blocks every state-rule product), and one that EDITS `state` without recomputing leaves the old
 * code in place: the customer keeps resolving to the state they left (a ban in the new state never
 * binds — a fail-open). Every writer of a state spreads this.
 *
 * Never a guess: an unresolvable value (blank, "Unknown", a misspelling, a territory the normalizer
 * does not carry) AND an AMBIGUOUS name ("Washington", "Oregon", ... — `AMBIGUOUS_STATE_TEXTS`; a bare
 * 2-letter code is never ambiguous) is `stateCode: null` + `stateNeedsReview: true`. It is not
 * rejected — the customer must still be creatable — it fails closed in the engine and is listed by
 * the "State needs review" chip.
 */
export function addressStateFields(state: string | null | undefined): {
  stateCode: string | null;
  stateNeedsReview: boolean;
} {
  const code = normalizeUsState(state);
  const key = (state ?? "").trim().toLowerCase();
  const stateCode = code !== null && AMBIGUOUS_STATE_TEXTS.has(key) ? null : code;
  return { stateCode, stateNeedsReview: stateCode === null };
}
