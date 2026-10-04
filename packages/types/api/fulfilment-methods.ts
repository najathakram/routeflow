// One table for how an order is fulfilled, per METHOD. The status enum never changes (PENDING,
// CONFIRMED, OUT_FOR_DELIVERY, DELIVERED ...); what changes per method is the WORD for a status, the
// ordered steps, when the invoice is raised and which notification event fires. Web, mobile and the
// emails read this table instead of scattering `if (SHIP)` checks.
//
// The capability CONTRACT itself (`FulfilmentCapability`, `FulfilmentMethod`, the mode values) lives in
// ./fulfilment (business profiles 1A); this file is only the per-method table and the client helpers
// that read a capability.

import type { FulfilmentCapability, FulfilmentMethod } from "./fulfilment";

export const FULFILMENT_METHOD_VALUES = ["ROUTE", "SHIP", "PICKUP"] as const;

export interface FulfilmentMethodDef {
  /** Ordered order-status steps this method walks through. */
  steps: readonly string[];
  /** The label of each status for this method. ROUTE is today's wording, unchanged. */
  labels: Readonly<Record<string, string>>;
  /** Where the invoice is raised: the status that triggers it. SHIP is "SHIPPED" when the business is set
   *  to shipping (no such enum value yet: it maps onto OUT_FOR_DELIVERY), otherwise DELIVERED. */
  invoiceAt: "DELIVERED" | "SHIPPED";
  /** Customer notification event name per status transition. */
  emailEvents: Readonly<Record<string, string>>;
}

export const FULFILMENT_METHODS: Readonly<Record<FulfilmentMethod, FulfilmentMethodDef>> = {
  ROUTE: {
    steps: ["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY", "DELIVERED"],
    labels: { OUT_FOR_DELIVERY: "Out for Delivery", DELIVERED: "Delivered" },
    invoiceAt: "DELIVERED",
    emailEvents: { OUT_FOR_DELIVERY: "order.out_for_delivery", DELIVERED: "order.delivered" },
  },
  SHIP: {
    steps: ["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY", "DELIVERED"],
    labels: { OUT_FOR_DELIVERY: "Shipped", DELIVERED: "Delivered" },
    invoiceAt: "SHIPPED",
    emailEvents: { OUT_FOR_DELIVERY: "order.shipped", DELIVERED: "order.delivered" },
  },
  PICKUP: {
    steps: ["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY", "DELIVERED"],
    labels: { OUT_FOR_DELIVERY: "Ready for pickup", DELIVERED: "Picked up" },
    invoiceAt: "DELIVERED",
    emailEvents: { OUT_FOR_DELIVERY: "order.ready_for_pickup", DELIVERED: "order.picked_up" },
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

/** An account with no fulfilment mode set: exactly today's behaviour (ROUTE/SHIP both offered). */
export const UNSET_FULFILMENT_CAPABILITIES: FulfilmentCapability = {
  methods: ["ROUTE", "SHIP"],
  staffDefault: "ROUTE",
  staffOpensAs: "order",
  portalMethods: [],
  portalDefault: null,
  counter: "off",
  fleet: true,
  consistent: true,
};

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
