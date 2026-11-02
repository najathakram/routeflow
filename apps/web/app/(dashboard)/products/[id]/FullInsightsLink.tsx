"use client";

import Link from "next/link";
import { BarChart3 } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { usePlanFlag } from "@/lib/api/plan-flags";
import { useDeniedGroups } from "@/lib/api/my-permissions";
import { planFlagVisible } from "@/lib/plan-gated-nav";

/**
 * #2119 / SA-1087: this page keeps its own demand/sales cards; "Full insights" links to the
 * dedicated page for the trend, buyers, sold lines and CSV. Its own file, like DemandCard and
 * SalesHistoryCard below it, to hold page.tsx under the size ratchet.
 *
 * Shown only to what the endpoint serves (`/analytics/products/:id/insights`: an operator or
 * admin, the REPORTS group, `flag.analytics`), never a link that ends in a refusal. A pending or
 * failed permission read shows the link; the server is the authority.
 */
export function FullInsightsLink({ productId }: { productId: string }) {
  const { user } = useAuth();
  const analytics = usePlanFlag("flag.analytics");
  const denied = useDeniedGroups();

  const roleOk = user?.role === "OPERATOR" || user?.role === "TENANT_ADMIN";
  if (!roleOk || !planFlagVisible(analytics) || denied.includes("REPORTS")) return null;

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
