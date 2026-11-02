"use client";

import Link from "next/link";
import { ScanSearch } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import { useInsightsAccess } from "./use-insights-access";

/**
 * SA-1087 PR-2: Analytics' way into the product finder (`/insights`). Its own file, so
 * `analytics/page.tsx` gains two lines. Same audience as the endpoint (`useInsightsAccess`):
 * staff without REPORTS, or a plan without `flag.analytics`, get no link.
 */
export function FindInsightsLink({ className }: { className?: string }) {
  if (!useInsightsAccess()) return null;
  return (
    <Link
      href="/insights"
      className={cn(
        "inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-700",
        className,
      )}
    >
      <ScanSearch size={15} />
      Look up a product
    </Link>
  );
}
