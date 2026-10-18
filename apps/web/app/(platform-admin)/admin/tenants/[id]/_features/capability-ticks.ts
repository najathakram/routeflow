import type {
  BusinessCapabilities,
  BusinessCapabilitiesRequest,
  CapabilityPresetTicks,
  OpensAs,
} from "@/lib/platform-admin/capabilities-contract";
import { opensAsChoosableFor } from "./opens-as";

/**
 * The ticks model shared by the Setup card and the create form. It holds what the admin ticked and nothing else:
 * which fulfilment mode, counter mode or add-ons those ticks mean is the server's job (the preview says so). Only the
 * UI-local consequences live here: the sub-option follows Delivery, and the "opens as" default follows D6.
 */
export type CapabilityTicks = CapabilityPresetTicks;
export type CapabilityBox = "delivery" | "shipping" | "counter";

export const NO_TICKS: CapabilityTicks = {
  delivery: false,
  doorPayments: false,
  shipping: false,
  counter: false,
  opensAs: "order",
};

/** The visible names of the boxes: one source for the checkboxes, the create review and the tests. */
export const CAPABILITY_LABELS = {
  delivery: "Delivers on own trucks",
  doorPayments: "Collect payment at the door",
  shipping: "Ships by carrier",
  counter: "Sells at the counter",
} as const;

export function nothingTicked(t: CapabilityTicks): boolean {
  return !t.delivery && !t.shipping && !t.counter;
}

/** What the saved tenant shows: a tenant nobody set up has nothing ticked (D1), whatever else the read carries. */
export function ticksFromCapabilities(c: BusinessCapabilities): CapabilityTicks {
  if (!c.configured) return NO_TICKS;
  return {
    delivery: c.delivery,
    doorPayments: c.delivery && c.doorPayments,
    shipping: c.shipping,
    counter: c.counter,
    opensAs: c.opensAs === "counter" ? "counter" : "order",
  };
}

/** Drops values that cannot matter, so two ticks that mean the same thing compare equal. */
function normalize(t: CapabilityTicks): CapabilityTicks {
  return {
    delivery: t.delivery,
    doorPayments: t.delivery && t.doorPayments,
    shipping: t.shipping,
    counter: t.counter,
    opensAs: opensAsChoosableFor(t) ? t.opensAs : "order",
  };
}

/** A stable string for the ticks: the preview's identity ("last request wins" and "same as saved" compare it). */
export function ticksKey(t: CapabilityTicks): string {
  const n = normalize(t);
  return JSON.stringify([n.delivery, n.doorPayments, n.shipping, n.counter, n.opensAs]);
}

export function toggleCapability(
  t: CapabilityTicks,
  box: CapabilityBox,
  on: boolean,
): CapabilityTicks {
  const next: CapabilityTicks = { ...t, [box]: on };
  if (box === "delivery") next.doorPayments = on;
  if (!opensAsChoosableFor(next)) next.opensAs = "order";
  else if (!opensAsChoosableFor(t)) next.opensAs = "counter"; // D6: Shipping + Counter opens as a counter sale
  return next;
}

export function setDoorPayments(t: CapabilityTicks, on: boolean): CapabilityTicks {
  return t.delivery ? { ...t, doorPayments: on } : t;
}

export function setOpensAs(t: CapabilityTicks, value: OpensAs): CapabilityTicks {
  return opensAsChoosableFor(t) ? { ...t, opensAs: value } : t;
}

/** The preview/confirm body: only values that mean something (door payments need Delivery, opens-as needs a choice). */
export function ticksToRequest(t: CapabilityTicks): BusinessCapabilitiesRequest {
  const body: BusinessCapabilitiesRequest = { delivery: t.delivery };
  if (t.delivery) body.doorPayments = t.doorPayments;
  body.shipping = t.shipping;
  body.counter = t.counter;
  if (opensAsChoosableFor(t)) body.opensAs = t.opensAs;
  return body;
}

/** The ticked boxes by their visible names (the create review lists these and derives nothing from them). */
export function tickedNames(t: CapabilityTicks): string[] {
  const names: string[] = [];
  if (t.delivery) names.push(CAPABILITY_LABELS.delivery);
  if (t.delivery && t.doorPayments) names.push(CAPABILITY_LABELS.doorPayments);
  if (t.shipping) names.push(CAPABILITY_LABELS.shipping);
  if (t.counter) names.push(CAPABILITY_LABELS.counter);
  return names;
}
