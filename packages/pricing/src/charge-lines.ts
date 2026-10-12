import { roundMoney } from "./pricing";
import type { MoneyLike } from "./invoice-totals";

/**
 * CQ-03 / CQ-08: a regulated levy (deposit, excise) is its OWN named charge on the till's breakdown, the receipt and
 * the invoice: "CRV deposit $0.40", "Tobacco excise $2.00" - never folded into "Tax", never an unexplained
 * "Adjustments". ONE grouping and ONE wording, here, for every surface.
 */
export interface ChargeLineInput {
  /** The line's levy in money. 0 / absent lines add nothing. */
  categoryTaxAmount?: MoneyLike | null;
  /** The regulated category's id: lines of one category are ONE charge. Absent: grouped by name. */
  categoryId?: string | null;
  categoryName?: string | null;
  /** The category's tax type (`DEPOSIT_PER_CONTAINER`, `EXCISE_PER_UNIT`, `PER_VOLUME`, `PERCENT_OF_SALE`). */
  categoryTaxType?: string | null;
}

export interface ChargeLine {
  /** the category id (or its name when no id is known): a stable React key */
  key: string;
  label: string;
  amount: number;
}

const WORD: Record<string, string> = {
  DEPOSIT_PER_CONTAINER: "deposit",
  EXCISE_PER_UNIT: "excise",
  PER_VOLUME: "tax",
  PERCENT_OF_SALE: "tax",
};

/** "CRV" + deposit -> "CRV deposit"; a name that already says it ("Bottle deposit") is left alone. */
export function categoryChargeLabel(
  name: string | null | undefined,
  taxType: string | null | undefined,
): string {
  const n = (name ?? "").trim();
  const word = WORD[taxType ?? ""] ?? "charge";
  if (!n) return `${word[0].toUpperCase()}${word.slice(1)}`;
  return new RegExp(`\\b${word}\\b`, "i").test(n) ? n : `${n} ${word}`;
}

/** One charge per regulated category, first-seen order, zero amounts left out, each amount rounded to cents. */
export function chargeLinesOf(lines: readonly ChargeLineInput[]): ChargeLine[] {
  const byKey = new Map<string, ChargeLine>();
  for (const l of lines) {
    const amount = Number(l.categoryTaxAmount ?? 0);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const key = l.categoryId || (l.categoryName ?? "").trim() || "levy";
    const prev = byKey.get(key);
    if (prev) prev.amount = roundMoney(prev.amount + amount);
    else
      byKey.set(key, {
        key,
        label: categoryChargeLabel(l.categoryName, l.categoryTaxType),
        amount: roundMoney(amount),
      });
  }
  return [...byKey.values()].filter((c) => c.amount !== 0);
}
