import { NAV_LAYOUT_MAX_PINNED, NAV_LAYOUT_NEVER_HIDDEN, type NavLayout } from "@routeflow/types";
import { Pin } from "lucide-react";
import type { NavEntry, NavLeaf } from "./nav-config";

/**
 * The per-tenant sidebar layout pass (SA-1209 F-1 pinned, SA-1228 F-2 hidden and order). DISPLAY ONLY, never a permission.
 *
 * Pure, and it can only reorder or drop entries it is given: every entry it returns is one the caller passed in, so it
 * can never add a page the viewer does not already see. Hiding a page only tidies this menu; the palette and the keys
 * read the menu before the layout (`buildOperatorNavIndex`), and no route guard reads it (L-305).
 */

/** The label of the top section; also how the open/active helpers tell it from a real group. */
export const PINNED_GROUP_LABEL = "Pinned";

const stringList = (v: unknown): string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : [];

/** Drop every leaf whose href is in `drop`; a group left with no child goes too. Skeletons stay. */
function dropLeaves(nav: NavEntry[], drop: ReadonlySet<string>): NavEntry[] {
  return nav.flatMap((e): NavEntry[] => {
    if (e.kind === "leaf") return drop.has(e.href) ? [] : [e];
    if (e.kind === "group") {
      const children = e.children.filter((c) => !drop.has(c.href));
      if (children.length === 0) return [];
      return [children.length === e.children.length ? e : { ...e, children }];
    }
    return [e];
  });
}

/**
 * Entries unchanged with no layout (loading or failed: the sidebar is never blank) or when all three lists are empty.
 * Otherwise, in this order: hidden pages are dropped (never Settings), pins are taken from what is left and removed
 * from where they were (a page is listed once), the top level is ordered by `order`, and a "Pinned" group goes first.
 * Each list is read on its own: one that is not a list of strings reads as empty.
 */
export function applyNavLayout(nav: NavEntry[], layout: NavLayout | undefined): NavEntry[] {
  if (!layout || typeof layout !== "object") return nav;
  const pinnedIn = stringList(layout.pinned);
  const order = stringList(layout.order);
  const hidden = new Set(stringList(layout.hidden).filter((h) => h !== NAV_LAYOUT_NEVER_HIDDEN));
  if (pinnedIn.length === 0 && order.length === 0 && hidden.size === 0) return nav;

  let rest = hidden.size > 0 ? dropLeaves(nav, hidden) : nav;

  const seen = new Map<string, NavLeaf>();
  for (const e of rest) {
    if (e.kind === "leaf") seen.set(e.href, e);
    else if (e.kind === "group")
      for (const c of e.children) if (!seen.has(c.href)) seen.set(c.href, c);
  }
  const pinned: NavLeaf[] = [];
  for (const href of pinnedIn) {
    const leaf = seen.get(href);
    if (leaf && !pinned.includes(leaf)) pinned.push(leaf);
    if (pinned.length === NAV_LAYOUT_MAX_PINNED) break;
  }
  if (pinned.length > 0) rest = dropLeaves(rest, new Set(pinned.map((p) => p.href)));

  if (order.length > 0) {
    const rank = new Map<string, number>();
    for (const id of order) if (!rank.has(id)) rank.set(id, rank.size);
    const rankOf = (e: NavEntry): number | undefined => {
      const id = e.kind === "leaf" ? e.href : e.kind === "group" ? e.id : e.holds;
      return id === undefined ? undefined : rank.get(id);
    };
    const named = rest
      .filter((e) => rankOf(e) !== undefined)
      .sort((a, b) => (rankOf(a) as number) - (rankOf(b) as number));
    rest = [...named, ...rest.filter((e) => rankOf(e) === undefined)];
  }

  if (pinned.length === 0) return rest;
  return [
    { kind: "group", id: "pinned", label: PINNED_GROUP_LABEL, icon: Pin, children: pinned },
    ...rest,
  ];
}
