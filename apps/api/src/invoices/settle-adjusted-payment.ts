/**
 * SA-1156 (W-871): the payments the post-edit credit settle re-adjusts: a credit-note payment that names its note
 * (`settleOrderCreditsInTx` shrinks or tops these up after every order edit; cash, card, check and advance are never
 * auto-adjusted). ONE predicate in two forms: the Prisma where-fragment and its pure twin. A unit pin runs one fixture set
 * through both so they cannot drift. Read by the settle's shrink filter and by the edit-lock fragment.
 */
export const SETTLE_ADJUSTED_PAYMENT_WHERE = {
  method: "CREDIT_NOTE" as const,
  creditNoteId: { not: null },
};

export const isSettleAdjustedPayment = (p: {
  method?: string | null;
  creditNoteId?: string | null;
}): boolean => p.method === "CREDIT_NOTE" && !!p.creditNoteId;
