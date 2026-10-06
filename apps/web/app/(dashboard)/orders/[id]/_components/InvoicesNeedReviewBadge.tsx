import { Badge } from "@routeflow/ui/web";
import type { OrderInvoicesNeedReview } from "@routeflow/types";

/**
 * B1116: office-only "Invoices need review" badge for the staff order header. The server sends the
 * field to staff only (never on a buyer, customer or driver read) and `flagged` is the live derived
 * truth, so the badge clears itself once the invoices are fixed. Renders nothing otherwise.
 * The tooltip explains why, and — when a driver's stop completion left the audit row — who and when.
 */
const FALLBACK_REASON = "This order's invoices need review before more is billed on it.";

export function InvoicesNeedReviewBadge({ review }: { review?: OrderInvoicesNeedReview | null }) {
  if (!review?.flagged) return null;
  const lines = [review.reason ?? FALLBACK_REASON];
  if (review.flaggedAtStop) {
    const when = new Date(review.flaggedAtStop.at);
    const at = Number.isNaN(when.getTime())
      ? ""
      : ` on ${when.toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}`;
    lines.push(`Flagged at stop completion by ${review.flaggedAtStop.by}${at}`);
  }
  return (
    <Badge
      variant="warning"
      label="Invoices need review"
      title={lines.join("\n")}
      data-testid="order-invoices-need-review-badge"
    />
  );
}
