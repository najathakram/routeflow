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
  Settings,
  ShoppingCart,
  Truck,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

// ─── Nav types & structure ────────────────────────────────────────────────────

export type NavLeaf = { kind: "leaf"; label: string; href: string; icon: LucideIcon };
export type NavGroup = { kind: "group"; label: string; icon: LucideIcon; children: NavLeaf[] };
/** Placeholder row held at a gated entry's position while its addon/entitlement
 *  query is still resolving, so the rail never grows once the answer lands. */
export type NavSkeleton = { kind: "skeleton"; key: string };
export type NavEntry = NavLeaf | NavGroup | NavSkeleton;

/** Full operator nav — all sections visible */
export const OPERATOR_NAV: NavEntry[] = [
  { kind: "leaf", label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  {
    kind: "group",
    label: "Orders",
    icon: ShoppingCart,
    children: [
      { kind: "leaf", label: "All Orders", href: "/orders", icon: ShoppingCart },
      { kind: "leaf", label: "Returns", href: "/returns", icon: RotateCcw },
    ],
  },
  {
    kind: "group",
    label: "Dispatch",
    icon: Truck,
    children: [
      { kind: "leaf", label: "Overview", href: "/dispatch", icon: LayoutDashboard },
      { kind: "leaf", label: "Routes", href: "/routes", icon: MapPin },
      { kind: "leaf", label: "Order delivery", href: "/deliveries", icon: Package },
      { kind: "leaf", label: "Drivers", href: "/drivers", icon: Truck },
    ],
  },
  { kind: "leaf", label: "Customers", href: "/customers", icon: Users },
  {
    kind: "group",
    label: "Warehouse",
    icon: Package,
    children: [
      { kind: "leaf", label: "Inventory", href: "/inventory", icon: Layers },
      // Not plan-gated (never in PLAN_GATED_NAV): manual POs are core inventory, LITE keeps them.
      { kind: "leaf", label: "Purchase Orders", href: "/purchase-orders", icon: PackageCheck },
      { kind: "leaf", label: "Products", href: "/products", icon: Package },
      { kind: "leaf", label: "Promotions", href: "/promotions", icon: Megaphone },
      { kind: "leaf", label: "Suppliers", href: "/suppliers", icon: Building2 },
      { kind: "leaf", label: "Supplier Bills", href: "/vendor-bills", icon: ClipboardList },
    ],
  },
  {
    kind: "group",
    label: "Finance",
    icon: Wallet,
    children: [
      { kind: "leaf", label: "Overview", href: "/finance/dashboard", icon: LayoutDashboard },
      { kind: "leaf", label: "Invoices", href: "/invoices", icon: FileText },
      { kind: "leaf", label: "Shipments", href: "/shipments", icon: Truck },
      { kind: "leaf", label: "Estimates", href: "/estimates", icon: FileCheck },
      { kind: "leaf", label: "Credit Notes", href: "/credit-notes", icon: Receipt },
      { kind: "leaf", label: "Payments", href: "/finance/payments", icon: CreditCard },
      {
        kind: "leaf",
        label: "Payment Requests",
        href: "/finance/payment-requests",
        icon: DollarSign,
      },
      {
        kind: "leaf",
        label: "Supplier Statements",
        href: "/finance/statements",
        icon: FileSpreadsheet,
      },
      { kind: "leaf", label: "Reports", href: "/finance/reports", icon: BarChart3 },
    ],
  },
  // Analytics is app-wide (Revenue, Products & Inventory, Customers, Operations),
  // so it lives at top level rather than nested under Finance.
  { kind: "leaf", label: "Analytics", href: "/analytics", icon: BarChart2 },
  { kind: "leaf", label: "Settings", href: "/settings", icon: Settings },
];

/** Customer nav — orders, invoices, returns and their own account only */
export const CUSTOMER_NAV: NavEntry[] = [
  { kind: "leaf", label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  {
    kind: "group",
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
 * hunting. The nav is a single-open accordion, so this never grows the rail.
 */
export function defaultOpenGroup(nav: NavEntry[], pathname: string): string | null {
  const active = nav.find(
    (e): e is NavGroup => e.kind === "group" && e.children.some((c) => pathname.startsWith(c.href)),
  );
  if (active) return active.label;
  return nav.some((e) => e.kind === "group" && e.label === "Warehouse") ? "Warehouse" : null;
}

/** The sidebar label for the operator route `pathname` sits under (longest matching leaf href), so
 *  a lock card can name the feature the person actually clicked. */
export function navLabelForPath(pathname: string): string | null {
  let best: NavLeaf | null = null;
  const consider = (leaf: NavLeaf) => {
    const hit = pathname === leaf.href || pathname.startsWith(leaf.href + "/");
    if (hit && (!best || leaf.href.length > best.href.length)) best = leaf;
  };
  for (const e of OPERATOR_NAV) {
    if (e.kind === "leaf") consider(e);
    else if (e.kind === "group") e.children.forEach(consider);
  }
  return (best as NavLeaf | null)?.label ?? null;
}
