import type {
  BusinessCapabilities,
  BusinessCapabilityTicks,
  BusinessProfileKey,
} from "@routeflow/types";
import { BUSINESS_PROFILES, type BusinessProfileDef } from "./business-profiles";
import { capabilityFromInputs, type FulfilmentInputs } from "./fulfilment-capability";

/**
 * BO-03: the capability ticks a platform admin sees for one tenant, read back from the server.
 *
 * Pure. Every fulfilment fact goes through `capabilityFromInputs` (the ONE derivation, fulfilment-capability.ts);
 * nothing here re-derives a mode. `driver_payments` is a module, not a mode, so the caller passes the held modules.
 */
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
    opensAsChoosable: ticks.shipping && ticks.counter && !ticks.delivery,
    counterCapability: cap.counter,
    fleetHeld: cap.fleet,
    matchedPreset: configured ? matchPreset(ticks) : null,
  };
}

/** The ticks a preset pre-ticks: its own modes and fleet, read through the same derivation. */
export function presetTicks(def: BusinessProfileDef): BusinessCapabilityTicks {
  const cap = capabilityFromInputs({
    fulfilmentMode: def.modes.fulfilment_model ?? "unset",
    counterSales: def.modes.counter_sales ?? "unset",
    fleet: def.fleet,
    modesFailed: false,
  });
  return {
    delivery: cap.methods.includes("ROUTE"),
    doorPayments: def.fleet,
    shipping: cap.methods.includes("SHIP"),
    counter: cap.counter !== "off",
    opensAs: cap.staffOpensAs,
  };
}

/** The preset whose ticks equal these exactly (counter, delivery, door payments, shipping, opens-as), else null. */
export function matchPreset(ticks: BusinessCapabilityTicks): BusinessProfileKey | null {
  const hit = BUSINESS_PROFILES.find((def) => {
    const t = presetTicks(def);
    return (
      t.delivery === ticks.delivery &&
      t.doorPayments === ticks.doorPayments &&
      t.shipping === ticks.shipping &&
      t.counter === ticks.counter &&
      t.opensAs === ticks.opensAs
    );
  });
  return (hit?.key as BusinessProfileKey | undefined) ?? null;
}
