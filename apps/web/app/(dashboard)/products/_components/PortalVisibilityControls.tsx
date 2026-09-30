"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { Badge, Button, useToast } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import { useBulkSetPortalVisibility } from "@/lib/api/product-portal-visibility";
import {
  BULK_PORTAL_MAX,
  bulkPortalPayload,
  bulkPortalTooMany,
  canBulkSetPortalVisibility,
  portalBadge,
  PORTAL_BADGE_LABEL,
  type PortalVisibilityRow,
} from "@/lib/product-portal-visibility-ui";

/** "Hidden" / "Hidden by parent" badge for a list row; renders nothing for a visible row. */
export function PortalHiddenBadge({ product }: { product: PortalVisibilityRow }) {
  const kind = portalBadge(product);
  if (!kind) return null;
  return (
    <span data-testid="portal-hidden-badge">
      <Badge variant="warning" label={PORTAL_BADGE_LABEL[kind]} />
    </span>
  );
}

/** Toolbar toggle: list only products hidden from the buyer portal. */
export function PortalHiddenFilter({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-navy">
      <input
        type="checkbox"
        data-testid="portal-hidden-filter"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      Hidden from portal
    </label>
  );
}

/** Bulk Hide / Show for the current selection (TENANT_ADMIN only, server-enforced too). */
export function PortalBulkButtons({
  selected,
  onDone,
}: {
  selected: Set<string>;
  onDone: () => void;
}) {
  const role = useAuth().user?.role;
  const { toast } = useToast();
  const bulk = useBulkSetPortalVisibility();
  if (!canBulkSetPortalVisibility(role, selected.size)) return null;
  const tooMany = bulkPortalTooMany(selected.size);
  const run = (portalVisible: boolean) =>
    bulk.mutate(bulkPortalPayload(selected, portalVisible), {
      onSuccess: (res) => {
        toast({
          title: `${res.updated} ${portalVisible ? "shown in" : "hidden from"} portal, ${res.unchanged} unchanged`,
          variant: "success",
        });
        onDone();
      },
    });
  return (
    <>
      {tooMany && (
        <span className="text-xs text-amber-700" data-testid="portal-bulk-limit">
          Select up to {BULK_PORTAL_MAX} products to hide or show ({selected.size} selected).
        </span>
      )}
      <Button
        variant="secondary"
        leftIcon={<EyeOff className="h-4 w-4" />}
        disabled={tooMany}
        loading={bulk.isPending}
        data-testid="portal-bulk-hide"
        onClick={() => run(false)}
      >
        Hide from portal
      </Button>
      <Button
        variant="secondary"
        leftIcon={<Eye className="h-4 w-4" />}
        disabled={tooMany}
        loading={bulk.isPending}
        data-testid="portal-bulk-show"
        onClick={() => run(true)}
      >
        Show in portal
      </Button>
    </>
  );
}
