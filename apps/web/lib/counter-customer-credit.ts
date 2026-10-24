import { roundMoney } from "@routeflow/pricing";

/**
 * CQ-07: the account signal the counter shows for a picked customer: their payment terms, credit limit and open balance,
 * an OVERDUE flag and an informational OVER-LIMIT note. Display only. Nothing here changes a sale (owner ruling 10-07: the
 * client never disables Complete for it; `credit_limit.enforce_new_orders` stays untouched).
 *
 * Every figure comes from ONE read and shows only when THAT read resolved: a failed or still-loading source gives that
 * field a "loading" / "failed" state, never a made-up value ("No limit", the business default terms as the customer's, or
 * a silently missing overdue flag).
 */

export type CreditSourceState = "loading" | "ready" | "failed";

/** One read's outcome: its state, and its body once ready (any part may be missing or wrong-typed). */
export interface CreditSource {
  state: CreditSourceState;
  data?: unknown;
}

export interface CounterCustomerCreditInput {
  /** `GET /customers/:id` (credit limit, own payment terms) */
  customer: CreditSource;
  /** `GET /customers/:id/statement` (outstanding, overdue) */
  statement: CreditSource;
  /** `GET /settings/invoice` (the business's default terms): used only when the customer has none of their own */
  settings: CreditSource;
}

/** A field is its value once its source resolved; otherwise it is still loading or could not be read. */
export type CreditField<T> = { state: "loading" | "failed" } | { state: "ready"; value: T };

export interface CounterCustomerCreditView {
  /** the customer's own terms, or the business default (`isDefault`); ready null = neither is on file */
  terms: CreditField<{ text: string; isDefault: boolean } | null>;
  /** ready null = no limit configured (the server treats only NULL as "no limit"); 0 is a real zero limit */
  creditLimit: CreditField<number | null>;
  /** the statement's outstanding amount */
  openBalance: CreditField<number>;
  /** the statement's overdue amount (0 = nothing overdue) */
  overdue: CreditField<number>;
  /** open balance above the limit (rounded to cents first); 0 = not over, or not known */
  overLimitBy: number;
  /** a read that matters here failed: the screen says so instead of showing a partial picture as complete */
  loadFailed: boolean;
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

const pending = (s: CreditSource): { state: "loading" | "failed" } =>
  s.state === "loading" ? { state: "loading" } : { state: "failed" };

export function counterCustomerCreditView(
  input: CounterCustomerCreditInput,
): CounterCustomerCreditView {
  const { customer, statement, settings } = input;

  // terms: the customer's OWN terms need the customer read; the business default only fills in for a customer who has none
  let terms: CounterCustomerCreditView["terms"];
  if (customer.state !== "ready") terms = pending(customer);
  else {
    const own = text(field(customer.data, "defaultPaymentTerms"));
    if (own) terms = { state: "ready", value: { text: own, isDefault: false } };
    else if (settings.state === "ready") {
      const fallback = text(field(settings.data, "defaultTerms"));
      terms = { state: "ready", value: fallback ? { text: fallback, isDefault: true } : null };
    } else terms = pending(settings);
  }

  // credit limit: only a missing limit is "no limit"; 0 is a zero limit (the server's credit guard reads it that way)
  let creditLimit: CounterCustomerCreditView["creditLimit"];
  if (customer.state !== "ready") creditLimit = pending(customer);
  else {
    const raw = num(field(customer.data, "creditLimit"));
    creditLimit = { state: "ready", value: raw !== null && raw >= 0 ? raw : null };
  }

  let openBalance: CounterCustomerCreditView["openBalance"];
  let overdue: CounterCustomerCreditView["overdue"];
  if (statement.state !== "ready") {
    openBalance = pending(statement);
    overdue = pending(statement);
  } else {
    const open = num(field(statement.data, "outstandingAmount"));
    const over = num(field(statement.data, "overdueAmount"));
    openBalance = open === null ? { state: "failed" } : { state: "ready", value: open };
    overdue =
      over === null
        ? { state: "failed" }
        : { state: "ready", value: roundMoney(over) > 0 ? roundMoney(over) : 0 };
  }

  // roundMoney BEFORE the comparison (L-170): float dust must not flip "over"
  let overLimitBy = 0;
  if (
    creditLimit.state === "ready" &&
    creditLimit.value !== null &&
    openBalance.state === "ready"
  ) {
    const gap = roundMoney(openBalance.value - creditLimit.value);
    overLimitBy = gap > 0 ? gap : 0;
  }

  const termsNeedSettings =
    customer.state === "ready" && !text(field(customer.data, "defaultPaymentTerms"));
  const loadFailed =
    customer.state === "failed" ||
    statement.state === "failed" ||
    (termsNeedSettings && settings.state === "failed");

  return { terms, creditLimit, openBalance, overdue, overLimitBy, loadFailed };
}

export const COUNTER_CUSTOMER_OVERDUE_COPY = "Overdue";
/**
 * Wording that claims nothing about what the SERVER will do: the order credit gate (`credit_limit.enforce_new_orders`) may
 * still refuse an order, and the till only shows the figures. Informational, and Complete is never disabled by the client.
 */
export const COUNTER_CUSTOMER_OVERDUE_NOTE = "For information only.";
export const COUNTER_CUSTOMER_OVER_LIMIT_NOTE = "For information only.";
export const COUNTER_CUSTOMER_NO_LIMIT_COPY = "No limit";
export const COUNTER_CUSTOMER_LOAD_FAILED_COPY = "Couldn't load credit info.";
export const COUNTER_CUSTOMER_DEFAULT_TERMS_COPY = "default terms";
