import { Plus, Route as RouteIcon, Store, type LucideIcon } from "lucide-react";
import { activeLeafHref } from "./nav-active";
import type { NavEntry, NavGroup, NavLeaf } from "./nav-config";
import { PINNED_GROUP_LABEL } from "./nav-layout";

/**
 * The one map of the staff shell (UXG-R8, C1). The menu is built once (`buildOperatorNav`); everything else that
 * lists "places a person can go" reads that same list through the helpers here, so a page the menu hides is
 * never offered by a shortcut, the help or (later) search, and a rename happens in one place.
 */

/** Every leaf of the menu in menu order. Skeleton rows hold a place for an entry that is still loading; they are not pages. */
export function navLeaves(nav: readonly NavEntry[]): NavLeaf[] {
  const all = nav.flatMap((e): NavLeaf[] =>
    e.kind === "leaf" ? [e] : e.kind === "group" ? e.children : [],
  );
  // A pinned page is listed twice in the menu (SA-1209: Pinned and its own group); it is one page everywhere else.
  const seen = new Set<string>();
  return all.filter((l) => !seen.has(l.href) && !!seen.add(l.href));
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
      (e): e is NavGroup =>
        e.kind === "group" &&
        e.label !== PINNED_GROUP_LABEL && // the page's own group opens, not the pin copy
        e.children.some((c) => c.href === leaf.href),
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

/**
 * Retired and alternative names, searchable and never shown as rows of their own (palette search reads
 * these as keywords). A rename moves the old label here, so nobody who knows it loses the page.
 */
export const NAV_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "/dashboard": ["home"],
  "/orders": ["Orders", "My orders", "All orders"],
  "/dispatch": ["Overview", "Dispatch overview"],
  "/deliveries": ["Order delivery", "Trips", "Deliveries"],
  "/settings": ["Settings"],
  "/vendor-bills": ["Expenses"],
  "/finance/dashboard": ["Overview", "Finance overview"],
  "/finance/payments": ["Payments", "Payments received"],
  "/insights": ["look up find scan barcode sales history demand trend buyers"],
};

export type QuickAction = {
  id: string;
  label: string;
  icon: LucideIcon;
  /** The page the action opens; with `opensCreate` it opens that page's own create form. */
  href: string;
  opensCreate: boolean;
  /** The menu leaf that must exist for this person, or the action is not theirs to offer. */
  needs: string;
  keywords: string;
  /** Creates something: a read-only workspace lists it disabled with the shared line. */
  readOnlyGated: boolean;
  /** `readOnlyGated` and the workspace is read-only right now. */
  blocked: boolean;
};

type QuickActionDef = Omit<QuickAction, "blocked">;

/** The creating actions, in the order every surface lists them. A new quick action is one row here. */
const QUICK_ACTION_DEFS: readonly QuickActionDef[] = [
  {
    id: "act-new-order",
    label: "New Order",
    icon: Plus,
    href: "/orders",
    opensCreate: true,
    needs: "/orders",
    keywords: "create add order",
    readOnlyGated: true,
  },
  {
    id: "act-counter-sale",
    label: "New counter sale",
    icon: Store,
    href: "/orders/counter-sale",
    opensCreate: false,
    needs: "/orders/counter-sale",
    keywords: "walk-in pickup pos till scan",
    readOnlyGated: true,
  },
  {
    id: "act-new-invoice",
    label: "New Invoice",
    icon: Plus,
    href: "/invoices/new",
    opensCreate: false,
    needs: "/invoices",
    keywords: "create add invoice",
    readOnlyGated: true,
  },
  {
    id: "act-new-route",
    label: "New Route",
    icon: Plus,
    href: "/routes/create",
    opensCreate: false,
    needs: "/routes",
    keywords: "create add route",
    readOnlyGated: false,
  },
  {
    id: "act-plan-trip",
    label: "Plan delivery",
    icon: RouteIcon,
    href: "/deliveries/new",
    opensCreate: false,
    needs: "/deliveries",
    keywords: "adhoc trip dispatch delivery",
    readOnlyGated: false,
  },
  {
    id: "act-new-customer",
    label: "New Customer",
    icon: Plus,
    href: "/customers",
    opensCreate: true,
    needs: "/customers",
    keywords: "create add customer",
    readOnlyGated: true,
  },
  {
    id: "act-new-product",
    label: "New Product",
    icon: Plus,
    href: "/products",
    opensCreate: true,
    needs: "/products",
    keywords: "create add product",
    readOnlyGated: true,
  },
];

/**
 * The creating actions this menu can offer. `staff` is false for a customer or a driver, who get none
 * (starting an order is a staff action, REG-B1). Each action needs its page in the menu, so a plan or
 * add-on that hides the page hides the action with it.
 */
export function quickActions(
  nav: readonly NavEntry[],
  opts: { staff: boolean; readOnly: boolean },
): QuickAction[] {
  if (!opts.staff) return [];
  const have = new Set(navLeaves(nav).map((l) => l.href));
  return QUICK_ACTION_DEFS.filter((a) => have.has(a.needs)).map((a) => ({
    ...a,
    blocked: a.readOnlyGated && opts.readOnly,
  }));
}

/**
 * Where an action goes. A create form opened from a list is `?action=new`; when the person already stands on that
 * list its own query state (page, search) is kept, because the target page consumes `action` and replaces the URL
 * with whatever remains.
 */
export function quickActionHref(action: Pick<QuickAction, "href" | "opensCreate">): string {
  if (!action.opensCreate) return action.href;
  const params =
    typeof window !== "undefined" && window.location.pathname === action.href
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  params.set("action", "new");
  return `${action.href}?${params.toString()}`;
}
