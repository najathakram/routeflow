import { defaultCounterTender, type CounterDefaultTender } from "@routeflow/types";
import type { CreditSource } from "./counter-customer-credit";

/**
 * SA-933 / W-822(a): the default tender for the picked customer, once the reads that decide it have answered. The customer's
 * own terms come from `GET /customers/:id`, the business default from `GET /settings/invoice` (the same two reads the
 * customer panel makes, same query keys). `null` = not known yet (a read pending or failed): the screen never guesses On
 * account from it; an undecided sale whose customer's terms are unknown sits on Cash until they are known (the safe side,
 * see useCounterTenderDefault). A walk-in is known at once: CASH.
 */
const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

const field = (src: unknown, key: string): unknown =>
  src && typeof src === "object" && !Array.isArray(src)
    ? (src as Record<string, unknown>)[key]
    : undefined;

export function resolveCounterDefaultTender(input: {
  customerId: string | null;
  customer: CreditSource;
  settings: CreditSource;
}): CounterDefaultTender | null {
  if (!input.customerId) return defaultCounterTender({ customer: null });
  if (input.customer.state !== "ready") return null;
  const own = text(field(input.customer.data, "defaultPaymentTerms"));
  if (own) return defaultCounterTender({ customer: { defaultPaymentTerms: own } });
  if (input.settings.state !== "ready") return null;
  const tenant = text(field(input.settings.data, "defaultTerms"));
  if (!tenant) return null; // the settings read always carries a default: a body without one is not an answer
  return defaultCounterTender({
    customer: { defaultPaymentTerms: null },
    tenantDefaultTerms: tenant,
  });
}
