import type {
  BusinessCapabilities,
  BusinessCapabilitiesPreviewResponse,
  CapabilityPresetKey,
  CapabilityPresetSummary,
  CapabilityPresetTicks,
} from "@/lib/platform-admin/capabilities-contract";
import { EFFECTIVE_FIXTURE } from "./effective.fixtures";

const FLEET = ["recurring_routes", "order_delivery", "driver_payments"];

function preset(
  key: CapabilityPresetKey,
  label: string,
  description: string,
  ticks: Partial<CapabilityPresetTicks>,
  modes: Record<string, string>,
  fleet: boolean,
): CapabilityPresetSummary {
  return {
    key,
    label,
    description,
    available: true,
    modes,
    grants: fleet ? FLEET : [],
    denies: fleet ? [] : FLEET,
    ticks: {
      delivery: false,
      doorPayments: false,
      shipping: false,
      counter: false,
      opensAs: "order",
      ...ticks,
    },
  };
}

/** `GET /platform-admin/business-profiles` once BO-03/BO-04 land: the five presets plus the two new ones, with ticks. */
export const CAPABILITY_PRESETS_FIXTURE: CapabilityPresetSummary[] = [
  preset(
    "delivery_distributor",
    "Delivery distributor",
    "Delivers on its own trucks.",
    { delivery: true, doorPayments: true },
    { fulfilment_model: "delivery", counter_sales: "unset" },
    true,
  ),
  preset(
    "shipping_wholesaler",
    "Shipping wholesaler",
    "Ships by carrier.",
    { shipping: true },
    { fulfilment_model: "ship", counter_sales: "unset" },
    false,
  ),
  preset(
    "in_store_retailer",
    "Counter retailer",
    "Sells over the counter.",
    { counter: true },
    { fulfilment_model: "pickup", counter_sales: "on" },
    false,
  ),
  preset(
    "in_store_shipping_retailer",
    "Counter + shipping retailer",
    "Sells over the counter and ships.",
    { shipping: true, counter: true, opensAs: "counter" },
    { fulfilment_model: "pickup_ship", counter_sales: "on" },
    false,
  ),
  preset(
    "delivery_pos",
    "Delivery + counter",
    "Delivers and sells over the counter.",
    { delivery: true, doorPayments: true, counter: true },
    { fulfilment_model: "delivery", counter_sales: "on" },
    true,
  ),
  preset(
    "delivery_shipping",
    "Delivery + shipping",
    "Delivers and ships.",
    { delivery: true, doorPayments: true, shipping: true },
    { fulfilment_model: "both", counter_sales: "unset" },
    true,
  ),
  preset(
    "delivery_shipping_pos",
    "Everything",
    "Delivers, ships and sells over the counter.",
    { delivery: true, doorPayments: true, shipping: true, counter: true },
    { fulfilment_model: "both", counter_sales: "on" },
    true,
  ),
];

/** `GET .../business-capabilities` for a tenant nobody set up. */
export const NOT_CONFIGURED_FIXTURE: BusinessCapabilities = {
  configured: false,
  delivery: false,
  doorPayments: false,
  shipping: false,
  counter: false,
  opensAs: "order",
  opensAsChoosable: false,
  counterCapability: "off",
  fleetHeld: false,
  matchedPreset: null,
};

export function capabilitiesFixture(
  over: Partial<BusinessCapabilities> = {},
): BusinessCapabilities {
  return { ...NOT_CONFIGURED_FIXTURE, configured: true, ...over };
}

/** A saved Delivery + counter tenant. */
export const DELIVERY_COUNTER_FIXTURE = capabilitiesFixture({
  delivery: true,
  doorPayments: true,
  counter: true,
  counterCapability: "optional",
  fleetHeld: true,
  matchedPreset: "delivery_pos",
});

/** A capabilities preview with nothing to bill and nothing to comp: only a mode line. */
export function capabilitiesPreview(
  over: Partial<BusinessCapabilitiesPreviewResponse> = {},
): BusinessCapabilitiesPreviewResponse {
  return {
    plan: { overrides: [], comps: [], modes: [], billing: [] },
    summary: ["Where orders go: Own delivery → Delivery and shipping"],
    changes: ["Where orders go: Own delivery → Delivery and shipping"],
    planFingerprint: "f".repeat(64),
    before: EFFECTIVE_FIXTURE,
    after: EFFECTIVE_FIXTURE,
    changed: [],
    blocked: null,
    ...over,
  };
}

/** A preview that stops billing: a Stripe-billed add-on and a manually billed one. */
export function capabilitiesPreviewWithBilling(
  over: Partial<BusinessCapabilitiesPreviewResponse> = {},
): BusinessCapabilitiesPreviewResponse {
  return capabilitiesPreview({
    plan: {
      overrides: [],
      comps: [],
      modes: [{ key: "fulfilment_model", from: "delivery", to: "ship" }],
      billing: [
        { featureKey: "driver_payments", action: "disable", manual: false },
        { featureKey: "order_delivery", action: "disable", manual: true },
      ],
    },
    changes: ["Where orders go: Own delivery → Ship by carrier"],
    planFingerprint: "a".repeat(64),
    ...over,
  });
}

/** A preview that turns modules on as comps (nothing billed). */
export function capabilitiesPreviewWithComps(
  over: Partial<BusinessCapabilitiesPreviewResponse> = {},
): BusinessCapabilitiesPreviewResponse {
  return capabilitiesPreview({
    plan: {
      overrides: [],
      comps: FLEET.map((featureKey) => ({ featureKey })),
      modes: [{ key: "fulfilment_model", from: "ship", to: "both" }],
      billing: [],
    },
    changes: ["Where orders go: Ship by carrier → Delivery and shipping"],
    planFingerprint: "c".repeat(64),
    ...over,
  });
}
