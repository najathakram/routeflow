// ─── Per-tenant sidebar layout (SA-1209) — the web menu <-> API contract ─────────────────────────────
//
// Stored per business as one JSON string under the SystemConfig key `settings.navLayout` (no migration), read through
// GET /settings (`navLayout`, defaults filled) and written by PATCH /settings/nav-layout (TENANT_ADMIN only). The generic
// PATCH /settings refuses the key. DISPLAY ONLY: a layout reorders or drops menu entries the viewer already sees; it never
// adds one and it is never a permission.

/** The SystemConfig key the whole layout is stored under (one JSON string). */
export const NAV_LAYOUT_CONFIG_KEY = "settings.navLayout";

/** At most this many pinned leaves. */
export const NAV_LAYOUT_MAX_PINNED = 5;

/** The stable ids of the menu groups, the values `order` may name beside top-level leaf hrefs (SA-1228 F-2). */
export const NAV_GROUP_ID_VALUES = [
  "orders",
  "dispatch",
  "warehouse",
  "finance",
  "reports",
  "regulated",
] as const;
export type NavGroupId = (typeof NAV_GROUP_ID_VALUES)[number];

/** The one page a layout can never hide: the way back to this very setting. */
export const NAV_LAYOUT_NEVER_HIDDEN = "/settings";

export interface NavLayout {
  /** Leaf hrefs shown in the top "Pinned" section, in this order. */
  pinned: string[];
  /** Top-level ids in menu order: group ids from NAV_GROUP_ID_VALUES and top-level leaf hrefs (applied). */
  order: string[];
  /** Leaf hrefs hidden from the sidebar (applied; display only, never a permission). */
  hidden: string[];
}
