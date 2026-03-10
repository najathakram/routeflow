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
  BookOpen,
  Settings,
  Bell,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  LogOut,
  User as UserIcon,
} from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { cn, Avatar } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import { PageTitleProvider, usePageTitle } from "@/lib/page-title-context";

// ─── Constants ────────────────────────────────────────────────────────────────

const UNREAD_NOTIFICATIONS = 3;

const NAV_ITEMS = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Orders", href: "/orders", icon: ShoppingCart },
  { label: "Routes", href: "/routes", icon: MapPin },
  { label: "Drivers", href: "/drivers", icon: Truck },
  { label: "Customers", href: "/customers", icon: Users },
  { label: "Products", href: "/products", icon: Package },
  { label: "Bookkeeping", href: "/bookkeeping", icon: BookOpen },
  { label: "Settings", href: "/settings", icon: Settings },
] as const;

// ─── Auth guard ───────────────────────────────────────────────────────────────

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (!isAuthenticated) {
      router.push("/login");
    }
  }, [isAuthenticated, router]);

  if (!isAuthenticated) return null;
  return <>{children}</>;
}

// ─── Nav link ─────────────────────────────────────────────────────────────────

function NavLink({
  item,
  collapsed,
  active,
}: {
  item: (typeof NAV_ITEMS)[number];
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

// ─── Header ───────────────────────────────────────────────────────────────────

function Header({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { title } = usePageTitle();
  const { user, logout } = useAuth();

  return (
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-surface-border bg-white px-4">
      <button
        onClick={onToggle}
        className="rounded-lg p-2 text-navy/60 transition-colors hover:bg-surface-raised hover:text-navy"
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? (
          <ChevronRight className="h-5 w-5" />
        ) : (
          <ChevronLeft className="h-5 w-5" />
        )}
      </button>

      <div className="flex-1">
        {title && <h1 className="text-base font-semibold text-navy">{title}</h1>}
      </div>

      <div className="flex items-center gap-1">
        {/* Notification bell */}
        <button
          className="relative rounded-lg p-2 text-navy/60 transition-colors hover:bg-surface-raised hover:text-navy"
          aria-label={`${UNREAD_NOTIFICATIONS} unread notifications`}
        >
          <Bell className="h-5 w-5" />
          {UNREAD_NOTIFICATIONS > 0 && (
            <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-danger text-[10px] font-bold leading-none text-white">
              {UNREAD_NOTIFICATIONS}
            </span>
          )}
        </button>

        {/* Avatar dropdown */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-raised"
              aria-label="Open user menu"
            >
              <Avatar name={user.name} size="sm" />
              <span className="hidden text-sm font-medium text-navy sm:block">
                {user.name}
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
                onSelect={() => {}}
              >
                <UserIcon className="h-4 w-4 text-navy/40" />
                Profile
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 border-t border-surface-border" />
              <DropdownMenu.Item
                className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-danger outline-none hover:bg-danger-bg"
                onSelect={logout}
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

// ─── Dashboard shell ──────────────────────────────────────────────────────────

function DashboardShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = React.useState(false);
  const pathname = usePathname();
  const toggle = () => setCollapsed((v) => !v);

  return (
    <div className="flex h-screen overflow-hidden">
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
            {NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <NavLink
                  item={item}
                  collapsed={collapsed}
                  active={
                    item.href === "/dashboard"
                      ? pathname === "/dashboard"
                      : pathname.startsWith(item.href)
                  }
                />
              </li>
            ))}
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
        <Header collapsed={collapsed} onToggle={toggle} />
        <main className="flex-1 overflow-y-auto bg-surface-raised">
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
    <PageTitleProvider>
      <AuthGuard>
        <DashboardShell>{children}</DashboardShell>
      </AuthGuard>
    </PageTitleProvider>
  );
}
