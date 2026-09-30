"use client";

import * as React from "react";
import { LayoutDashboard, ShoppingCart } from "lucide-react";
import { usePortalPresence } from "@/lib/hooks/usePortalPresence";
import {
  PORTAL_SWITCH_LABELS,
  portalSwitchTarget,
  type Portal,
  type SwitchVariant,
} from "@/lib/portal-routing";

export interface PortalSwitchLinkProps extends Omit<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  "href" | "children"
> {
  /** The portal this link leads to. */
  to: Portal;
  iconClassName?: string;
  /** Localized labels; defaults to the English PORTAL_SWITCH_LABELS. */
  labels?: Record<SwitchVariant, string>;
}

/**
 * The door between the buyer portal and the seller dashboard. Presence-aware:
 * links straight into the other portal when this browser holds a session there,
 * otherwise to its sign-in page. A plain anchor on purpose — the two portals are
 * separate app shells and a full navigation resets client state. Forwards its
 * ref and spreads props so Radix `DropdownMenu.Item asChild` can drive it.
 */
export const PortalSwitchLink = React.forwardRef<HTMLAnchorElement, PortalSwitchLinkProps>(
  function PortalSwitchLink({ to, iconClassName = "h-4 w-4", labels, ...rest }, ref) {
    const presence = usePortalPresence();
    const target = portalSwitchTarget(to, presence);
    const label = (labels ?? PORTAL_SWITCH_LABELS[to])[target.variant];
    const Icon = to === "buyer" ? ShoppingCart : LayoutDashboard;
    return (
      <a ref={ref} href={target.href} {...rest}>
        <Icon className={iconClassName} aria-hidden="true" />
        {label}
      </a>
    );
  },
);
