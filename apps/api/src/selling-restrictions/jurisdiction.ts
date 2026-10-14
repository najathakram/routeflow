import type { RestrictionAddressPrecedence } from "@routeflow/types";
import { normalizeUsState } from "../common/us-states";
import { resolveGoverningState, type CustomerAddressFacts } from "./selling-restrictions.core";

/**
 * Row 510 (lead ruling 2026-10-13, Q5): the ONE answer to "which state is this sale judged in?". Pure: the caller
 * loads the customer's addresses and the tenant's business state (the service owns the reads); this decides.
 *
 *   COUNTER, POS and every PICKUP sale are judged where the STORE is (`tenantBusinessState`), a named customer or not:
 *     the goods change hands at the till, whatever address the buyer has on file.
 *   DELIVERY and SHIP are judged at the CUSTOMER's governing address, with the tenant's existing
 *     `selling_restrictions.governing_address` precedence (`resolveGoverningState`, reused and never forked).
 *   The tenant's system walk-in has no address of its own, so it is judged at the store on ANY path (the CQ-04 rule).
 *
 * Every staff path passes its path here through `EvaluateOptions.path` (the engine calls this once per evaluation);
 * the MacBook lane (L8) adopts the same function, so 510 and L8 cannot fork.
 */
export type SalePath = "COUNTER" | "POS" | "PICKUP" | "DELIVERY" | "SHIP";

/** What a sale is judged against: the buyer's address or the store's. Also the `basis` in the warning hash. */
export type JurisdictionBasis = "CUSTOMER" | "STORE";

/** The paths judged at the store. Everything else is judged at the customer's governing address. */
const STORE_PATHS: ReadonlySet<SalePath> = new Set<SalePath>(["COUNTER", "POS", "PICKUP"]);

export interface SaleCustomerFacts {
  /** The system walk-in flag (never the name). */
  isWalkIn?: boolean | null;
  addresses: readonly CustomerAddressFacts[];
}

export interface SaleTenantFacts {
  /** `tenantBusinessState(...)`: a USPS code, or null when the tenant has no usable business state. */
  businessState: string | null;
  addressPrecedence: RestrictionAddressPrecedence;
}

export interface SaleJurisdiction {
  /** A USPS code, or null when the state cannot be determined (the engine reads null as UNRESOLVED / INDETERMINATE). */
  state: string | null;
  basis: JurisdictionBasis;
}

/** Does this path, for this customer, take the store's state? (The service skips the customer read when it does.) */
export function usesStoreState(path: SalePath, customer?: { isWalkIn?: boolean | null } | null) {
  return STORE_PATHS.has(path) || customer?.isWalkIn === true;
}

export function resolveSaleJurisdiction(input: {
  path: SalePath;
  customer: SaleCustomerFacts | null;
  tenant: SaleTenantFacts;
}): SaleJurisdiction {
  const { path, customer, tenant } = input;
  if (usesStoreState(path, customer)) {
    return { state: normalizeUsState(tenant.businessState), basis: "STORE" };
  }
  if (!customer) return { state: null, basis: "CUSTOMER" };
  const governing = resolveGoverningState(customer.addresses, tenant.addressPrecedence);
  return { state: governing.resolved ? governing.state : null, basis: "CUSTOMER" };
}

/**
 * The path of an ORDER sale, from what the order itself says: the counter-sale POST (`counterSale`) is COUNTER; the
 * stored fulfil path decides the rest (PICKUP = the till / POS mode, SHIP = a carrier, anything else is delivered by
 * route). Used wherever an order is judged by its own path (create, promote, reopen, edit, the path switch).
 */
export function salePathForOrder(order: {
  counterSale?: boolean | null;
  fulfillPath?: string | null;
}): SalePath {
  if (order.counterSale === true) return "COUNTER";
  if (order.fulfillPath === "PICKUP") return "PICKUP";
  if (order.fulfillPath === "SHIP") return "SHIP";
  return "DELIVERY";
}
