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
  /** The InvoicePayment this advance was created from (a group's excess), a plain id with no relation. */
  sourcePaymentId?: string | null;
}

/**
 * B839 (read half): is this advance spendable credit? No source payment: yes (as always). A source payment: only
 * when it is PAID (confirmed). A DRAFT or PENDING group's excess, or a VOID one, is never shown as credit.
 * `sourceStatus` is the linked payment's status, undefined when the advance has no source or the row is gone.
 */
export function isAdvanceAvailable(
  advance: AdvanceLike,
  sourceStatus: string | null | undefined,
): boolean {
  if (!advance.sourcePaymentId) return true;
  return sourceStatus === "PAID";
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

/** One spendable credit row, newest first in `AvailableCredit.items`. `number` is a note's credit-note number. */
export interface CreditItem {
  kind: "NOTE" | "ADVANCE";
  id: string;
  date: Date;
  remaining: number;
  number?: string;
}

export interface AvailableCredit {
  /** Unused remainder of open credit notes. */
  notes: number;
  /** Advance payment balances. */
  advances: number;
  /** notes + advances, the figure every surface shows as "available credit". */
  total: number;
  /** The rows behind the sums (remaining > 0), newest first: the buyer's credit list reads these, never a re-read. */
  items: CreditItem[];
}

/** Sum the credit of rows already read for ONE customer. Pure; the caller owns the tenant and customer scope. */
export function sumAvailableCredit(input: {
  notes: ReadonlyArray<CreditNoteLike>;
  advances: ReadonlyArray<AdvanceLike & { id?: string; receivedAt?: Date }>;
  /** Linked source-payment statuses by id (B839); an advance with no source never needs one. */
  sourceStatuses?: ReadonlyMap<string, string>;
  now: Date;
}): AvailableCredit {
  const spendable = input.advances.filter((a) =>
    isAdvanceAvailable(
      a,
      a.sourcePaymentId ? input.sourceStatuses?.get(a.sourcePaymentId) : undefined,
    ),
  );
  const notes = roundMoney(
    input.notes.reduce((sum, n) => sum + creditNoteRemaining(n, input.now), 0),
  );
  const advances = roundMoney(spendable.reduce((sum, a) => sum + advanceRemaining(a), 0));
  const items: CreditItem[] = [
    ...input.notes.map((n: any) => ({
      kind: "NOTE" as const,
      id: String(n.id),
      date: new Date(n.createdAt),
      remaining: creditNoteRemaining(n, input.now),
      number: n.creditNoteNumber as string | undefined,
    })),
    ...spendable.map((a) => ({
      kind: "ADVANCE" as const,
      id: String(a.id),
      date: new Date(a.receivedAt as Date),
      remaining: advanceRemaining(a),
    })),
  ]
    .filter((i) => i.remaining > 0)
    .sort((x, y) => y.date.getTime() - x.date.getTime());
  return { notes, advances, total: roundMoney(notes + advances), items };
}

/** The tenant-scoped client the loader needs: pass `prisma.forTenant()`, never a bare client. */
export interface AvailableCreditDb {
  creditNote: { findMany: (args: any) => Promise<any[]> };
  advancePayment: { findMany: (args: any) => Promise<any[]> };
  invoicePayment: { findMany: (args: any) => Promise<any[]> };
}

/** B839: the statuses of the payments these advances came from, in ONE tenant-scoped `id in` read (none when unlinked). */
export async function loadAdvanceSourceStatuses(
  db: Pick<AvailableCreditDb, "invoicePayment">,
  advances: ReadonlyArray<AdvanceLike>,
): Promise<Map<string, string>> {
  const ids = [...new Set(advances.map((a) => a.sourcePaymentId).filter(Boolean))] as string[];
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await db.invoicePayment.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true },
  });
  for (const r of rows) out.set(r.id, r.status);
  return out;
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
      select: {
        id: true,
        creditNoteNumber: true,
        createdAt: true,
        amount: true,
        amountUsed: true,
        status: true,
        expiresAt: true,
      },
    }),
    db.advancePayment.findMany({
      where: { customerId, balance: { gt: 0 } },
      select: { id: true, balance: true, receivedAt: true, sourcePaymentId: true },
    }),
  ]);
  const sourceStatuses = await loadAdvanceSourceStatuses(db, advances);
  return sumAvailableCredit({ notes, advances, sourceStatuses, now });
}

function groupByCustomer<T extends { customerId: string }>(
  rows: ReadonlyArray<T>,
): Map<string, T[]> {
  const by = new Map<string, T[]>();
  for (const r of rows) {
    const list = by.get(r.customerId);
    if (list) list.push(r);
    else by.set(r.customerId, [r]);
  }
  return by;
}

/**
 * The same figures for a PAGE of customers (the staff list, the CSV): three bounded tenant-scoped `in` reads (notes,
 * advances, advance sources), never a query per customer. Every id gets an entry, zeros when it holds no credit.
 */
export async function loadAvailableCreditByCustomer(
  db: AvailableCreditDb,
  customerIds: ReadonlyArray<string>,
  now: Date = new Date(),
): Promise<Map<string, Pick<AvailableCredit, "notes" | "advances" | "total">>> {
  const out = new Map<string, Pick<AvailableCredit, "notes" | "advances" | "total">>();
  if (customerIds.length === 0) return out;
  const [notes, advances] = await Promise.all([
    db.creditNote.findMany({
      where: { customerId: { in: [...customerIds] }, status: { not: "VOID" } },
      select: { customerId: true, amount: true, amountUsed: true, status: true, expiresAt: true },
    }),
    db.advancePayment.findMany({
      where: { customerId: { in: [...customerIds] }, balance: { gt: 0 } },
      select: { customerId: true, balance: true, sourcePaymentId: true },
    }),
  ]);
  const sourceStatuses = await loadAdvanceSourceStatuses(db, advances);
  // SA-1225 MED-2: group once, then one pass per customer (never a filter over all rows per customer).
  const notesBy = groupByCustomer(notes);
  const advancesBy = groupByCustomer(advances);
  for (const id of customerIds) {
    const {
      notes: n,
      advances: a,
      total,
    } = sumAvailableCredit({
      notes: notesBy.get(id) ?? [],
      advances: advancesBy.get(id) ?? [],
      sourceStatuses,
      now,
    });
    out.set(id, { notes: n, advances: a, total });
  }
  return out;
}
