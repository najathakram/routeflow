import { roundMoney } from "@routeflow/pricing";

/**
 * CQ-07: the account signal the counter shows for a picked customer: their payment terms, credit limit and open balance,
 * an OVERDUE flag and an informational OVER-LIMIT note. Display only. Nothing here blocks or changes a sale (owner ruling
 * 10-07: a sale is never prevented; `credit_limit.enforce_new_orders` stays untouched).
 */

/** What the two reads (the customer record and the operator statement) hand over. Any part may be missing or wrong-typed. */
export interface CounterCustomerCreditInput {
  /** `GET /customers/:id` */
  customer?: unknown;
  /** `GET /customers/:id/statement` */
  statement?: unknown;
  /** the business's default terms (`GET /settings/invoice` `defaultTerms`), used when the customer has none of their own */
  tenantTerms?: string | null;
}

export interface CounterCustomerCreditView {
  /** the customer's own terms, else the business default; null when neither is known */
  terms: string | null;
  /** null = no limit configured (0 / absent), a positive number otherwise */
  creditLimit: number | null;
  /** the statement's outstanding amount; null while unknown */
  openBalance: number | null;
  /** the statement's overdue amount; 0 = nothing overdue (or unknown) */
  overdue: number;
  /** open balance above the limit (rounded to cents first); 0 = not over */
  overLimitBy: number;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

const field = (src: unknown, key: string): unknown =>
  src && typeof src === "object" && !Array.isArray(src)
    ? (src as Record<string, unknown>)[key]
    : undefined;

export function counterCustomerCreditView(
  input: CounterCustomerCreditInput,
): CounterCustomerCreditView {
  const limitRaw = num(field(input.customer, "creditLimit"));
  const creditLimit = limitRaw !== null && limitRaw > 0 ? limitRaw : null;
  const openBalance = num(field(input.statement, "outstandingAmount"));
  const overdueRaw = num(field(input.statement, "overdueAmount"));
  const overdue = overdueRaw !== null && roundMoney(overdueRaw) > 0 ? roundMoney(overdueRaw) : 0;
  // roundMoney BEFORE the comparison (L-170): float dust must not flip "over".
  const gap =
    creditLimit !== null && openBalance !== null ? roundMoney(openBalance - creditLimit) : 0;
  return {
    terms: text(field(input.customer, "defaultPaymentTerms")) ?? text(input.tenantTerms),
    creditLimit,
    openBalance,
    overdue,
    overLimitBy: gap > 0 ? gap : 0,
  };
}

export const COUNTER_CUSTOMER_OVERDUE_COPY = "Overdue";
export const COUNTER_CUSTOMER_OVERDUE_NOTE = "You can still ring this sale.";
export const COUNTER_CUSTOMER_OVER_LIMIT_NOTE =
  "For your information only. This sale is not blocked.";
export const COUNTER_CUSTOMER_NO_LIMIT_COPY = "No limit";
export const COUNTER_CUSTOMER_UNAVAILABLE_COPY = "Account details unavailable.";
