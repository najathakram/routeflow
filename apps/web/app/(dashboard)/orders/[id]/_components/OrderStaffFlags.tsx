import type { OrderInvoicesNeedReview, ToCollectState } from "@routeflow/types";
import { ToCollectChip } from "@/components/ToCollectChip";
import { InvoicesNeedReviewBadge } from "./InvoicesNeedReviewBadge";

/**
 * The staff order header's flags, in one slot: "Invoices need review" (B1116) and "To collect" (SA-1026, a check not
 * received yet). The server sends both fields to staff only and derives both; this renders them and re-derives nothing.
 */
export function OrderStaffFlags({
  order,
}: {
  order: { invoicesNeedReview?: OrderInvoicesNeedReview; toCollect?: ToCollectState };
}) {
  return (
    <>
      <InvoicesNeedReviewBadge review={order.invoicesNeedReview} />
      <ToCollectChip state={order.toCollect} />
    </>
  );
}
