import { isOwnReturn, ownReturnedAmount, type OwnReturnShape } from "./counter-own-return";
import { CONFIRMED_STATUS } from "./payment-confirmation";
import { roundMoney } from "./pricing";

/**
 * SA-838a: what a sale's OWN return did, in ONE place. Counter receipts (the Today's-sales row, the reprint, the emailed
 * receipt) and `counterTenderSplit` read these figures from here and derive them nowhere else.
 *
 * The invariant every reader keeps, in cents:
 *   Balance due = Total - Paid (tenders) - Returned, where Returned is the credit APPLIED to this order's invoices.
 * A refunded or kept credit is shown but NEVER subtracted; the settlement state only decides which info line prints.
 */

/** Statuses of a return that moved no money and never will (the API's `DEAD_RETURN_STATUSES`, pinned equal by a spec). */
export const DEAD_RETURN_STATUS_VALUES = ["REJECTED", "CANCELLED"] as const;

/** The refund method of money returned outside RouteFlow (`Return.refundMethod`; nothing is minted). */
const EXTERNAL_REFUND = "EXTERNAL_REFUND";

export interface SettlementReturn extends OwnReturnShape {
  id?: string;
  /** `Return.status`: REJECTED / CANCELLED are dead; every other status is live */
  status: string;
  /** the credit note the return minted, when it minted one */
  creditNoteId?: string | null;
  /**
   * That note's status (ISSUED / APPLIED / VOID) when the caller could read it. A minted note whose status is unknown is
   * treated as issued: only a VOID note is no longer a credit.
   */
  creditNoteStatus?: string | null;
  /** EXTERNAL_REFUND = money returned outside RouteFlow; `refundedAt` null = chosen but not yet recorded */
  refundMethod?: string | null;
  refundedAt?: Date | string | null;
}

export interface SettlementPayment {
  amount: unknown;
  status?: string;
  /** the credit note this payment applied */
  creditNoteId?: string | null;
}

export type ReturnSettlementState = "PENDING" | "SETTLED" | "DEAD";

export interface ReturnSettlement {
  /**
   * SETTLED = the return's credit note is issued and not VOID, or a recorded external refund is complete. PENDING (also
   * APPROVED / IN_TRANSIT / RECEIVED, and a refund chosen but not recorded) is not settled. DEAD prints nothing: a rejected
   * or cancelled return, or one that is not this order's own.
   */
  state: ReturnSettlementState;
  /** the credit note this settlement spoke for (the split uses it to tell a tender from the return's own credit) */
  creditNoteId: string | null;
  /** this return's credit applied (as PAID payments) to THIS order's invoices: the only figure the balance subtracts */
  applied: number;
  /** the completed external refund */
  refunded: number;
  /** a settled credit neither applied here nor refunded: still the customer's, on their account */
  kept: number;
}

const DEAD: ReturnSettlement = {
  state: "DEAD",
  creditNoteId: null,
  applied: 0,
  refunded: 0,
  kept: 0,
};

/**
 * @param ret      one return as the caller read it
 * @param payments the payments the caller PROVED are this order's own return credit (the provenance read: this order's live
 *                 invoices, both links agreeing); a payment of any other note, or one the caller could not prove, is a tender
 * @param orderId  the order the figures are for: an INLINE return filed on a CARRYING order is worth only its items sold here
 */
export function returnSettlement(
  ret: SettlementReturn,
  payments: ReadonlyArray<SettlementPayment>,
  orderId: string,
): ReturnSettlement {
  if (
    (DEAD_RETURN_STATUS_VALUES as readonly string[]).includes(ret.status) ||
    !isOwnReturn(orderId, ret)
  ) {
    return DEAD;
  }
  const worth = ownReturnedAmount(orderId, [ret]);
  const creditNoteId = ret.creditNoteId ?? null;
  const applied = creditNoteId
    ? roundMoney(
        payments
          .filter((p) => p.status === CONFIRMED_STATUS && p.creditNoteId === creditNoteId)
          .reduce((s, p) => s + Number(p.amount), 0),
      )
    : 0;
  const refundDone = ret.refundMethod === EXTERNAL_REFUND && ret.refundedAt != null;
  const creditIssued = !!creditNoteId && ret.creditNoteStatus !== "VOID";
  if (!refundDone && !creditIssued) {
    // not settled: whatever was applied is still money on the invoice, nothing else is shown
    return { state: "PENDING", creditNoteId, applied, refunded: 0, kept: 0 };
  }
  return {
    state: "SETTLED",
    creditNoteId,
    applied,
    refunded: refundDone ? worth : 0,
    kept: refundDone ? 0 : Math.max(0, roundMoney(worth - applied)),
  };
}
