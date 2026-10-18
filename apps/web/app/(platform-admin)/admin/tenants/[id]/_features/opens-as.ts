/**
 * Whether the admin may choose what new staff orders open as, for ticks that are not saved yet.
 *
 * TODO(BO-03): replace this with the server's `opensAsChoosable` echo once the preview/read carries it for unsaved
 * ticks. Until then this is the ONE place that knows the rule: only Shipping + Counter without Delivery is
 * choosable (a Delivery business always opens staff orders as orders; a counter-only one has nothing to choose).
 */
export function opensAsChoosableFor(ticks: {
  delivery: boolean;
  shipping: boolean;
  counter: boolean;
}): boolean {
  return !ticks.delivery && ticks.shipping && ticks.counter;
}
