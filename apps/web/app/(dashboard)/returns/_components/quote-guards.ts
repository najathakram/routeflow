import { REFUND_COPY } from "./refund-copy";

/**
 * The inline-return dialog's last-line guards (SA-972 §2.2, review-a P1), pure. The footer already hides the buttons
 * they protect; these make sure no path (a keyboard submit, a quote that changes under a saved return) can send a walk-in
 * to store credit or capture a walk-in return that cannot be refunded.
 */

/** A walk-in cannot hold store credit. Keyed on the QUOTE's own flag: the dialog's derived `walkIn` is also false for a walk-in that cannot be refunded. */
export function walkInStoreCreditRefused(
  quote: { canRefund?: boolean | null; customerIsWalkIn?: boolean | null } | null | undefined,
): boolean {
  return !!quote?.customerIsWalkIn;
}

/** Why Confirm must not capture now (null = go ahead). A walk-in with no refund falls to the server's default, a credit note, so it is refused here. */
export function confirmRefusal(state: {
  walkInNoRefund: boolean;
  hasReason: boolean;
}): string | null {
  if (state.walkInNoRefund) return REFUND_COPY.walkInNoRefund;
  if (!state.hasReason) return "Choose a reason before confirming";
  return null;
}
