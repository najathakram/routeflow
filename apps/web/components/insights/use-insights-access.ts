"use client";

import { useAuth } from "@/lib/auth-context";
import { usePlanFlag } from "@/lib/api/plan-flags";
import { useDeniedGroups } from "@/lib/api/my-permissions";
import { planFlagVisible } from "@/lib/plan-gated-nav";

/**
 * SA-1087: who is shown a way into product insights — what `/analytics/products/:id/insights`
 * serves: an operator or admin, the REPORTS group, `flag.analytics`. One predicate for every entry
 * (the product page link, the Analytics link, the command palette), never a link that ends in a
 * refusal. A pending or failed permission read shows the entry; the server stays the authority.
 */
export function useInsightsAccess(): boolean {
  const { user } = useAuth();
  const analytics = usePlanFlag("flag.analytics");
  const denied = useDeniedGroups();
  const roleOk = user?.role === "OPERATOR" || user?.role === "TENANT_ADMIN";
  return roleOk && planFlagVisible(analytics) && !denied.includes("REPORTS");
}
