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

/** A credit note as the caller's ONE batched read saw it: its status and the PAID amount applied to it on ANY sale. */
export interface SettlementCreditNote {
  /** ISSUED / APPLIED / VOID */
  status: string;
  appliedAnywhere: number;
  /**
   * The part of `appliedAnywhere` sitting on ANY invoice of the order being read (live or dead, proven or not): it is never
   * "elsewhere", so an application the provenance could not prove (it stays a tender) is not also counted as Credit used.
   * Absent: only the proven application is known to be here.
   */
  appliedOnThisOrder?: number;
}

export interface SettlementReturn extends OwnReturnShape {
  id?: string;
  /** `Return.status`: REJECTED / CANCELLED are dead; every other status is live */
  status: string;
  /** the credit note the return minted, when it minted one */
  creditNoteId?: string | null;
  /**
   * That note as the batched read saw it. A minted note the read did NOT return (absent here) is never claimed as a credit:
   * the return is not settled (PENDING). A VOID note with no completed refund is DEAD: the credit no longer exists.
   */
  creditNote?: SettlementCreditNote | null;
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
   * SETTLED = the return's credit note was seen and is not VOID, or a recorded external refund is complete. PENDING (also
   * APPROVED / IN_TRANSIT / RECEIVED, a refund chosen but not recorded, and a note the read could not see) is not settled.
   * DEAD prints nothing: a rejected or cancelled return, a VOID note with no refund, or a return that is not this order's own.
   */
  state: ReturnSettlementState;
  /** the credit note this settlement spoke for (the split uses it to tell a tender from the return's own credit) */
  creditNoteId: string | null;
  /** this return's credit applied (as PAID payments) to THIS order's invoices: the only figure the balance subtracts */
  applied: number;
  /** the completed external refund */
  refunded: number;
  /** the part of the credit spent on OTHER orders (an info line, never subtracted): applied anywhere - applied on this order */
  appliedElsewhere: number;
  /** what is still the customer's on account: worth - applied ANYWHERE - refunded */
  kept: number;
}

const DEAD: ReturnSettlement = {
  state: "DEAD",
  creditNoteId: null,
  applied: 0,
  refunded: 0,
  appliedElsewhere: 0,
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
  if (!refundDone && creditNoteId && ret.creditNote?.status === "VOID") return DEAD;
  const creditSeen = !!creditNoteId && !!ret.creditNote;
  if (!refundDone && !creditSeen) {
    // not settled (or a note nobody could see): whatever was applied is still money on the invoice, nothing else is shown
    return { state: "PENDING", creditNoteId, applied, refunded: 0, appliedElsewhere: 0, kept: 0 };
  }
  // the PAID amount applied to the note on ANY sale; never less than what sits on this order (proven or not)
  const onThisOrder = Math.max(applied, roundMoney(ret.creditNote?.appliedOnThisOrder ?? 0));
  const anywhere = refundDone
    ? 0
    : Math.max(onThisOrder, roundMoney(ret.creditNote?.appliedAnywhere ?? 0));
  const refunded = refundDone ? worth : 0;
  return {
    state: "SETTLED",
    creditNoteId,
    applied,
    refunded,
    appliedElsewhere: Math.max(0, roundMoney(anywhere - onThisOrder)),
    kept: Math.max(0, roundMoney(worth - anywhere - refunded)),
  };
}

export interface SettlementTotals {
  applied: number;
  refunded: number;
  kept: number;
  /** credit spent on other orders (Credit used) */
  used: number;
  /** some own return is not settled yet */
  pending: boolean;
}

/**
 * The row's figures from its settlements, in cents. A credit note is counted ONCE: two returns that name one note (or one
 * return seen twice) never add its application twice, so `applied` is exactly the own-credit PAID payments.
 */
export function settlementTotals(settlements: ReadonlyArray<ReturnSettlement>): SettlementTotals {
  const seen = new Set<string>();
  const counted = settlements.filter((s) => {
    if (s.state === "DEAD") return false;
    if (!s.creditNoteId) return true;
    if (seen.has(s.creditNoteId)) return false;
    seen.add(s.creditNoteId);
    return true;
  });
  const sum = (pick: (s: ReturnSettlement) => number) =>
    roundMoney(counted.reduce((t, s) => roundMoney(t + pick(s)), 0));
  return {
    applied: sum((s) => s.applied),
    refunded: sum((s) => s.refunded),
    kept: sum((s) => s.kept),
    used: sum((s) => s.appliedElsewhere),
    pending: settlements.some((s) => s.state === "PENDING"),
  };
}
