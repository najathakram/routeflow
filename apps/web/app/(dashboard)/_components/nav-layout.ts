import { NAV_LAYOUT_MAX_PINNED, type NavLayout } from "@routeflow/types";
import { Pin } from "lucide-react";
import type { NavEntry, NavLeaf } from "./nav-config";

/**
 * The per-tenant sidebar layout pass (SA-1209 F-1: PINNED ONLY). DISPLAY ONLY, never a permission.
 *
 * Pure, and it can only reorder or drop entries it is given: every entry it returns is one the caller passed in, so it
 * can never add a page the viewer does not already see. `order` and `hidden` are stored but not applied until F-2.
 */

/** The label of the top section; also how the open/active helpers tell it from a real group. */
export const PINNED_GROUP_LABEL = "Pinned";

const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Entries unchanged with no layout (loading or failed: the sidebar is never blank), with a malformed one, or when
 * none of the pins is a page the viewer sees. Otherwise a "Pinned" group is placed first and every entry stays in
 * its own group as well.
 */
export function applyNavLayout(nav: NavEntry[], layout: NavLayout | undefined): NavEntry[] {
  if (!layout || typeof layout !== "object" || !isStringList(layout.pinned)) return nav;

  const seen = new Map<string, NavLeaf>();
  for (const e of nav) {
    if (e.kind === "leaf") seen.set(e.href, e);
    else if (e.kind === "group")
      for (const c of e.children) if (!seen.has(c.href)) seen.set(c.href, c);
  }
  const pinned: NavLeaf[] = [];
  for (const href of layout.pinned) {
    const leaf = seen.get(href);
    if (leaf && !pinned.includes(leaf)) pinned.push(leaf);
    if (pinned.length === NAV_LAYOUT_MAX_PINNED) break;
  }
  if (pinned.length === 0) return nav;
  return [{ kind: "group", label: PINNED_GROUP_LABEL, icon: Pin, children: pinned }, ...nav];
}
