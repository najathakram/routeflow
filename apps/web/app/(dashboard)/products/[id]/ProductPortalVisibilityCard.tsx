"use client";

import * as React from "react";
import { Badge } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import { isStaffRole } from "@/lib/default-unit-line";
import { isRuleAdmin } from "@/lib/rule-chooser";
import { usePlanFlag } from "@/lib/api/plan-flags";
import { useSetProductPortalVisibility } from "@/lib/api/product-portal-visibility";
import { portalBadge, PORTAL_BADGE_LABEL } from "@/lib/product-portal-visibility-ui";

// No error toasts here: the global MutationCache handler shows the server message once (B594).
const HELP =
  "Hidden products never appear to buyers; staff still see them. A hidden parent hides all its variants.";
const OFF_CAPTION = "Hidden from your online shop. Your team can still add it to orders.";
/** Hiding a product from the portal hides it from EVERY portal customer: account-admin-only (owner L5). */
export const PORTAL_ADMIN_ONLY_HINT =
  "Only an account admin can hide a product from every portal customer.";
const PORTAL_HINT_ID = "portal-visibility-admin-hint";
const PARENT_CAPTION = "Shown on its own, but hidden from buyers because its parent is hidden.";

/**
 * Buyer-portal visibility of one product. An account admin gets the switch (server-enforced); an operator sees it
 * disabled with the visible admin-only hint (owner ruling 2026-10-14); anyone else a read-only status. A variant under a hidden parent shows "Hidden by parent" while the
 * switch still edits the variant's own flag.
 */
export function ProductPortalVisibilityCard({
  product,
}: {
  product: {
    id: string;
    portalVisible?: boolean;
    parent?: { portalVisible?: boolean | null } | null;
  };
}) {
  const productId = product.id;
  const portalVisible = product.portalVisible !== false;
  const parent = product.parent;
  const role = useAuth().user?.role;
  const isAdmin = isRuleAdmin(role);
  const showsSwitch = isAdmin || isStaffRole(role);
  const setVisibility = useSetProductPortalVisibility(productId);
  const badge = portalBadge({ portalVisible, parent });
  // A tenant without the buyer-portal add-on has no buyer portal to hide products from. Fail OPEN while unknown.
  const portalFlag = usePlanFlag("addon.buyer_portal");
  if (portalFlag.resolved && !portalFlag.enabled) return null;

  return (
    <div
      className="rounded-xl border border-surface-border bg-white p-4"
      data-testid="portal-visibility-card"
    >
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
        Buyer portal
      </h3>
      {showsSwitch && (
        <label className="flex items-center gap-2 text-sm font-medium text-navy">
          <input
            type="checkbox"
            role="switch"
            data-testid="portal-visibility-switch"
            aria-label="Show in buyer portal"
            checked={portalVisible}
            disabled={!isAdmin || setVisibility.isPending}
            aria-describedby={isAdmin ? undefined : PORTAL_HINT_ID}
            onChange={(e) => isAdmin && setVisibility.mutate({ portalVisible: e.target.checked })}
          />
          Show in buyer portal
        </label>
      )}
      {!isAdmin && (
        <p className="text-sm text-navy" data-testid="portal-visibility-status">
          {!portalVisible
            ? "Hidden from buyer portal"
            : badge === "hidden-by-parent"
              ? "Hidden by parent"
              : "Visible in buyer portal"}
        </p>
      )}
      {showsSwitch && !isAdmin && (
        <p id={PORTAL_HINT_ID} className="mt-1 text-xs text-navy/70">
          {PORTAL_ADMIN_ONLY_HINT}
        </p>
      )}
      {badge && (
        <div className="mt-2" data-testid="portal-visibility-badge">
          <Badge variant="warning" label={PORTAL_BADGE_LABEL[badge]} />
        </div>
      )}
      {(!portalVisible || badge === "hidden-by-parent") && (
        <p className="mt-2 text-xs text-navy" data-testid="portal-visibility-caption">
          {!portalVisible ? OFF_CAPTION : PARENT_CAPTION}
        </p>
      )}
      <p className="mt-2 text-xs text-navy/60">{HELP}</p>
    </div>
  );
}
