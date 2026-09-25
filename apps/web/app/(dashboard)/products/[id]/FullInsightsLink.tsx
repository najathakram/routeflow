import Link from "next/link";
import { BarChart3 } from "lucide-react";

/**
 * #2119 / plan §A10: this page keeps its own demand/sales cards; "Full
 * insights" links to the dedicated finder-rooted page for the trend/buyers/
 * CSV view once #2105-a's API ships. Its own file — like DemandCard /
 * SalesHistoryCard below it — to hold page.tsx under the size ratchet.
 */
export function FullInsightsLink({ productId }: { productId: string }) {
  return (
    <Link
      href={`/insights/products/${productId}`}
      className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-brand-600 hover:text-brand-700"
    >
      <BarChart3 size={15} />
      Full insights
    </Link>
  );
}
