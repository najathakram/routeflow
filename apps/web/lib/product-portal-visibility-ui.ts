// Pure UI logic for buyer-portal visibility (Hidden badge, filter param, bulk controls).

export interface PortalVisibilityRow {
  portalVisible?: boolean | null;
  parent?: { portalVisible?: boolean | null } | null;
}

export type PortalBadge = "hidden" | "hidden-by-parent" | null;

/** Own flag wins ("Hidden"); else a hidden parent shows "Hidden by parent"; else no badge. */
export function portalBadge(row: PortalVisibilityRow): PortalBadge {
  if (row.portalVisible === false) return "hidden";
  if (row.parent?.portalVisible === false) return "hidden-by-parent";
  return null;
}

export const PORTAL_BADGE_LABEL: Record<Exclude<PortalBadge, null>, string> = {
  hidden: "Hidden from portal",
  "hidden-by-parent": "Hidden by parent",
};

/** List-query param: only set when the "Hidden from portal" filter is on. */
export function portalVisibleFilterParam(hiddenOnly: boolean): { portalVisible?: false } {
  return hiddenOnly ? { portalVisible: false } : {};
}

/** Bulk Hide/Show are TENANT_ADMIN-only and need a selection. */
export function canBulkSetPortalVisibility(role: string | undefined, selectedCount: number) {
  return role === "TENANT_ADMIN" && selectedCount > 0;
}

/** The server caps one bulk call at 200 ids; past that the UI says so instead of surfacing a raw 400. */
export const BULK_PORTAL_MAX = 200;
export const bulkPortalTooMany = (selectedCount: number) => selectedCount > BULK_PORTAL_MAX;

export function bulkPortalPayload(selected: Iterable<string>, portalVisible: boolean) {
  return { ids: Array.from(selected), portalVisible };
}
