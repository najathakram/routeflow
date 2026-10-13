import { resolveAddressState } from "../common/us-address-state";

/**
 * The two `CustomerAddress` columns the selling-restrictions engine reads, derived from the
 * free-text `state` AND the row's `zip` at the WRITE boundary. The engine reads ONLY `stateCode`
 * (never `state`), so a writer that stores a state without deriving it leaves the customer unresolved
 * (INDETERMINATE — blocks every state-rule product), and one that EDITS `state` without recomputing
 * leaves the old code in place: the customer keeps resolving to the state they left (a ban in the
 * new state never binds — a fail-open). Every writer of a state spreads this
 * (`address-writers-inventory.spec.ts` fails the build for one that does not).
 *
 * The rules are the backfill's (`common/us-address-state.ts`, pinned to the script): aliases and a
 * trailing zip/country resolve ("Calif.", "TX 77001"); a resolved code a usable zip CONTRADICTS is
 * ZIP_CONFLICT; and an AMBIGUOUS text ("Washington", "Oregon", ... — also a city's name) resolves ONLY
 * with a civilian zip that CONFIRMS it, so "Washington" + 98xxx is WA and + 200xx or no zip is not.
 *
 * Never a guess: anything unresolved (blank, "Unknown", a misspelling, a contradicting zip, an
 * unconfirmed ambiguous text) is `stateCode: null` + `stateNeedsReview: true`. It is not rejected — the
 * customer must still be creatable — it fails closed in the engine and is listed by the "State needs
 * review" chip.
 */
export function addressStateFields(
  state: string | null | undefined,
  zip: string | null | undefined,
): {
  stateCode: string | null;
  stateNeedsReview: boolean;
} {
  const { code } = resolveAddressState(state, zip);
  return { stateCode: code, stateNeedsReview: code === null };
}

/** The three state columns of one address, as captured before a bulk state fix. */
export interface AddressStateSnapshot {
  state: string;
  stateCode: string | null;
  stateNeedsReview: boolean;
}

/**
 * UNDO ONLY: puts back exactly the three state columns a bulk state fix captured from the row a moment
 * earlier — a restore of what the write boundary already stored, never a new state. A writer that
 * stores a NEW state uses `addressStateFields` (`address-writers-inventory.spec.ts` classifies a call
 * through this helper as RESTORE and no other).
 */
export function restoredStateFields(snapshot: AddressStateSnapshot): AddressStateSnapshot {
  return {
    state: snapshot.state,
    stateCode: snapshot.stateCode,
    stateNeedsReview: snapshot.stateNeedsReview,
  };
}
