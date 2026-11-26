import { compareCodePoint, normalizeCustomerName, suggestCustomers } from "./customer-score";
import { parseCustomerName } from "./parse-customer-name";
import type {
  CustomerBindingRow,
  CustomerBindResult,
  CustomerCandidate,
  RfCustomerRow,
} from "./types";

/**
 * Pure binding resolver over RF customers and existing bindings PASSED IN.
 * It never writes and never creates a customer: no status leads to a default create.
 *
 * - Blank customer (or blank parent): HELD with a row error.
 * - One confirmed binding on the full "Parent:Job" key, to a customer still in the list: BOUND.
 *   A binding on the parent alone does not bind its jobs; each job is bound on its own.
 * - Otherwise the parent name is offered: one exact customer is CANDIDATE_EXACT, near names
 *   (or several exact ones) are SUGGESTED. All of these still need a person to confirm.
 * - Nothing near: UNBOUND.
 */
export function resolveCustomerBinding(
  name: string,
  customers: RfCustomerRow[],
  bindings: CustomerBindingRow[],
): CustomerBindResult {
  const { sourceKey, parent, job } = parseCustomerName(name);
  const base = { sourceKey, parent, job };

  if (sourceKey === "" || parent === "") {
    return {
      ...base,
      status: "HELD",
      boundCustomerId: null,
      canPost: false,
      candidates: [],
      rowError: {
        code: "BLANK_CUSTOMER",
        message: "The customer name is blank, so the row is held and nothing is attached.",
      },
    };
  }

  const bound = new Set(
    bindings
      .filter((b) => b.confirmed && b.sourceCustomerKey === sourceKey)
      .map((b) => b.customerId),
  );
  if (bound.size === 1) {
    const [customerId] = [...bound];
    if (customers.some((c) => c.id === customerId)) {
      return {
        ...base,
        status: "BOUND",
        boundCustomerId: customerId,
        canPost: true,
        candidates: [],
        rowError: null,
      };
    }
  }

  const key = normalizeCustomerName(parent);
  const exact: CustomerCandidate[] = customers
    .filter((c) => normalizeCustomerName(c.name) === key)
    .map((c) => ({ customerId: c.id, name: c.name, score: 1, basis: "EXACT" as const }))
    .sort(
      (x, y) => compareCodePoint(x.name, y.name) || compareCodePoint(x.customerId, y.customerId),
    );
  const open = { boundCustomerId: null, canPost: false, rowError: null };

  if (exact.length === 1) {
    return { ...base, ...open, status: "CANDIDATE_EXACT", candidates: exact };
  }
  if (exact.length > 1) {
    return { ...base, ...open, status: "SUGGESTED", candidates: exact };
  }

  const near = suggestCustomers(parent, customers);
  return near.length > 0
    ? { ...base, ...open, status: "SUGGESTED", candidates: near }
    : { ...base, ...open, status: "UNBOUND", candidates: [] };
}
