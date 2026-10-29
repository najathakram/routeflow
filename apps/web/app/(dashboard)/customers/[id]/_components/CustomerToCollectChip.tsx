import Link from "next/link";
import { Badge } from "@routeflow/ui/web";
import { formatMoney } from "@/lib/format";

/**
 * SA-1026 A: the customer detail's "To collect" chip: how many of the customer's invoices read To collect and the sum of
 * their existing balance due, both from the staff statement (the server sums them; no money math here). It links to that
 * customer's To collect list. An older server, a buyer read or a count of 0 renders nothing.
 */
export function CustomerToCollectChip({
  customerId,
  summary,
}: {
  customerId: string;
  summary?: { count: number; balance: number } | null;
}) {
  if (!summary || summary.count <= 0) return null;
  return (
    <Link
      href={`/invoices?customerId=${encodeURIComponent(customerId)}&toCollect=true`}
      aria-label={`To collect: ${summary.count} ${summary.count === 1 ? "invoice" : "invoices"}, ${formatMoney(summary.balance)}`}
    >
      <Badge
        variant="warning"
        label={`To collect · ${summary.count} · ${formatMoney(summary.balance)}`}
        data-testid="customer-to-collect-chip"
      />
    </Link>
  );
}
