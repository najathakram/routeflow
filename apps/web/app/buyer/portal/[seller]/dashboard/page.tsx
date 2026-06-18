"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ShoppingCart,
  Truck,
  Repeat,
  DollarSign,
  Plus,
  Package,
  ArrowRight,
  Loader2,
  ChevronRight,
  Store,
} from "lucide-react";
import { Badge, Button, cn } from "@routeflow/ui/web";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import {
  useBuyerDashboard,
  useBuyerTemplates,
  useBuyerReorder,
  type OrderTemplate,
} from "@/lib/api/buyer";
import { useBuyerCart } from "@/lib/buyer-cart";
import { objectPositionForUrl } from "@/lib/image-focal";
import { PwaInstallPrompt } from "@/components/PwaInstallPrompt";

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function getStatusVariant(s: string): "success" | "warning" | "danger" | "neutral" {
  if (s === "DELIVERED" || s === "COMPLETED") return "success";
  if (s === "PENDING" || s === "CONFIRMED" || s === "OUT_FOR_DELIVERY") return "warning";
  if (s === "CANCELLED") return "danger";
  return "neutral";
}

function formatStatus(s: string) {
  return s
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function nextDeliveryLabel(daysOfWeek: number[]): string {
  if (!daysOfWeek.length) return "No schedule";
  const today = new Date().getDay();
  // Find the soonest upcoming day (including today)
  const sorted = [...daysOfWeek].sort((a, b) => {
    const da = (a - today + 7) % 7;
    const db = (b - today + 7) % 7;
    return da - db;
  });
  const next = sorted[0];
  const daysAway = (next - today + 7) % 7;
  if (daysAway === 0) return "Today";
  if (daysAway === 1) return "Tomorrow";
  return `This ${DAY_FULL[next]}`;
}

function StandingOrdersPanel({
  sellerSlug,
  templates,
  isLoading,
}: {
  sellerSlug: string;
  templates: OrderTemplate[];
  isLoading: boolean;
}) {
  const reorder = useBuyerReorder();
  const [reordering, setReordering] = React.useState<string | null>(null);

  const handleReorder = async (templateId: string) => {
    if (reordering) return;
    setReordering(templateId);
    try {
      await reorder.mutateAsync(templateId);
    } finally {
      setReordering(null);
    }
  };

  if (isLoading) return null;

  const active = templates.filter((t) => t.isActive);
  if (!active.length) return null;

  return (
    <div className="rounded-xl border border-buyer-200 bg-buyer-50/30 overflow-hidden">
      <div className="flex items-center justify-between border-b border-buyer-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <Repeat className="h-4 w-4 text-buyer-600" />
          <h2 className="text-sm font-semibold text-navy">Standing Orders</h2>
          <span className="rounded-full bg-buyer-500 px-2 py-0.5 text-[10px] font-bold text-white">
            {active.length}
          </span>
        </div>
        <button
          onClick={() => (window.location.href = `/buyer/portal/${sellerSlug}/templates`)}
          className="text-xs text-buyer-500 hover:text-buyer-600 font-medium flex items-center gap-1"
        >
          Manage <ArrowRight className="h-3 w-3" />
        </button>
      </div>
      <div className="divide-y divide-buyer-100">
        {active.map((t) => {
          const nextLabel = nextDeliveryLabel(t.daysOfWeek);
          const dayChips = t.daysOfWeek.sort().map((d) => DAY_NAMES[d]);
          const isReordering = reordering === t.id;
          return (
            <div key={t.id} className="flex items-center gap-4 px-4 py-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-navy truncate">{t.name}</p>
                <div className="mt-1 flex items-center gap-2">
                  <div className="flex items-center gap-1">
                    {dayChips.map((d) => (
                      <span
                        key={d}
                        className="rounded bg-buyer-100 px-1.5 py-0.5 text-[10px] font-medium text-buyer-700"
                      >
                        {d}
                      </span>
                    ))}
                  </div>
                  <span className="text-xs text-navy/70">·</span>
                  <span className="text-xs text-navy/70">
                    {t.items.length} item{t.items.length !== 1 ? "s" : ""}
                  </span>
                </div>
              </div>
              <div className="text-right shrink-0">
                <p
                  className={cn(
                    "text-xs font-semibold",
                    nextLabel === "Today" ? "text-buyer-600" : "text-navy/70",
                  )}
                >
                  {nextLabel}
                </p>
                <button
                  onClick={() => handleReorder(t.id)}
                  disabled={isReordering}
                  className="mt-1 flex items-center gap-1 rounded-lg bg-buyer-500 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-buyer-600 transition-colors disabled:opacity-50"
                >
                  {isReordering ? (
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  ) : (
                    <ShoppingCart className="h-3 w-3" />
                  )}
                  Reorder
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function BuyerDashboardPage() {
  const params = useParams();
  const router = useRouter();
  const { buyer, activeSeller, isLoading: authLoading } = useBuyerAuth();
  const sellerSlug = params.seller as string;

  const [frequentWindow, setFrequentWindow] = React.useState<"30d" | "90d" | "all">("all");
  const { data: dashboard, isLoading, isError } = useBuyerDashboard(frequentWindow);
  const { data: templatesData, isLoading: templatesLoading } = useBuyerTemplates();
  const cart = useBuyerCart(buyer?.id, sellerSlug);
  const templates: OrderTemplate[] = templatesData?.data ?? [];

  React.useEffect(() => {
    if (!authLoading && !activeSeller) router.push("/buyer/portal");
  }, [authLoading, activeSeller, router]);

  if (authLoading || isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-buyer-500" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-6">
        <div className="rounded-lg bg-danger-bg px-4 py-3 text-sm text-danger">
          Failed to load dashboard data. Please try again later.
        </div>
      </div>
    );
  }

  if (!dashboard) return null;

  return (
    <div className="p-6 space-y-6">
      {/* Welcome */}
      <div>
        <h1 className="text-2xl font-bold text-navy">
          Welcome back{activeSeller ? `, ${activeSeller.customer.businessName}` : ""}
        </h1>
        <p className="text-sm text-navy/70 mt-1">Your dashboard at {activeSeller?.tenant.name}</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          {
            icon: ShoppingCart,
            label: "Active Orders",
            value: dashboard.stats.activeOrders,
            color: "text-buyer-600 bg-buyer-50",
          },
          {
            icon: DollarSign,
            label: "This Month",
            value: fmt(dashboard.stats.spend30d),
            color: "text-success bg-success-bg",
          },
          {
            icon: Truck,
            label: "Pending Deliveries",
            value: dashboard.stats.pendingDeliveries,
            color: "text-warning bg-warning-bg",
          },
          {
            icon: Repeat,
            label: "Standing Orders",
            value: dashboard.stats.templateCount,
            color: "text-navy/70 bg-surface-raised",
          },
        ].map((stat) => (
          <div key={stat.label} className="rounded-xl border border-surface-border bg-white p-4">
            <div className="flex items-center gap-3 mb-2">
              <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${stat.color}`}>
                <stat.icon className="h-4 w-4" />
              </div>
              <span className="text-xs text-navy/70">{stat.label}</span>
            </div>
            <p className="text-xl font-bold text-navy">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Standing Orders — front and centre */}
      <StandingOrdersPanel
        sellerSlug={sellerSlug}
        templates={templates}
        isLoading={templatesLoading}
      />

      {/* Frequently Ordered */}
      {dashboard.frequentlyOrdered.length > 0 && (
        <div className="rounded-xl border border-surface-border bg-white overflow-hidden">
          <div className="flex items-center justify-between border-b border-surface-border px-4 py-3">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-semibold text-navy">Frequently Ordered</h2>
              <div className="flex items-center rounded-lg border border-surface-border bg-surface-raised p-0.5">
                {[
                  { value: "30d" as const, label: "30 Days" },
                  { value: "90d" as const, label: "90 Days" },
                  { value: "all" as const, label: "All Time" },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setFrequentWindow(opt.value)}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      frequentWindow === opt.value
                        ? "bg-white text-buyer-600 shadow-sm"
                        : "text-navy/70 hover:text-navy"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <button
              onClick={() => router.push(`/buyer/portal/${sellerSlug}/shop`)}
              className="text-xs text-buyer-500 hover:text-buyer-600 font-medium flex items-center gap-1"
            >
              Browse All <ArrowRight className="h-3 w-3" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-6">
            {dashboard.frequentlyOrdered.slice(0, 6).map((p) => (
              <div
                key={p.productId}
                className="group flex flex-col items-center gap-2 rounded-lg border border-surface-border p-3 hover:shadow-sm transition-shadow"
              >
                <div className="h-14 w-14 rounded-lg bg-surface-raised flex items-center justify-center overflow-hidden">
                  {p.thumbnailUrl ? (
                    <img
                      src={p.thumbnailUrl}
                      alt=""
                      className="h-full w-full object-cover"
                      style={{ objectPosition: objectPositionForUrl(p.thumbnailUrl) }}
                    />
                  ) : (
                    <Package className="h-6 w-6 text-navy/15" />
                  )}
                </div>
                <p className="text-xs font-medium text-navy text-center line-clamp-2">{p.name}</p>
                <p className="text-xs font-bold text-navy">{fmt(p.buyerPrice)}</p>
                <button
                  onClick={() =>
                    cart.addItem({
                      productId: p.productId,
                      qty: 1,
                      name: p.name,
                      unit: p.unit,
                      thumbnailUrl: p.thumbnailUrl,
                    })
                  }
                  className="flex items-center gap-1 rounded-md bg-buyer-500 px-2 py-1 text-[10px] font-semibold text-white hover:bg-buyer-600 transition-colors"
                >
                  <Plus className="h-3 w-3" /> Add
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Orders */}
      {dashboard.recentOrders.length > 0 && (
        <div className="rounded-xl border border-surface-border bg-white overflow-hidden">
          <div className="flex items-center justify-between border-b border-surface-border px-4 py-3">
            <h2 className="text-sm font-semibold text-navy">Recent Orders</h2>
            <button
              onClick={() => router.push(`/buyer/portal/${sellerSlug}/orders`)}
              className="text-xs text-buyer-500 hover:text-buyer-600 font-medium flex items-center gap-1"
            >
              View All <ArrowRight className="h-3 w-3" />
            </button>
          </div>
          <div className="divide-y divide-surface-border">
            {dashboard.recentOrders.map((order) => (
              <button
                key={order.id}
                type="button"
                onClick={() => router.push(`/buyer/portal/${sellerSlug}/orders/${order.id}`)}
                className="flex w-full items-center justify-between px-4 py-3 hover:bg-surface-raised/50 transition-colors text-left"
              >
                <div className="flex items-center gap-4">
                  <div>
                    <p className="text-sm font-medium text-navy">{order.orderNumber}</p>
                    <p className="text-xs text-navy/70">
                      {formatDate(order.createdAt)} · {order.itemCount} items
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant={getStatusVariant(order.status)}>
                    {formatStatus(order.status)}
                  </Badge>
                  <span className="text-sm font-semibold text-navy">{fmt(order.total)}</span>
                  <ChevronRight className="h-4 w-4 text-navy/30" />
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* New from Seller */}
      {dashboard.newFromSeller.length > 0 && (
        <div className="rounded-xl border border-surface-border bg-white overflow-hidden">
          <div className="flex items-center justify-between border-b border-surface-border px-4 py-3">
            <h2 className="text-sm font-semibold text-navy">
              New from {activeSeller?.tenant.name}
            </h2>
            <button
              onClick={() => router.push(`/buyer/portal/${sellerSlug}/shop`)}
              className="text-xs text-buyer-500 hover:text-buyer-600 font-medium flex items-center gap-1"
            >
              Browse All <ArrowRight className="h-3 w-3" />
            </button>
          </div>
          <div className="flex gap-3 overflow-x-auto p-4">
            {dashboard.newFromSeller.map((p) => (
              <div
                key={p.id}
                className="flex-shrink-0 w-36 flex flex-col items-center gap-2 rounded-lg border border-surface-border p-3"
              >
                <div className="h-16 w-16 rounded-lg bg-surface-raised flex items-center justify-center overflow-hidden">
                  {p.thumbnailUrl ? (
                    <img
                      src={p.thumbnailUrl}
                      alt=""
                      className="h-full w-full object-cover"
                      style={{ objectPosition: objectPositionForUrl(p.thumbnailUrl) }}
                    />
                  ) : (
                    <Package className="h-7 w-7 text-navy/15" />
                  )}
                </div>
                <p className="text-xs font-medium text-navy text-center line-clamp-2">{p.name}</p>
                <p className="text-xs font-bold text-navy">{fmt(p.buyerPrice)}</p>
                <button
                  onClick={() =>
                    cart.addItem({
                      productId: p.id,
                      qty: 1,
                      name: p.name,
                      unit: p.unit,
                      thumbnailUrl: p.thumbnailUrl,
                    })
                  }
                  className="flex items-center gap-1 rounded-md bg-buyer-500 px-2 py-1 text-[10px] font-semibold text-white hover:bg-buyer-600 transition-colors"
                >
                  <Plus className="h-3 w-3" /> Add
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Featured Items */}
      {dashboard.featuredItems && dashboard.featuredItems.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/30 overflow-hidden">
          <div className="flex items-center justify-between border-b border-amber-200 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="text-amber-500 text-base">⭐</span>
              <h2 className="text-sm font-semibold text-navy">
                Featured by {activeSeller?.tenant.name}
              </h2>
            </div>
            <button
              onClick={() => router.push(`/buyer/portal/${sellerSlug}/shop`)}
              className="text-xs text-buyer-500 hover:text-buyer-600 font-medium flex items-center gap-1"
            >
              Browse All <ArrowRight className="h-3 w-3" />
            </button>
          </div>
          <div className="flex gap-3 overflow-x-auto p-4">
            {dashboard.featuredItems.map((p) => (
              <div
                key={p.id}
                className="flex-shrink-0 w-36 flex flex-col items-center gap-2 rounded-lg border border-amber-200 bg-white p-3"
              >
                <div className="h-16 w-16 rounded-lg bg-surface-raised flex items-center justify-center overflow-hidden">
                  {p.thumbnailUrl ? (
                    <img
                      src={p.thumbnailUrl}
                      alt=""
                      className="h-full w-full object-cover"
                      style={{ objectPosition: objectPositionForUrl(p.thumbnailUrl) }}
                    />
                  ) : (
                    <Package className="h-7 w-7 text-navy/15" />
                  )}
                </div>
                <p className="text-xs font-medium text-navy text-center line-clamp-2">{p.name}</p>
                <p className="text-xs font-bold text-navy">{fmt(p.buyerPrice)}</p>
                <button
                  onClick={() =>
                    cart.addItem({
                      productId: p.id,
                      qty: 1,
                      name: p.name,
                      unit: p.unit,
                      thumbnailUrl: p.thumbnailUrl,
                    })
                  }
                  className="flex items-center gap-1 rounded-md bg-buyer-500 px-2 py-1 text-[10px] font-semibold text-white hover:bg-buyer-600 transition-colors"
                >
                  <Plus className="h-3 w-3" /> Add
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Suggested for You */}
      {dashboard.suggestedItems && dashboard.suggestedItems.length > 0 && (
        <div className="rounded-xl border border-surface-border bg-white overflow-hidden">
          <div className="flex items-center justify-between border-b border-surface-border px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-navy">Suggested for You</h2>
              <p className="text-[11px] text-navy/70 mt-0.5">
                Products from categories you order from but haven&apos;t tried yet
              </p>
            </div>
            <button
              onClick={() => router.push(`/buyer/portal/${sellerSlug}/shop`)}
              className="text-xs text-buyer-500 hover:text-buyer-600 font-medium flex items-center gap-1"
            >
              Browse All <ArrowRight className="h-3 w-3" />
            </button>
          </div>
          <div className="flex gap-3 overflow-x-auto p-4">
            {dashboard.suggestedItems.map((p) => (
              <div
                key={p.id}
                className="flex-shrink-0 w-36 flex flex-col items-center gap-2 rounded-lg border border-buyer-100 bg-buyer-50/30 p-3"
              >
                <div className="h-16 w-16 rounded-lg bg-surface-raised flex items-center justify-center overflow-hidden">
                  {p.thumbnailUrl ? (
                    <img
                      src={p.thumbnailUrl}
                      alt=""
                      className="h-full w-full object-cover"
                      style={{ objectPosition: objectPositionForUrl(p.thumbnailUrl) }}
                    />
                  ) : (
                    <Package className="h-7 w-7 text-navy/15" />
                  )}
                </div>
                {p.category && (
                  <span className="rounded-full bg-buyer-100 px-2 py-0.5 text-[9px] font-medium text-buyer-600">
                    {p.category}
                  </span>
                )}
                <p className="text-xs font-medium text-navy text-center line-clamp-2">{p.name}</p>
                <p className="text-xs font-bold text-navy">{fmt(p.buyerPrice)}</p>
                <button
                  onClick={() =>
                    cart.addItem({
                      productId: p.id,
                      qty: 1,
                      name: p.name,
                      unit: p.unit,
                      thumbnailUrl: p.thumbnailUrl,
                    })
                  }
                  className="flex items-center gap-1 rounded-md bg-buyer-500 px-2 py-1 text-[10px] font-semibold text-white hover:bg-buyer-600 transition-colors"
                >
                  <Plus className="h-3 w-3" /> Add
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Spend summary */}
      <div className="rounded-xl border border-surface-border bg-white p-4">
        <h2 className="text-sm font-semibold text-navy mb-3">Spending Summary</h2>
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: "Last 30 Days", value: dashboard.stats.spend30d },
            { label: "Last 90 Days", value: dashboard.stats.spend90d },
            { label: "All Time", value: dashboard.stats.spendAllTime },
          ].map((s) => (
            <div key={s.label} className="text-center">
              <p className="text-xs text-navy/70 mb-1">{s.label}</p>
              <p className="text-lg font-bold text-navy">{fmt(s.value)}</p>
            </div>
          ))}
        </div>
      </div>

      {/* PWA install — only when cart is empty */}
      {cart.itemCount === 0 && <PwaInstallPrompt />}

      {/* Quick action */}
      <div className="flex items-center justify-center gap-4">
        <Button variant="secondary" onClick={() => router.push(`/buyer/portal/${sellerSlug}/shop`)}>
          <Store className="mr-1.5 h-4 w-4" /> Browse Products
        </Button>
        {cart.itemCount > 0 && (
          <Button
            className="bg-buyer-500 hover:bg-buyer-600 focus-visible:ring-buyer-500"
            onClick={() => router.push(`/buyer/portal/${sellerSlug}/cart`)}
          >
            <ShoppingCart className="mr-1.5 h-4 w-4" /> View Cart ({cart.totalQty})
          </Button>
        )}
      </div>
    </div>
  );
}
