import { isPaidAtSale } from "@routeflow/pricing";
import { toCollectState } from "./to-collect";

/**
 * The derived flags an invoice read adds to the stored row, shared by the list and the detail so the two never disagree:
 *  - `paidAtSale` (row 401): a counter sale paid at the till shows no due date or terms.
 *  - `toCollect` (SA-1026): "To collect", derived from the payment intent and the status by the one rule in to-collect.ts.
 *    Staff only: the buyer projections (`customerInvoiceList`, the allowlist in common/staff-only-fields.ts) drop it.
 */
export function listRowFlags(
  inv: Parameters<typeof isPaidAtSale>[0] & {
    status: string;
    expectedPaymentMethod?: string | null;
  },
) {
  return { paidAtSale: isPaidAtSale(inv), toCollect: toCollectState(inv) };
}
