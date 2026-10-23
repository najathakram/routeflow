import type { PaymentMethod } from "@prisma/client";
import { DEDUPE_STATUSES, roundMoney, toCents } from "@routeflow/pricing";
import { withAfterCommit, type AfterCommit } from "../common/after-commit";
import type { PrismaService } from "../prisma/prisma.service";
import {
  createPaymentRefGuard,
  groupTotalForEdit,
  normalizePaymentRef,
  paymentRefLockUnavailable,
  withPaymentRefLock,
  type PaymentRefGuard,
  type RefDedupeOpts,
} from "./payment-ref-dedupe";

/**
 * Row 752 / SA-843: an EDIT of a payment runs the ONE reference predicate (payment-ref-dedupe.ts) only when it
 * gives the row a NEW dedupe identity, so a notes-only save of a pre-498 duplicate (or of a recorded-anyway row) is
 * never refused.
 *
 * LOCK ORDER (one order, SA-843 ruling 5): the `payment-ref` session lock on the NEW key (taken BEFORE the
 * transaction opens, inside `retryOnTxConflict`, by withPaymentRefLock) -> tx: counterPay.lock (stays the first
 * statement) -> Invoice FOR UPDATE -> read -> assertEditDated -> guard.check -> invoicePayment.update ->
 * guard.recorded -> invoice status. Nothing under the lock takes "order-merge". The key needs the STORED reference
 * when the body has none, so it is read unlocked before the lock, then re-derived under the Invoice lock: a
 * concurrent edit that moved it is the retryable 503 LOCK_UNAVAILABLE, nothing written. Only the NEW key is locked
 * (moving AWAY from a key cannot create a duplicate).
 */

/** The stored fields the dedupe identity reads (amount is a Prisma Decimal on a read). */
export interface StoredPaymentKey {
  method: string;
  reference: string | null;
  amount: unknown;
  status: string | null;
}

/** The edit body fields the identity reads (UpdatePaymentDto). */
export interface PaymentEditBody {
  method: PaymentMethod;
  amount: number;
  reference?: string | null;
  status?: string;
}

export interface EditKey {
  method: PaymentMethod;
  /** The effective reference, raw: the body's when its key is present, else the stored one. */
  reference: string;
  amount: number;
}

const inSet = (status: string | null | undefined) =>
  (DEDUPE_STATUSES as readonly string[]).includes(status ?? "PAID");

/**
 * The NEW dedupe identity this edit gives the row, or null when it gives none (SA-843 ruling 2): the row enters the
 * set (stored VOID -> DRAFT/PAID), or, while in the set, its method, normalised effective reference or cents change.
 * An edit to VOID, DRAFT <-> PAID with the same key, and a row with no effective reference never get one.
 */
export function editDedupeKey(stored: StoredPaymentKey, dto: PaymentEditBody): EditKey | null {
  const status = dto.status ?? stored.status ?? "PAID";
  if (!inSet(status)) return null;
  const reference = dto.reference !== undefined ? dto.reference : stored.reference;
  const norm = normalizePaymentRef(reference);
  if (!norm || !reference) return null;
  const amount = roundMoney(dto.amount);
  const changed =
    !inSet(stored.status) ||
    dto.method !== stored.method ||
    norm !== normalizePaymentRef(stored.reference) ||
    toCents(amount) !== toCents(roundMoney(Number(stored.amount)));
  return changed ? { method: dto.method, reference, amount } : null;
}

/** What the payment-ref lock is held on for this key (method + normalised reference); null = no lock. */
export function editLockKey(key: EditKey | null): string | null {
  return key ? `${key.method}:${normalizePaymentRef(key.reference)}` : null;
}

/** updatePayment's options: the staff "record anyway" flag (set by the controller only). */
export interface RefOpts {
  refDedupe?: RefDedupeOpts;
}

/** The edit's guard, opened under the Invoice lock: null when the edit gives the row no new identity. */
export interface PaymentEditRef {
  check(
    tx: any,
    row: StoredPaymentKey & { id: string; paidAt: Date; paymentGroupId: string | null },
    customerId: string,
  ): Promise<PaymentRefGuard | null>;
}

/**
 * Open updatePayment's transaction (`withAfterCommit`) under the payment-ref lock of the edit's NEW key and run
 * `fn` in it. `edit.check` (inside `fn`, after assertEditDated, before the update) re-derives the key from the
 * locked row and opens the guard.
 */
export async function withPaymentEditRef<T>(
  prisma: PrismaService,
  ids: { invoiceId: string; paymentId: string },
  dto: PaymentEditBody,
  opts: RefOpts | undefined,
  fn: (tx: any, after: AfterCommit, edit: PaymentEditRef) => Promise<T>,
): Promise<T> {
  // Read through the (tenant-scoped) invoice, exactly as the locked read below does, so a legacy row is read alike.
  const inv = await prisma.invoice.findUnique({
    where: { id: ids.invoiceId },
    select: {
      payments: {
        where: { id: ids.paymentId },
        select: { method: true, reference: true, amount: true, status: true },
      },
    },
  });
  const stored = inv?.payments?.[0];
  const lockedKey = stored ? editDedupeKey(stored, dto) : null;
  const locked = editLockKey(lockedKey);
  const edit: PaymentEditRef = {
    async check(tx, row, customerId) {
      const key = editDedupeKey(row, dto);
      // A concurrent edit moved the key this edit locked: retry. A locked row that needs no check any more (a
      // double-clicked Save whose first save landed) is no conflict (#3635 review B NIT 1).
      if (key && editLockKey(key) !== locked) throw paymentRefLockUnavailable();
      if (!key) return null;
      // Other attempts only (SA-843 ruling 3): this payment, its own group, and the excess advance its group booked.
      const attempt = { ids: new Set<string>([row.id]) };
      let amount = key.amount;
      if (row.paymentGroupId) {
        // SA-865: a grouped row is judged on the group's NEW total, as a fresh record of the group would be.
        const group = await groupTotalForEdit(
          tx,
          { ...row, paymentGroupId: row.paymentGroupId, customerId },
          toCents(key.amount),
        );
        for (const id of group.advanceIds) attempt.ids.add(id);
        // SA-867: only an AMOUNT-ONLY edit is judged on the group total. A row whose method or normalised reference
        // changes leaves its group's key, so it is judged alone (its own group and advance stay seeded either way).
        const sameKey =
          key.method === row.method &&
          normalizePaymentRef(key.reference) === normalizePaymentRef(row.reference);
        if (sameKey) amount = group.cents / 100;
      }
      const guard = createPaymentRefGuard({
        method: key.method,
        reference: key.reference,
        amount,
        customerId,
        invoiceId: ids.invoiceId,
        opts: {
          refDedupe: opts?.refDedupe,
          paymentAttempt: attempt,
          paymentGroupId: row.paymentGroupId ?? undefined,
        },
      });
      await guard.check(tx);
      return guard;
    },
  };
  return withPaymentRefLock(prisma, lockedKey ?? {}, () =>
    withAfterCommit(prisma, (tx, after) => fn(tx, after, edit)),
  );
}
