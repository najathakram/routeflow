import type { RoutePlanningOriginKind } from "@/components/RoutePlanningControls";

/**
 * What Create route says above its buttons while the button is off for want of a start point.
 *
 * - "choose": nothing usable is set; the person has to pick a start.
 * - "settings-failed": the start is the business address and the route settings did not load, so the page cannot
 *   tell whether one is set.
 * - null: say nothing. Either a start is ready, or the start is the business address and the settings are still on
 *   their way: telling a dispatcher who HAS a depot to "choose where the route starts" for the length of the fetch
 *   is a false statement (review R-138, M2).
 */
export type StartPointHint = "choose" | "settings-failed" | null;

export function startPointHint(args: {
  originReady: boolean;
  originKind: RoutePlanningOriginKind;
  settings: "loading" | "error" | "ready";
}): StartPointHint {
  if (args.originReady) return null;
  if (args.originKind === "TENANT" && args.settings !== "ready") {
    return args.settings === "error" ? "settings-failed" : null;
  }
  return "choose";
}
