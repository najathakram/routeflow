/**
 * SA-1506 PR-1a (Amendment 1 section E, Amendment 2 section D, SA-1408 words): the sentences the delivered-line refusals
 * say, in one leaf file (no imports) so the guards (delivered-line-lock.ts) and the decider's consumers read the same
 * words. The api cannot value-import `@routeflow/types`, so `LINE_LOCKED_COPY` / `LINE_STATUS_COPY` there are pinned
 * word for word to these tables by `delivered-line-edit-mode.parity.spec.ts` (L-072); web and mobile import the
 * `@routeflow/types` copy.
 *
 * Every sentence says why and names a step that exists (SA-C 7176923474): "Mark the order delivered again" is the Mark
 * delivered button, "Reopen the order" the order's button. None says a line can never be changed: ROUTE and RETURN say an
 * admin can correct it in the next update (PR-1c, same merge window).
 */
export const LOCKED_COPY = {
  REOPEN_FIRST: "Reopen the order to correct delivered items.",
  ON_RUN:
    "This order is on a delivery run. Complete its stop on the route, or take it off the run first.",
  ROUTE:
    "A driver delivered this item. Admins can correct it in the next update, landing with this one.",
  RETURN:
    "An item on this order had a return. Admins can correct it in the next update, landing with this one.",
  RETURN_BASIS:
    "The box size of {item} is unclear, so its return can't be counted. Check the item's box size, then try again.",
  RETURN_REMAINDER:
    "Part of {item} was never delivered and part was returned, so its quantity can't be lowered here. Mark the order delivered again, then record a return.",
  RETURN_PRICE:
    "{item} was returned at the old price. To change the price, issue a credit note for the difference.",
  SPLIT_BILL:
    "Part of this order is billed on another invoice. Mark the order delivered again, then record a return or add a new order.",
  WRITTEN_OFF:
    "Invoice {n} was written off, so this order is closed. Add anything missed on a new order.",
  SHIPMENT_BILLED:
    "This order was billed when it shipped. Mark the order delivered again, then record a return for the difference.",
  UNIT: "{item} is sold by unit and already invoiced. Mark the order delivered again, then record a return.",
} as const;

/** STATUS: one sentence per status that holds a delivered line outside CONFIRMED / PARTIALLY_DELIVERED / DELIVERED. */
export const STATUS_COPY: Readonly<Record<string, string>> = {
  PENDING: "Confirm the order to correct delivered items.",
  DRAFT: "Submit and confirm the order to correct delivered items.",
  OUT_FOR_DELIVERY: "Move the order back to Confirmed to correct delivered items.",
  REFUSED: "Use Deliver again, then correct delivered items.",
  CANCELLED: "This order is cancelled. Add anything missed on a new order.",
};

export const OPERATOR_NOTE = "Only an admin can correct a delivered line.";

/** SA-1408 item 3 / SA-C 7176923474 change 2: today's text plus the admin sentence, on a reopened order. */
export const OPERATOR_BELOW_MESSAGE =
  "This line's quantity can't be less than what was delivered. Only an admin can correct a delivered line. To take goods back, mark the order delivered again, then record a return.";
export const OPERATOR_REMOVED_MESSAGE =
  "This line was delivered, so it can't be removed. Only an admin can correct a delivered line. To take goods back, mark the order delivered again, then record a return.";

/** NEW-H1: CORRECT restates quantity, box split and price, or takes the line off: nothing that changes what the line is. */
export const CORRECT_IDENTITY_MESSAGE = "To swap this item, take it off and add the right one.";

/** M5: one save corrects the delivery; the return is its own step, because the two read the order's stock differently. */
export const CORRECT_WITH_RETURN_MESSAGE =
  "Save the delivered-item changes first, then add the return.";

/** The admin's cut would leave an invoice paid beyond its new total (PR-1a only; "For now" goes with PR-1b, SA-C change 3). */
export const CORRECT_OVERPAY_MESSAGE =
  "This change would leave the invoice below what the customer already paid. For now, mark the order delivered again, then record a return for the difference.";

/** The restatement cannot reach every invoice of the order (a manual line, lost provenance): nothing is written. */
export const UNCLEAN_PARTITION_MESSAGE =
  "Invoice {n} has a line added by hand, so order changes can't update it. Revert the invoice to draft and edit it there.";

/** A2 M5 / lock class: the edit's lock class changed between the pre-transaction read and the Order lock. */
export const ORDER_CHANGED_DURING_EDIT_MESSAGE =
  "This order changed while you were editing it. Reload it and try again.";

export function lockedCopy(
  reason: keyof typeof LOCKED_COPY,
  words: { item?: string | null; invoiceNumber?: string | null } = {},
): string {
  return fill(LOCKED_COPY[reason], words);
}

/** The STATUS sentence of one order status (an unknown status reads as PENDING's: confirm first). */
export function statusCopy(status: string | null | undefined): string {
  return STATUS_COPY[status ?? ""] ?? STATUS_COPY.PENDING;
}

export function fill(
  template: string,
  words: { item?: string | null; invoiceNumber?: string | null } = {},
): string {
  return template
    .replace("{item}", words.item?.trim() || "This item")
    .replace("{n}", words.invoiceNumber?.trim() || "linked to this order");
}
