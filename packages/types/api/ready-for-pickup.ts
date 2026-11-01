// W-1043 (SA-1062 MUST 18): POST /orders/:id/ready-for-pickup. What staff are told after the press: the one
// `notice` says what really happened to the customer's email. Web renders it (`readyForPickupCopy`), exhaustively.

export const READY_FOR_PICKUP_NOTICE_VALUES = [
  "SENT",
  "NO_EMAIL",
  "OPTED_OUT",
  "OFF",
  "FAILED",
] as const;
export type ReadyForPickupNotice = (typeof READY_FOR_PICKUP_NOTICE_VALUES)[number];

/** The step ran now: `email` is the address a SENT notice went to. */
export interface ReadyForPickupDone {
  notice: ReadyForPickupNotice;
  email?: string;
}

/** A repeat press on an order already at Ready for pickup: nothing moved and nothing was sent. */
export interface ReadyForPickupAlready {
  alreadyReady: true;
}

/**
 * SA-1070 (W-1060, walk F13): the customer was already emailed for this order (a SENT `order.ready_for_pickup` row is on
 * the record). The status moved exactly as before; no email and no push went. `email`/`at` are that first send.
 */
export interface ReadyForPickupToldOnce {
  toldOnce: true;
  email?: string;
  /** ISO timestamp of the first send. */
  at: string;
}

export type ReadyForPickupResponse =
  ReadyForPickupDone | ReadyForPickupAlready | ReadyForPickupToldOnce;

/** The body of POST /orders/:id/ready-for-pickup: `resend` is "Send again", valid only once the order is Ready. */
export interface ReadyForPickupBody {
  resend?: boolean;
}

/** One send on the record: what happened to the customer's email, to which address, and when (ISO). */
export interface ReadyForPickupLast {
  notice: ReadyForPickupNotice;
  email?: string;
  at: string;
}

/** GET /orders/:id/ready-for-pickup: the record the order page's one line reads. `preview` is what a press would do now. */
export interface ReadyForPickupRecord {
  preview: ReadyForPickupDone;
  last: ReadyForPickupLast | null;
}
