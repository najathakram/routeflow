/**
 * Row 590 (SA-978a): the fixed copy of an office DELIVERED on an order whose run stop has not completed. The api sends
 * the same sentence in the 409 body; it keeps a literal copy (it never value-imports this package at runtime), pinned
 * byte-equal by apps/api/src/common/order-route-stop-copy-parity.spec.ts. Pure.
 */
export const ORDER_DELIVERED_ON_ROUTE_STOP_COPY =
  "This order is on a delivery run. Complete its stop on the route, or take it off the run first.";

/** Row 590 (SA-978 §1): one line that keeps the driver's figure on a DELIVERED order, in the status response. */
export interface RouteHeldLineView {
  lineId: string;
  delivered: number;
  qty: number;
}

/** "{name} stays at 6 of 10, as the driver recorded. To put the other 4 back in stock, lower its quantity." */
export function routeHeldLineCopy(name: string, delivered: number, qty: number): string {
  const rest = Math.round((qty - delivered) * 1000) / 1000;
  return `${name} stays at ${delivered} of ${qty}, as the driver recorded. To put the other ${rest} back in stock, lower its quantity.`;
}

/**
 * Web: after an office DELIVERED, the one toast that names the lines the driver's figure holds (`routeHeldLines` of the
 * status response; absent or empty = no toast). `lines` is the order the page shows, to find each line's name.
 */
export function routeHeldNotice(
  done: unknown,
  lines:
    | ReadonlyArray<{ id: string; name?: string | null; product?: { name?: string } | null }>
    | undefined,
  toast: (opts: { title: string; description: string; variant: "warning" }) => unknown,
): void {
  const held = (done as { routeHeldLines?: RouteHeldLineView[] } | null | undefined)
    ?.routeHeldLines;
  if (!Array.isArray(held) || held.length === 0) return;
  const description = held
    .map((h) => {
      const li = lines?.find((l) => l.id === h.lineId);
      return routeHeldLineCopy(li?.product?.name ?? li?.name ?? "A line", h.delivered, h.qty);
    })
    .join(" ");
  toast({ title: "Order delivered", description, variant: "warning" });
}
