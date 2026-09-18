"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  Building2,
  LogOut,
  ScrollText,
  CreditCard,
  Layers,
  Users,
  GitMerge,
  UserCircle,
  Bot,
} from "lucide-react";
import { BrandMark } from "@/components/brand";
import { cn } from "@routeflow/ui/web";
import {
  useResponsiveSidebar,
  SidebarCollapseToggle,
  MobileNavTrigger,
  MobileSidebarDrawer,
  MobileDrawerCloseButton,
} from "@/components/ResponsiveSidebar";

// ─── Auth guard ────────────────────────────────────────────────────────────────

function parseJwt(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

function SuperAdminGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [checked, setChecked] = React.useState(false);

  React.useEffect(() => {
    const token = localStorage.getItem("superAdminToken");
    if (!token) {
      router.replace("/admin-login");
      return;
    }
    const payload = parseJwt(token);
    if (!payload || payload.role !== "SUPER_ADMIN") {
      localStorage.removeItem("superAdminToken");
      router.replace("/admin-login");
      return;
    }
    if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
      localStorage.removeItem("superAdminToken");
      router.replace("/admin-login");
      return;
    }
    setChecked(true);
  }, [router]);

  if (!checked) return null;
  return <>{children}</>;
}

// ─── Sidebar nav ──────────────────────────────────────────────────────────────

const NAV_ITEMS = [
  { label: "Dashboard", href: "/admin/dashboard", icon: LayoutDashboard },
  { label: "Tenants", href: "/admin/tenants", icon: Building2 },
  { label: "Buyers", href: "/admin/buyers", icon: Users },
  { label: "Merge Requests", href: "/admin/buyers/merge-requests", icon: GitMerge },
  { label: "Plans & Features", href: "/admin/plans", icon: Layers },
  { label: "Billing", href: "/admin/billing", icon: CreditCard },
  { label: "Audit Logs", href: "/admin/audit-logs", icon: ScrollText },
  { label: "AI Settings", href: "/admin/settings", icon: Bot },
  { label: "My Account", href: "/admin/profile", icon: UserCircle },
];

/** Rendered for the desktop rail (collapsed reflects the persisted preference) and the mobile
 *  drawer (always expanded; onNavigate closes the drawer after navigating). */
function SidebarNavItems({
  pathname,
  collapsed,
  onNavigate,
}: {
  pathname: string;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  return (
    <nav className={cn("flex-1 py-3", collapsed ? "px-2" : "px-2")}>
      <ul className="flex flex-col gap-0.5">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active =
            pathname === item.href ||
            (item.href !== "/admin/dashboard" && pathname.startsWith(item.href));
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onNavigate}
                title={collapsed ? item.label : undefined}
                className={cn(
                  "flex items-center rounded-lg py-2.5 text-sm font-medium transition-colors",
                  collapsed ? "justify-center px-2" : "gap-3 px-3",
                  active
                    ? "bg-indigo-600 text-white"
                    : "text-slate-400 hover:bg-slate-800 hover:text-white",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {!collapsed && item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const sidebar = useResponsiveSidebar("rf-admin-sidebar-collapsed");

  const handleLogout = () => {
    localStorage.removeItem("superAdminToken");
    router.push("/admin-login");
  };

  return (
    <>
      {/* Static rail on lg+ (collapsible to an icon-only width), replaced by a drawer below lg. */}
      <aside
        className={cn(
          "hidden shrink-0 flex-col bg-slate-900 border-r border-slate-700/50 transition-[width] duration-200 ease-in-out lg:flex",
          sidebar.collapsed ? "lg:w-16" : "lg:w-60",
        )}
      >
        {/* Logo */}
        <div
          className={cn(
            "flex h-16 items-center border-b border-slate-700/50",
            sidebar.collapsed ? "justify-center px-2" : "gap-3 px-4",
          )}
        >
          {/* Dark surface: the aside's `bg-slate-900` (B2). */}
          <BrandMark size={32} className="rounded-lg" tone="light" />
          {!sidebar.collapsed && (
            <div>
              <div className="text-sm font-bold text-white">RouteFlow</div>
              <div className="text-[10px] font-medium uppercase tracking-wider text-indigo-400">
                Platform Admin
              </div>
            </div>
          )}
        </div>

        <SidebarNavItems pathname={pathname} collapsed={sidebar.collapsed} />

        {/* Logout + collapse toggle */}
        <div className="border-t border-slate-700/50 p-2">
          <button
            onClick={handleLogout}
            title={sidebar.collapsed ? "Sign out" : undefined}
            className={cn(
              "flex w-full items-center rounded-lg py-2.5 text-sm font-medium text-slate-400 transition-colors hover:bg-red-900/30 hover:text-red-400",
              sidebar.collapsed ? "justify-center px-2" : "gap-3 px-3",
            )}
          >
            <LogOut className="h-4 w-4 shrink-0" />
            {!sidebar.collapsed && "Sign out"}
          </button>
          <SidebarCollapseToggle
            collapsed={sidebar.collapsed}
            onToggle={sidebar.toggleCollapsed}
            className="mt-0.5 text-slate-400 hover:bg-slate-800 hover:text-white"
          />
        </div>
      </aside>

      {/* Mobile nav drawer — off-canvas sidebar below the lg breakpoint */}
      <MobileSidebarDrawer open={sidebar.mobileNavOpen} onClose={sidebar.closeMobileNav}>
        <aside className="absolute inset-y-0 left-0 flex w-64 max-w-[82%] flex-col bg-slate-900 shadow-modal animate-in slide-in-from-left duration-200">
          <div className="flex h-16 shrink-0 items-center justify-between border-b border-slate-700/50 px-4">
            <div className="flex items-center gap-3">
              <BrandMark size={32} className="rounded-lg" tone="light" />
              <div>
                <div className="text-sm font-bold text-white">RouteFlow</div>
                <div className="text-[10px] font-medium uppercase tracking-wider text-indigo-400">
                  Platform Admin
                </div>
              </div>
            </div>
            <MobileDrawerCloseButton
              onClose={sidebar.closeMobileNav}
              className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
            />
          </div>
          <SidebarNavItems
            pathname={pathname}
            collapsed={false}
            onNavigate={sidebar.closeMobileNav}
          />
          <div className="border-t border-slate-700/50 p-2">
            <button
              onClick={handleLogout}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-400 transition-colors hover:bg-red-900/30 hover:text-red-400"
            >
              <LogOut className="h-4 w-4 shrink-0" />
              Sign out
            </button>
          </div>
        </aside>
      </MobileSidebarDrawer>

      {/* Mobile-only top bar — this shell has no separate header, so the drawer needs its own
          trigger below lg. */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-700/50 bg-slate-900 px-4 lg:hidden">
        <MobileNavTrigger
          onOpen={sidebar.openMobileNav}
          className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
        />
        <BrandMark size={24} className="rounded" tone="light" />
        <span className="text-sm font-bold text-white">RouteFlow</span>
      </header>
    </>
  );
}

// ─── Layout ────────────────────────────────────────────────────────────────────

export default function PlatformAdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <SuperAdminGuard>
      <div className="surface-admin flex h-screen flex-col overflow-hidden bg-slate-950 lg:flex-row">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </SuperAdminGuard>
  );
}
