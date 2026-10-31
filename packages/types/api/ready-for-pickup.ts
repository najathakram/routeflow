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

export type ReadyForPickupResponse = ReadyForPickupDone | ReadyForPickupAlready;
