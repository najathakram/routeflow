import { FLEET_MODULE_KEYS, type FulfilmentMode } from "@routeflow/types";

/**
 * Fixed plain-English copy for the Setup tab and the business-profile flow. Everything the admin reads here comes from
 * this file or from the API's own registry text (profile labels and descriptions, the preview's change list) — never
 * from a server error message.
 */

/** The three fleet modules a delivery profile turns on and every other profile turns off. */
export const FLEET_MODULES = [
  { key: "recurring_routes", label: "Recurring routes" },
  { key: "order_delivery", label: "Ad hoc order delivery" },
  { key: "driver_payments", label: "At-door payment collection" },
] as const;

/** Either of these makes delivery possible; "At-door payment collection" alone does not. */
export const FLEET_ENABLERS = FLEET_MODULE_KEYS; // the ONE list (@routeflow/types), the api pins it

const KEY_LABELS: Record<string, string> = {
  recurring_routes: "Recurring routes",
  order_delivery: "Ad hoc order delivery",
  driver_payments: "At-door payment collection",
  fulfilment_model: "the fulfilment model",
  counter_sales: "counter sales",
};

/** A feature or config key as a phrase; an unknown key is never shown raw. */
export function keyLabel(key: unknown): string {
  return typeof key === "string" && KEY_LABELS[key] ? KEY_LABELS[key] : "a feature";
}

export const FULFILMENT_MODE_LABELS: Record<FulfilmentMode, string> = {
  unset: "Not set (works the way it did before business profiles)",
  delivery: "Own delivery: orders go out on the business's own trucks",
  ship: "Ship by carrier: orders are shipped, not delivered",
  both: "Own delivery and carrier shipping",
  pickup: "In store only: customers collect at the counter",
  pickup_ship: "In store + shipping: counter sales and carrier shipping",
};

/** A stored mode this build does not know: say so rather than print the raw value. */
export const UNKNOWN_MODE_LABEL = "A setting this screen does not recognise";

export function fulfilmentModeLabel(value: string): string {
  return Object.prototype.hasOwnProperty.call(FULFILMENT_MODE_LABELS, value)
    ? FULFILMENT_MODE_LABELS[value as FulfilmentMode]
    : UNKNOWN_MODE_LABEL;
}
