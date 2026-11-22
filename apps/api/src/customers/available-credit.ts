import { roundMoney } from "@routeflow/pricing";

/**
 * SA-1208 D7 (M1-05): the ONE answer to "how much credit does this customer have available".
 *
 * Credit is two kinds of money the customer holds with the seller: the unused remainder of open, non-expired,
 * non-VOID credit notes, and the balance of advance payments. Every statement surface (the buyer's own statement,
 * the monthly statement, the account statement behind the portal and the PDF) reads it here, so a $300 unused note
 * plus a $200 advance reads $500 everywhere. Before this, two of the three surfaces counted notes only.
 *
 * Credit is applied by staff and is NEVER netted against the open balance (SA-1197): callers show it on its own row.
 * The sites pin (available-credit.sites.spec.ts) fails when a statement file recomputes it.
 */

/** A remainder at or under this is dust, not credit (the epsilon the open-note predicate has always used). */
const OPEN_CREDIT_EPSILON = 0.001;

export interface CreditNoteLike {
  status?: string | null;
  amount: unknown;
  amountUsed: unknown;
  expiresAt?: Date | string | null;
}

export interface AdvanceLike {
  balance: unknown;
}

/** What is left on a credit note: 0 for a VOID, expired or used-up note, else amount - amountUsed to the cent. */
export function creditNoteRemaining(note: CreditNoteLike, now: Date): number {
  if (note.status === "VOID") return 0;
  if (note.expiresAt && new Date(note.expiresAt) <= now) return 0;
  const remaining = roundMoney(Number(note.amount) - Number(note.amountUsed));
  return remaining > OPEN_CREDIT_EPSILON ? remaining : 0;
}

/** What is left on an advance payment: its balance to the cent, 0 when empty. */
export function advanceRemaining(advance: AdvanceLike): number {
  const remaining = roundMoney(Number(advance.balance));
  return remaining > OPEN_CREDIT_EPSILON ? remaining : 0;
}

export interface AvailableCredit {
  /** Unused remainder of open credit notes. */
  notes: number;
  /** Advance payment balances. */
  advances: number;
  /** notes + advances, the figure every surface shows as "available credit". */
  total: number;
}

/** Sum the credit of rows already read for ONE customer. Pure; the caller owns the tenant and customer scope. */
export function sumAvailableCredit(input: {
  notes: ReadonlyArray<CreditNoteLike>;
  advances: ReadonlyArray<AdvanceLike>;
  now: Date;
}): AvailableCredit {
  const notes = roundMoney(
    input.notes.reduce((sum, n) => sum + creditNoteRemaining(n, input.now), 0),
  );
  const advances = roundMoney(input.advances.reduce((sum, a) => sum + advanceRemaining(a), 0));
  return { notes, advances, total: roundMoney(notes + advances) };
}

/** The tenant-scoped client the loader needs: pass `prisma.forTenant()`, never a bare client. */
export interface AvailableCreditDb {
  creditNote: { findMany: (args: any) => Promise<any[]> };
  advancePayment: { findMany: (args: any) => Promise<any[]> };
}

/**
 * Read and sum one customer's available credit. Both reads are scoped to `customerId` and run on the caller's
 * tenant-scoped client, so another customer's credit, or another tenant's, never enters the sum.
 */
export async function loadAvailableCredit(
  db: AvailableCreditDb,
  customerId: string,
  now: Date = new Date(),
): Promise<AvailableCredit> {
  const [notes, advances] = await Promise.all([
    db.creditNote.findMany({
      where: { customerId, status: { not: "VOID" } },
      select: { amount: true, amountUsed: true, status: true, expiresAt: true },
    }),
    db.advancePayment.findMany({
      where: { customerId, balance: { gt: 0 } },
      select: { balance: true },
    }),
  ]);
  return sumAvailableCredit({ notes, advances, now });
}
