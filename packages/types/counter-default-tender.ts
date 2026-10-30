/**
 * SA-933 / W-822(a): the counter's DEFAULT tender for the picked customer, from their EFFECTIVE payment terms. Pure, shared by
 * web and mobile, and the same one rule the server's `InvoicesService.resolveDefaultTerms()` applies: the customer's own
 * `defaultPaymentTerms` win; otherwise the tenant's `invoice.defaultTerms`; otherwise "Net 30".
 *
 * Due on Receipt (and Net 0) means the money is owed now: CASH. Any Net N above zero means the customer is billed later:
 * ON_ACCOUNT. A walk-in, or no customer at all, has no account to charge: CASH. A term this function cannot read is priced
 * like the server prices it (`TERM_DAYS[terms] ?? 30`): thirty days, so ON_ACCOUNT.
 *
 * It is only a default: the clerk's own tender choice always wins, and the screen never applies it over a restored sale.
 */
export type CounterDefaultTender = "CASH" | "ON_ACCOUNT";

export interface CounterDefaultTenderInput {
  /** The picked customer; null / absent is a walk-in. Only their own terms matter here. */
  customer?: { defaultPaymentTerms?: string | null } | null;
  /** The tenant's default terms (`invoice.defaultTerms`); null / empty when none is stored. */
  tenantDefaultTerms?: string | null;
}

const clean = (v: string | null | undefined): string => (typeof v === "string" ? v.trim() : "");

export function defaultCounterTender(input: CounterDefaultTenderInput): CounterDefaultTender {
  if (!input.customer) return "CASH";
  const terms =
    clean(input.customer.defaultPaymentTerms) || clean(input.tenantDefaultTerms) || "Net 30";
  if (/^due on receipt$/i.test(terms)) return "CASH";
  const net = /^net\s+(\d+)$/i.exec(terms);
  if (net) return Number(net[1]) > 0 ? "ON_ACCOUNT" : "CASH";
  return "ON_ACCOUNT";
}
