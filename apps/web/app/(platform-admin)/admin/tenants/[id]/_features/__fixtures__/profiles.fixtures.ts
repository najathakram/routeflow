import type {
  BusinessProfileKey,
  BusinessProfilePlan,
  BusinessProfilePreviewResponse,
  BusinessProfileSummary,
} from "@routeflow/types";
import { EFFECTIVE_FIXTURE } from "./effective.fixtures";

const FLEET = ["recurring_routes", "order_delivery", "driver_payments"];

/** `GET /platform-admin/business-profiles` as the API serves it today: the two in-store profiles are unavailable. */
export const PROFILES_FIXTURE: BusinessProfileSummary[] = [
  {
    key: "delivery_distributor",
    label: "Delivery distributor",
    description: "Delivers on its own trucks: routes, ad hoc delivery and at-door payments on.",
    available: true,
    modes: { fulfilment_model: "delivery" },
    grants: FLEET,
    denies: [],
  },
  {
    key: "shipping_wholesaler",
    label: "Shipping wholesaler",
    description: "Ships by carrier: no delivery fleet.",
    available: true,
    modes: { fulfilment_model: "ship" },
    grants: [],
    denies: FLEET,
  },
  {
    key: "in_store_retailer",
    label: "In-store retailer",
    description: "Sells over the counter for in-store pickup: no delivery fleet.",
    available: false,
    modes: { fulfilment_model: "pickup", counter_sales: "on" },
    grants: [],
    denies: FLEET,
  },
  {
    key: "in_store_shipping_retailer",
    label: "In-store + shipping retailer",
    description: "Sells over the counter and ships by carrier: no delivery fleet.",
    available: false,
    modes: { fulfilment_model: "pickup_ship", counter_sales: "on" },
    grants: [],
    denies: FLEET,
  },
  {
    key: "delivery_pos",
    label: "Delivery + POS",
    description:
      "Delivers on its own trucks and also sells over the counter: delivery routes on, counter sales on.",
    available: true,
    modes: { fulfilment_model: "delivery", counter_sales: "on" },
    grants: FLEET,
    denies: [],
  },
];

/** A `shipping_wholesaler` preview for a tenant that PAYS for two fleet add-ons (billing lines first, as the API orders them). */
export function shippingPreviewWithBilling(
  extra: Partial<BusinessProfilePreviewResponse> = {},
): BusinessProfilePreviewResponse {
  const plan: BusinessProfilePlan = {
    overrides: FLEET.map((featureKey) => ({
      featureKey,
      effect: "DENY" as const,
      action: "skip" as const,
    })),
    comps: [],
    modes: [{ key: "fulfilment_model", from: "delivery", to: "ship" }],
    billing: [
      { featureKey: "driver_payments", action: "disable", manual: false },
      { featureKey: "order_delivery", action: "disable", manual: true },
    ],
  };
  return {
    profile: "shipping_wholesaler" as BusinessProfileKey,
    plan,
    summary: [
      "At-door payment collection will be switched off and its billing stopped",
      "Ad hoc order delivery will be switched off; remove it from their manual invoice",
      "Where orders go: Own delivery → Ship by carrier",
    ],
    changes: ["Where orders go: Own delivery → Ship by carrier"],
    planFingerprint: "a".repeat(64),
    before: EFFECTIVE_FIXTURE,
    after: EFFECTIVE_FIXTURE,
    changed: ["driver_payments", "order_delivery"],
    ...extra,
  };
}

/** A preview for a tenant that already matches the profile: nothing to change. */
export function matchingPreview(profile: BusinessProfileKey): BusinessProfilePreviewResponse {
  return {
    profile,
    plan: { overrides: [], comps: [], modes: [], billing: [] },
    summary: [],
    changes: [],
    planFingerprint: "b".repeat(64),
    before: EFFECTIVE_FIXTURE,
    after: EFFECTIVE_FIXTURE,
    changed: [],
  };
}

/**
 * SA-769: a `delivery_distributor` preview for a tenant that holds nothing - every fleet module becomes a COMP row
 * ("Included free with this profile"), so nothing is billed and no GRANT override is written.
 */
export function deliveryPreviewWithComps(
  extra: Partial<BusinessProfilePreviewResponse> = {},
): BusinessProfilePreviewResponse {
  const plan: BusinessProfilePlan = {
    overrides: FLEET.map((featureKey) => ({
      featureKey,
      effect: "GRANT" as const,
      action: "skip" as const,
    })),
    comps: FLEET.map((featureKey) => ({ featureKey })),
    modes: [{ key: "fulfilment_model", from: "unset", to: "delivery" }],
    billing: [],
  };
  return {
    profile: "delivery_distributor" as BusinessProfileKey,
    plan,
    summary: [
      "Turn on Recurring routes: included free with this profile, no charge added",
      "Turn on Ad hoc order delivery: included free with this profile, no charge added",
      "Turn on At-door payment collection: included free with this profile, no charge added",
      "Where orders go: Not configured (today's behavior) → Own delivery",
    ],
    // the comp lines are NOT in changes: the modal renders them from plan.comps
    changes: ["Where orders go: Not configured (today's behavior) → Own delivery"],
    planFingerprint: "c".repeat(64),
    before: EFFECTIVE_FIXTURE,
    after: EFFECTIVE_FIXTURE,
    changed: FLEET,
    ...extra,
  };
}
