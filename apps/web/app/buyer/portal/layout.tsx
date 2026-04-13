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
} from "lucide-react";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import { useBuyerCart } from "@/lib/buyer-cart";
import type { BuyerSeller } from "@/lib/buyer-auth";

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
      return "bg-surface-raised text-navy/60";
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
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
        isActive
          ? "bg-brand-50 text-brand-700 ring-1 ring-brand-200"
          : "text-navy/70 hover:bg-surface-raised hover:text-navy"
      }`}
    >
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-surface-border text-xs font-bold text-navy/60">
        {seller.tenant.name.slice(0, 2).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-medium truncate ${isActive ? "text-brand-700" : "text-navy"}`}>
          {seller.tenant.name}
        </p>
        <p className="text-xs text-navy/50 truncate">{seller.customer.businessName}</p>
      </div>
      {isActive && <ChevronRight className="h-4 w-4 flex-shrink-0 text-brand-500" />}
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
        isActive
          ? "bg-brand-50 text-brand-700"
          : "text-navy/70 hover:bg-surface-raised hover:text-navy"
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
  const [sellersOpen, setSellersOpen] = React.useState(false);

  // Redirect to login if not authenticated
  React.useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push("/buyer/login");
    }
  }, [isLoading, isAuthenticated, router]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-raised">
        <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
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
          href: `/buyer/portal/${sellerSlug}/templates`,
          icon: Repeat,
          label: "Standing Orders",
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
    <div className="flex min-h-screen bg-surface-raised">
      {/* Sidebar */}
      <aside className="flex w-64 flex-shrink-0 flex-col border-r border-surface-border bg-white">
        {/* Header */}
        <div className="border-b border-surface-border px-4 py-4">
          <div className="flex items-center gap-2">
            <div
              className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-white"
              style={{ backgroundColor: "#3B82F6" }}
            >
              RF
            </div>
            <div>
              <p className="text-sm font-bold text-navy">RouteFlow</p>
              <p className="text-xs text-navy/50">Buyer Portal</p>
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
              className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-semibold uppercase tracking-wider text-navy/40 hover:bg-surface-raised transition-colors"
            >
              <span>Your Sellers</span>
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${sellersOpen ? "rotate-180" : ""}`}
              />
            </button>

            {/* Preview: show active seller name when collapsed */}
            {!sellersOpen && activeSeller && (
              <div className="mt-1 px-3 py-1.5 rounded-lg bg-brand-50 text-sm font-medium text-brand-700 truncate">
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
                  <div className="rounded-lg border border-dashed border-surface-border p-4 text-center">
                    <Building2 className="mx-auto mb-2 h-6 w-6 text-navy/30" />
                    <p className="text-xs text-navy/50">No sellers linked yet</p>
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
              <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-navy/40">
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
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-500 px-1.5 text-[10px] font-bold text-white">
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
        <div className="border-t border-surface-border px-3 py-3">
          <div className="mb-2 rounded-lg bg-surface-raised px-3 py-2">
            <p className="text-xs font-medium text-navy truncate">{buyer.name}</p>
            <p className="text-xs text-navy/50 truncate">{buyer.email}</p>
          </div>
          <button
            type="button"
            onClick={logout}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-navy/60 hover:bg-danger-bg hover:text-danger transition-colors"
          >
            <LogOut className="h-4 w-4" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
