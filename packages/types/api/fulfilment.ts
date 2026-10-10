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

/** An account with no fulfilment mode set: exactly today's behaviour (ROUTE/SHIP both offered). The ONE
 *  copy: the api's derive is pinned to it and the web's unset check reads it. */
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

export interface TenantCapabilities {
  fulfilment: FulfilmentCapability;
}

/**
 * `GET /buyer/capabilities` (business profiles 1B): the ONLY fulfilment facts a buyer gets about
 * its seller — how portal orders ship and whether the seller runs its own fleet. No staff fields
 * (`methods`, `staffDefault`, `staffOpensAs`, `counter`) and no `consistent`.
 */
export type BuyerSellerCapability = Pick<
  FulfilmentCapability,
  "portalMethods" | "portalDefault" | "fleet"
>;

// ─── Settings → Fulfillment (tenant-admin self-serve toggle) ─────────────────────────────────
//
// `GET/POST preview/PATCH /settings/fulfilment`. Dark behind the API's FULFILMENT_SELF_SERVE flag:
// the web shows the tab only when `selfServe` is true.

export type FulfilmentCounterSetting = "on" | "off";
export type FulfilmentCounterEffective = "always" | "optional" | "off";

export interface FulfilmentModeOption {
  key: FulfilmentMode;
  label: string;
  /** False when the mode cannot be chosen now; `blockedBy` says why. */
  selectable: boolean;
  /** "plan": needs Routes or Order delivery. "proposed": an in-store mode not yet open to this account. */
  blockedBy?: "plan" | "proposed";
}

export interface FulfilmentLastChange {
  at: string;
  /** "business": a user of this account; "routeflow": RouteFlow support or a platform tool. */
  by: "business" | "routeflow";
  name: string | null;
}

export interface FulfilmentSettings {
  fulfilmentModel: {
    /** The stored mode ("unset" when none). */
    value: FulfilmentMode;
    /** What the account actually runs on after fleet rules. */
    effective: FulfilmentMode;
    options: FulfilmentModeOption[];
  };
  counterSales: { value: FulfilmentCounterSetting; effective: FulfilmentCounterEffective };
  capability: FulfilmentCapability;
  selfServe: boolean;
  canEdit: boolean;
  /** Opaque 16-hex token of the stored values and the fleet; send it back with a change. */
  fingerprint: string;
  lastChange: FulfilmentLastChange | null;
}

export interface UpdateFulfilmentSettingsRequest {
  fulfilmentModel?: FulfilmentMode;
  counterSales?: FulfilmentCounterSetting;
}

export interface FulfilmentSettingsPatchRequest extends UpdateFulfilmentSettingsRequest {
  fingerprint: string;
}

export interface FulfilmentChange {
  key: "fulfilmentModel" | "counterSales";
  from: string;
  to: string;
}

export type FulfilmentEffectCode =
  | "OPEN_ROUTE_ORDERS"
  | "TEMPLATES_PATH_CHANGES"
  | "BILLING_MOMENT"
  | "PORTAL_CHOICE"
  | "NEW_ORDER_OPENS"
  | "COUNTER_CLOSES"
  | "COUNTER_OPENS";

export interface FulfilmentEffect {
  code: FulfilmentEffectCode;
  count: number;
  /** Ready-to-show sentence, built by the server. */
  text: string;
}

export interface FulfilmentPreview {
  changes: FulfilmentChange[];
  effects: FulfilmentEffect[];
  notChanged: string[];
  fingerprint: string;
}

export interface FulfilmentSettingsUpdated extends FulfilmentSettings {
  changed: boolean;
}
