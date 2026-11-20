import { activeLeafHref } from "./nav-active";
import type { NavEntry, NavGroup, NavLeaf } from "./nav-config";

/**
 * The one map of the staff shell (UXG-R8, C1). The menu is built once (`buildOperatorNav`); everything else that
 * lists "places a person can go" reads that same list through the helpers here, so a page the menu hides is
 * never offered by a shortcut, the help or (later) search, and a rename happens in one place.
 */

/** Every leaf of the menu in menu order. Skeleton rows hold a place for an entry that is still loading; they are not pages. */
export function navLeaves(nav: readonly NavEntry[]): NavLeaf[] {
  return nav.flatMap((e): NavLeaf[] =>
    e.kind === "leaf" ? [e] : e.kind === "group" ? e.children : [],
  );
}

/**
 * The ONE rule for "which entry holds this page": the longest leaf href that equals the path or is a
 * "/"-boundary prefix of it, over every leaf of the menu. Null when no leaf holds the page.
 */
export function activeNavLeaf(nav: readonly NavEntry[], pathname: string): NavLeaf | null {
  const leaves = navLeaves(nav);
  const href = activeLeafHref(leaves, pathname);
  return href === null ? null : (leaves.find((l) => l.href === href) ?? null);
}

/** The group whose child holds this page (null for a top-level leaf or no page). */
export function activeNavGroup(nav: readonly NavEntry[], pathname: string): NavGroup | null {
  const leaf = activeNavLeaf(nav, pathname);
  if (!leaf) return null;
  return (
    nav.find(
      (e): e is NavGroup => e.kind === "group" && e.children.some((c) => c.href === leaf.href),
    ) ?? null
  );
}

/** "g" then a letter: the pages that have a key, in the order the help lists them. Data, not code. */
export const SHORTCUT_KEYS: Readonly<Record<string, string>> = {
  "/dashboard": "h",
  "/orders": "o",
  "/routes": "r",
  "/drivers": "d",
  "/customers": "c",
  "/invoices": "i",
  "/finance/dashboard": "f",
  "/settings": "s",
  "/orders/counter-sale": "t",
};

export type NavShortcut = {
  letter: string;
  href: string;
  /** The keys as the help shows them: ["g", "h"]. */
  keys: [string, string];
  label: string;
};

/** The keys whose page is a leaf of this menu, each labelled "Go to {the entry's name}". */
export function navShortcuts(nav: readonly NavEntry[]): NavShortcut[] {
  const leaves = navLeaves(nav);
  return Object.entries(SHORTCUT_KEYS).flatMap(([href, letter]): NavShortcut[] => {
    const leaf = leaves.find((l) => l.href === href);
    return leaf ? [{ letter, href, keys: ["g", letter], label: `Go to ${leaf.label}` }] : [];
  });
}

/** `navShortcuts` as the letter → page map the key handler reads. */
export function navShortcutTargets(nav: readonly NavEntry[]): Record<string, string> {
  return Object.fromEntries(navShortcuts(nav).map((s) => [s.letter, s.href]));
}
