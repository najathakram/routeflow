/**
 * F03 — the CONFIRMED payment predicate, and B421's cash/credit/advance split.
 *
 * A payment "counts" toward paid amounts, invoice status, dashboards, and
 * customer-facing documents ONLY once an operator has confirmed it
 * (`InvoicePayment.status === "PAID"`). DRAFT rows (e.g. an unconfirmed bulk
 * bank-reconciliation import) and VOID rows (a bounced check, a manual void)
 * must never be folded into a money-summing read.
 *
 * `status: { not: "VOID" }` was the historical (buggy) shorthand for "counts as
 * paid" across ~15 sites (bookkeeping dashboards, the invoice PDF,
 * reminder/send emails) — it silently counted an unconfirmed DRAFT payment as
 * collected money. See B11/B57/B74/B81/B84/B85/B97/B102/B103 in the bug
 * register and campaign batch F03.
 *
 * LISTING reads (the raw payments array shown to an operator/customer) keep
 * the broader `not: VOID` filter — a DRAFT row must stay VISIBLE so the UI can
 * render its "Draft — unconfirmed" badge (R2). Only the SUM that drives
 * balanceDue / invoice status / dashboards / documents narrows to this
 * predicate. Do not use this to replace a listing's `not: VOID` filter.
 *
 * MONEY DISCIPLINE: this is the ONE copy of the payment-confirmation predicate
 * — api, web and mobile all import it from `@routeflow/pricing`, never a
 * hand-rolled mirror. Plain string literals only (`CONFIRMED_STATUS`/
 * `CREDIT_NOTE_METHOD`/`ADVANCE_METHOD`), never a `@prisma/client` import —
 * this package has no build-time or runtime dependency on Prisma so it stays
 * importable from every workspace. A dedicated parity spec on the API side
 * (which does have Prisma) pins these literals to the live `PaymentStatus`/
 * `PaymentMethod` enum values.
 */
export const CONFIRMED_STATUS = "PAID";

/** @deprecated prefer `CONFIRMED_STATUS` directly; kept for existing Prisma
 *  `where: { ...CONFIRMED_PAYMENT }` call sites. */
export const CONFIRMED_PAYMENT = { status: CONFIRMED_STATUS } as const;

/**
 * B421 — the two `InvoicePayment.method` values that are credit APPLICATIONS,
 * not cash-like tender: a CREDIT_NOTE application never represents money the
 * tenant received (the credit note itself is the artifact; nothing is banked
 * when it's applied). An ADVANCE application draws down a pre-existing
 * `AdvancePayment` balance the customer funded earlier — from THIS invoice's
 * point of view it is also not new payment, which is why `statement.service.ts`
 * groups both together as "credits" for a per-customer statement.
 *
 * That symmetry does NOT extend to tenant-wide cash reporting: RouteFlow's
 * bookkeeping never reads the `AdvancePayment` model at all, so an ADVANCE
 * application's `InvoicePayment` row is the ONLY point in the entire system
 * where that already-real cash is ever recorded. Excluding it from cash-flow
 * the same way CREDIT_NOTE is excluded would make real, previously-received
 * cash disappear rather than just fix its timing — see `splitConfirmed`'s own
 * doc for which bucket each consumer should use.
 */
export const CREDIT_NOTE_METHOD = "CREDIT_NOTE";
export const ADVANCE_METHOD = "ADVANCE";
const CREDIT_METHODS = [CREDIT_NOTE_METHOD, ADVANCE_METHOD] as const;

/** Prisma `method: { notIn: [...] }` filter for a cash-like-only aggregate. */
export const CASH_METHOD_FILTER = { notIn: [...CREDIT_METHODS] };

export interface ConfirmablePaymentRow {
  // `unknown` (not `number | string`) so a Prisma row's `amount: Decimal` — the
  // actual runtime type on every InvoicePayment read in this codebase — is
  // assignable without this package importing Prisma's Decimal type.
  // `Number(...)` accepts it the same way every money-summing site already does.
  amount: unknown;
  // Optional (not just `| undefined`) so web/mobile's own (looser)
  // InvoicePayment DTOs — which model status/method as optional properties —
  // are structurally assignable without a cast at every call site. A missing
  // status/method simply never matches CONFIRMED / CREDIT_NOTE / ADVANCE
  // below, the correct conservative behavior for a row this package can't
  // otherwise identify.
  status?: string;
  method?: string;
}

/**
 * Sum the `amount` of only the CONFIRMED (PAID) rows in a payments array.
 * Tolerant of `null`/`undefined` so a caller can pass a relation that wasn't
 * included on a given query without an extra guard at every call site.
 */
export function sumConfirmed(
  payments: ReadonlyArray<Pick<ConfirmablePaymentRow, "amount" | "status">> | null | undefined,
): number {
  return (payments ?? [])
    .filter((p) => p.status === CONFIRMED_STATUS)
    .reduce((sum, p) => sum + Number(p.amount), 0);
}

export interface SplitConfirmedResult {
  /** Cash-like tender only (CASH/CHECK/ACH/CREDIT_CARD/ZELLE/OTHER). */
  cash: number;
  /** CREDIT_NOTE applications — never real cash, at this invoice or ever. */
  creditApplied: number;
  /** ADVANCE applications — real cash, but received earlier than this row's
   *  `paidAt` (see the module doc above); callers computing tenant-wide cash
   *  received (not this invoice's own balance) must add this to `cash`. */
  advanceApplied: number;
}

/**
 * Splits the SAME confirmed-payment array `sumConfirmed` sums into cash vs.
 * credit-note vs. advance buckets, so every consumer derives its figures from
 * ONE call over ONE filtered array instead of re-filtering independently
 * (B421 — a CREDIT_NOTE application rendering/counting as "Paid" cash was
 * exactly that kind of re-filtering drift). `cash + creditApplied +
 * advanceApplied === sumConfirmed(payments)` always.
 */
export function splitConfirmed(
  payments: ReadonlyArray<ConfirmablePaymentRow> | null | undefined,
): SplitConfirmedResult {
  const confirmed = (payments ?? []).filter((p) => p.status === CONFIRMED_STATUS);
  let cash = 0;
  let creditApplied = 0;
  let advanceApplied = 0;
  for (const p of confirmed) {
    const amount = Number(p.amount);
    if (p.method === CREDIT_NOTE_METHOD) creditApplied += amount;
    else if (p.method === ADVANCE_METHOD) advanceApplied += amount;
    else cash += amount;
  }
  return { cash, creditApplied, advanceApplied };
}

/** The subset of an already-serialized invoice/DTO carrying pre-split figures
 *  (e.g. what a server layer attaches via `splitConfirmed`). Field names match
 *  the API's DTO (`totalPaid`); a caller keying its own DTO differently (e.g.
 *  web's `paidAmount`) maps its field onto `totalPaid` before calling in. */
export interface PrecomputedConfirmedAmounts {
  totalPaid?: number | string | null;
  creditApplied?: number | string | null;
  advanceApplied?: number | string | null;
}

/**
 * Resolves the same three figures `splitConfirmed` produces, preferring a
 * caller's already-computed `totalPaid`/`creditApplied`/`advanceApplied` over
 * re-deriving them from the raw `payments` array — for a rendering surface
 * (a PDF/document template, a list/detail page) that receives a
 * server-computed DTO but must still degrade gracefully for a caller that
 * hands it raw payments instead.
 *
 * All-or-nothing on `totalPaid` alone (B421 hardening, independent review):
 * a caller that supplies `totalPaid` but omits `creditApplied`/
 * `advanceApplied` gets `0` for those, NEVER a value re-derived from
 * `payments` — mixing an old, credit-inclusive `totalPaid` with a freshly
 * split `creditApplied` would subtract the same credit twice and understate
 * the balance. Only when `totalPaid` itself is absent does this fall back to
 * splitting `payments` for all three figures together, so the three always
 * come from ONE consistent basis. See lesson L-159.
 */
export function resolveConfirmedAmounts(
  precomputed: PrecomputedConfirmedAmounts,
  payments: ReadonlyArray<ConfirmablePaymentRow> | null | undefined,
): SplitConfirmedResult {
  if (precomputed.totalPaid != null) {
    return {
      cash: Number(precomputed.totalPaid),
      creditApplied: Number(precomputed.creditApplied ?? 0),
      advanceApplied: Number(precomputed.advanceApplied ?? 0),
    };
  }
  return splitConfirmed(payments);
}
