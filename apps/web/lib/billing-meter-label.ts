import type { MeterKey } from "@routeflow/types";

/** One label per server meter. Typed on the shared `MeterKey` union (parity-pinned to Prisma), so a
 *  meter the server adds fails the type-check here instead of printing its raw key on the page. */
const METER_LABEL: Record<MeterKey, string> = {
  SEATS: "Seats",
  ROUTES: "Routes / day",
  SCANS: "AI scans",
  MSGS: "Messages",
  CUSTOMERS: "Customers",
};

/** The label for a usage meter. A key this build has never heard of (a newer server) is humanised
 *  ("ROUTE_STOPS" -> "Route stops"), never shown raw. */
export function meterLabel(key: string): string {
  const known = (METER_LABEL as Record<string, string | undefined>)[key];
  if (known) return known;
  const words = key
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, " ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}
