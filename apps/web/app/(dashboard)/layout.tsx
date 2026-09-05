"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  ShoppingCart,
  MapPin,
  Truck,
  Users,
  Package,
  Layers,
  Settings,
  Bell,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  ArrowLeft,
  LogOut,
  User as UserIcon,
  AlertTriangle,
  CheckCircle2,
  Trash2,
  FileText,
  BarChart2,
  Receipt,
  RotateCcw,
  FileCheck,
  FileSpreadsheet,
  Wallet,
  Building2,
  DollarSign,
  CreditCard,
  BarChart3,
  PieChart,
  ClipboardList,
  Megaphone,
  Search,
  Menu,
  X,
  Check,
  Languages,
  ShieldCheck,
  ShieldAlert,
  Handshake,
  BadgePercent,
  type LucideIcon,
} from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { cn, Avatar, ToastProvider } from "@routeflow/ui/web";
import { TenantLogo } from "@/components/TenantLogo";
import { PortalSwitchLink } from "@/components/PortalSwitchLink";
import { setLastPortalCookie } from "@/lib/presence-cookies";
import { CommandPalette, useCommandPalette } from "@/components/CommandPalette";
import { useAuth } from "@/lib/auth-context";
import {
  getImpersonation,
  exitImpersonation,
  subscribeImpersonation,
  type ImpersonationState,
} from "@/lib/impersonation";
import { PageTitleProvider, usePageTitle } from "@/lib/page-title-context";
import { useRealtimeUpdates } from "@/lib/hooks/useRealtimeUpdates";
import { useNotifications, type AppNotification } from "@/lib/hooks/useNotifications";
import { useExpiringAuthorizations, type ExpiringAuthorization } from "@/lib/api/authorizations";
import { usePendingPortalApprovals } from "@/lib/api/portal-approvals";
import { PwaInstallPrompt } from "@/components/PwaInstallPrompt";
import { DraftDock } from "@/components/DraftDock";
import { useHasAddon, useTenantAddons } from "@/lib/api/tobacco";
import { useRoutesAccess, useDeliveryAccess, SALES_AGENTS_ADDON } from "@/lib/api/addons";
import { useTrackedCategories } from "@/lib/api/tracked-categories";
import { useI18n, LOCALES, LOCALE_LABELS } from "@/lib/i18n";
import { useDriveMode } from "@/lib/drive-mode";

// ─── Nav types & structure ────────────────────────────────────────────────────

type NavLeaf = { kind: "leaf"; label: string; href: string; icon: LucideIcon };
type NavGroup = { kind: "group"; label: string; icon: LucideIcon; children: NavLeaf[] };
/** Placeholder row held at a gated entry's position while its addon/entitlement
 *  query is still resolving, so the rail never grows once the answer lands. */
type NavSkeleton = { kind: "skeleton"; key: string };
type NavEntry = NavLeaf | NavGroup | NavSkeleton;

/** Full operator nav — all sections visible */
const OPERATOR_NAV: NavEntry[] = [
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
      { kind: "leaf", label: "Products", href: "/products", icon: Package },
      { kind: "leaf", label: "Promotions", href: "/promotions", icon: Megaphone },
      { kind: "leaf", label: "Suppliers", href: "/suppliers", icon: Building2 },
      { kind: "leaf", label: "Bills & Purchasing", href: "/vendor-bills", icon: ClipboardList },
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

/** Customer nav — orders, invoices, returns, settings only */
const CUSTOMER_NAV: NavEntry[] = [
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
  { kind: "leaf", label: "Settings", href: "/settings", icon: Settings },
];

/** Driver nav — routes and settings only */
const DRIVER_NAV: NavEntry[] = [
  { kind: "leaf", label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { kind: "leaf", label: "My Routes", href: "/routes", icon: MapPin },
  { kind: "leaf", label: "Settings", href: "/settings", icon: Settings },
];

function getNavForRole(
  role: string | undefined,
  canActAsDriver: boolean | undefined,
  access: { routesAccess: boolean; deliveryAccess: boolean },
): NavEntry[] {
  const { routesAccess, deliveryAccess } = access;
  if (role === "CUSTOMER") return CUSTOMER_NAV;
  if (role === "DRIVER") {
    // Drivers run both recurring routes and ad-hoc delivery trips, so "My
    // Routes" needs either surface unlocked — not just recurring routes.
    if (!(routesAccess || deliveryAccess))
      return DRIVER_NAV.filter((e) => e.kind !== "leaf" || e.href !== "/routes");
    return DRIVER_NAV;
  }

  // Tenants without either addon never see the Dispatch group — it's gated
  // on having at least one of the two features.
  const showDispatchGroup = routesAccess || deliveryAccess;
  let baseNav = OPERATOR_NAV.filter(
    (entry) => !(entry.kind === "group" && entry.label === "Dispatch" && !showDispatchGroup),
  ).map((entry): NavEntry => {
    if (entry.kind !== "group" || entry.label !== "Dispatch") return entry;
    // Inside a visible Dispatch group, the routes/delivery leaves are each
    // gated on their own feature; Overview and Drivers are shared by both
    // and always render once the group itself is showing.
    return {
      ...entry,
      children: entry.children.filter((c) => {
        if (c.href === "/routes") return routesAccess;
        if (c.href === "/deliveries") return deliveryAccess;
        return true;
      }),
    };
  });

  // Operators who can also act as drivers get "My Routes" inside the
  // Dispatch group instead of as a stand-alone top-level item.
  if (canActAsDriver && showDispatchGroup) {
    baseNav = baseNav.map((entry): NavEntry => {
      if (entry.kind === "group" && entry.label === "Dispatch") {
        const alreadyHasMyRoutes = entry.children.some((c) => c.href === "/routes/my-runs");
        if (alreadyHasMyRoutes) return entry;
        return {
          ...entry,
          children: [
            ...entry.children,
            { kind: "leaf", label: "My Routes", href: "/routes/my-runs", icon: MapPin },
          ],
        };
      }
      return entry;
    });
  }

  return baseNav; // OPERATOR, SUPER_ADMIN, TENANT_ADMIN, unknown
}

// ─── Role-based route guard ───────────────────────────────────────────────────

/** Paths that CUSTOMER users may access (prefix-matched) */
const CUSTOMER_ALLOWED: string[] = ["/dashboard", "/orders", "/returns", "/invoices", "/settings"];
/** Paths that DRIVER users may access (prefix-matched) */
const DRIVER_ALLOWED: string[] = ["/dashboard", "/routes", "/settings"];
/**
 * In-development surfaces gated per-feature addon (owner decision 2026-08-25:
 * recurring routes and ad-hoc order delivery are separate addons; owner
 * decision 2026-08-28: `devMode` no longer unlocks either one client-side).
 * `/drivers` is shared by both features ("either").
 */
const GATED_PREFIXES: { prefix: string; need: "routes" | "delivery" | "either" }[] = [
  { prefix: "/dispatch", need: "either" },
  { prefix: "/routes", need: "routes" },
  { prefix: "/deliveries", need: "delivery" },
  { prefix: "/drivers", need: "either" },
];

function isPathAllowed(pathname: string, allowed: string[]): boolean {
  return allowed.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

/**
 * The `/routes` paths that are recurring-routes surfaces in their own right.
 * Everything else under `/routes` is a single run/template/my-runs detail page
 * shared by BOTH features: an ad-hoc delivery has no detail page of its own —
 * a dispatched one opens its run at `/routes/:id` (where the builder also lands
 * after a successful dispatch) and a draft opens the template it was built as
 * at `/routes/templates/:id`. Gating those on "routes" would bounce a
 * delivery-only tenant to /dashboard from every delivery it opens.
 */
const RECURRING_ROUTES_PATHS = new Set(["/routes", "/routes/create"]);

/**
 * Find the GATED_PREFIXES entry matching `pathname`, if any. The legacy
 * `/routes/trips*` pages are redirect stubs to `/deliveries`/`/deliveries/new`
 * — they must NOT be bounced by the `/routes` gate, or a delivery-only tenant
 * deep-linking there would land on /dashboard before the stub ever gets to
 * redirect it to the (correctly gated) /deliveries surface.
 *
 * `role` matters for `/routes` itself: a DRIVER's whole nav is "My Routes" →
 * `/routes`, shown whenever EITHER feature is unlocked (drivers run ad-hoc
 * deliveries too), so for that role the landing page must be "either" as well
 * or the only link a delivery-only tenant's driver has bounces to /dashboard.
 */
function matchGatedPrefix(
  pathname: string,
  role?: string,
): { prefix: string; need: "routes" | "delivery" | "either" } | null {
  for (const gated of GATED_PREFIXES) {
    if (pathname !== gated.prefix && !pathname.startsWith(gated.prefix + "/")) continue;
    if (gated.prefix === "/routes") {
      if (pathname === "/routes/trips" || pathname.startsWith("/routes/trips/")) continue;
      if (role === "DRIVER" || !RECURRING_ROUTES_PATHS.has(pathname))
        return { ...gated, need: "either" };
    }
    return gated;
  }
  return null;
}

function RouteGuard({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const { enabled: routesAccess, resolved: routesResolved } = useRoutesAccess();
  const { enabled: deliveryAccess, resolved: deliveryResolved } = useDeliveryAccess();

  React.useEffect(() => {
    const role = user?.role;
    if (!role) return;
    let allowed: string[] | null = null;
    if (role === "CUSTOMER") allowed = CUSTOMER_ALLOWED;
    if (role === "DRIVER") allowed = DRIVER_ALLOWED;
    if (allowed && !isPathAllowed(pathname, allowed)) {
      router.replace("/dashboard");
      return;
    }
    // Tenants without the relevant addon can't deep-link into
    // dispatch/routes/deliveries/drivers either — gated per-feature.
    const gate = matchGatedPrefix(pathname, role);
    if (!gate) return;
    // Gating on `resolved` (not just "not loading") is mandatory: it fails OPEN
    // while the addons query is in flight AND when it errored, so a tenant that
    // actually has access is never bounced on an unknown answer.
    const resolved =
      gate.need === "routes"
        ? routesResolved
        : gate.need === "delivery"
          ? deliveryResolved
          : routesResolved || deliveryResolved;
    if (!resolved) return;
    const allowedByGate =
      gate.need === "routes"
        ? routesAccess
        : gate.need === "delivery"
          ? deliveryAccess
          : routesAccess || deliveryAccess;
    if (!allowedByGate) {
      router.replace("/dashboard");
    }
  }, [
    user?.role,
    pathname,
    router,
    routesAccess,
    routesResolved,
    deliveryAccess,
    deliveryResolved,
  ]);

  return <>{children}</>;
}

// ─── Auth guard ───────────────────────────────────────────────────────────────

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading, user } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      router.push("/login");
      return;
    }
    if (user?.forcePasswordChange) {
      router.push("/change-password");
      return;
    }
    // "/" opens the portal used last when both a buyer and an operator session
    // are live (lib/portal-routing.ts) — record that this one rendered.
    setLastPortalCookie("op");
  }, [isAuthenticated, isLoading, user, router]);

  if (isLoading) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }
  if (!isAuthenticated || user?.forcePasswordChange) return null;
  return <RouteGuard>{children}</RouteGuard>;
}

// ─── Nav link ─────────────────────────────────────────────────────────────────

function NavLink({
  item,
  collapsed,
  active,
  onNavigate,
}: {
  item: NavLeaf;
  collapsed: boolean;
  active: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      title={collapsed ? item.label : undefined}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-[7px] px-2.5 py-2 text-[13px] font-medium transition-colors",
        collapsed && "justify-center",
        active
          ? "bg-white/10 text-white shadow-[inset_2.5px_0_0_theme(colors.brand.300)]"
          : "text-white/70 hover:bg-white/[0.06] hover:text-white",
      )}
    >
      <Icon
        className={cn("h-[18px] w-[18px] shrink-0", active ? "text-brand-300" : "opacity-75")}
      />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );
}

// ─── Nav group section ────────────────────────────────────────────────────────

/**
 * When a group has sibling children whose hrefs prefix one another (e.g.
 * "/deliveries" and "/deliveries/new"), a plain `pathname.startsWith(href)`
 * check lights up every ancestor, not just the actual current page. Return
 * the single longest-matching child href (or null) so exactly one leaf highlights.
 */
function longestMatchingChildHref(children: NavLeaf[], pathname: string): string | null {
  let best: string | null = null;
  for (const child of children) {
    const matches = pathname === child.href || pathname.startsWith(child.href + "/");
    if (matches && (best === null || child.href.length > best.length)) {
      best = child.href;
    }
  }
  return best;
}

function NavGroupSection({
  group,
  collapsed,
  pathname,
  open,
  onToggle,
  onNavigate,
}: {
  group: NavGroup;
  collapsed: boolean;
  pathname: string;
  /** Whether the parent accordion currently has this group expanded. */
  open: boolean;
  /** Ask the parent to toggle this group (single-open accordion). */
  onToggle: (label: string) => void;
  onNavigate?: () => void;
}) {
  const activeChildHref = longestMatchingChildHref(group.children, pathname);
  const isAnyChildActive = activeChildHref !== null;
  // The group holding the active route is always shown expanded so the current
  // page is never hidden inside a collapsed group.
  const expanded = open || isAnyChildActive;

  const Icon = group.icon;

  // Collapsed rail: render each child as a flat icon-only link
  if (collapsed) {
    return (
      <>
        {group.children.map((child) => (
          <li key={child.href}>
            <NavLink
              item={child}
              collapsed={true}
              active={child.href === activeChildHref}
              onNavigate={onNavigate}
            />
          </li>
        ))}
      </>
    );
  }

  // Expanded: collapsible group header + indented children
  return (
    <li>
      <button
        onClick={() => onToggle(group.label)}
        aria-expanded={expanded}
        className={cn(
          "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-xs font-semibold transition-colors",
          // /70 (5.28:1) clears WCAG AA; the old /40 inactive label was 3.23:1.
          isAnyChildActive ? "text-white" : "text-white/70 hover:text-white",
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-left">{group.label}</span>
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 transition-transform duration-150",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded && (
        <ul className="mt-0.5 flex flex-col gap-0.5 pl-3">
          {group.children.map((child) => (
            <li key={child.href}>
              <NavLink
                item={child}
                collapsed={false}
                active={child.href === activeChildHref}
                onNavigate={onNavigate}
              />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

// ─── Sidebar nav list (shared by desktop rail + mobile drawer) ─────────────────

function SidebarNav({
  navStructure,
  collapsed,
  pathname,
  onNavigate,
}: {
  navStructure: NavEntry[];
  collapsed: boolean;
  pathname: string;
  onNavigate?: () => void;
}) {
  // Single-open accordion: at most one group expanded at a time, so the nav
  // never overflows when every group is opened. The group containing the
  // active route stays open regardless.
  const activeGroupLabel =
    navStructure.find(
      (e): e is NavGroup =>
        e.kind === "group" && e.children.some((c) => pathname.startsWith(c.href)),
    )?.label ?? null;
  const [openGroup, setOpenGroup] = React.useState<string | null>(activeGroupLabel);

  React.useEffect(() => {
    if (activeGroupLabel) setOpenGroup(activeGroupLabel);
  }, [activeGroupLabel]);

  const toggleGroup = (label: string) => setOpenGroup((cur) => (cur === label ? null : label));

  return (
    <ul className="flex flex-col gap-0.5">
      {navStructure.map((entry) =>
        entry.kind === "skeleton" ? (
          // Held at a gated entry's position while its addon/entitlement query
          // resolves — same row height/padding as a group header, so nothing
          // shifts once the real group or leaf replaces it.
          <li key={entry.key} aria-hidden="true">
            <div
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2",
                collapsed && "justify-center px-0",
              )}
            >
              <div className="skeleton h-4 w-4 shrink-0 rounded" />
              {!collapsed && <div className="skeleton h-3 w-24 rounded-full" />}
            </div>
          </li>
        ) : entry.kind === "leaf" ? (
          <li key={entry.href}>
            <NavLink
              item={entry}
              collapsed={collapsed}
              active={
                entry.href === "/dashboard"
                  ? pathname === "/dashboard"
                  : pathname.startsWith(entry.href)
              }
              onNavigate={onNavigate}
            />
          </li>
        ) : (
          <NavGroupSection
            key={entry.label}
            group={entry}
            collapsed={collapsed}
            pathname={pathname}
            open={openGroup === entry.label}
            onToggle={toggleGroup}
            onNavigate={onNavigate}
          />
        ),
      )}
    </ul>
  );
}

// ─── Notification helpers ─────────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function NotificationIcon({ type }: { type: AppNotification["type"] }) {
  if (type === "urgent")
    return (
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-danger-bg">
        <AlertTriangle className="h-4 w-4 text-danger" />
      </span>
    );
  if (type === "route")
    return (
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-success-bg">
        <CheckCircle2 className="h-4 w-4 text-success" />
      </span>
    );
  if (type === "driver")
    return (
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50">
        <Truck className="h-4 w-4 text-brand-500" />
      </span>
    );
  if (type === "buyer")
    return (
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50">
        <Users className="h-4 w-4 text-brand-500" />
      </span>
    );
  // stock
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warning-bg">
      <Package className="h-4 w-4 text-warning" />
    </span>
  );
}

// ─── Header ───────────────────────────────────────────────────────────────────

function expiryLabel(a: ExpiringAuthorization): string {
  if (a.expired) return "Expired";
  if (a.bucket === 1) return "Expires in ~1 day";
  if (a.bucket) return `Expires in ~${a.bucket} days`;
  return "Expiring soon";
}

function Header({
  onOpenPalette,
  onOpenMobileNav,
}: {
  onOpenPalette: () => void;
  onOpenMobileNav: () => void;
}) {
  const { title } = usePageTitle();
  const { user, logout } = useAuth();
  const { locale, setLocale, t } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const { notifications, unreadCount, markAllRead, clear } = useNotifications();
  const { data: expiring = [] } = useExpiringAuthorizations();
  // Buyer-connect requests whose sign-in email didn't match the customer
  // record — pinned in the bell until the seller approves or declines
  // (server-derived, so it's immune to mark-all-read/clear/localStorage loss).
  const { data: pendingApprovals = [] } = usePendingPortalApprovals();
  const bellCount = unreadCount + expiring.length + pendingApprovals.length;
  const { driveMode, setDriveMode } = useDriveMode();
  // Drive mode is a recurring-routes affordance ("My Routes"), so it's gated
  // on routesAccess (not delivery access).
  const { enabled: routesAccess } = useRoutesAccess();

  // B138: mirror ImpersonationBanner's read so the avatar menu never offers
  // "Sign out" while impersonation state exists (expired included — an expired
  // impersonation plus a /auth/logout POST races api-client's auto-exit).
  const [imp, setImp] = React.useState<ImpersonationState | null>(null);
  React.useEffect(() => {
    const read = () => setImp(getImpersonation());
    read();
    return subscribeImpersonation(read);
  }, []);
  React.useEffect(() => {
    setImp(getImpersonation());
  }, [pathname]);

  // Show a back button only on sub-pages (e.g. /routes/123, /customers/456)
  const isSubPage = pathname.split("/").filter(Boolean).length > 1;

  return (
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-surface-border bg-white px-4">
      {/* Mobile nav trigger — opens the sidebar drawer below the lg breakpoint */}
      <button
        onClick={onOpenMobileNav}
        className="rounded-lg p-2 text-navy/70 transition-colors hover:bg-surface-raised hover:text-navy lg:hidden"
        aria-label="Open navigation menu"
      >
        <Menu className="h-5 w-5" />
      </button>

      {isSubPage ? (
        <button
          onClick={() => router.back()}
          className="rounded-lg p-2 text-navy/70 transition-colors hover:bg-surface-raised hover:text-navy"
          aria-label="Go back"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
      ) : (
        <div className="w-9 shrink-0" />
      )}

      <div className="flex flex-1 items-center gap-2 min-w-0">
        {title && <h1 className="text-base font-semibold text-navy truncate">{title}</h1>}
        {/* Drive-mode indicator + one-tap Exit (pos-cost-roles-spec §4) — lets the
            operator leave the field layout without hunting through the avatar menu. */}
        {routesAccess && driveMode && (
          <button
            onClick={() => setDriveMode(false)}
            className="ml-2 inline-flex shrink-0 items-center gap-1.5 rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-brand-600 transition-colors hover:bg-brand-100"
            title="Exit drive mode"
          >
            <Truck className="h-3.5 w-3.5" />
            Drive mode
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-2">
        {/* Command palette trigger — Ledger search pill */}
        <button
          onClick={onOpenPalette}
          className="hidden h-[34px] w-[280px] items-center gap-2.5 rounded-full border border-line-strong bg-surface-raised px-3 text-[13px] text-ink-400 transition-colors hover:border-brand-300 hover:text-ink-500 md:flex"
          aria-label="Open command palette"
        >
          <Search className="h-[15px] w-[15px]" />
          <span>{t("topbar.searchPlaceholder")}</span>
          <kbd className="ml-auto inline-flex h-5 items-center rounded-[5px] border border-line-strong bg-paper px-1.5 font-mono text-[11px] text-ink-500">
            ⌘K
          </kbd>
        </button>
        <button
          onClick={onOpenPalette}
          className="flex items-center justify-center rounded-lg p-2 text-navy/70 transition-colors hover:bg-surface-raised hover:text-navy md:hidden"
          aria-label="Open command palette"
        >
          <Search className="h-5 w-5" />
        </button>

        {/* Notification bell */}
        <DropdownMenu.Root
          onOpenChange={(open) => {
            if (open) markAllRead();
          }}
        >
          <DropdownMenu.Trigger asChild>
            <button
              className="relative rounded-lg p-2 text-navy/70 transition-colors hover:bg-surface-raised hover:text-navy"
              aria-label={bellCount > 0 ? `${bellCount} notifications` : "Notifications"}
            >
              <Bell className="h-5 w-5" />
              {bellCount > 0 && (
                <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-danger text-[10px] font-bold leading-none text-white">
                  {bellCount > 9 ? "9+" : bellCount}
                </span>
              )}
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={8}
              className="z-50 w-80 rounded-lg border border-surface-border bg-white shadow-dropdown animate-in fade-in-0 zoom-in-95"
            >
              {/* Panel header */}
              <div className="flex items-center justify-between border-b border-surface-border px-4 py-3">
                <p className="text-sm font-semibold text-navy">Notifications</p>
                {notifications.length > 0 && (
                  <button
                    onClick={clear}
                    className="flex items-center gap-1 text-xs text-navy/70 hover:text-danger transition-colors"
                    title="Clear all"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Clear all
                  </button>
                )}
              </div>

              {/* List */}
              <div className="max-h-[60vh] overflow-y-auto">
                {/* Buyer-connect approval requests — pinned above everything else,
                    server-derived so it stays until the seller acts (not cleared
                    by "mark all read"/"clear", not lost on localStorage clear).
                    Clicking a row goes to the customer page where Approve/Decline
                    live (lib/api/portal-approvals.ts). */}
                {pendingApprovals.length > 0 && (
                  <div className="border-b border-surface-border">
                    <p className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-navy/40">
                      Action needed
                    </p>
                    <ul className="divide-y divide-surface-border">
                      {pendingApprovals.map((a) => (
                        <DropdownMenu.Item
                          key={a.customerId}
                          asChild
                          onSelect={() => router.push(`/customers/${a.customerId}`)}
                        >
                          <li className="flex cursor-pointer items-start gap-3 bg-brand-50/40 px-4 py-3 outline-none transition-colors hover:bg-brand-50">
                            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-600">
                              <Users className="h-4 w-4" />
                            </span>
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-navy">
                                {a.buyerName} wants to connect
                              </p>
                              <p className="mt-0.5 truncate text-xs text-navy/70 leading-snug">
                                {a.buyerEmail} → {a.customerName}
                              </p>
                            </div>
                          </li>
                        </DropdownMenu.Item>
                      ))}
                    </ul>
                  </div>
                )}
                {/* W7b: license expiry section (30/7/1 + expired) */}
                {expiring.length > 0 && (
                  <div className="border-b border-surface-border">
                    <p className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-navy/40">
                      Licenses
                    </p>
                    <ul className="divide-y divide-surface-border">
                      {expiring.map((a) => (
                        <li
                          key={a.id}
                          className={cn(
                            "flex items-start gap-3 px-4 py-3",
                            a.expired ? "bg-danger/5" : "bg-amber-50/50",
                          )}
                        >
                          <span
                            className={cn(
                              "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                              a.expired
                                ? "bg-danger/10 text-danger"
                                : "bg-amber-100 text-amber-700",
                            )}
                          >
                            <ShieldAlert className="h-4 w-4" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-navy">
                              {a.categoryName} — {expiryLabel(a)}
                            </p>
                            <p className="mt-0.5 text-xs text-navy/70 leading-snug">
                              {a.customerName}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {notifications.length === 0 &&
                expiring.length === 0 &&
                pendingApprovals.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-10 text-center">
                    <Bell className="h-8 w-8 text-navy/20" />
                    <p className="text-sm text-navy/70">No notifications yet</p>
                    <p className="text-xs text-navy/30">
                      Order, delivery, and account alerts will appear here.
                    </p>
                  </div>
                ) : notifications.length > 0 ? (
                  <ul className="divide-y divide-surface-border">
                    {notifications.map((n) => (
                      <li
                        key={n.id}
                        className={cn(
                          "flex items-start gap-3 px-4 py-3 transition-colors",
                          !n.read && "bg-brand-50/40",
                        )}
                      >
                        <NotificationIcon type={n.type} />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-navy">{n.title}</p>
                          <p className="mt-0.5 text-xs text-navy/70 leading-snug">
                            {n.description}
                          </p>
                          <p className="mt-1 text-[10px] text-navy/30">{timeAgo(n.timestamp)}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        {/* Avatar dropdown */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-raised"
              aria-label="Open user menu"
            >
              <Avatar name={user?.username ?? ""} size="sm" />
              <span className="hidden text-sm font-medium text-navy sm:block">
                {user?.username}
              </span>
              <ChevronDown className="hidden h-4 w-4 text-navy/70 sm:block" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={8}
              className="z-50 min-w-[160px] rounded-lg border border-surface-border bg-white py-1 shadow-dropdown animate-in fade-in-0 zoom-in-95"
            >
              <DropdownMenu.Item
                className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-navy outline-none hover:bg-surface-raised"
                onSelect={() => router.push("/settings")}
              >
                <UserIcon className="h-4 w-4 text-navy/70" />
                {t("menu.profile")}
              </DropdownMenu.Item>
              {/* Drive mode — one tap toggle to the field run layout for admins/operators
                  who can act as a driver (canActAsDriver; capability enforced server-side
                  by RolesGuard). Turning it on swaps layout only — no logout, permission
                  change, or draft loss — and jumps to My Routes; turning it off (here or
                  via the topbar Exit affordance) just restores the normal layout in place.
                  pos-cost-roles-spec §4. */}
              {(user as { canActAsDriver?: boolean })?.canActAsDriver && routesAccess && (
                <DropdownMenu.Item
                  className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-navy outline-none hover:bg-surface-raised"
                  onSelect={() => {
                    const next = !driveMode;
                    setDriveMode(next);
                    if (next) router.push("/routes/my-runs");
                  }}
                >
                  <Truck className="h-4 w-4 text-navy/70" />
                  <span className="flex-1">Drive mode</span>
                  {driveMode && <Check className="h-4 w-4 text-accent-deep" />}
                </DropdownMenu.Item>
              )}
              {/* Buyer ⇄ seller portal switch — the two portals are separate
                  sessions in one browser; this is the door between them
                  (components/PortalSwitchLink.tsx). */}
              <DropdownMenu.Item asChild>
                <PortalSwitchLink
                  to="buyer"
                  className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-navy outline-none hover:bg-surface-raised"
                  iconClassName="h-4 w-4 text-navy/70"
                  labels={{
                    switch: t("menu.switchToBuyerPortal"),
                    signIn: t("menu.buyerPortalSignIn"),
                  }}
                />
              </DropdownMenu.Item>
              {/* Language / Idioma — per-user locale (unified/ux-standards.html) */}
              <DropdownMenu.Separator className="my-1 border-t border-surface-border" />
              <div className="flex items-center gap-2 px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-navy/40">
                <Languages className="h-3.5 w-3.5" />
                {t("menu.language")}
              </div>
              {LOCALES.map((l) => (
                <DropdownMenu.Item
                  key={l}
                  className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm text-navy outline-none hover:bg-surface-raised"
                  onSelect={() => setLocale(l)}
                >
                  {LOCALE_LABELS[l]}
                  {locale === l && <Check className="h-4 w-4 text-accent-deep" />}
                </DropdownMenu.Item>
              ))}
              <DropdownMenu.Separator className="my-1 border-t border-surface-border" />
              {imp ? (
                <DropdownMenu.Item
                  className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-danger outline-none hover:bg-danger-bg"
                  onSelect={() => exitImpersonation()}
                >
                  <LogOut className="h-4 w-4" />
                  {t(imp.expired ? "menu.returnToAdmin" : "menu.exitImpersonation")}
                </DropdownMenu.Item>
              ) : (
                <DropdownMenu.Item
                  className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-danger outline-none hover:bg-danger-bg"
                  onSelect={() => void logout()}
                >
                  <LogOut className="h-4 w-4" />
                  {t("menu.signOut")}
                </DropdownMenu.Item>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
  );
}

// ─── Impersonation banner ─────────────────────────────────────────────────────

function ImpersonationBanner() {
  const pathname = usePathname();
  const [imp, setImp] = React.useState<ImpersonationState | null>(null);

  React.useEffect(() => {
    const read = () => setImp(getImpersonation());
    read();
    return subscribeImpersonation(read);
  }, []);
  React.useEffect(() => {
    setImp(getImpersonation());
  }, [pathname]);

  if (!imp) return null;

  return (
    <div className="flex items-center justify-between bg-red-600 px-4 py-2 text-sm text-white">
      <span>
        {imp.expired ? (
          <>
            ⚠️ Impersonation of <strong>{imp.slug}</strong> has expired
          </>
        ) : (
          <>
            ⚠️ Impersonating <strong>{imp.slug}</strong> — acting as{" "}
            {imp.username ?? "Tenant Admin"}
          </>
        )}
      </span>
      <button
        onClick={exitImpersonation}
        className="rounded bg-white/20 px-3 py-1 text-xs font-semibold hover:bg-white/30 transition-colors"
      >
        {imp.expired ? "Return to admin" : "Exit impersonation"}
      </button>
    </div>
  );
}

// ─── Dashboard shell ──────────────────────────────────────────────────────────

function DashboardShell({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { open: paletteOpen, setOpen: setPaletteOpen } = useCommandPalette();
  const hasSalesAgents = useHasAddon(SALES_AGENTS_ADDON);
  // routesAccess/deliveryAccess/hasSalesAgents all read the same underlying
  // tenant-addons query (react-query dedupes on queryKey), so this one
  // `isLoading` is that single shared fetch's in-flight state — used below
  // to hold a skeleton for every addon-gated nav entry (Dispatch, Sales Agents)
  // until the real answer is in, instead of the group just popping into
  // existence. Deliberately NOT `!resolved` (= `!isSuccess`): useTenantAddons
  // is `retry: false`, so one 5xx would leave `resolved` false forever and
  // strand the placeholders as permanent shimmer. `isLoading` settles either
  // way, and a failed fetch degrades to the pre-existing "gate stays hidden".
  const { isLoading: addonsLoading } = useTenantAddons();
  const { enabled: routesAccess } = useRoutesAccess();
  const { enabled: deliveryAccess } = useDeliveryAccess();
  // Only OPERATOR/TENANT_ADMIN see regulated nav; skip the fetch for CUSTOMER/DRIVER.
  const isStaff = user?.role !== "CUSTOMER" && user?.role !== "DRIVER";
  const { data: regulatedSections, isLoading: regulatedLoading } = useTrackedCategories(
    { active: true },
    { enabled: isStaff },
  );
  const navStructure = React.useMemo(() => {
    const nav = getNavForRole(user?.role, (user as any)?.canActAsDriver, {
      routesAccess,
      deliveryAccess,
    });

    // CUSTOMER/DRIVER nav has neither a Dispatch nor a Sales Agents entry, so
    // the skeleton splicing below only applies to the operator-ish (isStaff)
    // branch. While the shared addons fetch is in flight, `enabled` defaults
    // false and getNavForRole already omitted Dispatch — hold a skeleton at
    // its position (right before Customers) so the rail doesn't grow once the
    // real answer resolves.
    let base = nav;
    if (isStaff && addonsLoading) {
      const idx = base.findIndex((e) => e.kind === "leaf" && e.href === "/customers");
      const skeleton: NavEntry = { kind: "skeleton", key: "dispatch-skeleton" };
      base =
        idx === -1 ? [...base, skeleton] : [...base.slice(0, idx), skeleton, ...base.slice(idx)];
    }

    if (!isStaff) return base;

    // "Regulated Items" nav group — one child per active regulated section, each
    // opening that section's dashboard. Shown whenever the tenant has ≥1 section
    // (an empty group is never spliced); a skeleton holds its place while the
    // tracked-categories fetch is still in flight.
    const inject: NavEntry[] = [];
    const sections = regulatedSections ?? [];
    if (regulatedLoading) {
      inject.push({ kind: "skeleton", key: "regulated-skeleton" });
    } else if (sections.length > 0) {
      inject.push({
        kind: "group",
        label: "Regulated Items",
        icon: ShieldCheck,
        children: sections.map((s) => ({
          kind: "leaf" as const,
          label: s.name,
          href: `/compliance/${s.id}`,
          icon: ShieldCheck,
        })),
      });
    }

    if (addonsLoading) {
      // Sales Agents (+ its Commissions child inside Finance) pops in off the
      // same addons fetch as Dispatch — hold a skeleton at the leaf's position
      // (right after Customers) meanwhile.
      const idx = base.findIndex((e) => e.kind === "leaf" && e.href === "/customers");
      const skeleton: NavEntry = { kind: "skeleton", key: "sales-agents-skeleton" };
      base =
        idx === -1
          ? [...base, skeleton]
          : [...base.slice(0, idx + 1), skeleton, ...base.slice(idx + 1)];
    } else if (hasSalesAgents) {
      // "Sales Agents" as a top-level leaf right after Customers; "Commissions"
      // inside the Finance group after Supplier Statements. Same splice style as
      // the canActAsDriver Dispatch rewrite above — never mutate OPERATOR_NAV.
      base = base.flatMap((entry): NavEntry[] => {
        if (entry.kind === "leaf" && entry.href === "/customers") {
          return [
            entry,
            { kind: "leaf", label: "Sales Agents", href: "/sales-agents", icon: Handshake },
          ];
        }
        if (entry.kind === "group" && entry.label === "Finance") {
          const idx = entry.children.findIndex((c) => c.href === "/finance/statements");
          const child: NavLeaf = {
            kind: "leaf",
            label: "Commissions",
            href: "/finance/commissions",
            icon: BadgePercent,
          };
          const children =
            idx === -1
              ? [...entry.children, child]
              : [...entry.children.slice(0, idx + 1), child, ...entry.children.slice(idx + 1)];
          return [{ ...entry, children }];
        }
        return [entry];
      });
    }

    if (inject.length === 0) return base;

    const idx = base.findIndex((e) => e.kind === "leaf" && e.href === "/analytics");
    return idx === -1
      ? [...base, ...inject]
      : [...base.slice(0, idx + 1), ...inject, ...base.slice(idx + 1)];
  }, [
    user,
    isStaff,
    hasSalesAgents,
    regulatedSections,
    regulatedLoading,
    routesAccess,
    deliveryAccess,
    addonsLoading,
  ]);
  const [collapsed, setCollapsed] = React.useState(() => {
    if (typeof window !== "undefined") {
      // Auto-collapse on small screens, otherwise respect saved preference
      if (window.innerWidth < 768) return true;
      return localStorage.getItem("rf-sidebar-collapsed") === "true";
    }
    return false;
  });
  const pathname = usePathname();
  const toggle = () =>
    setCollapsed((v) => {
      const next = !v;
      localStorage.setItem("rf-sidebar-collapsed", String(next));
      return next;
    });

  // Below lg the static rail is hidden and replaced by an off-canvas drawer.
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);

  // Close the mobile drawer whenever the route changes.
  React.useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  // Esc closes the mobile drawer; lock body scroll while it is open.
  React.useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [mobileNavOpen]);

  useRealtimeUpdates();

  const shellRouter = useRouter();

  // ── Keyboard shortcuts ──
  const [shortcutHelpOpen, setShortcutHelpOpen] = React.useState(false);
  React.useEffect(() => {
    let sequence = "";
    let seqTimer: ReturnType<typeof setTimeout> | null = null;

    const handler = (e: KeyboardEvent) => {
      // Skip if user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (e.target as HTMLElement)?.isContentEditable
      )
        return;
      // Skip if modifier keys held (except shift for ?)
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "?") {
        setShortcutHelpOpen((v) => !v);
        return;
      }

      // Sequence shortcuts (g + letter)
      sequence += e.key.toLowerCase();
      if (seqTimer) clearTimeout(seqTimer);
      seqTimer = setTimeout(() => {
        sequence = "";
      }, 800);

      if (sequence === "go") {
        shellRouter.push("/orders");
        sequence = "";
      } else if (sequence === "gr") {
        if (routesAccess) shellRouter.push("/routes");
        sequence = "";
      } else if (sequence === "gd") {
        if (routesAccess) shellRouter.push("/drivers");
        sequence = "";
      } else if (sequence === "gc") {
        shellRouter.push("/customers");
        sequence = "";
      } else if (sequence === "gi") {
        shellRouter.push("/invoices");
        sequence = "";
      } else if (sequence === "gf") {
        shellRouter.push("/finance/dashboard");
        sequence = "";
      } else if (sequence === "gs") {
        shellRouter.push("/settings");
        sequence = "";
      } else if (sequence === "gh") {
        shellRouter.push("/dashboard");
        sequence = "";
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [shellRouter, routesAccess]);

  const SHORTCUTS = React.useMemo(
    () =>
      [
        { keys: ["g", "h"], label: "Go to Dashboard" },
        { keys: ["g", "o"], label: "Go to Orders" },
        { keys: ["g", "r"], label: "Go to Routes" },
        { keys: ["g", "d"], label: "Go to Drivers" },
        { keys: ["g", "c"], label: "Go to Customers" },
        { keys: ["g", "i"], label: "Go to Invoices" },
        { keys: ["g", "f"], label: "Go to Finance" },
        { keys: ["g", "s"], label: "Go to Settings" },
        { keys: ["⌘", "K"], label: "Open Command Palette" },
        { keys: ["?"], label: "Show Keyboard Shortcuts" },
      ].filter((s) => routesAccess || (s.label !== "Go to Routes" && s.label !== "Go to Drivers")),
    [routesAccess],
  );

  return (
    <div className="surface-operator flex h-screen overflow-hidden">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-brand-500 focus:px-4 focus:py-2 focus:text-white focus:shadow-lg"
      >
        Skip to content
      </a>
      {/* Sidebar — static rail on lg+, replaced by a drawer below lg */}
      <aside
        className={cn(
          "hidden shrink-0 flex-col overflow-hidden bg-navy transition-[width] duration-200 ease-in-out lg:flex",
          collapsed ? "lg:w-16" : "lg:w-60",
        )}
      >
        {/* Logo */}
        <div
          className={cn(
            "flex h-16 shrink-0 items-center border-b border-white/10 px-3",
            collapsed ? "justify-center" : "gap-3",
          )}
        >
          <TenantLogo
            className="h-8 w-8"
            showName={!collapsed}
            nameClassName="text-lg font-bold text-white truncate"
          />
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-2 py-3">
          <SidebarNav navStructure={navStructure} collapsed={collapsed} pathname={pathname} />
        </nav>

        {/* Collapse toggle */}
        <div className="shrink-0 border-t border-white/10 p-2">
          <button
            onClick={toggle}
            className={cn(
              "flex w-full items-center rounded-lg px-3 py-2.5 text-white/60 transition-colors hover:bg-white/10 hover:text-white",
              collapsed ? "justify-center" : "gap-3",
            )}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? (
              <ChevronRight className="h-5 w-5 shrink-0" />
            ) : (
              <>
                <ChevronLeft className="h-5 w-5 shrink-0" />
                <span className="text-sm font-medium">Collapse</span>
              </>
            )}
          </button>
        </div>
      </aside>

      {/* Mobile nav drawer — off-canvas sidebar below the lg breakpoint */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-50 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
        >
          <div
            className="absolute inset-0 bg-black/40 animate-in fade-in-0"
            aria-hidden="true"
            onClick={() => setMobileNavOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 flex w-64 max-w-[82%] flex-col bg-navy shadow-modal animate-in slide-in-from-left duration-200">
            <div className="flex h-16 shrink-0 items-center justify-between border-b border-white/10 px-3">
              <TenantLogo
                className="h-8 w-8"
                showName
                nameClassName="text-lg font-bold text-white truncate"
              />
              <button
                onClick={() => setMobileNavOpen(false)}
                className="rounded-lg p-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                aria-label="Close navigation menu"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto px-2 py-3">
              <SidebarNav
                navStructure={navStructure}
                collapsed={false}
                pathname={pathname}
                onNavigate={() => setMobileNavOpen(false)}
              />
            </nav>
          </aside>
        </div>
      )}

      {/* Right column — `relative` so the draft dock anchors to the bottom-left of
          the content area (right of the rail), not over the sidebar's collapse
          control; below lg the rail is a drawer so it becomes the viewport corner. */}
      <div className="relative flex flex-1 flex-col overflow-hidden">
        <ImpersonationBanner />
        <Header
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenMobileNav={() => setMobileNavOpen(true)}
        />
        {/* pb-24 reserves 96px of clearance below page content so the
            floating PwaInstallPrompt (fixed bottom-4) and similar
            bottom-anchored UI never sit on top of bottom-aligned form
            actions like Save Defaults / Save Changes. Without this, the
            install prompt covers the Save button on Settings →
            Invoicing → Invoice Defaults and on the Business Profile
            tab, making the form look like it has no save action. */}
        <main
          id="main-content"
          className="flex-1 overflow-x-hidden overflow-y-auto bg-surface-raised pb-24"
        >
          {children}
        </main>
        {/* Persistent parked-draft dock (pos-cost-roles-spec §2) — bottom-left of
            the content area, every operator screen; resume/discard + scan-to-draft. */}
        <DraftDock />
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <PwaInstallPrompt logoSrc="/logo.svg" accentClass="bg-brand-600 hover:bg-brand-700" />

      {/* Keyboard shortcuts help modal */}
      {shortcutHelpOpen && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
          onClick={() => setShortcutHelpOpen(false)}
        >
          <div
            className="w-full max-w-sm overflow-hidden rounded-xl border border-surface-border bg-white shadow-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-surface-border px-5 py-3.5">
              <p className="text-sm font-semibold text-navy">Keyboard Shortcuts</p>
              <button
                onClick={() => setShortcutHelpOpen(false)}
                className="rounded p-1 text-navy/70 hover:bg-surface-raised hover:text-navy transition-colors"
                aria-label="Close"
              >
                <ChevronRight className="h-4 w-4 rotate-90" />
              </button>
            </div>
            <ul className="divide-y divide-surface-border">
              {SHORTCUTS.map((s) => (
                <li key={s.label} className="flex items-center justify-between px-5 py-3">
                  <span className="text-sm text-navy/70">{s.label}</span>
                  <div className="flex items-center gap-1">
                    {s.keys.map((k) => (
                      <kbd
                        key={k}
                        className="rounded border border-surface-border bg-surface-raised px-1.5 py-0.5 text-xs font-medium text-navy"
                      >
                        {k}
                      </kbd>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Layout export ────────────────────────────────────────────────────────────

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <PageTitleProvider>
        <AuthGuard>
          <DashboardShell>{children}</DashboardShell>
        </AuthGuard>
      </PageTitleProvider>
    </ToastProvider>
  );
}
