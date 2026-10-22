"use client";

import * as React from "react";
import { cn } from "@routeflow/ui/web";
import { useOrderUiV2 } from "@/lib/api/addons";
import { usePhoneWidth } from "./use-phone-width";

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
 * There is deliberately NO "you can reopen it later" caption under Cancel: cancelling voids the
 * order's live invoices, `reopenOrder` does not un-void them, can be refused when an invoice is
 * paid, and returns the order to PENDING — a reassurance there would sit above the only real
 * warning (the cancel-impact dialog).
 *
 * WITH THE FLAG OFF THIS IS A PLAIN FRAGMENT: the same children in the same order, no wrapper
 * element, so the page renders exactly as before. It only re-groups and re-orders JSX the page
 * already renders — no handler, gating condition or confirm step lives here or moves.
 */
const TIER_CLASSES: Record<ActionTierName, string> = {
  primary:
    "order-1 flex items-center gap-2 max-sm:w-full max-sm:[&>*]:flex-1 max-sm:[&_button]:w-full",
  secondary: "order-2 flex flex-wrap items-center gap-2 max-sm:w-full",
  danger:
    "order-3 mt-1 flex w-full flex-wrap items-center gap-2 border-t border-surface-border pt-3 empty:hidden",
};

/**
 * Phone width (apple-ux r4 Q19), with the flag on OR off: the bar is ONE row. The primary fills what
 * the row leaves (44px tall), a secondary keeps its size, and the danger group is only whatever is
 * left of Cancel / Delete after they step into the "More actions" menu: a Delete confirm or the
 * with-the-carrier note, each on its own full-width line under the row, hidden when empty.
 */
const PHONE_TIER_CLASSES: Record<ActionTierName, string> = {
  primary:
    "order-1 flex min-w-[9rem] flex-1 items-center [&>*]:flex-1 [&_button]:w-full [&_button]:min-h-11",
  secondary: "order-2 flex shrink-0 items-center gap-2 [&_button]:min-h-11",
  danger: "order-4 flex basis-full flex-wrap items-center gap-2 empty:hidden",
};

export function ActionTier({
  tier,
  children,
}: {
  tier: ActionTierName;
  children: React.ReactNode;
}) {
  const { enabled } = useOrderUiV2();
  const phone = usePhoneWidth();
  if (phone) {
    return (
      <div data-tier={tier} className={PHONE_TIER_CLASSES[tier]}>
        {children}
      </div>
    );
  }
  if (!enabled) return <>{children}</>;

  return (
    <div
      // `data-tier` (not a test id): several secondary tiers can share one bar.
      data-tier={tier}
      // 44px touch targets under sm (spec §9) without touching the shared Button.
      className={cn(TIER_CLASSES[tier], "max-sm:[&_button]:min-h-11")}
    >
      {children}
    </div>
  );
}
