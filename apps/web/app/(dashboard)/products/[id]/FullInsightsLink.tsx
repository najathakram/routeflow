"use client";

import Link from "next/link";
import { BarChart3 } from "lucide-react";
import { useInsightsAccess } from "@/components/insights/use-insights-access";

/**
 * #2119 / SA-1087: this page keeps its own demand/sales cards; "Full insights" links to the
 * dedicated page for the trend, buyers, sold lines and CSV. Its own file, like DemandCard and
 * SalesHistoryCard below it, to hold page.tsx under the size ratchet.
 *
 * Shown only to what the endpoint serves (`useInsightsAccess`), never a link that ends in a refusal.
 */
export function FullInsightsLink({ productId }: { productId: string }) {
  if (!useInsightsAccess()) return null;

  return (
    <Link
      href={`/insights/products/${productId}`}
      className="inline-flex items-center gap-1.5 self-center text-sm font-medium text-brand-600 hover:text-brand-700"
    >
      <BarChart3 size={15} />
      Full insights
    </Link>
  );
}
