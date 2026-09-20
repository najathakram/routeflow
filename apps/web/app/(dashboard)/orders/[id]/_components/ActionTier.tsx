"use client";

import * as React from "react";
import { cn } from "@routeflow/ui/web";
import { useOrderUiV2 } from "@/lib/api/addons";

export type ActionTierName = "primary" | "secondary" | "danger";

/**
 * Visual weight tiers for the order-detail action bar (order-ui-redesign-spec §8.4, T7).
 *
 * The bar used to render every action at the same size and weight in one wrapping row — five
 * controls on a phone, one of which permanently destroys the order. Each group of existing
 * buttons is wrapped in a tier; with `order_ui_v2` on the tiers stack as
 *
 *   primary   — the one action that advances the order (full width on a phone)
 *   secondary — reversible actions (Edit, Unconfirm, Return to Confirmed, Reopen)
 *   danger    — Cancel / Delete, on their own ruled-off row (hidden when the group is empty, e.g.
 *               Delete is not offered once the order is closed or invoiced)
 *
 * WITH THE FLAG OFF THIS IS A PLAIN FRAGMENT: the same children in the same order, no wrapper
 * element, so the page renders exactly as before. It only re-groups and re-orders JSX the page
 * already renders — no handler, gating condition or confirm step lives here or moves.
 */
const TIER_CLASSES: Record<ActionTierName, string> = {
  primary: "order-1 flex items-center gap-2 max-sm:w-full max-sm:[&>*]:flex-1",
  secondary: "order-2 flex flex-wrap items-center gap-2 max-sm:w-full",
  danger:
    "order-3 mt-1 flex w-full flex-wrap items-center gap-2 border-t border-surface-border pt-3 empty:hidden",
};

export function ActionTier({
  tier,
  caption,
  children,
}: {
  tier: ActionTierName;
  /** Small helper line under a tier (v2 only) — e.g. that Cancel can be undone with Reopen. */
  caption?: string;
  children: React.ReactNode;
}) {
  const { enabled } = useOrderUiV2();
  if (!enabled) return <>{children}</>;

  return (
    <div
      data-testid={`action-tier-${tier}`}
      data-tier={tier}
      // 44px touch targets under sm (spec §9) without touching the shared Button.
      className={cn(TIER_CLASSES[tier], "max-sm:[&_button]:min-h-11")}
    >
      {children}
      {caption && <p className="w-full text-[11px] text-navy/50">{caption}</p>}
    </div>
  );
}
