import {
  BarChart2,
  BarChart3,
  Building2,
  PackageCheck,
  ClipboardList,
  CreditCard,
  DollarSign,
  FileCheck,
  FileSpreadsheet,
  FileText,
  Layers,
  LayoutDashboard,
  MapPin,
  Megaphone,
  Package,
  Receipt,
  RotateCcw,
  ScanSearch,
  Settings,
  ShoppingCart,
  Truck,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import type { NavGroupId } from "@routeflow/types";
import { activeNavGroup, activeNavLeaf } from "./nav-index";

// ─── Nav types & structure ────────────────────────────────────────────────────

export type NavLeaf = { kind: "leaf"; label: string; href: string; icon: LucideIcon };
export type NavGroup = {
  kind: "group";
  /** Stable id the stored layout names (never the label, which can be renamed or translated). */
  id: NavGroupId | "pinned";
  label: string;
  icon: LucideIcon;
  children: NavLeaf[];
};
/** Placeholder row held at a gated entry's position while its addon/entitlement
 *  query is still resolving, so the rail never grows once the answer lands. */
export type NavSkeleton = {
  kind: "skeleton";
  key: string;
  /** The group id or leaf href this row stands in for, so `order` keeps its place while it loads. */
  holds?: string;
};
export type NavEntry = NavLeaf | NavGroup | NavSkeleton;

/** Full operator nav — all sections visible */
export const OPERATOR_NAV: NavEntry[] = [
  { kind: "leaf", label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  {
    kind: "group",
    id: "orders",
    label: "Orders",
    icon: ShoppingCart,
    children: [
      { kind: "leaf", label: "All Orders", href: "/orders", icon: ShoppingCart },
      { kind: "leaf", label: "Estimates", href: "/estimates", icon: FileCheck },
      { kind: "leaf", label: "Returns", href: "/returns", icon: RotateCcw },
    ],
  },
  {
    kind: "group",
    id: "dispatch",
    label: "Dispatch",
    icon: Truck,
    children: [
      { kind: "leaf", label: "Dispatch", href: "/dispatch", icon: LayoutDashboard },
      { kind: "leaf", label: "Routes", href: "/routes", icon: MapPin },
      { kind: "leaf", label: "Order delivery", href: "/deliveries", icon: Package },
      // Moved here from Finance (UX guide improvement 3). Without a Dispatch group buildOperatorNav
      // puts it at the end of Orders.
      { kind: "leaf", label: "Shipments", href: "/shipments", icon: Truck },
      { kind: "leaf", label: "Drivers", href: "/drivers", icon: Truck },
    ],
  },
  { kind: "leaf", label: "Customers", href: "/customers", icon: Users },
  {
    kind: "group",
    id: "warehouse",
    label: "Warehouse",
    icon: Package,
    children: [
      { kind: "leaf", label: "Inventory", href: "/inventory", icon: Layers },
      // Not plan-gated (never in PLAN_GATED_NAV): manual POs are core inventory, LITE keeps them.
      { kind: "leaf", label: "Purchase orders", href: "/purchase-orders", icon: PackageCheck },
      { kind: "leaf", label: "Products", href: "/products", icon: Package },
      { kind: "leaf", label: "Promotions", href: "/promotions", icon: Megaphone },
      { kind: "leaf", label: "Suppliers", href: "/suppliers", icon: Building2 },
      { kind: "leaf", label: "Supplier bills", href: "/vendor-bills", icon: ClipboardList },
      // Moved here from Finance (UX guide improvement 3); not plan-gated, so every plan keeps it.
      {
        kind: "leaf",
        label: "Supplier statements",
        href: "/finance/statements",
        icon: FileSpreadsheet,
      },
    ],
  },
  {
    kind: "group",
    id: "finance",
    label: "Finance",
    icon: Wallet,
    children: [
      {
        kind: "leaf",
        label: "Finance overview",
        href: "/finance/dashboard",
        icon: LayoutDashboard,
      },
      { kind: "leaf", label: "Invoices", href: "/invoices", icon: FileText },
      { kind: "leaf", label: "Payments", href: "/finance/payments", icon: CreditCard },
      {
        kind: "leaf",
        label: "Payment requests",
        href: "/finance/payment-requests",
        icon: DollarSign,
      },
      { kind: "leaf", label: "Credit notes", href: "/credit-notes", icon: Receipt },
    ],
  },
  // Reports and Analytics (app-wide: Revenue, Products & Inventory, Customers, Operations) share one
  // group (UX guide improvement 3). Product insights (SA-1087, as amended by UXG-R8) is NOT here: it is
  // INSIGHTS_LEAF below, which buildOperatorNav appends only when the viewer may use it, so the default menu
  // never offers it by accident.
  {
    kind: "group",
    id: "reports",
    label: "Reports & analytics",
    icon: BarChart3,
    children: [
      { kind: "leaf", label: "Reports", href: "/finance/reports", icon: BarChart3 },
      { kind: "leaf", label: "Analytics", href: "/analytics", icon: BarChart2 },
    ],
  },
  { kind: "leaf", label: "Settings", href: "/settings", icon: Settings },
];

/** The Product insights entry: the last child of Reports & analytics, added by buildOperatorNav when insightsAccess is true. */
export const INSIGHTS_LEAF: NavLeaf = {
  kind: "leaf",
  label: "Product insights",
  href: "/insights",
  icon: ScanSearch,
};

/** Customer nav — orders, invoices, returns and their own account only */
export const CUSTOMER_NAV: NavEntry[] = [
  { kind: "leaf", label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  {
    kind: "group",
    id: "orders",
    label: "Orders",
    icon: ShoppingCart,
    children: [
      { kind: "leaf", label: "My Orders", href: "/orders", icon: ShoppingCart },
      { kind: "leaf", label: "Returns", href: "/returns", icon: RotateCcw },
    ],
  },
  { kind: "leaf", label: "Invoices", href: "/invoices", icon: FileText },
  { kind: "leaf", label: "My account", href: "/settings", icon: Settings },
];

/**
 * Driver nav — routes and their own account only. PHASE 1a (web driver mode): "Today's
 * route" is the landing item, pointing at the DRIVER-only my-runs view — see
 * getNavForRole's filter below, which drops it (and "My Routes") together
 * when neither routes addon is enabled.
 */
export const DRIVER_NAV: NavEntry[] = [
  { kind: "leaf", label: "Today's route", href: "/routes/my-runs", icon: Truck },
  { kind: "leaf", label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { kind: "leaf", label: "My Routes", href: "/routes", icon: MapPin },
  { kind: "leaf", label: "My account", href: "/settings", icon: Settings },
];

/**
 * Which sidebar group starts expanded. The group holding the active route wins; on a first
 * load with no active group the Warehouse group opens so Purchase Orders is visible without
 * hunting (UX guide improvement 1 keeps it as the first-load default; groups the person opened are
 * remembered per user by useOpenNavGroups).
 */
export function defaultOpenGroup(nav: NavEntry[], pathname: string): string | null {
  const active = activeNavGroup(nav, pathname);
  if (active) return active.label;
  return nav.some((e) => e.kind === "group" && e.label === "Warehouse") ? "Warehouse" : null;
}

/** The sidebar label for the operator route `pathname` sits under (the one active-entry rule, see nav-index), so
 *  a lock card can name the feature the person actually clicked. */
export function navLabelForPath(rawPathname: string): string | null {
  return activeNavLeaf([...OPERATOR_NAV, INSIGHTS_LEAF], rawPathname)?.label ?? null;
}
