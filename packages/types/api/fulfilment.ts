// ─── Fulfilment capability (business profiles 1A) — the shared contract ────────────────────
//
// `fulfilment_model` and `counter_sales` are free config modes (apps/api feature-registry); the
// server derives ONE capability answer from them plus the fleet modules, and every client and
// server rule reads only that answer, never the raw modes. `unset` = today's behavior.

export const FULFILMENT_MODE_VALUES = [
  "unset",
  "delivery",
  "ship",
  "both",
  "pickup",
  "pickup_ship",
] as const;
export type FulfilmentMode = (typeof FULFILMENT_MODE_VALUES)[number];

export const COUNTER_SALES_MODE_VALUES = ["unset", "on"] as const;
export type CounterSalesMode = (typeof COUNTER_SALES_MODE_VALUES)[number];

/** The modules that make a fleet (routes, order delivery), for the web's setup copy. The api keeps
 *  its own `FLEET_KEYS` literal (a runtime import of this raw-TS package fails its dist build);
 *  apps/api/src/billing/fleet-keys-parity.spec.ts pins the two set-equal. */
export const FLEET_MODULE_KEYS = ["recurring_routes", "order_delivery"] as const;

/**
 * PICKUP is a capability METHOD and a FulfillPath value (the order enum is ROUTE|SHIP|PICKUP since
 * the 20261004150000 migration). No order write accepts "PICKUP" yet (WRITABLE_FULFILL_PATHS);
 * pickup orders come from the counter-sale path once it lands.
 */
export type FulfilmentMethod = "ROUTE" | "SHIP" | "PICKUP";

/**
 * `GET /tenants/me/features` -> `capabilities.fulfilment`.
 * - `methods`: what staff can choose per order; `staffDefault` is the default of those.
 * - `staffOpensAs`: whether staff "New order" opens as a normal order or the one-step counter.
 * - `portalMethods` / `portalDefault`: the same for the buyer portal. `[]` / `null` = the buyer gets
 *   NO choice (UNSET, today): the server applies the customer's default, then ROUTE.
 * - `counter`: "always" (in-store modes), "optional" (counter_sales on), "off".
 * - `fleet`: recurring_routes || order_delivery effective. The MODULES are the only truth; no
 *   mode turns fleet on or off.
 * - `consistent`: false when the mode is delivery|both and `fleet` is false. Then clients keep
 *   today's ROUTE/SHIP choice and the platform admin sees a warning.
 */
export interface FulfilmentCapability {
  methods: FulfilmentMethod[];
  staffDefault: FulfilmentMethod;
  staffOpensAs: "order" | "counter";
  portalMethods: FulfilmentMethod[];
  portalDefault: FulfilmentMethod | null;
  counter: "always" | "optional" | "off";
  fleet: boolean;
  consistent: boolean;
}

export interface TenantCapabilities {
  fulfilment: FulfilmentCapability;
}
