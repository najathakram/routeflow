import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import type { PaymentMethod } from "@prisma/client";
import { DEDUPE_STATUSES, roundMoney, toCents } from "@routeflow/pricing";
import type { DuplicatePaymentRefBody } from "@routeflow/types";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { LockTimeoutError, LockUnavailableError, withAdvisoryLock } from "../common/db-locks";
import { retryOnTxConflict, txConflictState } from "../common/tx-retry";

/**
 * Row 498 (SA-837 + the lead's rulings of 2026-10-22): the ONE payment-reference dedupe predicate, its ONE
 * normaliser and its ONE lock. Every InvoicePayment writer that can carry a typed reference goes through here
 * (the census spec payment-ref-writers.census.spec.ts lists them and fails on a new writer).
 *
 * The rule: with a reference, a payment is a DUPLICATE when a non-VOID payment of the same tenant, customer and
 * method with the same NORMALISED reference and the same amount already exists, with NO time window. Without a
 * reference (or a reference of only spaces and dashes) nothing is deduped.
 *
 *  - It compares ONLY against payments of OTHER attempts. The payments of one attempt are one logical payment and
 *    never collide: the rows of one standalone group (the check runs once, before any is written), the rows a
 *    caller marks with a shared `paymentAttempt` (a counter tender over sibling invoices, seeded with the sale's
 *    earlier stored tender rows so a resumed sale does not collide with itself), and the rows that share the
 *    call's `paymentGroupId` (pickup-complete's tender group).
 *  - It needs an IDENTIFIED customer: the shared walk-in identity (`Customer.isWalkIn`) is never deduped. That is
 *    a property of the identity, not of a channel: an account buyer at the counter is deduped like anyone else.
 *  - A hit is 409 DUPLICATE_PAYMENT_REF naming the existing payment (date, amount, invoice number). A STAFF caller
 *    may resend with `recordAnyway`: the payment is then recorded and exactly ONE audit row is written (actor,
 *    invoice, normalised reference, the existing payment id it duplicates). A non-staff role's flag is ignored.
 *  - SA-837b: money ALREADY CAPTURED externally is never refused. A caller whose own code says so
 *    (`capturedExternally`, set by the Stripe settle path only, never read from a request) gets the payment RECORDED
 *    and FLAGGED on a hit: one audit row in the payment's transaction plus a suspect the caller turns into the
 *    invoice breadcrumb and an operator notification, so staff can refund in Stripe. The one exception: a hit whose
 *    raw reference is the capture's own source reference is the SAME charge already recorded (a crash between the
 *    record and the SETTLED flip): `PaymentAlreadyRecordedError`, and the caller settles idempotently.
 *  - SERIALISATION: `withPaymentRefLock` is `withAdvisoryLock` (family "payment-ref", key tenant:method:normRef),
 *    never raw SQL, so two NEW attempts with the same reference cannot both pass the check. A session lock wraps
 *    the writer's transaction, so it is taken BEFORE the transaction opens; the SA-824 key claim stays the first
 *    statement of that transaction, and a replay of a held key returns before this lock is ever requested.
 *    LOCK ORDER: the customer merge lock ("order-merge"), when a path holds it, is always taken BEFORE this lock;
 *    no code under this lock takes it (pinned by the census spec and the writers spec). SA-837b: every lock path
 *    runs inside `retryOnTxConflict`, so a Postgres-aborted wait (40P01 / 40001) retries the whole lock + transaction.
 */

/**
 * Roles that may use `recordAnyway` (the staff roles the payment routes already admit). The ONE source is
 * packages/types/payment-ref-copy.ts (`RECORD_ANYWAY_ROLES`, read by the web and mobile clients); the API cannot
 * import that package at runtime, so this is its literal copy, pinned equal by payment-ref-staff-roles.parity.spec.ts.
 */
export const RECORD_ANYWAY_ROLES: readonly string[] = ["SUPER_ADMIN", "TENANT_ADMIN", "OPERATOR"];

/** Strip spaces and dashes, uppercase. Null when nothing is left (no reference). The ONE normaliser. */
export function normalizePaymentRef(ref: string | null | undefined): string | null {
  const n = (ref ?? "").replace(/[\s‐-―-]+/g, "").toUpperCase();
  return n.length > 0 ? n : null;
}

/** The payments of ONE logical attempt: writers add every payment id they create, callers may seed it. */
export interface PaymentAttempt {
  ids: Set<string>;
}

/** Who is recording and whether they asked to record a repeat anyway (set by the staff HTTP controllers only). */
export interface RefDedupeOpts {
  actor?: string | null;
  role?: string | null;
  recordAnyway?: boolean;
}

/** The `refDedupe` option of a staff request: the actor, the role and the body's `recordAnyway` flag. */
export function refDedupeFromRequest(
  user: { sub?: string | null; role?: string | null } | undefined,
  dto: { recordAnyway?: boolean },
): RefDedupeOpts {
  return {
    actor: user?.sub ?? null,
    role: user?.role ?? null,
    recordAnyway: dto.recordAnyway === true,
  };
}

/** A Stripe-captured payment that repeated an existing one: recorded anyway, flagged for staff (SA-837b). */
export interface DuplicateSuspect {
  paymentIds: string[];
  invoiceId: string | null;
  duplicateOfPaymentId: string;
  duplicateOfInvoiceNumber: string | null;
}

/**
 * Money that already moved outside RouteFlow (SA-837b). Set ONLY by server code that holds the processor's event (the
 * Stripe settle path); there is no request field that can reach it. `suspects` collects what the caller must flag.
 */
export interface ExternalCapture {
  source: "STRIPE";
  /** The processor's own id for this charge (the payment intent id): the reference the payment is recorded under. */
  sourceRef: string;
  suspects?: DuplicateSuspect[];
}

/** The same charge is already on the ledger (thrown instead of recording it twice); the caller settles idempotently. */
export class PaymentAlreadyRecordedError extends Error {
  constructor(
    readonly paymentGroupId: string | null,
    readonly paymentId: string,
  ) {
    super("This charge was already recorded");
    this.name = "PaymentAlreadyRecordedError";
  }
}

/** The error's name test (an instance check would break across module copies in specs). */
export function isPaymentAlreadyRecorded(err: unknown): err is PaymentAlreadyRecordedError {
  return (err as { name?: unknown } | null)?.name === "PaymentAlreadyRecordedError";
}

export interface PaymentRefOpts {
  refDedupe?: RefDedupeOpts;
  paymentAttempt?: PaymentAttempt;
  paymentGroupId?: string;
  capturedExternally?: ExternalCapture;
}

export interface PaymentRefInput {
  /** The STORED Prisma method (a till's "CARD" is mapped to CREDIT_CARD by the caller, `toPrismaMethod`). */
  method: PaymentMethod;
  reference?: string | null;
  /** The payment's amount (a standalone payment: its total, excess included). */
  amount: number;
  /** The customer, when the writer knows it; else it is read off `invoiceId`. */
  customerId?: string | null;
  invoiceId?: string | null;
  opts?: PaymentRefOpts;
}

interface Existing {
  id: string;
  paymentNumber: string | null;
  paidAt: Date;
  cents: number;
  /** Null for an AdvancePayment. */
  invoiceId: string | null;
  invoiceNumber: string | null;
  paymentGroupId: string | null;
}

/** The retryable 503 LOCK_UNAVAILABLE: the reference is being recorded (or, for an edit, moved) elsewhere. */
export function paymentRefLockUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: API_ERROR_CODES.LOCK_UNAVAILABLE,
    message: "Another payment with this reference is being recorded. Try again in a moment.",
  });
}

/** 409 DUPLICATE_PAYMENT_REF: the body names the existing payment (the clients read it, packages/types). */
export function duplicatePaymentRefConflict(existing: Existing): ConflictException {
  const body: DuplicatePaymentRefBody = {
    code: API_ERROR_CODES.DUPLICATE_PAYMENT_REF,
    message:
      "A payment with this reference and amount was already recorded for this customer. Check before recording it again.",
    existingPayment: {
      id: existing.id,
      paymentNumber: existing.paymentNumber,
      paidAt: existing.paidAt.toISOString(),
      amount: existing.cents / 100,
      invoiceId: existing.invoiceId,
      invoiceNumber: existing.invoiceNumber,
    },
  };
  return new ConflictException(body);
}

export interface PaymentRefGuard {
  /** Inside the writer's transaction, before any money row: throws 409 on a duplicate unless staff recordAnyway. */
  check(tx: any): Promise<void>;
  /** Inside the same transaction after the money rows: marks the attempt, and audits a recorded-anyway repeat. */
  recorded(
    tx: any,
    paymentIds: ReadonlyArray<string | null | undefined>,
    invoiceId: string | null,
  ): Promise<void>;
}

/** The earliest row of a payment event, as the `Existing` the refusal names. */
function existingOf(hit: { rows: any[]; cents: number }): Existing {
  const first = [...hit.rows].sort(
    (a, b) => new Date(a.paidAt).getTime() - new Date(b.paidAt).getTime() || (a.id < b.id ? -1 : 1),
  )[0];
  return {
    id: first.id,
    paymentNumber: first.paymentNumber ?? null,
    paidAt: new Date(first.paidAt),
    cents: hit.cents,
    invoiceId: first.invoiceId,
    invoiceNumber: first.invoice?.invoiceNumber ?? null,
    paymentGroupId: first.paymentGroupId ?? null,
  };
}

export function createPaymentRefGuard(p: PaymentRefInput): PaymentRefGuard {
  const norm = normalizePaymentRef(p.reference);
  const attempt = p.opts?.paymentAttempt;
  const captured = p.opts?.capturedExternally;
  let anyway: Existing | null = null;
  let suspect: Existing | null = null;

  return {
    async check(tx) {
      anyway = null; // a retried transaction starts clean
      suspect = null;
      // m1: a rolled-back attempt's suspects never survive into the retry (the caller alerts only on what committed).
      if (captured?.suspects) captured.suspects.length = 0;
      if (!norm) return;
      const customerId =
        p.customerId ??
        (p.invoiceId
          ? (
              await tx.invoice.findUnique({
                where: { id: p.invoiceId },
                select: { customerId: true },
              })
            )?.customerId
          : null);
      if (!customerId) return;
      if (captured) {
        // m2: an all-excess charge books ONLY an AdvancePayment (no InvoicePayment row to dedupe against). Under the
        // payment-ref lock, an advance already carrying this exact source reference IS this charge: a second concurrent
        // delivery must not book a second advance.
        const advance = await tx.advancePayment.findFirst({
          where: { customerId, reference: captured.sourceRef },
          select: { id: true },
        });
        if (advance) throw new PaymentAlreadyRecordedError(null, advance.id);
      }
      const target = toCents(roundMoney(p.amount));
      const groupId = p.opts?.paymentGroupId;
      const rows: any[] = await tx.invoicePayment.findMany({
        where: {
          method: p.method,
          // every non-void payment with this ref is a duplicate, in-flight DRAFT/PENDING included
          status: { in: [...DEDUPE_STATUSES] },
          reference: { not: null },
          invoice: { customerId },
          // M4: a duplicate is the same amount (one row) or a member of a payment group (summed below); never every
          // referenced payment of the customer. The reference itself is judged by the one JS normaliser.
          OR: [
            { amount: roundMoney(p.amount) },
            { paymentGroupId: { not: null } },
            // m3: the same charge is recognised by its exact reference whatever its amount was
            ...(captured ? [{ reference: captured.sourceRef }] : []),
          ],
        },
        select: {
          id: true,
          amount: true,
          paidAt: true,
          paymentNumber: true,
          paymentGroupId: true,
          reference: true,
          invoiceId: true,
          invoice: { select: { invoiceNumber: true } },
        },
      });
      const others = rows.filter(
        (r) =>
          !attempt?.ids.has(r.id) &&
          !(groupId && r.paymentGroupId === groupId) &&
          normalizePaymentRef(r.reference) === norm,
      );
      if (captured) {
        // m3: the SAME charge is already on the ledger when ANY candidate carries its exact reference, whatever amount
        // or event the hit below picks; the caller then settles idempotently instead of recording it twice.
        const same = others.find((r) => r.reference === captured.sourceRef);
        if (same) throw new PaymentAlreadyRecordedError(same.paymentGroupId ?? null, same.id);
      }
      // One logical payment = one group (or one row): its amount is the sum of its rows.
      const events = new Map<string, { rows: any[]; cents: number; grouped: boolean }>();
      for (const r of others) {
        const key = r.paymentGroupId ?? r.id;
        const e = events.get(key) ?? { rows: [], cents: 0, grouped: r.paymentGroupId != null };
        e.rows.push(r);
        e.cents += toCents(Number(r.amount));
        events.set(key, e);
      }
      let hit = [...events.values()].find((e) => e.cents === target);
      if (!hit && [...events.values()].some((e) => e.grouped)) {
        // A standalone payment's excess is booked as an AdvancePayment with the same method, reference and date.
        const advances: any[] = await tx.advancePayment.findMany({
          where: { customerId, method: p.method },
          select: { amount: true, reference: true, receivedAt: true },
        });
        hit = [...events.values()].find((e) => {
          if (!e.grouped) return false;
          const at = new Date(e.rows[0].paidAt).getTime();
          const extra = advances
            .filter(
              (a) =>
                normalizePaymentRef(a.reference) === norm &&
                new Date(a.receivedAt).getTime() === at,
            )
            .reduce((s, a) => s + toCents(Number(a.amount)), 0);
          return extra > 0 && e.cents + extra === target;
        });
        if (hit) hit.cents = target; // the named amount is the whole payment, excess included
      }
      let existing: Existing | null = hit ? existingOf(hit) : null;
      if (!existing) {
        // SA-837b item 2 / G4: an AdvancePayment (no status: every row is live) with the same method, normalised
        // reference and amount is a duplicate too, in BOTH directions with the invoice payments above.
        const advances: any[] = await tx.advancePayment.findMany({
          where: {
            customerId,
            method: p.method,
            reference: { not: null },
            amount: roundMoney(p.amount),
          },
          select: { id: true, amount: true, reference: true, receivedAt: true },
        });
        const adv = advances.find(
          (a) =>
            !attempt?.ids.has(a.id) &&
            toCents(Number(a.amount)) === target &&
            normalizePaymentRef(a.reference) === norm,
        );
        if (adv) {
          existing = {
            id: adv.id,
            paymentNumber: null,
            paidAt: new Date(adv.receivedAt),
            cents: toCents(Number(adv.amount)),
            invoiceId: null,
            invoiceNumber: null,
            paymentGroupId: null,
          };
        }
      }
      if (!existing) return;
      const customer = await tx.customer.findUnique({
        where: { id: customerId },
        select: { isWalkIn: true },
      });
      if (customer?.isWalkIn) return; // the shared walk-in identity is never deduped
      if (captured) {
        // SA-837b: money already captured is never refused: a repeat that is not the same charge (m3, above) is
        // recorded and flagged.
        suspect = existing;
        return;
      }
      const role = p.opts?.refDedupe?.role;
      if (p.opts?.refDedupe?.recordAnyway === true && role && RECORD_ANYWAY_ROLES.includes(role)) {
        anyway = existing;
        return;
      }
      throw duplicatePaymentRefConflict(existing);
    },

    async recorded(tx, paymentIds, invoiceId) {
      for (const id of paymentIds) if (id) attempt?.ids.add(id);
      if (suspect && captured) {
        const ids = paymentIds.filter((id): id is string => !!id);
        const forInvoice = invoiceId ?? suspect.invoiceId;
        await tx.auditLog.create({
          data: {
            userId: null,
            action: AUDIT_ACTIONS.PAYMENT_REF_DUPLICATE_SUSPECT,
            entityType: "invoice",
            entityId: forInvoice,
            meta: {
              source: captured.source,
              paymentIntentId: captured.sourceRef,
              invoiceId: forInvoice,
              paymentIds: ids,
              normalisedRef: norm,
              duplicateOfPaymentId: suspect.id,
              method: p.method,
              amount: suspect.cents / 100,
            },
          },
        });
        captured.suspects?.push({
          paymentIds: ids,
          invoiceId: forInvoice,
          duplicateOfPaymentId: suspect.id,
          duplicateOfInvoiceNumber: suspect.invoiceNumber,
        });
        return;
      }
      if (!anyway) return;
      const actor = p.opts?.refDedupe?.actor ?? null;
      const forInvoice = invoiceId ?? anyway.invoiceId;
      // An advance duplicate has no invoice: the audit row then names the new advance itself.
      const entityId = forInvoice ?? paymentIds.find((id) => !!id) ?? anyway.id;
      await tx.auditLog.create({
        data: {
          userId: actor,
          action: AUDIT_ACTIONS.PAYMENT_REF_RECORDED_ANYWAY,
          entityType: forInvoice ? "invoice" : "advancePayment",
          entityId,
          meta: {
            actor,
            invoiceId: forInvoice,
            // SA-843 ruling 4: the rows this write recorded (or, for an edit, the row edited); additive, every writer
            paymentIds: paymentIds.filter((id): id is string => !!id),
            normalisedRef: norm,
            duplicateOfPaymentId: anyway.id,
            method: p.method,
            amount: anyway.cents / 100,
          },
        },
      });
    },
  };
}

/**
 * Run `fn` (the writer, transaction included) under the payment-ref lock for this payment's
 * tenant:method:normalised reference. No reference = no lock.
 *
 * SA-837b item 4: the lock acquisition AND the writer run inside `retryOnTxConflict` (the house wrapper that retries a
 * Postgres-aborted 40P01 / 40001, 3 attempts with backoff), so when the deadlock detector aborts one side of a
 * wait cycle that includes this lock, the victim retries instead of failing. Retries exhausted, or a lock that cannot
 * be taken, is a retryable 503, never a 500.
 *
 * KNOWN, BOUNDED (review M3): the lock is held across the writer, which may itself wait on the counter close lock or an
 * Invoice row. A wait cycle made only of row/transaction locks is aborted by the deadlock detector (40P01) and retried
 * here. A cycle through a pending exclusive day-close is NOT seen by the detector (this lock is a session advisory lock
 * taken on another connection): it ends at the 10 s lock wait with the retryable 503, the payment is not recorded at
 * the till, and nothing is written.
 */
export async function withPaymentRefLock<T>(
  deps: { getTenantId(): string | null },
  p: { method?: string | null; reference?: string | null },
  fn: () => Promise<T>,
): Promise<T> {
  const norm = normalizePaymentRef(p.reference);
  if (!norm || !p.method) return fn();
  const unavailable = paymentRefLockUnavailable;
  try {
    return await retryOnTxConflict(`payment-ref ${p.method}`, async () => {
      const out = await withAdvisoryLock(
        {
          family: "payment-ref",
          key: `${deps.getTenantId() ?? "none"}:${p.method}:${norm}`,
          mode: "wait",
          waitMs: 10_000,
        },
        fn,
      );
      if (!out.acquired) throw new LockUnavailableError(new Error("payment-ref lock not acquired"));
      return out.value;
    });
  } catch (e) {
    if (e instanceof LockTimeoutError || e instanceof LockUnavailableError || txConflictState(e))
      throw unavailable();
    throw e;
  }
}
