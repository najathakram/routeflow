/**
 * Row 604 F17: the tab that created an order also receives the realtime `order.created` event for it. Recording the
 * order here lets the realtime handler skip its "New order placed" toast, so one order gives one toast.
 */
const mine = new Map<string, number>();
const REMEMBER_MS = 60_000;
/** How long the realtime toast waits, so a create response that lands after the event can still claim it. */
export const ECHO_GRACE_MS = 1500;

export function markOrderCreatedHere(orderNumber: string | null | undefined): void {
  if (orderNumber) mine.set(orderNumber, Date.now());
}

export function wasCreatedHere(orderNumber: string | null | undefined): boolean {
  if (!orderNumber) return false;
  const at = mine.get(orderNumber);
  if (at === undefined) return false;
  if (Date.now() - at > REMEMBER_MS) {
    mine.delete(orderNumber);
    return false;
  }
  return true;
}
