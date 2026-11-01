import { BadRequestException } from "@nestjs/common";
import type {
  BusinessCapabilities,
  BusinessProfilePlan,
  FirstRunAnswer,
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

/**
 * `configured` is only "has the admin set `fulfilment_model`". The ticks are ALWAYS what the business does today
 * (SA-1028): an unset tenant works as ROUTE + SHIP, so it reads Shipping, and Delivery when the fleet is held (an unset
 * tenant with no fleet cannot deliver on trucks), and Counter when `counter_sales` is on. Reading it as "nothing ticked"
 * made the card send a request that turned Delivery and Shipping off, which wrote `fulfilment_model` under a carrier order.
 */
export function capabilitiesFromInputs(
  inputs: FulfilmentInputs,
  heldModules: Iterable<string>,
): BusinessCapabilities {
  const cap = capabilityFromInputs(inputs);
  const held = new Set(heldModules);
  const configured = inputs.fulfilmentMode !== "unset";
  const ticks: BusinessCapabilityTicks = {
    delivery: cap.methods.includes("ROUTE") && (configured || cap.fleet),
    doorPayments: held.has("driver_payments"),
    shipping: cap.methods.includes("SHIP"),
    counter: cap.counter !== "off",
    opensAs: cap.staffOpensAs,
  };
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
 * `doorPayments` omitted means KEEP CURRENT (`current`, which the tenant-facing caller reads from the tenant's
 * held `driver_payments`): only an explicit true/false changes it, so an omitted tick can never comp a paid
 * module. With no `current` (a preset's own ticks, which always carry it) an omitted value is true. It is ignored
 * (false) without Delivery; Delivery with door payments off
 * keeps the two fleet keys and switches `driver_payments` off through the def's `modules` map. `opensAs` is honoured
 * only for Shipping + Counter without Delivery; everywhere else it is whatever the mode derives. Nothing ticked is a
 * 400 BUSINESS_CAPABILITIES_EMPTY.
 *
 * `normalised` is `presetTicks` of the resulting def (what the audit row and the response echo); `preset` is the
 * preset it equals, else null (the def is then keyed "custom"). A tuple equal to a preset returns that preset's own def.
 */
export function ticksToProfileDef(
  input: BusinessCapabilitiesRequest,
  current?: CurrentCapabilities,
): {
  def: BusinessProfileDef;
  normalised: BusinessCapabilityTicks;
  preset: BusinessProfileKey | null;
} {
  assertCapabilitiesRequested(input);
  const delivery = input.delivery === true;
  const shipping = input.shipping === true;
  const counter = input.counter === true;
  const doorPayments = delivery && (input.doorPayments ?? current?.doorPayments ?? true);
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
  // SA-1028 keep rule: a tenant nobody set up (fulfilment_model unset) whose Delivery, Shipping and Opens-as stay as the
  // card read them keeps its model unset. Only the other boxes (Counter, door payments) are written, so no mode moves
  // and the carrier-in-transit rule has nothing to refuse. A real change to D/S/Opens-as still writes the model.
  if (current && !current.configured && current.ticks && keepsModel(input, current.ticks, mode)) {
    const kept: BusinessProfileDef = {
      key: "custom",
      label: "Custom capabilities",
      description:
        "A combination of delivery, shipping and counter sales chosen for this business.",
      fleet: delivery,
      ...(delivery && !doorPayments
        ? { modules: { recurring_routes: true, order_delivery: true, driver_payments: false } }
        : {}),
      modes: { counter_sales: counter ? "on" : "unset" },
    };
    const normalised: BusinessCapabilityTicks = {
      delivery,
      doorPayments,
      shipping,
      counter,
      opensAs: current.ticks.opensAs,
    };
    return { def: kept, normalised, preset: null };
  }
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

/** What the planner needs to know about the tenant the ticks are for (read once, with the GET that shows the card). */
export interface CurrentCapabilities {
  /** The held `driver_payments` module: what an omitted `doorPayments` keeps. */
  doorPayments: boolean;
  /** `fulfilment_model` is set. Only an unset tenant can keep its model (see the keep rule). */
  configured: boolean;
  /** The ticks the card showed for this tenant. */
  ticks?: BusinessCapabilityTicks;
}

/** 400 BUSINESS_CAPABILITIES_EMPTY when no capability is ticked. Called before any read, so an empty request never touches the DB. */
export function assertCapabilitiesRequested(input: BusinessCapabilitiesRequest): void {
  if (input.delivery !== true && input.shipping !== true && input.counter !== true) {
    throw new BadRequestException({
      statusCode: 400,
      code: API_ERROR_CODES.BUSINESS_CAPABILITIES_EMPTY,
      message: "Choose at least one of Delivery, Shipping or Counter.",
    });
  }
}

/**
 * The keep rule's test: Delivery and Shipping equal the current ticks, and so does Opens-as wherever the request can
 * choose it (an omitted choice is the D6 default "counter", so it is a change from the card's "order").
 */
function keepsModel(
  input: BusinessCapabilitiesRequest,
  now: BusinessCapabilityTicks,
  mode: string,
): boolean {
  const delivery = input.delivery === true;
  const shipping = input.shipping === true;
  if (delivery !== now.delivery || shipping !== now.shipping) return false;
  if (!isOpensAsChoosable({ delivery, shipping, counter: input.counter === true })) return true;
  const requested = mode === "pickup_ship" ? "counter" : "order"; // the opens-as the written mode would derive
  return requested === now.opensAs;
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

/**
 * W1: the request the first question sends to the ONE planner. It is not the back office's call as it stands: that call
 * saves nothing for Shipping alone, and saves `pickup` / `pickup_ship` (still `proposed`, which tenant Settings refuses)
 * for the counter. Here Delivery and Shipping map to `delivery` / `ship` / `both`, the counter is only `counter_sales`,
 * and new orders open as an order. The keep rule is off except for Counter alone, where it is what we want (the model
 * stays `unset`). Door payments are never sent: they read off on a new account, so the planner keeps them off.
 * Probed against the real planner at e134d6bd5d: rf-specs specs/website-review/probe-first-run.txt, section B.
 */
export function firstRunRequest(
  answer: FirstRunAnswer,
  now: Pick<BusinessCapabilities, "doorPayments" | "configured" | "counter">,
): ReturnType<typeof ticksToProfileDef> {
  const delivery = answer.delivery === true;
  const shipping = answer.shipping === true;
  const counter = answer.counter === true;
  if (counter && !delivery && !shipping) {
    return ticksToProfileDef(
      { shipping: true, counter: true, opensAs: "order" },
      {
        doorPayments: now.doorPayments,
        configured: false,
        ticks: {
          delivery: false,
          doorPayments: false,
          shipping: true,
          counter: now.counter,
          opensAs: "order",
        },
      },
    );
  }
  return ticksToProfileDef(
    { delivery, shipping, counter, opensAs: "order" },
    { doorPayments: now.doorPayments, configured: now.configured },
  );
}

/**
 * W1: the first question only FILLS BLANKS. A plan is applied only if it stops no billing, changes no override (every
 * `action` is `skip`), and every mode change starts from `unset`. Any other plan means the team (or an earlier partial
 * apply with a different answer) already set this account up, so it is left alone.
 */
export function fillsBlanks(plan: BusinessProfilePlan): boolean {
  return (
    plan.billing.length === 0 &&
    plan.overrides.every((o) => o.action === "skip") &&
    plan.modes.every((m) => m.from === "unset")
  );
}
