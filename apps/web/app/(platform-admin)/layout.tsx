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

function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();

  const handleLogout = () => {
    localStorage.removeItem("superAdminToken");
    router.push("/admin-login");
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col bg-slate-900 border-r border-slate-700/50">
      {/* Logo */}
      <div className="flex h-16 items-center gap-3 border-b border-slate-700/50 px-4">
        {/* Dark surface: the aside's `bg-slate-900` (B2). */}
        <BrandMark size={32} className="rounded-lg" tone="light" />
        <div>
          <div className="text-sm font-bold text-white">RouteFlow</div>
          <div className="text-[10px] font-medium uppercase tracking-wider text-indigo-400">
            Platform Admin
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-3">
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
                  className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                    active
                      ? "bg-indigo-600 text-white"
                      : "text-slate-400 hover:bg-slate-800 hover:text-white"
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Logout */}
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
  );
}

// ─── Layout ────────────────────────────────────────────────────────────────────

export default function PlatformAdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <SuperAdminGuard>
      <div className="surface-admin flex h-screen overflow-hidden bg-slate-950">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </SuperAdminGuard>
  );
}
