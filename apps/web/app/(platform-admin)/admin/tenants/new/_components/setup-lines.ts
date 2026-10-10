import type { BusinessProfileSummary } from "@routeflow/types";
import { FLEET_MODULES, keyLabel } from "../../[id]/_features/setup-copy";

/** How each stored fulfilment mode reads in the review sheet. An unknown mode is left out, never printed raw. */
const FULFILMENT_LINES: Record<string, string> = {
  delivery: "Orders go out on the business's own trucks",
  ship: "Orders ship by carrier",
  both: "Orders go out on the business's own trucks or ship by carrier",
  pickup: "Orders are in-store pickup only",
  pickup_ship: "Orders are in-store pickup or carrier shipping",
};

/** "Delivery routes" stands for the whole fleet trio; anything short of all three is listed one by one. */
function moduleLines(keys: string[], state: "on" | "off"): string[] {
  const fleet = FLEET_MODULES.map((m) => m.key as string);
  const hasAllFleet = fleet.every((k) => keys.includes(k));
  const lines: string[] = [];
  if (hasAllFleet) lines.push(`Delivery routes ${state}`);
  for (const k of keys) {
    if (hasAllFleet && fleet.includes(k)) continue;
    lines.push(`${keyLabel(k)} ${state}`);
  }
  return lines;
}

/**
 * What the chosen profile will set, as short plain lines, derived from the profile's own modes, grants and denies
 * (`GET /platform-admin/business-profiles`) with the Setup tab's labels. Counter sales first, then where orders go,
 * then the delivery modules. A key this build has no words for reads "a feature", never raw.
 */
export function setupLines(profile: BusinessProfileSummary): string[] {
  const lines: string[] = [];
  const counter = profile.modes?.counter_sales;
  if (counter === "on") lines.push("Counter sales on");
  else if (counter === "off") lines.push("Counter sales off");
  const fulfilment = profile.modes?.fulfilment_model;
  if (fulfilment && FULFILMENT_LINES[fulfilment]) lines.push(FULFILMENT_LINES[fulfilment]!);
  lines.push(...moduleLines(profile.grants ?? [], "on"));
  lines.push(...moduleLines(profile.denies ?? [], "off"));
  return lines;
}
