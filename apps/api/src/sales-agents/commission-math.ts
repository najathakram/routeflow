import { roundMoney } from "../common/pricing";

/** Sub-cent tolerance for paid/complete comparisons. */
export const COMMISSION_EPS = 0.005;

export interface InvoiceMoneyState {
  subtotal: number;
  discount: number;
  total: number;
  /** Σ InvoicePayment.amount, status PAID, method !== CREDIT_NOTE. */
  cashCollected: number;
  /** Σ InvoicePayment.amount, status PAID, method === CREDIT_NOTE. */
  creditApplied: number;
}

/**
 * Owner decision: base = goods subtotal after discounts, excluding tax and shipping.
 * Credit notes reduce the base by their PRE-TAX share (a credit is applied against
 * the tax-inclusive total, so scale it back to goods terms before subtracting).
 */
export function commissionBase(s: InvoiceMoneyState): number {
  const goods = Math.max(0, s.subtotal - s.discount);
  const creditPrincipal =
    s.total > COMMISSION_EPS ? roundMoney(s.creditApplied * (goods / s.total)) : 0;
  return roundMoney(Math.max(0, goods - creditPrincipal));
}

/**
 * Fraction of the still-collectible cash that has actually landed. Credit-note
 * applications are excluded from BOTH sides: they already shrank the base, so
 * counting them as collection would release commission on money never received.
 */
export function collectionRatio(s: InvoiceMoneyState): number {
  const collectible = roundMoney(s.total - s.creditApplied);
  if (collectible <= COMMISSION_EPS) return 1;
  if (collectible - s.cashCollected <= COMMISSION_EPS) return 1; // full-payment snap
  return Math.max(0, Math.min(1, s.cashCollected / collectible));
}

export type RateSource = "ORDER_OVERRIDE" | "CUSTOMER_RATE" | "AGENT_DEFAULT" | "NONE";

export interface RateRow {
  ratePct: number;
  effectiveFrom: Date;
}

/**
 * Precedence: per-order override (0 IS a value — "exempt") -> newest customer rate
 * effective on basisDate -> newest agent rate effective on basisDate -> NONE.
 */
export function resolveRate(
  orderOverridePct: number | null | undefined,
  customerRates: RateRow[],
  agentRates: RateRow[],
  basisDate: Date,
): { ratePct: number; source: RateSource } {
  if (orderOverridePct != null)
    return { ratePct: Number(orderOverridePct), source: "ORDER_OVERRIDE" };
  const pick = (rows: RateRow[]) =>
    rows
      .filter((r) => r.effectiveFrom.getTime() <= basisDate.getTime())
      .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];
  const c = pick(customerRates);
  if (c) return { ratePct: Number(c.ratePct), source: "CUSTOMER_RATE" };
  const a = pick(agentRates);
  if (a) return { ratePct: Number(a.ratePct), source: "AGENT_DEFAULT" };
  return { ratePct: 0, source: "NONE" };
}

/** STOPPED_FOR_NEW: new business stops, pre-stop recurring relationships keep earning. */
export function passesGrandfathering(args: {
  stopNewBusinessAt: Date | null;
  basisDate: Date;
  orderTemplateCreatedAt: Date | null;
  recurringInvoiceCreatedAt: Date | null;
}): boolean {
  const stop = args.stopNewBusinessAt;
  if (!stop || args.basisDate.getTime() < stop.getTime()) return true;
  return (
    (args.orderTemplateCreatedAt != null &&
      args.orderTemplateCreatedAt.getTime() < stop.getTime()) ||
    (args.recurringInvoiceCreatedAt != null &&
      args.recurringInvoiceCreatedAt.getTime() < stop.getTime())
  );
}

export const accruedCommission = (base: number, ratePct: number): number =>
  roundMoney((base * ratePct) / 100);

export const payableCommission = (accrued: number, ratio: number): number =>
  roundMoney(accrued * ratio);
