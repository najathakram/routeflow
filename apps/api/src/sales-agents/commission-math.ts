import { roundMoney } from "../common/pricing";

/** Sub-cent tolerance for paid/complete comparisons. */
export const COMMISSION_EPS = 0.005;

/**
 * The ONLY marker of an NSF bounce-fee InvoiceItem — written solely by
 * `invoices.service.ts setCheckStatus`, which imports this constant so the
 * writer and the commission engine's reader can never drift apart.
 */
export const NSF_FEE_DESCRIPTION_PREFIX = "NSF fee — returned check";

export interface InvoiceMoneyState {
  subtotal: number;
  discount: number;
  total: number;
  /** Σ InvoicePayment.amount, status PAID, method !== CREDIT_NOTE. */
  cashCollected: number;
  /** Σ InvoicePayment.amount, status PAID, method === CREDIT_NOTE. */
  creditApplied: number;
  /**
   * Σ qty×unitPrice of InvoiceItem rows whose description starts with
   * NSF_FEE_DESCRIPTION_PREFIX. Owner decision: agents must not earn
   * commission on NSF bounce-fee penalties, even though the fee is folded
   * into the STORED subtotal/total by `setCheckStatus`.
   */
  nsfFees: number;
}

/**
 * Owner decision: base = goods subtotal after discounts, excluding tax,
 * shipping, and NSF bounce fees. Credit notes reduce the base by their
 * PRE-TAX share (a credit is applied against the tax-inclusive total, so
 * scale it back to goods terms before subtracting) — that scaling uses
 * `goods` AFTER the NSF subtraction, since the fee is not goods and a credit
 * against the invoice should scale against real goods only.
 */
export function commissionBase(s: InvoiceMoneyState): number {
  const goods = Math.max(0, s.subtotal - s.discount - s.nsfFees);
  const creditPrincipal =
    s.total > COMMISSION_EPS ? roundMoney(s.creditApplied * (goods / s.total)) : 0;
  return roundMoney(Math.max(0, goods - creditPrincipal));
}

/**
 * Fraction of the still-collectible cash that has actually landed. Credit-note
 * applications are excluded from BOTH sides: they already shrank the base, so
 * counting them as collection would release commission on money never received.
 *
 * Deliberately UNCHANGED by the NSF exclusion above: the fee stays inside
 * `total` (and therefore `collectible`), so until the customer actually pays
 * it off this ratio reads slightly lower than it would if the fee were also
 * stripped out here — under-releasing payable rather than over-releasing it.
 * That is the conservative direction and never overpays an agent.
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
