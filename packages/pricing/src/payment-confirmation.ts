import { roundMoney } from "./pricing";

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

/** Prisma `method: { notIn: [...] }` filter for a cash-like-only aggregate
 *  (excludes BOTH CREDIT_NOTE and ADVANCE) — an invoice-level "how much cash
 *  did THIS invoice collect" figure. `as const` so `notIn`'s array stays the
 *  specific `"CREDIT_NOTE" | "ADVANCE"` literal union, not a widened
 *  `string[]` — Prisma's generated enum filter (`EnumPaymentMethodFilter`)
 *  requires the narrow union; a plain `string[]` fails `tsc` at the call
 *  site even though this package can't import that Prisma type to check
 *  against directly. */
export const CASH_METHOD_FILTER = { notIn: [...CREDIT_METHODS] } as const;

/** Prisma `method: { not: ... }` filter for a "money genuinely received (at
 *  SOME point)" aggregate — excludes ONLY CREDIT_NOTE, keeps ADVANCE. Use
 *  this (never `CASH_METHOD_FILTER`) for a tenant- or customer-wide
 *  lifetime/cash-flow figure: an ADVANCE application's `InvoicePayment` row
 *  is the only place that already-real cash is ever recorded (see this
 *  module's own doc above), so dropping it here would make real cash
 *  disappear rather than just reflect its true collection date. `as const`
 *  for the same narrow-literal reason as `CASH_METHOD_FILTER` above. */
export const RECEIVED_METHOD_FILTER = { not: CREDIT_NOTE_METHOD } as const;

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

// ─── Post-dated check payments PR-1 (additive-only) — HELD money vs. capacity ──────────────────
//
// `PaymentStatus` gains a `PENDING` value (a post-dated check recorded and on file, but not yet
// clearable/bankable) alongside the existing `DRAFT`/`PAID`/`VOID`. The helpers below are
// consumed by NOTHING in this PR (every existing call site is untouched — see the design's
// §3.4 table, which is out of scope here) — they exist so a later PR has one shared place to
// read "is this money held" from, instead of a fifth hand-rolled predicate.

/** The two statuses that represent money the tenant can treat as spoken for: fully confirmed
 *  (PAID) or a post-dated check on file that has not yet cleared (PENDING). Deliberately
 *  excludes DRAFT — see `isNotVoid`/`remainingCapacity` below for why a capacity guard must
 *  NOT be built on this set. */
export const HELD_STATUSES = ["PAID", "PENDING"] as const;

/** Prisma `where: { status: { in: [...] } }` filter for `HELD_STATUSES`. */
export const HELD_PAYMENT = { status: { in: [...HELD_STATUSES] } } as const;

/** True iff `p.status` is PAID or PENDING — the same test `HELD_PAYMENT`/`HELD_STATUSES`
 *  express as a Prisma filter, for a caller holding an already-fetched row instead of building
 *  a query. */
export function isHeldPayment(p: { status?: string }): boolean {
  return p.status === "PAID" || p.status === "PENDING";
}

/**
 * Every `InvoicePayment.status` that should still BLOCK a destructive action on the invoice/order
 * it's attached to (a void, a cancel) — i.e. everything except VOID. `PaymentStatus` today is
 * DRAFT | PAID | VOID | PENDING (no separate "failed" status), so this is exactly DRAFT + PAID +
 * PENDING.
 *
 * N4 (binding — independent Opus review of the design, quoted verbatim; see `remainingCapacity`
 * below for the same citation in full):
 *
 * > N4: HELD = PAID ∪ PENDING omits DRAFT... `externalPaidOn`/`cancelImpact` become
 * > `isHeldPayment`. A DRAFT external payment... would stop blocking an invoice void or order
 * > cancel. That silently reverses a block master deliberately keeps.
 *
 * Owner ruling (2026-09-16, relayed by the lead): DRAFT payments KEEP blocking invoice void /
 * order cancel — a recorded-but-unconfirmed payment is money in flight. `HELD_STATUSES`/
 * `HELD_PAYMENT`/`isHeldPayment` above answer "is this money spoken-for" for MONEY TOTALS; this
 * constant answers "is there a payment here that should block a destructive action" for EXISTENCE
 * checks — a different question that must NEVER be answered with `isHeldPayment` (that is
 * precisely the regression N4 exists to prevent). Kept as its own named, documented export
 * (rather than reusing the internal `sumNotVoid` filter `remainingCapacity` uses below) because
 * existence and capacity are different questions that happen to share a filter today; a future
 * split of either must update its own export explicitly, never silently share the other's.
 */
export const BLOCKING_PAYMENT_STATUSES = ["DRAFT", "PAID", "PENDING"] as const;

/** Prisma `where: { status: { in: [...] } }` filter for `BLOCKING_PAYMENT_STATUSES`. */
export const BLOCKING_PAYMENT = { status: { in: [...BLOCKING_PAYMENT_STATUSES] } } as const;

/** True iff `p.status` is one of `BLOCKING_PAYMENT_STATUSES` (i.e. not VOID) — the existence-
 *  check predicate `externalPaidOn`/`cancelImpact` use instead of `isHeldPayment`. */
export function isBlockingPayment(p: { status?: string }): boolean {
  return p.status !== "VOID";
}

/**
 * Sum the `amount` of every HELD (PAID or PENDING) row in a payments array — money currently
 * held: either fully confirmed, or a post-dated check on file that hasn't cleared yet. Used
 * later where a reader needs "this money is spoken for" without yet being bankable. Distinct
 * from `sumConfirmed` (PAID only) — see the mixed-fixture spec proving the two differ.
 */
export function sumHeld(
  payments: ReadonlyArray<Pick<ConfirmablePaymentRow, "amount" | "status">> | null | undefined,
): number {
  return roundMoney(
    (payments ?? []).filter((p) => isHeldPayment(p)).reduce((sum, p) => sum + Number(p.amount), 0),
  );
}

/** The date money on a payment is treated as actually collected: `settledAt` when set, else
 *  `paidAt`. Deliberately generic (no Date import) like the rest of this file — a caller
 *  `Number()`s/formats it as needed. */
export function collectedDateOf(p: { settledAt?: unknown; paidAt?: unknown }): unknown {
  return p.settledAt ?? p.paidAt;
}

/**
 * Sum of every payment whose `status` is NOT VOID — i.e. DRAFT + PAID + PENDING. This is the
 * capacity-consuming set, and it is DELIBERATELY NOT `sumHeld`/`sumConfirmed`: those answer "is
 * this money held/confirmed", a different question from "does this row already consume
 * capacity against the invoice/allocation it was recorded on".
 *
 * Internal to this module — `remainingCapacity` below is the public entry point. Not exported
 * because "not void" is a capacity concept, not a payment-confirmation concept, and giving it
 * its own top-level export would invite a second, competing "which payments count" predicate in
 * this file.
 */
function sumNotVoid(
  payments: ReadonlyArray<Pick<ConfirmablePaymentRow, "amount" | "status">> | null | undefined,
): number {
  return (payments ?? [])
    .filter((p) => p.status !== "VOID")
    .reduce((sum, p) => sum + Number(p.amount), 0);
}

/**
 * How much more can be applied/recorded against an invoice/allocation before it is overbooked —
 * a GUARD used at record/apply time, never a display figure.
 *
 * N4 (binding — independent Opus review of the design, quoted verbatim so a future reader has
 * the citation):
 *
 * > N4: HELD = PAID ∪ PENDING omits DRAFT, so capacity guards built on it would NOT be
 * > behaviour-neutral. Today's capacity/guard sites (recordPayment, updatePayment, credit-note
 * > apply/auto-apply, advance apply, mobile edit cap) all check `status !== VOID` — meaning an
 * > unconfirmed DRAFT payment (e.g. an unconfirmed bulk bank-import row) already consumes
 * > capacity today, correctly preventing a double-book before that DRAFT is even confirmed.
 * > Resolution: CAPACITY = status ≠ VOID is the conservative choice — capacity must keep
 * > counting DRAFT.
 *
 * Therefore this function subtracts `sumNotVoid` (DRAFT + PAID + PENDING), never `sumHeld`
 * (PAID + PENDING only) and never `sumConfirmed` (PAID only) — reusing either of those here
 * would silently stop counting DRAFT the moment this helper is wired into a real call site,
 * which is exactly the regression N4 exists to prevent. Rounded with `roundMoney` like every
 * other money-returning export in this package.
 */
export function remainingCapacity(
  total: number,
  payments: ReadonlyArray<Pick<ConfirmablePaymentRow, "amount" | "status">> | null | undefined,
): number {
  return roundMoney(Number(total) - sumNotVoid(payments));
}
