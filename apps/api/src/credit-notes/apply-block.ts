import type { CreditNoteApplyBlockReason } from "@prisma/client";

/**
 * SA-436 / SA-436a (#2401): the don't-re-apply memory for a (credit note, invoice) pair, in ONE
 * place (L-167). While a CreditNoteApplyBlock row exists, neither the send-time oldest-first sweep
 * (autoApplyOldestCreditsInTx) nor the order-intent settle (settleOrderCreditsInTx) applies that
 * note to that invoice.
 *
 * Writers: unapplyFromInvoice (UNAPPLIED), syncOrderCreditSelections for a DROPPED intent (UNTICKED,
 * one row per non-VOID invoice of the order), void-with-reversal (VOID_REVERSAL, SA-436 PR-2).
 * Clearers (explicit human intent wins): a manual applyToInvoice clears its pair; re-ticking or
 * re-amounting a note on an order clears that note across the order's non-VOID invoices.
 *
 * Ids are UUIDs, so the reads key on them alone; writes carry `tenantId` explicitly because the
 * settle path can run on an UNWRAPPED tx where the tenant proxy injects nothing.
 */
export const pairKey = (creditNoteId: string, invoiceId: string): string =>
  `${creditNoteId}:${invoiceId}`;

/** The blocked pairs among these invoices, as `pairKey` strings. */
export async function blockedPairs(db: any, invoiceIds: string[]): Promise<Set<string>> {
  if (invoiceIds.length === 0) return new Set();
  const rows: Array<{ creditNoteId: string; invoiceId: string }> =
    (await db.creditNoteApplyBlock.findMany({
      where: { invoiceId: { in: invoiceIds } },
      select: { creditNoteId: true, invoiceId: true },
    })) ?? [];
  return new Set(rows.map((r) => pairKey(r.creditNoteId, r.invoiceId)));
}

/** Blocks the note on each invoice; an already-blocked pair keeps its first row. */
export async function writeApplyBlocks(
  db: any,
  args: {
    tenantId: string | null;
    creditNoteId: string;
    invoiceIds: string[];
    reason: CreditNoteApplyBlockReason;
    createdById?: string | null;
  },
): Promise<void> {
  if (!args.tenantId || args.invoiceIds.length === 0) return;
  await db.creditNoteApplyBlock.createMany({
    data: args.invoiceIds.map((invoiceId) => ({
      tenantId: args.tenantId,
      creditNoteId: args.creditNoteId,
      invoiceId,
      reason: args.reason,
      createdById: args.createdById ?? null,
    })),
    skipDuplicates: true,
  });
}

/** Clears the note's blocks on these invoices. */
export async function clearApplyBlocks(
  db: any,
  creditNoteId: string,
  invoiceIds: string[],
): Promise<void> {
  if (invoiceIds.length === 0) return;
  await db.creditNoteApplyBlock.deleteMany({
    where: { creditNoteId, invoiceId: { in: invoiceIds } },
  });
}
