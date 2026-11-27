// SA-1506 PR-1a (Amendment 1 C1/E, Amendment 2 section C/D): what staff may do to a DELIVERED line, decided on the
// server by `deliveredLineEditMode` (apps/api/src/orders/delivered-line-edit-mode.ts) and carried on every order line
// of the detail read. Web and mobile read these fields and never recompute the rule (L-072: no local mirror).
//
// The api cannot value-import this package, so it keeps its own literals, pinned set-equal to these (and the copy
// below word for word) by `apps/api/src/orders/delivered-line-edit-mode.parity.spec.ts`.

/** EDIT: an ordinary line. CORRECT: an admin may restate the delivery. LOCKED: refused, see `lockedReason`. */
export const LINE_EDIT_MODE_VALUES = ["EDIT", "CORRECT", "LOCKED"] as const;
export type LineEditMode = (typeof LINE_EDIT_MODE_VALUES)[number];

/**
 * Why a delivered line is LOCKED. One named reason per rule, decided in one place, so a later ruling flips a reason
 * to CORRECT by changing the decider alone (PR-1c flips ROUTE and RETURN; ON_RUN, STATUS and the rest stay).
 */
export const LOCKED_REASON_VALUES = [
  "ROLE",
  "UNIT",
  "STATUS",
  "REOPEN_FIRST",
  "ON_RUN",
  "ROUTE",
  "RETURN",
  "RETURN_BASIS",
  "RETURN_REMAINDER",
  "RETURN_PRICE",
  "SPLIT_BILL",
  "WRITTEN_OFF",
  "SHIPMENT_BILLED",
] as const;
export type LineLockedReason = (typeof LOCKED_REASON_VALUES)[number];

/** What evidence a CORRECT restates: NONE (column only, no rows), OFFICE (the office's rows), ROUTE (a stop's rows, PR-1c). */
export const CORRECTION_BASIS_VALUES = ["NONE", "OFFICE", "ROUTE"] as const;
export type CorrectionBasis = (typeof CORRECTION_BASIS_VALUES)[number];

/** The per-line fields the order detail wire carries (staff reads). */
export interface LineEditModeFields {
  lineEditMode: LineEditMode;
  /** null unless `lineEditMode` is LOCKED. */
  lockedReason: LineLockedReason | null;
  /** NONE unless `lineEditMode` is CORRECT. */
  correctionBasis: CorrectionBasis;
  /** The lowest quantity the line may be corrected to, in the line's own unit. 0 until PR-1c (the return floor). */
  correctMinQty: number;
  /** A price change is refused on this line (a returned product). false until PR-1c. */
  priceLocked: boolean;
  /** A cut needs a reason (it overrules a driver's record). false until PR-1c. */
  needsReason: boolean;
  /** ROLE only: an OPERATOR is refused and an admin could correct this line, so the refusal adds the admin sentence. */
  lockedOperatorNote?: boolean;
  /** WRITTEN_OFF only: the number the copy names. */
  lockedInvoiceNumber?: string;
  /** STATUS only: the order status the copy is keyed by. */
  lockedStatus?: string;
}

/** The sentence for a LOCKED reason (Amendment 2 section D). `{n}` / `{item}` are filled by `fillLockedCopy`. */
export const LINE_LOCKED_COPY: Record<Exclude<LineLockedReason, "ROLE" | "STATUS">, string> = {
  REOPEN_FIRST: "Reopen the order to correct delivered items.",
  ON_RUN:
    "This order is on a delivery run. Complete its stop on the route, or take it off the run first.",
  ROUTE:
    "A driver delivered this item. Admins can correct it in the next update, landing with this one.",
  RETURN:
    "An item on this order had a return. Admins can correct it in the next update, landing with this one.",
  RETURN_BASIS:
    "{item} has no Units per box set, so its return can't be counted. Set Units per box on the item, then try again.",
  RETURN_REMAINDER:
    "Part of {item} was never delivered and part was returned, so its quantity can't be lowered here. Mark the order delivered again, then record a return.",
  RETURN_PRICE:
    "{item} was returned at the old price. To change the price, issue a credit note for the difference.",
  SPLIT_BILL:
    "Part of this order is billed on another invoice. Mark the order delivered again, then record a return or add a new order.",
  WRITTEN_OFF:
    "Invoice {invoiceNumber} was written off, so this order is closed. Add anything missed on a new order.",
  SHIPMENT_BILLED:
    "This order was billed when it shipped. Mark the order delivered again, then record a return for the difference.",
  UNIT: "{item} is sold by unit and already invoiced. Mark the order delivered again, then record a return.",
};

/** STATUS: one sentence per order status that holds a delivered line but is not CONFIRMED / PARTIALLY_DELIVERED / DELIVERED. */
export const LINE_STATUS_COPY: Record<string, string> = {
  PENDING: "Confirm the order to correct delivered items.",
  DRAFT: "Submit and confirm the order to correct delivered items.",
  OUT_FOR_DELIVERY: "Move the order back to Confirmed to correct delivered items.",
  REFUSED: "Use Deliver again, then correct delivered items.",
  CANCELLED: "This order is cancelled. Add anything missed on a new order.",
};

/** The sentence an OPERATOR is told when an admin could correct the line (SA-1408 item 3, shown to operators only). */
export const OPERATOR_CORRECT_NOTE = "Only an admin can correct a delivered line.";

/** SA-1525 (k) / SA-C 7178828662: RETURN_REMAINDER on a stop-linked order. No button. */
export const RETURN_REMAINDER_STOP_COPY =
  "Part of {item} was never delivered and part was returned. The invoice already bills only what was delivered ({billed} {unit}), so nothing needs changing here.";

export function fillLockedCopy(
  reason: Exclude<LineLockedReason, "ROLE">,
  words: {
    item?: string | null;
    invoiceNumber?: string | null;
    status?: string | null;
    stopLinked?: boolean;
    billed?: number | string | null;
    unit?: string | null;
  } = {},
): string {
  const template =
    reason === "STATUS"
      ? (LINE_STATUS_COPY[words.status ?? ""] ?? LINE_STATUS_COPY.PENDING ?? "")
      : reason === "RETURN_REMAINDER" && words.stopLinked
        ? RETURN_REMAINDER_STOP_COPY
        : LINE_LOCKED_COPY[reason];
  return template
    .replace("{item}", words.item?.trim() || "This item")
    .replace("{invoiceNumber}", words.invoiceNumber?.trim() || "linked to this order")
    .replace("{billed}", words.billed != null ? String(words.billed) : "what was")
    .replace("{unit}", words.unit?.trim() || "units");
}
