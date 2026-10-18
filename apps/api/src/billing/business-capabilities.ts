import { BadRequestException } from "@nestjs/common";
import type {
  BusinessCapabilities,
  BusinessCapabilitiesRequest,
  BusinessCapabilityTicks,
  BusinessProfileKey,
  CapabilityAvailability,
} from "@routeflow/types";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { BUSINESS_PROFILES, wants, type BusinessProfileDef } from "./business-profiles";
import { FLEET_KEYS, capabilityFromInputs, type FulfilmentInputs } from "./fulfilment-capability";
import { FEATURE_REGISTRY } from "./feature-registry";

/**
 * BO-03: the capability ticks a platform admin sees for one tenant, read back from the server.
 *
 * Pure. Every fulfilment fact goes through `capabilityFromInputs` (the ONE derivation, fulfilment-capability.ts);
 * nothing here re-derives a mode. `driver_payments` is a module, not a mode, so the caller passes the held modules.
 */
/**
 * The opens-as rule: Shipping + Counter without Delivery is the only combination where staff may pick. The API may
 * not value-import @routeflow/types (a compiled-source runtime-import pin), so this is the API's copy of the shared
 * `isOpensAsChoosable`; business-capabilities.spec.ts pins the two equal over every combination.
 */
export const isOpensAsChoosable = (
  t: Pick<BusinessCapabilityTicks, "delivery" | "shipping" | "counter">,
): boolean => t.shipping && t.counter && !t.delivery;

const NO_TICKS: BusinessCapabilityTicks = {
  delivery: false,
  doorPayments: false,
  shipping: false,
  counter: false,
  opensAs: "order",
};

export function capabilitiesFromInputs(
  inputs: FulfilmentInputs,
  heldModules: Iterable<string>,
): BusinessCapabilities {
  const cap = capabilityFromInputs(inputs);
  const held = new Set(heldModules);
  const configured = inputs.fulfilmentMode !== "unset";
  const ticks: BusinessCapabilityTicks = configured
    ? {
        delivery: cap.methods.includes("ROUTE"),
        doorPayments: held.has("driver_payments"),
        shipping: cap.methods.includes("SHIP"),
        counter: cap.counter !== "off",
        opensAs: cap.staffOpensAs,
      }
    : NO_TICKS;
  return {
    configured,
    ...ticks,
    opensAsChoosable: isOpensAsChoosable(ticks),
    counterCapability: cap.counter,
    fleetHeld: cap.fleet,
    matchedPreset: configured ? matchPreset(ticks, cap.fleet) : null,
    unavailable: capabilityAvailability(),
  };
}

/** The ticks a preset pre-ticks: its own modes and fleet, read through the same derivation. */
export function presetTicks(def: BusinessProfileDef): BusinessCapabilityTicks {
  const cap = capabilityFromInputs({
    fulfilmentMode: def.modes.fulfilment_model ?? "unset",
    counterSales: def.modes.counter_sales ?? "unset",
    fleet: FLEET_KEYS.some((k) => wants(def, k)),
    modesFailed: false,
  });
  return {
    delivery: cap.methods.includes("ROUTE"),
    // BO-04: door payments are the driver_payments module, which a per-module map may switch off beside the fleet
    doorPayments: wants(def, "driver_payments"),
    shipping: cap.methods.includes("SHIP"),
    counter: cap.counter !== "off",
    opensAs: cap.staffOpensAs,
  };
}

/**
 * BO-04: the ticks an admin sends, as a `BusinessProfileDef` the ONE planner already understands (a second INPUT,
 * not a second planner). `counter_sales` is ALWAYS in `modes` (`on` or `unset`), so unticking Counter switches it off.
 *
 *   D -> delivery | S -> ship | C -> pickup | S+C -> pickup_ship (opens as counter, the D6 default) or ship (opens as order)
 *   D+C -> delivery | D+S -> both | D+S+C -> both          (counter_sales on with C, unset without)
 *
 * `doorPayments` is true by default with Delivery and ignored (false) without it; Delivery with door payments off
 * keeps the two fleet keys and switches `driver_payments` off through the def's `modules` map. `opensAs` is honoured
 * only for Shipping + Counter without Delivery; everywhere else it is whatever the mode derives. Nothing ticked is a
 * 400 BUSINESS_CAPABILITIES_EMPTY.
 *
 * `normalised` is `presetTicks` of the resulting def (what the audit row and the response echo); `preset` is the
 * preset it equals, else null (the def is then keyed "custom"). A tuple equal to a preset returns that preset's own def.
 */
export function ticksToProfileDef(input: BusinessCapabilitiesRequest): {
  def: BusinessProfileDef;
  normalised: BusinessCapabilityTicks;
  preset: BusinessProfileKey | null;
} {
  const delivery = input.delivery === true;
  const shipping = input.shipping === true;
  const counter = input.counter === true;
  if (!delivery && !shipping && !counter) {
    throw new BadRequestException({
      statusCode: 400,
      code: API_ERROR_CODES.BUSINESS_CAPABILITIES_EMPTY,
      message: "Choose at least one of Delivery, Shipping or Counter.",
    });
  }
  const doorPayments = delivery && input.doorPayments !== false;
  const opensAsCounter = input.opensAs !== "order"; // D6 default: Shipping + Counter opens as a Counter sale
  const mode = delivery
    ? shipping
      ? "both"
      : "delivery"
    : shipping
      ? counter && opensAsCounter
        ? "pickup_ship"
        : "ship"
      : "pickup";
  const custom: BusinessProfileDef = {
    key: "custom",
    label: "Custom capabilities",
    description: "A combination of delivery, shipping and counter sales chosen for this business.",
    fleet: delivery,
    ...(delivery && !doorPayments
      ? { modules: { recurring_routes: true, order_delivery: true, driver_payments: false } }
      : {}),
    modes: { fulfilment_model: mode, counter_sales: counter ? "on" : "unset" },
  };
  const normalised = presetTicks(custom);
  const preset = matchPreset(normalised);
  const def = preset ? (BUSINESS_PROFILES.find((p) => p.key === preset) ?? custom) : custom;
  return { def, normalised, preset };
}

/**
 * The preset whose ticks equal these exactly (counter, delivery, door payments, shipping, opens-as),
 * else null. With `fleetHeld`, the preset's fleet must match too: a stored `delivery` tenant whose
 * fleet add-on lapsed is not that preset (applying it would grant the fleet again).
 */
export function matchPreset(
  ticks: BusinessCapabilityTicks,
  fleetHeld?: boolean,
): BusinessProfileKey | null {
  const hit = BUSINESS_PROFILES.find((def) => {
    const t = presetTicks(def);
    return (
      (fleetHeld === undefined || def.fleet === fleetHeld) &&
      t.delivery === ticks.delivery &&
      t.doorPayments === ticks.doorPayments &&
      t.shipping === ticks.shipping &&
      t.counter === ticks.counter &&
      t.opensAs === ticks.opensAs
    );
  });
  return (hit?.key as BusinessProfileKey | undefined) ?? null;
}

/** Each capability's own mode: delivery and shipping are fulfilment_model modes; the counter is pickup. */
const CAPABILITY_MODES: { capability: keyof CapabilityAvailability; key: string; mode: string }[] =
  [
    { capability: "delivery", key: "fulfilment_model", mode: "delivery" },
    { capability: "shipping", key: "fulfilment_model", mode: "ship" },
    { capability: "counter", key: "fulfilment_model", mode: "pickup" },
  ];

const registryOffers = (key: string, mode: string): boolean =>
  FEATURE_REGISTRY.find((f) => f.key === key)?.config?.modes[mode]?.available === true;

/**
 * PC-L C2: the capabilities that cannot be ticked, with a reason. Read from the registry's own `available` flag
 * (the same one `unavailableModes` uses), so it is plan-independent today: every mode is offered on every plan and
 * profile grants are free comps. `unavailable(key, mode)` is the test seam; production passes nothing.
 */
export function capabilityAvailability(
  unavailable: (key: string, mode: string) => boolean = (k, m) => !registryOffers(k, m),
): CapabilityAvailability {
  const out: CapabilityAvailability = {};
  for (const c of CAPABILITY_MODES)
    if (unavailable(c.key, c.mode)) out[c.capability] = "Not available yet";
  return out;
}
