import { roundMoney } from "./pricing";

/**
 * SA-1050 rule 2: the PRE-TAX share of a written-off `amount`: `roundMoney(amount × (total − tax) / total)`, or 0 when
 * the invoice total is not positive. Uncollected sales tax is a liability reversal, not an expense (owner ruling
 * 2026-09-15), so the bad-debt expense books only this share. This is the B456 expression moved out of
 * `fetchBadDebtExpense`: the write-off event's `preTax` and the legacy per-invoice term both call it, never a second copy.
 */
export function badDebtPreTax(amount: unknown, total: unknown, taxAmount: unknown): number {
  const a = Number(amount ?? 0);
  const t = Number(total ?? 0);
  const tax = Number(taxAmount ?? 0);
  if (!Number.isFinite(a) || !Number.isFinite(t) || !Number.isFinite(tax) || !(t > 0)) return 0;
  return roundMoney((a * (t - tax)) / t);
}
