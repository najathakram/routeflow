/**
 * Display label for an order status on the STAFF surfaces, from the shared fulfilment method table
 * (`FULFILMENT_METHODS` in @routeflow/types): SHIP reads "Shipped", PICKUP "Ready for pickup" / "Picked
 * up", ROUTE today's words. DISPLAY ONLY: the status enum and the API are untouched.
 */
import { FULFILMENT_METHODS, fulfilmentStatusLabel } from "@routeflow/types";

export { FULFILMENT_METHODS };

/** `label` for `status` under `method` (an order's fulfillPath, or the account default); `normal`
 *  when the table has no word for it. */
export function orderStatusText(
  status: string,
  method: string | null | undefined,
  normal: string,
): string {
  return fulfilmentStatusLabel(method, status, normal);
}
