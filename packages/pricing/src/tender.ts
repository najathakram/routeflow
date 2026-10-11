import { MoneyInvariantError } from "./money-invariants";
import { isWholeCents, roundMoney } from "./pricing";

/**
 * Split-payment tender vocabulary and the pure leg-placement plan, in INTEGER CENTS. No clock, no IO.
 * The API cannot value-import @routeflow/types, so the lists live here (L-072: one source) and the
 * types package pins its own copy against them.
 */
export const TENDER_METHOD_VALUES = [
  "CASH",
  "CARD",
  "CHECK",
  "ON_ACCOUNT",
  "STORE_CREDIT",
] as const;
export type TenderMethod = (typeof TENDER_METHOD_VALUES)[number];

/** Where a tender is taken. One row of TENDER_RULES per surface (the Record is exhaustive). */
export const TENDER_SURFACE_VALUES = ["counter"] as const;
export type TenderSurface = (typeof TENDER_SURFACE_VALUES)[number];

export interface TenderLeg {
  method: TenderMethod;
  amountCents: number;
  reference?: string;
  creditNoteId?: string;
}

export interface TenderRule {
  /** Methods this surface takes; anything else (e.g. STORE_CREDIT at the counter) is refused. */
  readonly allowed: readonly TenderMethod[];
  readonly maxLegs: number;
  readonly maxCashLegs: number;
  /** Methods that may only be the sale's single leg (ON_ACCOUNT takes no money, so it cannot be split). */
  readonly singleLegOnly: readonly TenderMethod[];
  /**
   * UUID namespace for the server-built `paymentGroupId` of a leg: uuidv5(`${orderId}:${legIndex}`, ns).
   * A FIXED literal generated once and pinned by a spec: changing it orphans every stored split sale.
   */
  readonly groupNamespace: string;
}

export const TENDER_RULES: Record<TenderSurface, TenderRule> = {
  counter: {
    allowed: ["CASH", "CARD", "CHECK", "ON_ACCOUNT"],
    maxLegs: 4,
    maxCashLegs: 1,
    singleLegOnly: ["ON_ACCOUNT"],
    groupNamespace: "a23aad82-7f3e-4540-a470-5476bbe31766",
  },
};

export interface TenderInvoice {
  id: string;
  balanceCents: number;
}

export interface TenderPlacement {
  /** Index of the leg in the REQUEST (not in processing order). */
  legIndex: number;
  invoiceId: string;
  amountCents: number;
}

export interface TenderPlan {
  placements: TenderPlacement[];
  /** Cash handed over beyond what the cash legs placed. */
  changeCents: number;
  /** Request indexes of non-cash legs that did not fit what earlier legs left (placed whole or refused). */
  refusedLegIndexes: number[];
}

const assertCents = (n: number, what: string): void => {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new MoneyInvariantError(`${what} must be a safe integer >= 0 cents (got ${n})`);
  }
};

/**
 * Place a sale's tender legs over its invoices. `invoices` are used oldest-first AS GIVEN (the caller
 * orders them; this never sorts) and `legs` in request order; neither input is mutated.
 *
 * Non-cash legs go first in request order, then cash legs. Each leg takes what the earlier legs left,
 * oldest invoice first. A non-cash leg is placed WHOLE or refused (it appears in `refusedLegIndexes`,
 * nothing placed): a card cannot be charged for more than is owed. A cash leg places min(amount, left)
 * and the remainder is change. ON_ACCOUNT takes no money: it places nothing and is never refused.
 * Throws MoneyInvariantError on a non-integer, negative or unsafe amount or balance.
 */
export function planTenderLegs(
  invoices: readonly TenderInvoice[],
  legs: readonly Pick<TenderLeg, "method" | "amountCents">[],
): TenderPlan {
  invoices.forEach((i) => assertCents(i.balanceCents, `invoice ${i.id} balance`));
  legs.forEach((l, i) => assertCents(l.amountCents, `leg ${i} amount`));

  const left = invoices.map((i) => i.balanceCents);
  const placements: TenderPlacement[] = [];
  const refusedLegIndexes: number[] = [];
  let changeCents = 0;

  const place = (legIndex: number, want: number): number => {
    let remaining = want;
    for (let k = 0; k < invoices.length && remaining > 0; k++) {
      const part = Math.min(remaining, left[k]);
      if (part <= 0) continue;
      left[k] -= part;
      remaining -= part;
      placements.push({ legIndex, invoiceId: invoices[k].id, amountCents: part });
    }
    return want - remaining;
  };

  const indexes = legs.map((_, i) => i);
  const nonCash = indexes.filter(
    (i) => legs[i].method !== "CASH" && legs[i].method !== "ON_ACCOUNT",
  );
  for (const i of nonCash) {
    const amount = legs[i].amountCents;
    if (amount === 0) continue;
    if (amount > left.reduce((a, b) => a + b, 0)) refusedLegIndexes.push(i);
    else place(i, amount);
  }
  for (const i of indexes.filter((n) => legs[n].method === "CASH")) {
    changeCents += legs[i].amountCents - place(i, legs[i].amountCents);
  }
  return { placements, changeCents, refusedLegIndexes };
}

/**
 * Dollars -> integer cents for a tender amount. The ONE conversion (never `Math.round(x * 100)` inline):
 * roundMoney snaps the float tail first. Throws on a sub-cent or non-finite amount (refused, never rounded).
 */
export function dollarsToCents(dollars: number): number {
  if (!isWholeCents(dollars)) {
    throw new MoneyInvariantError(`amount must be whole cents (got ${dollars})`);
  }
  return Math.round(roundMoney(dollars) * 100);
}

/** Integer cents -> dollars (exact: the closest double to the decimal, whole cents by construction). */
export function centsToDollars(cents: number): number {
  if (!Number.isSafeInteger(cents)) {
    throw new MoneyInvariantError(`cents must be a safe integer (got ${cents})`);
  }
  return cents / 100;
}
