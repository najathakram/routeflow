import { normalizeUsState } from "../common/us-states";

/**
 * The two `CustomerAddress` columns the selling-restrictions engine reads, derived from the
 * free-text `state` at the WRITE boundary. The engine reads ONLY `stateCode` (never `state`), so a
 * writer that stores a state without deriving it leaves the customer unresolved (INDETERMINATE —
 * blocks every state-rule product), and one that EDITS `state` without recomputing leaves the old
 * code in place: the customer keeps resolving to the state they left (a ban in the new state never
 * binds). Every non-spec writer of a state spreads this; `address-state.spec.ts` fails the build
 * for a `customerAddress` write nobody has classified.
 *
 * An unresolvable value (blank, "Unknown", a misspelling, a territory the normalizer does not
 * carry) is never rejected — the customer must still be creatable — it is `stateCode: null` +
 * `stateNeedsReview: true`: fail closed in the engine, listed by the "State needs review" chip.
 */
export function addressStateFields(state: string | null | undefined): {
  stateCode: string | null;
  stateNeedsReview: boolean;
} {
  const stateCode = normalizeUsState(state);
  return { stateCode, stateNeedsReview: stateCode === null };
}
