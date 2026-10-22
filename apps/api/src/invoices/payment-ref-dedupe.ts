import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { roundMoney, toCents } from "@routeflow/pricing";
import type { DuplicatePaymentRefBody } from "@routeflow/types";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { LockTimeoutError, LockUnavailableError, withAdvisoryLock } from "../common/db-locks";

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
 *  - SERIALISATION: `withPaymentRefLock` is `withAdvisoryLock` (family "payment-ref", key tenant:method:normRef),
 *    never raw SQL, so two NEW attempts with the same reference cannot both pass the check. A session lock wraps
 *    the writer's transaction, so it is taken BEFORE the transaction opens; the SA-824 key claim stays the first
 *    statement of that transaction, and a replay of a held key returns before this lock is ever requested.
 *    LOCK ORDER: the customer merge lock ("order-merge"), when a path holds it, is always taken BEFORE this lock;
 *    no code under this lock takes it (pinned by the census spec and the writers spec).
 */

/** Roles that may use `recordAnyway` (the staff roles the payment routes already admit). */
const STAFF_ROLES: readonly string[] = ["SUPER_ADMIN", "TENANT_ADMIN", "OPERATOR"];

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

export interface PaymentRefOpts {
  refDedupe?: RefDedupeOpts;
  paymentAttempt?: PaymentAttempt;
  paymentGroupId?: string;
}

export interface PaymentRefInput {
  method: string;
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
  invoiceId: string;
  invoiceNumber: string | null;
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

export function createPaymentRefGuard(p: PaymentRefInput): PaymentRefGuard {
  const norm = normalizePaymentRef(p.reference);
  const attempt = p.opts?.paymentAttempt;
  let anyway: Existing | null = null;

  return {
    async check(tx) {
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
      const target = toCents(roundMoney(p.amount));
      const groupId = p.opts?.paymentGroupId;
      // scan-ok: draft-payment-not-void — a DRAFT / PENDING payment is a recorded payment too; only a VOID one
      // (a reversed or bounced payment) is not "existing".
      const rows: any[] = await tx.invoicePayment.findMany({
        where: {
          method: p.method,
          status: { not: "VOID" },
          reference: { not: null },
          invoice: { customerId },
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
      if (others.length === 0) return;
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
      if (!hit) return;
      const customer = await tx.customer.findUnique({
        where: { id: customerId },
        select: { isWalkIn: true },
      });
      if (customer?.isWalkIn) return; // the shared walk-in identity is never deduped
      const first = [...hit.rows].sort(
        (a, b) =>
          new Date(a.paidAt).getTime() - new Date(b.paidAt).getTime() || (a.id < b.id ? -1 : 1),
      )[0];
      const existing: Existing = {
        id: first.id,
        paymentNumber: first.paymentNumber ?? null,
        paidAt: new Date(first.paidAt),
        cents: hit.cents,
        invoiceId: first.invoiceId,
        invoiceNumber: first.invoice?.invoiceNumber ?? null,
      };
      const role = p.opts?.refDedupe?.role;
      if (p.opts?.refDedupe?.recordAnyway === true && role && STAFF_ROLES.includes(role)) {
        anyway = existing;
        return;
      }
      throw duplicatePaymentRefConflict(existing);
    },

    async recorded(tx, paymentIds, invoiceId) {
      for (const id of paymentIds) if (id) attempt?.ids.add(id);
      if (!anyway) return;
      const actor = p.opts?.refDedupe?.actor ?? null;
      const forInvoice = invoiceId ?? anyway.invoiceId;
      await tx.auditLog.create({
        data: {
          userId: actor,
          action: AUDIT_ACTIONS.PAYMENT_REF_RECORDED_ANYWAY,
          entityType: "invoice",
          entityId: forInvoice,
          meta: {
            actor,
            invoiceId: forInvoice,
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
 * tenant:method:normalised reference. No reference = no lock. Lock trouble is a retryable 503, never a 500.
 */
export async function withPaymentRefLock<T>(
  deps: { getTenantId(): string | null },
  p: { method?: string | null; reference?: string | null },
  fn: () => Promise<T>,
): Promise<T> {
  const norm = normalizePaymentRef(p.reference);
  if (!norm || !p.method) return fn();
  try {
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
  } catch (e) {
    if (e instanceof LockTimeoutError || e instanceof LockUnavailableError) {
      throw new ServiceUnavailableException({
        code: API_ERROR_CODES.LOCK_UNAVAILABLE,
        message: "Another payment with this reference is being recorded. Try again in a moment.",
      });
    }
    throw e;
  }
}
