// One table for how an order is SHOWN, per METHOD. The status enum never changes (PENDING,
// CONFIRMED, OUT_FOR_DELIVERY, DELIVERED ...); what changes per method is the WORD for a status and the
// ordered steps. Display only: the web and mobile read it instead of scattering `if (SHIP)` label checks.
// The billing moment and the notification events are NOT here: the api decides those (billsAtShipment,
// the shipped-email registry), per the business's fulfilment mode, never per method alone.
//
// The capability CONTRACT itself (`FulfilmentCapability`, `FulfilmentMethod`, the mode values) lives in
// ./fulfilment (business profiles 1A); this file is only the per-method table and the client helpers
// that read a capability.

import type { FulfilmentCapability, FulfilmentMethod } from "./fulfilment";

export interface FulfilmentMethodDef {
  /** Ordered order-status steps this method walks through. */
  steps: readonly string[];
  /** The label of each status for this method. ROUTE is today's wording, unchanged. */
  labels: Readonly<Record<string, string>>;
}

export const FULFILMENT_METHODS: Readonly<Record<FulfilmentMethod, FulfilmentMethodDef>> = {
  ROUTE: {
    steps: ["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY", "DELIVERED"],
    labels: { OUT_FOR_DELIVERY: "Out for Delivery", DELIVERED: "Delivered" },
  },
  SHIP: {
    steps: ["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY", "DELIVERED"],
    labels: { OUT_FOR_DELIVERY: "Shipped", DELIVERED: "Delivered" },
  },
  PICKUP: {
    steps: ["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY", "DELIVERED"],
    labels: { OUT_FOR_DELIVERY: "Ready for pickup", DELIVERED: "Picked up" },
  },
};

/** The word for `status` under `method`; `fallback` (the caller's normal label) for an unlisted status
 *  or an unknown method, so anything outside the table renders exactly as before. */
export function fulfilmentStatusLabel(
  method: string | null | undefined,
  status: string,
  fallback: string,
): string {
  const def = (FULFILMENT_METHODS as Record<string, FulfilmentMethodDef | undefined>)[method ?? ""];
  return def?.labels[status] ?? fallback;
}

// UNSET_FULFILMENT_CAPABILITIES lives in ./fulfilment (#3210): one copy, pinned by the api's
// fulfil-path-resolver spec; index.ts re-exports both files, so a second copy here would collide (TS2308).

/** The method to pre-select for an order/customer: the customer's own saved path first, but only when
 *  the account offers it; otherwise the account's staffDefault. */
export function preselectFulfilment(
  caps: Pick<FulfilmentCapability, "methods" | "staffDefault">,
  customerPath?: string | null,
): FulfilmentMethod {
  return customerPath && (caps.methods as string[]).includes(customerPath)
    ? (customerPath as FulfilmentMethod)
    : caps.staffDefault;
}
