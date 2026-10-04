/**
 * The ONE predicate for "which credit notes can send() sweep onto an invoice" — the query half.
 * `CreditNotesService.autoApplyOldestCreditsInTx` selects with it, and the counter sale's walk-in
 * open-credit guard asks the same question with it, so the guard can never be narrower than what the
 * sweep would actually take (L-167: one predicate, two readers).
 *
 * The remaining-balance half (amount - amountUsed > 0.001) cannot be a Prisma column comparison and
 * stays a JS filter at each caller, via {@link hasOpenCreditBalance}.
 */
import { roundMoney } from "@routeflow/pricing";

export function autoApplyCandidateWhere(args: {
  customerId: string;
  now: Date;
  excludeCreditNoteIds?: string[];
}) {
  return {
    customerId: args.customerId,
    status: { not: "VOID" as const },
    autoApplyExcluded: false, // SA-436: an operator kept this note out of the sweep
    OR: [{ expiresAt: null }, { expiresAt: { gt: args.now } }],
    ...(args.excludeCreditNoteIds?.length ? { id: { notIn: args.excludeCreditNoteIds } } : {}),
  };
}

/** True when the note still holds spendable balance (the JS half of the open predicate). */
export function hasOpenCreditBalance(note: { amount: unknown; amountUsed: unknown }): boolean {
  return roundMoney(Number(note.amount) - Number(note.amountUsed)) > 0.001;
}
