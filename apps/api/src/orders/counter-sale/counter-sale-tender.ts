import { ConflictException } from "@nestjs/common";
import {
  TENDER_RULES,
  dollarsToCents,
  planTenderLegs,
  remainingCapacity,
  roundMoney,
  type TenderPlacement,
} from "@routeflow/pricing";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import { uuidv5 } from "../../common/uuidv5";
import type { CounterLegInput } from "./counter-sale-legs";
import { toPrismaMethod } from "./counter-sale-payment";

export type InvoiceRow = {
  id: string;
  invoiceNumber?: string;
  total: unknown;
  payments?: Array<{
    id: string;
    amount: unknown;
    method?: string;
    status?: string;
    paymentGroupId?: string | null;
  }>;
};

/**
 * A payment the counter itself took (cash / card / check): not a credit-note or advance application.
 * scan-ok: draft-payment-not-void — a replay asks "was a tender already recorded?", and a VOIDED one
 * does not count; the counter never writes a DRAFT payment (recordPayment's default status is PAID).
 */
export const isTender = (p: { method?: string; status?: string }) =>
  p.status !== "VOID" && p.method !== "CREDIT_NOTE" && p.method !== "ADVANCE";

/**
 * The split tender of a counter sale, as pure functions: which payment row belongs to which leg, and what a
 * request's legs place over the sale's invoices. No IO, no lock (the service owns the one counter-tender lock).
 */

/** The server-built `paymentGroupId` of one leg: never in the DTO, never from the idempotency key. */
export function legGroupId(orderId: string, legIndex: number): string {
  return uuidv5(`${orderId}:${legIndex}`, TENDER_RULES.counter.groupNamespace);
}

export interface StoredLegRow {
  invoiceId: string;
  amountCents: number;
  /** the stored payment row itself (id, method, status for the read-back) */
  payment: NonNullable<InvoiceRow["payments"]>[number];
}

export interface StoredTender {
  /** leg index -> its stored payment rows (oldest invoice first, as read). */
  byLeg: Map<number, StoredLegRow[]>;
  /** true when tender rows exist but none carries this sale's group id (a pre-split attempt): all are leg 0's. */
  legacy: boolean;
}

/**
 * A row is this sale's grouped tender only if its paymentGroupId is the uuidv5 of some leg index below the
 * counter's leg limit. With NO grouped row, every other tender row counts toward leg 0 (the rule before
 * split payments, so a held attempt from before the deploy never double-charges). Once ANY grouped row exists,
 * rows without this sale's group id (an office payment made later) are not part of the tender.
 */
export function readStoredTender(orderId: string, invoices: InvoiceRow[]): StoredTender {
  const ids = new Map<string, number>();
  for (let i = 0; i < TENDER_RULES.counter.maxLegs; i++) ids.set(legGroupId(orderId, i), i);
  const all: Array<StoredLegRow & { leg: number | null }> = invoices.flatMap((inv) =>
    (inv.payments ?? []).filter(isTender).map((p) => ({
      invoiceId: inv.id,
      amountCents: dollarsToCents(roundMoney(Number(p.amount))),
      payment: p,
      leg: p.paymentGroupId != null ? (ids.get(p.paymentGroupId) ?? null) : null,
    })),
  );
  const byLeg = new Map<number, StoredLegRow[]>();
  const push = (leg: number, row: StoredLegRow) => byLeg.set(leg, [...(byLeg.get(leg) ?? []), row]);
  const grouped = all.filter((r) => r.leg != null);
  const rows = grouped.length > 0 ? grouped : all;
  for (const r of rows) {
    push(grouped.length > 0 ? r.leg! : 0, {
      invoiceId: r.invoiceId,
      amountCents: r.amountCents,
      payment: r.payment,
    });
  }
  return { byLeg, legacy: grouped.length === 0 && all.length > 0 };
}

export interface SaleTenderPlan {
  placements: TenderPlacement[];
  /** Cash handed over beyond what the cash leg places. */
  changeCents: number;
  /** Set when the tender cannot be taken as asked; NOTHING is placed then (all or nothing). */
  refusal?: string;
}

/** Each invoice's balance BEFORE any tender of this sale (total less wallet credit applied), in cents. */
export function preTenderBalances(
  invoices: InvoiceRow[],
): Array<{ id: string; balanceCents: number }> {
  return invoices.map((i) => ({
    id: i.id,
    balanceCents: dollarsToCents(
      roundMoney(
        remainingCapacity(
          Number(i.total),
          (i.payments ?? []).filter((p) => !isTender(p)),
        ),
      ),
    ),
  }));
}

/**
 * Plan the request's legs against the pre-tender balances (oldest invoice first, as given).
 * One leg keeps the rule from before split payments: an omitted amount is the exact balance, cash above it
 * gives change, a card or check above it is refused, a tender of zero is COUNTER_TENDER_SHORT, and a sale
 * with nothing owing takes nothing. A split is all or nothing: a refused non-cash leg, or a cash leg that
 * places nothing although cash was handed over, refuses the whole tender (COUNTER_PAYMENT_EXCEEDS_TOTAL) so
 * the clerk takes the payment again against the balance the server now shows.
 */
export function planSaleTender(invoices: InvoiceRow[], legs: CounterLegInput[]): SaleTenderPlan {
  const none: SaleTenderPlan = { placements: [], changeCents: 0 };
  const balances = preTenderBalances(invoices);
  const owing = balances.reduce((sum, b) => sum + b.balanceCents, 0);
  const single = legs.length === 1;
  if (single && (legs[0].method === "ON_ACCOUNT" || owing <= 0)) return none;
  const planned = legs.map((l) => ({
    method: l.method,
    amountCents: l.amount == null ? (single ? owing : 0) : dollarsToCents(roundMoney(l.amount)),
  }));
  if (single && planned[0].amountCents <= 0) {
    return { ...none, refusal: API_ERROR_CODES.COUNTER_TENDER_SHORT };
  }
  const plan = planTenderLegs(balances, planned);
  const cashPlacedNothing =
    !single &&
    planned.some(
      (l, i) =>
        l.method === "CASH" && l.amountCents > 0 && !plan.placements.some((p) => p.legIndex === i),
    );
  if (plan.refusedLegIndexes.length > 0 || cashPlacedNothing) {
    return { ...none, refusal: API_ERROR_CODES.COUNTER_PAYMENT_EXCEEDS_TOTAL };
  }
  return { placements: plan.placements, changeCents: plan.changeCents };
}

const changed = (why: string) =>
  new ConflictException({
    code: API_ERROR_CODES.COUNTER_TENDER_CHANGED,
    message: `This sale's payment no longer matches what was already taken (${why}). Check the sale before taking payment again.`,
  });

/**
 * A replay (same Idempotency-Key) must be the SAME tender, or a resume of it. Refused 409
 * COUNTER_TENDER_CHANGED, before anything more is recorded, when the stored rows cannot be this request's
 * legs: a split meeting a pre-split attempt's ungrouped rows, a stored leg this request does not have, a
 * stored leg with another method, or a stored amount above the planned placement (per leg and invoice, so
 * money is never topped up on another invoice). A stored amount BELOW the plan is an interrupted attempt:
 * it resumes (only the shortfall is recorded).
 */
export function assertStoredTenderMatches(
  stored: StoredTender,
  legs: CounterLegInput[],
  placements: TenderPlacement[],
): void {
  if (stored.legacy && legs.length > 1) throw changed("a one-payment sale replayed as a split");
  for (const [idx, rows] of stored.byLeg) {
    const leg = legs[idx];
    if (!leg) throw changed(`payment ${idx + 1} is not in this request`);
    const method = toPrismaMethod(leg.method as Parameters<typeof toPrismaMethod>[0]);
    if (rows.some((r) => r.payment.method !== method)) {
      throw changed(`payment ${idx + 1} was taken by another method`);
    }
    for (const invoiceId of new Set(rows.map((r) => r.invoiceId))) {
      const have = rows
        .filter((r) => r.invoiceId === invoiceId)
        .reduce((s, r) => s + r.amountCents, 0);
      const planned = placements
        .filter((p) => p.legIndex === idx && p.invoiceId === invoiceId)
        .reduce((s, p) => s + p.amountCents, 0);
      if (have > planned)
        throw changed(`payment ${idx + 1} was taken for more than this request asks`);
    }
  }
}
