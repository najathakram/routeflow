/**
 * S5 (RULES-AUDIT C19): the till never assumes who is buying. "Who's buying?" is answered by naming a customer or by
 * one explicit Walk-in tap; until then Complete is off. Pure rules and fixed copy; the state lives in
 * `useCounterBuyerChoice`.
 */
export type BuyerKind = "customer" | "walk-in" | null;

export const BUYER_QUESTION_COPY = "Who's buying?";
export const BUYER_HINT_COPY = "Find a customer below, or tap Walk-in.";
/** The visible reason beside the disabled Complete buttons (and the Enter-key refusal). */
export const BUYER_REASON_COPY = "Choose who's buying";

/** The shape the screen holds: a picked customer, or null (which says nothing by itself). */
interface PickedLike {
  isWalkIn?: boolean | null;
}

/** What picking `c` means: the system walk-in record is still a Walk-in choice. */
export function kindOfPick(c: PickedLike): "customer" | "walk-in" {
  return c.isWalkIn ? "walk-in" : "customer";
}

/**
 * The choice a restored cart carries (parked, resumed, refreshed or a held attempt). A customer on the cart IS the choice;
 * a cart without one keeps Walk-in only if Walk-in was explicitly chosen when it was saved; an older save says nothing,
 * so the till asks.
 */
export function restoredBuyerKind(customer: PickedLike | null, walkInChosen: boolean): BuyerKind {
  if (customer) return kindOfPick(customer);
  return walkInChosen ? "walk-in" : null;
}
