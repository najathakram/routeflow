/**
 * Whether the admin may choose what new staff orders open as, for ticks that are not saved yet.
 *
 * TODO(BO-03): replace this with `isOpensAsChoosable` from `@routeflow/types` (the API uses the same function; the
 * preview also echoes `opensAsChoosable`) once fix/mb-bo-api lands. Until then this is the ONE place that knows the rule: only Shipping + Counter without Delivery is
 * choosable (a Delivery business always opens staff orders as orders; a counter-only one has nothing to choose).
 */
export function opensAsChoosableFor(ticks: {
  delivery: boolean;
  shipping: boolean;
  counter: boolean;
}): boolean {
  return !ticks.delivery && ticks.shipping && ticks.counter;
}
