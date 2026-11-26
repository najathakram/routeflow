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

/**
 * POS mode (SA-763r P-2): an order with `fulfillPath: PICKUP` that is NOT a counter sale. There is no
 * `Order.posMode` column, so the pair is the whole predicate. The ONE copy (web and mobile import it).
 */
export function isPosOrder(
  order: { fulfillPath?: string | null; counterSale?: boolean | null } | null | undefined,
): boolean {
  return order?.fulfillPath === "PICKUP" && order?.counterSale !== true;
}

/** Why an order shows no delivery steps (W-1306, SA-1277). `null` = the steps are shown. */
export type DeliveryStepsAbsentReason =
  "PICKUP_MODEL" | "POS_MODE" | "NO_FLEET" | "CUSTOMER_PICKUP";

/** The facts the helper reads. A `FulfilmentCapability` (staff) and a `BuyerSellerCapability` both fit. */
export interface DeliveryStepsCapability {
  /** Staff only. Absent on a buyer's capability read. */
  methods?: readonly FulfilmentMethod[];
  portalMethods?: readonly FulfilmentMethod[];
  /** `null` = an unset account (today's behaviour, never "no fleet"). */
  portalDefault?: FulfilmentMethod | null;
  fleet: boolean;
}

/**
 * The ONE answer to "why are the delivery steps missing on this order?", read by the web order page,
 * the mobile order screen and the buyer timeline, so no surface hides a step without a reason.
 * - PICKUP order: PICKUP_MODEL when the business offers pickup; else POS_MODE (staff view) or
 *   CUSTOMER_PICKUP (no staff facts). There is no column, so POS_MODE is known only by elimination.
 * - Counter sale: its own one-step flow, `null`.
 * - ROUTE order of a configured seller with no fleet: NO_FLEET. SHIP keeps its own steps.
 */
export function deliveryStepsAbsentReason(input: {
  fulfillPath?: string | null;
  counterSale?: boolean | null;
  capability?: DeliveryStepsCapability | null;
}): DeliveryStepsAbsentReason | null {
  const { fulfillPath, capability } = input;
  if (fulfillPath === "PICKUP") {
    if (!isPosOrder(input)) return null;
    if ((capability?.methods ?? capability?.portalMethods)?.includes("PICKUP")) {
      return "PICKUP_MODEL";
    }
    return capability?.methods ? "POS_MODE" : "CUSTOMER_PICKUP";
  }
  if (fulfillPath === "SHIP") return null;
  const configured = capability?.portalDefault != null;
  return configured && capability?.fleet === false ? "NO_FLEET" : null;
}

/** One sentence per reason, each naming where to fix it. POS_MODE and CUSTOMER_PICKUP read the same. */
export const DELIVERY_STEPS_ABSENT_COPY: Record<DeliveryStepsAbsentReason, string> = {
  PICKUP_MODEL:
    "This business is set up for pickup only. To deliver, go to Settings > Fulfillment.",
  POS_MODE: "This order is pickup. To deliver, change Fulfillment to Delivery.",
  CUSTOMER_PICKUP: "This order is pickup. To deliver, change Fulfillment to Delivery.",
  NO_FLEET: "Delivery tracking is off. Turn on the delivery add-on to see each step.",
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
> & {
  /**
   * SA-733r6 (B4): false while the seller's workspace is read-only. ONE boolean and no reason: a buyer is never
   * told about the seller's billing. The buyer UI shows a single quiet line and disables Checkout.
   * The API always sends it; absent (an older server) means accepting.
   */
  acceptingOrders?: boolean;
};

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
