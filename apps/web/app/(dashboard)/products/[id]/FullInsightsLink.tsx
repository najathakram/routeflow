"use client";

import Link from "next/link";
import { BarChart3 } from "lucide-react";
import { useDeniedGroups } from "@/lib/api/my-permissions";

/**
 * #2119 / SA-1087: this page keeps its own demand/sales cards; "Full insights" links to the
 * dedicated page for the trend, buyers, sold lines and CSV. Its own file, like DemandCard and
 * SalesHistoryCard below it, to hold page.tsx under the size ratchet.
 *
 * Shown only to what the endpoint serves (`/analytics/products/:id/insights`: an operator or
 * admin, the REPORTS group, `flag.analytics`), never a link that ends in a refusal. Its one
 * parent, `ProductInsightsExport`, has already checked the role and the plan flag, so the link
 * reads only what the parent does not: the REPORTS group. A pending or failed permission read
 * shows the link; the server is the authority.
 */
export function FullInsightsLink({ productId }: { productId: string }) {
  if (useDeniedGroups().includes("REPORTS")) return null;

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
