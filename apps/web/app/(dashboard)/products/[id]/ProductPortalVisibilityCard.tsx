"use client";

import * as React from "react";
import { Eye } from "lucide-react";
import { Badge } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import { usePlanFlag } from "@/lib/api/plan-flags";
import { useSetProductPortalVisibility } from "@/lib/api/product-portal-visibility";
import { portalBadge, PORTAL_BADGE_LABEL } from "@/lib/product-portal-visibility-ui";

// No error toasts here: the global MutationCache handler shows the server message once (B594).
const HELP =
  "Hidden products never appear to buyers; staff still see them. A hidden parent hides all its variants.";
const OFF_CAPTION = "Hidden from your online shop. Your team can still add it to orders.";
const PARENT_CAPTION = "Shown on its own, but hidden from buyers because its parent is hidden.";

/**
 * Buyer-portal visibility of one product. TENANT_ADMIN gets a switch (server-enforced); everyone
 * else a read-only status. A variant under a hidden parent shows "Hidden by parent" while the
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
  const isAdmin = useAuth().user?.role === "TENANT_ADMIN";
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
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-navy">
        <Eye className="h-4 w-4 text-brand-600" aria-hidden /> Buyer portal
      </h3>
      {isAdmin ? (
        <label className="flex items-center gap-2 text-sm font-medium text-navy">
          <input
            type="checkbox"
            role="switch"
            data-testid="portal-visibility-switch"
            aria-label="Show in buyer portal"
            checked={portalVisible}
            disabled={setVisibility.isPending}
            onChange={(e) => setVisibility.mutate({ portalVisible: e.target.checked })}
          />
          Show in buyer portal
        </label>
      ) : (
        <p className="text-sm text-navy" data-testid="portal-visibility-status">
          {!portalVisible
            ? "Hidden from buyer portal"
            : badge === "hidden-by-parent"
              ? "Hidden by parent"
              : "Visible in buyer portal"}
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
