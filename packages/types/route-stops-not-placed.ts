/**
 * UXG B14: the ONE sentence for "optimize failed because some stops have no map position", shared by web and mobile
 * (API throws a coded 400 `ROUTE_STOPS_NOT_PLACED` with `count` and `names`; clients build this from those STRUCTURED fields,
 * never from the server `message`). At most three names, then "and N more".
 *
 *   2 stops have no map position (Acme Deli, Acme Market). Check their addresses, then optimize again.
 */
export const ROUTE_STOPS_NOT_PLACED_MAX_NAMES = 3;

export function routeStopsNotPlacedSentence(count: number, names: readonly string[]): string {
  const usable = names.map((x) => x.trim()).filter((x) => x.length > 0);
  const counted = Number.isFinite(count) && count > 0;
  // No usable number and no usable name: say nothing about how many.
  if (!counted && usable.length === 0)
    return "Some stops have no map position. Check their addresses, then optimize again.";
  const n = counted ? Math.floor(count) : usable.length;
  const total = Math.max(n, usable.length, 1);
  const shown = usable.slice(0, ROUTE_STOPS_NOT_PLACED_MAX_NAMES);
  const more = total - shown.length;
  const list =
    shown.length === 0 ? "" : ` (${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""})`;
  const subject = total === 1 ? "1 stop has" : `${total} stops have`;
  return `${subject} no map position${list}. Check their addresses, then optimize again.`;
}

/** Reads the builder's inputs from a coded 400 body; null when the body is not this refusal. */
export function routeStopsNotPlacedFromBody(
  data: unknown,
  code: string,
): { count: number; names: string[] } | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.code !== code) return null;
  const names = Array.isArray(d.names)
    ? d.names
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim().slice(0, 80))
        .filter((x) => x.length > 0)
    : [];
  const count = typeof d.count === "number" ? d.count : names.length;
  return { count, names };
}
