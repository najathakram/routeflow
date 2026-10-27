/**
 * The ONE predicate for "which credit notes can send() sweep onto an invoice" — the query half.
 * `CreditNotesService.autoApplyOldestCreditsInTx` selects with it (L-167: one predicate). W-913: it excludes the walk-in
 * account, so the counter sale's and the hand-over's old WALK_IN_OPEN_CREDIT guards (which re-asked this question) are retired.
 *
 * The remaining-balance half (amount - amountUsed > 0.001) cannot be a Prisma column comparison and
 * stays a JS filter at each caller, via {@link hasOpenCreditBalance}.
 */
import { roundMoney } from "@routeflow/pricing";
import { NOT_WALK_IN_WHERE } from "../customers/walk-in-protected";

export function autoApplyCandidateWhere(args: {
  customerId: string;
  now: Date;
  excludeCreditNoteIds?: string[];
}) {
  return {
    customerId: args.customerId,
    status: { not: "VOID" as const },
    autoApplyExcluded: false, // SA-436: an operator kept this note out of the sweep
    // W-913: the shared walk-in account is never a sweep target; credit left on it (legacy) stays unapplied until staff act
    customer: NOT_WALK_IN_WHERE,
    OR: [{ expiresAt: null }, { expiresAt: { gt: args.now } }],
    ...(args.excludeCreditNoteIds?.length ? { id: { notIn: args.excludeCreditNoteIds } } : {}),
  };
}

/** True when the note still holds spendable balance (the JS half of the open predicate). */
export function hasOpenCreditBalance(note: { amount: unknown; amountUsed: unknown }): boolean {
  return roundMoney(Number(note.amount) - Number(note.amountUsed)) > 0.001;
}

/**
 * The tenant's send-time credit sweep switch (SA-436, `TenantConfig.creditAutoApplyOnSend`, OFF by default; no
 * config row reads as OFF). The ONE reader: `autoApplyOldestCreditsInTx` runs only when it is on.
 */
export async function creditAutoApplyOnSend(
  db: { tenantConfig: { findUnique: (args: any) => Promise<any> } },
  tenantId: string | null,
): Promise<boolean> {
  if (!tenantId) return false;
  const cfg = await db.tenantConfig.findUnique({
    where: { tenantId },
    select: { creditAutoApplyOnSend: true },
  });
  return !!cfg?.creditAutoApplyOnSend;
}
