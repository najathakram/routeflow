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
  Wallet,
  Building2,
  DollarSign,
  CreditCard,
  BarChart3,
  PieChart,
  ShoppingBag,
  type LucideIcon,
} from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { cn, Avatar, ToastProvider } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import { PageTitleProvider, usePageTitle } from "@/lib/page-title-context";
import { useRealtimeUpdates } from "@/lib/hooks/useRealtimeUpdates";
import { useNotifications, type AppNotification } from "@/lib/hooks/useNotifications";

// ─── Nav types & structure ────────────────────────────────────────────────────

type NavLeaf  = { kind: "leaf";  label: string; href: string; icon: LucideIcon };
type NavGroup = { kind: "group"; label: string; icon: LucideIcon; children: NavLeaf[] };
type NavEntry = NavLeaf | NavGroup;

const NAV_STRUCTURE: NavEntry[] = [
  { kind: "leaf", label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  {
    kind: "group", label: "Orders", icon: ShoppingCart,
    children: [
      { kind: "leaf", label: "All Orders", href: "/orders",  icon: ShoppingCart },
      { kind: "leaf", label: "Returns",    href: "/returns", icon: RotateCcw },
    ],
  },
  {
    kind: "group", label: "Dispatch", icon: Truck,
    children: [
      { kind: "leaf", label: "Routes",  href: "/routes",  icon: MapPin },
      { kind: "leaf", label: "Drivers", href: "/drivers", icon: Truck },
    ],
  },
  { kind: "leaf", label: "Customers", href: "/customers", icon: Users },
  {
    kind: "group", label: "Warehouse", icon: Package,
    children: [
      { kind: "leaf", label: "Inventory", href: "/inventory", icon: Layers },
      { kind: "leaf", label: "Products",  href: "/products",  icon: Package },
      { kind: "leaf", label: "Suppliers", href: "/suppliers", icon: Building2 },
    ],
  },
  {
    kind: "group", label: "Finance", icon: Wallet,
    children: [
      { kind: "leaf", label: "Overview",         href: "/finance/dashboard", icon: LayoutDashboard },
      { kind: "leaf", label: "Invoices",         href: "/invoices",          icon: FileText },
      { kind: "leaf", label: "Estimates",        href: "/estimates",         icon: FileCheck },
      { kind: "leaf", label: "Credit Notes",     href: "/credit-notes",      icon: Receipt },
      { kind: "leaf", label: "Payments",         href: "/finance/payments",  icon: CreditCard },
      { kind: "leaf", label: "Expenses",         href: "/finance/expenses",  icon: ShoppingBag },
      { kind: "leaf", label: "Reports",          href: "/finance/reports",   icon: BarChart3 },
      { kind: "leaf", label: "Analytics",        href: "/analytics",         icon: BarChart2 },
    ],
  },
  { kind: "leaf", label: "Settings", href: "/settings", icon: Settings },
];

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
    }
  }, [isAuthenticated, isLoading, user, router]);

  if (isLoading || !isAuthenticated || user?.forcePasswordChange) return null;
  return <>{children}</>;
}

// ─── Nav link ─────────────────────────────────────────────────────────────────

function NavLink({
  item,
  collapsed,
  active,
}: {
  item: NavLeaf;
  collapsed: boolean;
  active: boolean;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      title={collapsed ? item.label : undefined}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
        collapsed && "justify-center",
        active
          ? "bg-white text-navy"
          : "text-white/70 hover:bg-white/10 hover:text-white",
      )}
    >
      <Icon className="h-5 w-5 shrink-0" />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );
}

// ─── Nav group section ────────────────────────────────────────────────────────

function NavGroupSection({
  group,
  collapsed,
  pathname,
}: {
  group: NavGroup;
  collapsed: boolean;
  pathname: string;
}) {
  const isAnyChildActive = group.children.some((c) => pathname.startsWith(c.href));
  const [open, setOpen] = React.useState(isAnyChildActive);

  React.useEffect(() => {
    if (isAnyChildActive) setOpen(true);
  }, [isAnyChildActive]);

  const Icon = group.icon;

  // Collapsed: render each child as a flat icon-only link
  if (collapsed) {
    return (
      <>
        {group.children.map((child) => (
          <li key={child.href}>
            <NavLink
              item={child}
              collapsed={true}
              active={pathname.startsWith(child.href)}
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
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-xs font-semibold uppercase tracking-wider transition-colors",
          isAnyChildActive
            ? "text-white/90"
            : "text-white/40 hover:text-white/70",
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-left">{group.label}</span>
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 transition-transform duration-150",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <ul className="mt-0.5 flex flex-col gap-0.5 pl-3">
          {group.children.map((child) => (
            <li key={child.href}>
              <NavLink
                item={child}
                collapsed={false}
                active={pathname.startsWith(child.href)}
              />
            </li>
          ))}
        </ul>
      )}
    </li>
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
  // stock
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warning-bg">
      <Package className="h-4 w-4 text-warning" />
    </span>
  );
}

// ─── Header ───────────────────────────────────────────────────────────────────

function Header() {
  const { title } = usePageTitle();
  const { user, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const { notifications, unreadCount, markAllRead, clear } = useNotifications();

  // Show a back button only on sub-pages (e.g. /routes/123, /customers/456)
  const isSubPage = pathname.split("/").filter(Boolean).length > 1;

  return (
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-surface-border bg-white px-4">
      {isSubPage ? (
        <button
          onClick={() => router.back()}
          className="rounded-lg p-2 text-navy/60 transition-colors hover:bg-surface-raised hover:text-navy"
          aria-label="Go back"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
      ) : (
        <div className="w-9 shrink-0" />
      )}

      <div className="flex-1">
        {title && <h1 className="text-base font-semibold text-navy">{title}</h1>}
      </div>

      <div className="flex items-center gap-1">
        {/* Notification bell */}
        <DropdownMenu.Root onOpenChange={(open) => { if (open) markAllRead(); }}>
          <DropdownMenu.Trigger asChild>
            <button
              className="relative rounded-lg p-2 text-navy/60 transition-colors hover:bg-surface-raised hover:text-navy"
              aria-label={unreadCount > 0 ? `${unreadCount} unread notifications` : "Notifications"}
            >
              <Bell className="h-5 w-5" />
              {unreadCount > 0 && (
                <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-danger text-[10px] font-bold leading-none text-white">
                  {unreadCount > 9 ? "9+" : unreadCount}
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
                    className="flex items-center gap-1 text-xs text-navy/40 hover:text-danger transition-colors"
                    title="Clear all"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Clear all
                  </button>
                )}
              </div>

              {/* List */}
              <div className="max-h-[60vh] overflow-y-auto">
                {notifications.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-10 text-center">
                    <Bell className="h-8 w-8 text-navy/20" />
                    <p className="text-sm text-navy/40">No notifications yet</p>
                    <p className="text-xs text-navy/30">
                      Urgent orders, driver updates, and low-stock alerts will appear here
                    </p>
                  </div>
                ) : (
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
                          <p className="mt-0.5 text-xs text-navy/60 leading-snug">{n.description}</p>
                          <p className="mt-1 text-[10px] text-navy/30">{timeAgo(n.timestamp)}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
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
              <ChevronDown className="hidden h-4 w-4 text-navy/40 sm:block" />
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
                <UserIcon className="h-4 w-4 text-navy/40" />
                Profile &amp; Settings
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 border-t border-surface-border" />
              <DropdownMenu.Item
                className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-danger outline-none hover:bg-danger-bg"
                onSelect={() => void logout()}
              >
                <LogOut className="h-4 w-4" />
                Sign out
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
  );
}

// ─── Impersonation banner ─────────────────────────────────────────────────────

function ImpersonationBanner() {
  const router = useRouter();
  const [tenantSlug, setTenantSlug] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const imp = localStorage.getItem("impersonationToken");
    if (imp) {
      setTenantSlug(localStorage.getItem("impersonationTenantSlug") ?? "unknown");
    }
  }, []);

  if (!tenantSlug) return null;

  const exitImpersonation = () => {
    localStorage.removeItem("impersonationToken");
    localStorage.removeItem("impersonationTenantSlug");
    router.push("/admin/tenants");
  };

  return (
    <div className="flex items-center justify-between bg-red-600 px-4 py-2 text-sm text-white">
      <span>
        ⚠️ Impersonating <strong>{tenantSlug}</strong> — acting as Tenant Admin
      </span>
      <button
        onClick={exitImpersonation}
        className="rounded bg-white/20 px-3 py-1 text-xs font-semibold hover:bg-white/30 transition-colors"
      >
        Exit impersonation
      </button>
    </div>
  );
}

// ─── Dashboard shell ──────────────────────────────────────────────────────────

function DashboardShell({ children }: { children: React.ReactNode }) {
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

  // Auto-collapse sidebar on narrow viewports
  React.useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const handler = (e: MediaQueryListEvent) => {
      if (e.matches) setCollapsed(true);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useRealtimeUpdates();

  return (
    <div className="flex h-screen overflow-hidden">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-brand-500 focus:px-4 focus:py-2 focus:text-white focus:shadow-lg"
      >
        Skip to content
      </a>
      {/* Sidebar */}
      <aside
        className={cn(
          "flex shrink-0 flex-col overflow-hidden bg-navy transition-[width] duration-200 ease-in-out",
          collapsed ? "w-16" : "w-60",
        )}
      >
        {/* Logo */}
        <div
          className={cn(
            "flex h-16 shrink-0 items-center border-b border-white/10 px-3",
            collapsed ? "justify-center" : "gap-3",
          )}
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-500 text-sm font-bold text-white">
            RF
          </div>
          {!collapsed && (
            <span className="text-lg font-bold text-white">RouteFlow</span>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-2 py-3">
          <ul className="flex flex-col gap-0.5">
            {NAV_STRUCTURE.map((entry) =>
              entry.kind === "leaf" ? (
                <li key={entry.href}>
                  <NavLink
                    item={entry}
                    collapsed={collapsed}
                    active={
                      entry.href === "/dashboard"
                        ? pathname === "/dashboard"
                        : pathname.startsWith(entry.href)
                    }
                  />
                </li>
              ) : (
                <NavGroupSection
                  key={entry.label}
                  group={entry}
                  collapsed={collapsed}
                  pathname={pathname}
                />
              )
            )}
          </ul>
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

      {/* Right column */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <ImpersonationBanner />
        <Header />
        <main id="main-content" className="flex-1 overflow-x-hidden overflow-y-auto bg-surface-raised">
          {children}
        </main>
      </div>
    </div>
  );
}

// ─── Layout export ────────────────────────────────────────────────────────────

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
