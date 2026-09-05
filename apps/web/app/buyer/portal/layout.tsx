"use client";

import * as React from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  ShoppingCart,
  FileText,
  User,
  LogOut,
  Building2,
  ChevronRight,
  ChevronDown,
  LayoutDashboard,
  Store,
  Repeat,
  Loader2,
  Settings,
  LayoutGrid,
  Heart,
  Bell,
  Boxes,
  ShieldAlert,
  X,
  TrendingUp,
  ShieldCheck,
  CreditCard,
} from "lucide-react";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import { useBuyerCart } from "@/lib/buyer-cart";
import { useBuyerNotifications, type BuyerNotification } from "@/lib/hooks/useBuyerNotifications";
import { useBuyerExpiringAuthorizations } from "@/lib/api/buyer";
import type { ExpiringAuthorization } from "@/lib/api/authorizations";
import type { BuyerSeller } from "@/lib/buyer-auth";
import { PortalSwitchLink } from "@/components/PortalSwitchLink";
import { setLastPortalCookie } from "@/lib/presence-cookies";

function buyerExpiryLabel(a: ExpiringAuthorization): string {
  if (a.expired) return "Expired";
  if (a.bucket === 1) return "Expires in ~1 day";
  if (a.bucket) return `Expires in ~${a.bucket} days`;
  return "Expiring soon";
}
import { BuyerPortalErrorBoundary } from "./error-boundary";

// ─── Status badge variant helper ─────────────────────────────────────────────

function getLinkStatusColor(status: string): string {
  switch (status) {
    case "ACTIVE":
      return "bg-success-bg text-success";
    case "PENDING":
    case "PENDING_SELLER_APPROVAL":
      return "bg-warning-bg text-warning";
    case "SUSPENDED":
    case "DISCONNECTED":
      return "bg-danger-bg text-danger";
    default:
      return "bg-surface-raised text-navy/70";
  }
}

// ─── Sidebar seller item ──────────────────────────────────────────────────────

function SellerItem({
  seller,
  isActive,
  onClick,
}: {
  seller: BuyerSeller;
  isActive: boolean;
  onClick: () => void;
}) {
  // Only an ACTIVE link can be switched into (mirrors mobile's canOpenSeller).
  // Pending/invited rows carry no customer identity (the API redacts it) and
  // opening one would only walk the buyer into a wall of 403s.
  const canOpen = seller.linkStatus === "ACTIVE";
  return (
    <button
      type="button"
      onClick={canOpen ? onClick : undefined}
      disabled={!canOpen}
      className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
        isActive
          ? "bg-buyer-500/20 text-buyer-100 ring-1 ring-buyer-400/30"
          : canOpen
            ? "text-white/70 hover:bg-white/10 hover:text-white"
            : "text-white/50 cursor-default"
      }`}
    >
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-white/10 text-xs font-bold text-buyer-200">
        {seller.tenant.name.slice(0, 2).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <p
          className={`text-sm font-medium truncate ${isActive ? "text-buyer-100" : "text-white/80"}`}
        >
          {seller.tenant.name}
        </p>
        <p className="text-xs text-buyer-300/70 truncate">
          {seller.customer ? seller.customer.businessName : "Pending approval"}
        </p>
      </div>
      {isActive && <ChevronRight className="h-4 w-4 flex-shrink-0 text-buyer-400" />}
    </button>
  );
}

// ─── Nav link ─────────────────────────────────────────────────────────────────

function NavLink({
  href,
  icon: Icon,
  label,
  isActive,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  isActive: boolean;
}) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.push(href)}
      className={`w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
        isActive ? "bg-white text-buyer-800" : "text-white/70 hover:bg-white/10 hover:text-white"
      }`}
    >
      <Icon className="h-4 w-4 flex-shrink-0" />
      {label}
    </button>
  );
}

// ─── Layout ───────────────────────────────────────────────────────────────────

export default function BuyerPortalLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { buyer, isLoading, isAuthenticated, activeSeller, sellers, setActiveSeller, logout } =
    useBuyerAuth();

  // Hooks must be called unconditionally — before any early returns
  const sellerSlug = activeSeller?.tenant.slug;
  const { totalQty: cartItemCount } = useBuyerCart(buyer?.id, sellerSlug);
  const { notifications, unreadCount, markAllRead, clearAll } = useBuyerNotifications();
  const { data: expiring = [] } = useBuyerExpiringAuthorizations(!!activeSeller);
  const bellCount = unreadCount + expiring.length;
  const [sellersOpen, setSellersOpen] = React.useState(false);
  const [notifOpen, setNotifOpen] = React.useState(false);

  // Redirect to login if not authenticated.
  // Pass the current path so the login page can bounce the user back after signing in.
  // Only buyerAccessToken / buyerRefreshToken are used in this portal — operator tokens
  // stored under "accessToken" are never read here (RF-220 token isolation).
  React.useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      const redirect = encodeURIComponent(window.location.pathname + window.location.search);
      router.push(`/buyer/login?redirect=${redirect}`);
      return;
    }
    // "/" opens the portal used last when both a buyer and an operator session
    // are live (lib/portal-routing.ts) — record that this one rendered.
    setLastPortalCookie("buyer");
  }, [isLoading, isAuthenticated, router]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-raised">
        <Loader2 className="h-8 w-8 animate-spin text-buyer-500" />
      </div>
    );
  }

  if (!isAuthenticated || !buyer) {
    return null;
  }

  const navItems = sellerSlug
    ? [
        {
          href: `/buyer/portal/${sellerSlug}/dashboard`,
          icon: LayoutDashboard,
          label: "Dashboard",
        },
        {
          href: `/buyer/portal/${sellerSlug}/shop`,
          icon: Store,
          label: "Shop",
        },
        {
          href: `/buyer/portal/${sellerSlug}/shelf`,
          icon: Boxes,
          label: "Your Shelf",
        },
        {
          href: `/buyer/portal/${sellerSlug}/favorites`,
          icon: Heart,
          label: "Favorites",
        },
        {
          href: `/buyer/portal/${sellerSlug}/orders`,
          icon: ShoppingCart,
          label: "Orders",
        },
        {
          href: `/buyer/portal/${sellerSlug}/invoices`,
          icon: FileText,
          label: "Invoices",
        },
        {
          href: `/buyer/portal/${sellerSlug}/payments`,
          icon: CreditCard,
          label: "Payments",
        },
        {
          href: `/buyer/portal/${sellerSlug}/finances`,
          icon: TrendingUp,
          label: "Finances",
        },
        {
          href: `/buyer/portal/${sellerSlug}/templates`,
          icon: Repeat,
          label: "Standing Orders",
        },
        {
          href: `/buyer/portal/${sellerSlug}/licenses`,
          icon: ShieldCheck,
          label: "Licenses",
        },
        {
          href: `/buyer/portal/${sellerSlug}/account`,
          icon: User,
          label: "Account",
        },
      ]
    : [];

  const handleSellerClick = (seller: BuyerSeller) => {
    setActiveSeller(seller);
    router.push(`/buyer/portal/${seller.tenant.slug}/dashboard`);
  };

  return (
    <div className="surface-buyer flex min-h-screen bg-surface-raised">
      {/* Sidebar — Buyer: dark teal/emerald theme */}
      <aside className="flex w-64 flex-shrink-0 flex-col bg-gradient-to-b from-buyer-900 to-buyer-800 shadow-lg">
        {/* Header */}
        <div className="border-b border-white/10 px-4 py-4">
          <div className="flex items-center gap-2">
            <img
              src="/logo-buyer.svg"
              alt="RouteFlow"
              className="h-8 w-8 rounded-lg object-contain"
            />
            <div className="flex-1">
              <p className="text-sm font-bold text-white">RouteFlow</p>
              <p className="text-xs text-buyer-300">Buyer Portal</p>
            </div>
            {/* Notification bell */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setNotifOpen(!notifOpen);
                  if (!notifOpen) markAllRead();
                }}
                className="relative rounded-lg p-2 text-buyer-300 hover:bg-white/10 hover:text-white transition-colors"
              >
                <Bell className="h-4 w-4" />
                {bellCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white">
                    {bellCount}
                  </span>
                )}
              </button>
              {notifOpen && (
                <div className="absolute left-0 top-full mt-1 z-50 w-72 rounded-xl border border-surface-border bg-white shadow-lg">
                  <div className="flex items-center justify-between border-b border-surface-border px-3 py-2">
                    <p className="text-xs font-semibold text-navy">Notifications</p>
                    {notifications.length > 0 && (
                      <button
                        onClick={clearAll}
                        className="text-[10px] text-navy/70 hover:text-danger"
                      >
                        Clear all
                      </button>
                    )}
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    {/* W7b: the buyer's own expiring / expired licenses */}
                    {expiring.length > 0 && (
                      <div className="border-b border-surface-border">
                        <p className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-navy/40">
                          Your licenses
                        </p>
                        {expiring.map((a) => (
                          <div
                            key={a.id}
                            className={`flex items-start gap-2 border-b border-surface-border px-3 py-2 last:border-b-0 ${
                              a.expired ? "bg-danger/5" : "bg-amber-50/50"
                            }`}
                          >
                            <ShieldAlert
                              className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                                a.expired ? "text-danger" : "text-amber-600"
                              }`}
                            />
                            <p className="min-w-0 flex-1 text-xs font-medium text-navy">
                              {a.categoryName} — {buyerExpiryLabel(a)}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                    {notifications.length === 0 && expiring.length === 0 ? (
                      <p className="px-3 py-6 text-center text-xs text-buyer-600">
                        No notifications
                      </p>
                    ) : notifications.length > 0 ? (
                      notifications.slice(0, 20).map((n) => (
                        <div
                          key={n.id}
                          className="border-b border-surface-border px-3 py-2 last:border-b-0 hover:bg-surface-raised/50"
                        >
                          <p className="text-xs font-medium text-navy">{n.title}</p>
                          <p className="text-[11px] text-navy/70 mt-0.5">{n.description}</p>
                          <p className="text-[9px] text-navy/30 mt-0.5">
                            {new Date(n.timestamp).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </p>
                        </div>
                      ))
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Sidebar content */}
        <div className="flex-1 overflow-y-auto px-3 py-4">
          {/* Settings link */}
          <div className="mb-3">
            <NavLink
              href="/buyer/portal/settings"
              icon={Settings}
              label="Settings"
              isActive={pathname === "/buyer/portal/settings"}
            />
          </div>

          {/* Your Sellers — collapsible dropdown */}
          <div className="mb-4">
            <button
              type="button"
              onClick={() => setSellersOpen(!sellersOpen)}
              className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-semibold uppercase tracking-wider text-buyer-300/60 hover:bg-white/10 transition-colors"
            >
              <span>Your Sellers</span>
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${sellersOpen ? "rotate-180" : ""}`}
              />
            </button>

            {/* Preview: show active seller name when collapsed */}
            {!sellersOpen && activeSeller && (
              <div className="mt-1 px-3 py-1.5 rounded-lg bg-buyer-500/20 text-sm font-medium text-buyer-100 truncate">
                {activeSeller.tenant.name}
              </div>
            )}

            {/* Expanded sellers list */}
            {sellersOpen && (
              <div className="mt-1 flex flex-col gap-1">
                {sellers.length > 0 ? (
                  sellers.map((seller) => (
                    <SellerItem
                      key={seller.linkId}
                      seller={seller}
                      isActive={activeSeller?.linkId === seller.linkId}
                      onClick={() => {
                        handleSellerClick(seller);
                        setSellersOpen(false);
                      }}
                    />
                  ))
                ) : (
                  <div className="rounded-lg border border-dashed border-white/20 p-4 text-center">
                    <Building2 className="mx-auto mb-2 h-6 w-6 text-buyer-400/40" />
                    <p className="text-xs text-buyer-300/60">No sellers linked yet</p>
                  </div>
                )}
                {/* Manage Sellers inside the dropdown */}
                <NavLink
                  href="/buyer/portal"
                  icon={LayoutGrid}
                  label="Manage Sellers"
                  isActive={pathname === "/buyer/portal"}
                />
              </div>
            )}
          </div>

          {/* Nav links for active seller */}
          {activeSeller && navItems.length > 0 && (
            <div>
              <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-buyer-300/60">
                {activeSeller.tenant.name}
              </p>
              <div className="flex flex-col gap-1">
                {navItems.map((item) => (
                  <div key={item.href} className="relative">
                    <NavLink
                      href={item.href}
                      icon={item.icon}
                      label={item.label}
                      isActive={pathname === item.href || pathname.startsWith(item.href)}
                    />
                    {item.label === "Shop" && cartItemCount > 0 && (
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 flex h-5 min-w-5 items-center justify-center rounded-full bg-buyer-400 px-1.5 text-[10px] font-bold text-white">
                        {cartItemCount}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-white/10 px-3 py-3">
          <div className="mb-2 rounded-lg bg-buyer-800/50 px-3 py-2">
            <p className="text-xs font-medium text-buyer-100 truncate">{buyer.name}</p>
            <p className="text-xs text-buyer-300/70 truncate">{buyer.email}</p>
          </div>
          <PortalSwitchLink
            to="op"
            className="mb-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-buyer-300/70 transition-colors hover:bg-white/10 hover:text-buyer-100"
            iconClassName="h-4 w-4"
          />
          <button
            type="button"
            onClick={logout}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-buyer-300/70 hover:bg-red-900/30 hover:text-red-400 transition-colors"
          >
            <LogOut className="h-4 w-4" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <BuyerPortalErrorBoundary>{children}</BuyerPortalErrorBoundary>
      </main>

      {/* Global floating cart button — visible on all pages when cart has items */}
      {sellerSlug && cartItemCount > 0 && !pathname.includes("/cart") && (
        <button
          type="button"
          onClick={() => router.push(`/buyer/portal/${sellerSlug}/cart`)}
          className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-buyer-500 text-white shadow-lg hover:bg-buyer-600 transition-colors"
          aria-label={`View cart (${cartItemCount} items)`}
        >
          <ShoppingCart className="h-6 w-6" />
          <span className="absolute -top-1.5 -right-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-white px-1 text-[10px] font-bold text-buyer-600 border border-buyer-200 shadow-sm">
            {cartItemCount}
          </span>
        </button>
      )}
    </div>
  );
}
