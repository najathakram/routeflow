"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  Grid3X3,
  List,
  ShoppingCart,
  Plus,
  Loader2,
  Package,
  ChevronLeft,
  ChevronRight,
  Heart,
  Lock,
} from "lucide-react";
import { Button } from "@routeflow/ui/web";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import {
  useBuyerProducts,
  useBuyerCatalogCounts,
  useBuyerPromotions,
  useBuyerReplenishment,
  useBuyerFavorites,
  useBuyerAddFavorite,
  useBuyerRemoveFavorite,
  useBuyerStockAlerts,
  useSubscribeStockAlert,
  useUnsubscribeStockAlert,
  toPromotionRules,
  type LockedCategory,
} from "@/lib/api/buyer";
import { promotionRuleLabel } from "@/lib/api/promotions";
import { useBuyerCart } from "@/lib/buyer-cart";
import { objectPositionForUrl } from "@/lib/image-focal";
import { QtyStepper } from "./_components/QtyStepper";
import { ProductTile } from "./_components/ProductTile";
import { CategoryRail, type RailSelection } from "./_components/CategoryRail";
import { RunningLowStrip } from "./_components/RunningLowStrip";
import { ShopSearch } from "./_components/ShopSearch";
import { deriveTilePrice } from "./_components/tile-pricing";

// ─── Grid density ─────────────────────────────────────────────────────────────
// Persisted density control — default "md" is one notch denser than the
// original hardcoded grid ("lg" preserves that original size). ProductTile
// imports this type to type its `size` prop.

export type ShopDensity = "sm" | "md" | "lg";

const DENSITY_STORAGE_KEY = "rf:buyer:shop:density";
const VIEW_STORAGE_KEY = "rf:buyer:shop:view";

// Static full class strings only — Tailwind's scanner cannot see interpolated
// class names, so this map is looked up by key, never built from a template.
const GRID_CLASS_BY_DENSITY: Record<ShopDensity, string> = {
  lg: "grid grid-cols-2 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
  md: "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5",
  sm: "grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function isSameSelection(a: RailSelection, b: RailSelection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "category" && b.kind === "category") return a.name === b.name;
  if (a.kind === "collection" && b.kind === "collection") return a.collection === b.collection;
  if (a.kind === "locked" && b.kind === "locked") return a.id === b.id;
  return true; // "all"
}

interface PillItem {
  key: string;
  label: string;
  count: number | null;
  selection: RailSelection;
  locked?: boolean;
}

// ─── Locked-categories unlock tile (W7b) ──────────────────────────────────────

function lockedStatusCopy(status: LockedCategory["status"]): string {
  switch (status) {
    case "PENDING_REVIEW":
      return "License pending review";
    case "EXPIRED":
      return "License expired — renew to unlock";
    case "REJECTED":
      return "License not approved";
    default:
      return "Requires a verified license";
  }
}

function LockedCategoriesTile({
  categories,
  sellerName,
}: {
  categories: LockedCategory[];
  sellerName?: string;
}) {
  if (categories.length === 0) return null;
  return (
    <div className="mb-5 rounded-xl border border-amber-300 bg-amber-50 p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700">
          <Lock className="h-4 w-4" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-navy">
            {categories.length === 1
              ? "1 category is locked"
              : `${categories.length} categories are locked`}
          </h3>
          <p className="mt-0.5 text-xs text-navy/70">
            These products unlock once {sellerName ?? "your seller"} verifies your license. Contact
            them to get set up.
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {categories.map((c) => (
              <li
                key={c.id}
                className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-white px-2.5 py-1 text-xs"
              >
                <span className="font-medium text-navy">{c.name}</span>
                <span className="text-navy/60">· {lockedStatusCopy(c.status)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BuyerShopPage() {
  const params = useParams();
  const router = useRouter();
  const { buyer, activeSeller, isLoading: authLoading } = useBuyerAuth();
  const sellerSlug = params.seller as string;

  const [selection, setSelection] = React.useState<RailSelection>({ kind: "all" });
  const [search, setSearch] = React.useState("");
  const [sort, setSort] = React.useState("best");
  const [page, setPage] = React.useState(1);
  const [viewMode, setViewMode] = React.useState<"grid" | "list">("grid");
  const [density, setDensity] = React.useState<ShopDensity>("md");
  const limit = 20;

  // Hydration-safe: state initializes to the default above; only after mount
  // do we read the persisted choices, so server- and first-client-render HTML
  // always match.
  React.useEffect(() => {
    const storedView = window.localStorage.getItem(VIEW_STORAGE_KEY);
    if (storedView === "grid" || storedView === "list") setViewMode(storedView);
    const storedDensity = window.localStorage.getItem(DENSITY_STORAGE_KEY);
    if (storedDensity === "sm" || storedDensity === "md" || storedDensity === "lg") {
      setDensity(storedDensity);
    }
  }, []);

  const handleSetViewMode = (mode: "grid" | "list") => {
    setViewMode(mode);
    window.localStorage.setItem(VIEW_STORAGE_KEY, mode);
  };

  const handleSetDensity = (next: ShopDensity) => {
    setDensity(next);
    window.localStorage.setItem(DENSITY_STORAGE_KEY, next);
  };

  // The product query tracks the last NON-locked selection. Selecting a
  // locked rail/pill entry only opens the info panel below — it must never
  // issue a product request (the gate already hides those products server
  // side, so the panel is pure UI over `computeGate().locked` metadata).
  // Holding the effective filter steady while `selection.kind === "locked"`
  // keeps useBuyerProducts' queryKey unchanged on that click, so no new
  // fetch fires.
  const [heldSelection, setHeldSelection] = React.useState<RailSelection>({ kind: "all" });
  React.useEffect(() => {
    if (selection.kind !== "locked") setHeldSelection(selection);
  }, [selection]);

  // Reset page on filter/search/sort change — keyed on the held/effective
  // filter so opening the locked panel doesn't reset pagination on a fetch
  // that's intentionally not being re-issued.
  React.useEffect(() => {
    setPage(1);
  }, [heldSelection, search, sort]);

  const {
    data: result,
    isLoading,
    isError,
  } = useBuyerProducts({
    search: search || undefined,
    category: heldSelection.kind === "category" ? heldSelection.name : undefined,
    collection: heldSelection.kind === "collection" ? heldSelection.collection : undefined,
    page,
    limit,
    sort,
  });
  const { data: counts } = useBuyerCatalogCounts();
  const { data: promotions } = useBuyerPromotions();
  const { data: estimates } = useBuyerReplenishment();
  const { data: favorites } = useBuyerFavorites();
  const addFavorite = useBuyerAddFavorite();
  const removeFavorite = useBuyerRemoveFavorite();
  const { data: stockAlerts } = useBuyerStockAlerts();
  const subscribeStockAlert = useSubscribeStockAlert();
  const unsubscribeStockAlert = useUnsubscribeStockAlert();

  const cart = useBuyerCart(buyer?.id, sellerSlug);

  const promoRules = React.useMemo(() => toPromotionRules(promotions), [promotions]);
  const estimateByProduct = React.useMemo(
    () => new Map((estimates ?? []).map((e) => [e.productId, e])),
    [estimates],
  );

  // Build a set of favorite product IDs for quick lookup
  const favoriteIds = React.useMemo(
    () => new Set((favorites ?? []).map((f) => f.productId)),
    [favorites],
  );

  const toggleFavorite = (productId: string) => {
    if (favoriteIds.has(productId)) {
      removeFavorite.mutate(productId);
    } else {
      addFavorite.mutate(productId);
    }
  };

  // Build a set of product IDs with a PENDING restock alert (P5-03).
  const alertIds = React.useMemo(() => new Set(stockAlerts?.productIds ?? []), [stockAlerts]);

  const toggleStockAlert = (productId: string) => {
    if (alertIds.has(productId)) {
      unsubscribeStockAlert.mutate(productId);
    } else {
      subscribeStockAlert.mutate(productId);
    }
  };

  // Redirect checks
  React.useEffect(() => {
    if (!authLoading && !activeSeller) router.push("/buyer/portal");
  }, [authLoading, activeSeller, router]);

  const products = result?.data ?? [];
  const meta = result?.meta;
  const lockedCategories = counts?.lockedCategories ?? result?.hiddenCategories ?? [];
  const lockedCategory =
    selection.kind === "locked" ? lockedCategories.find((c) => c.id === selection.id) : undefined;
  const activePromo = promotions?.[0];

  // Mobile/tablet horizontal pill rail — same selection model as CategoryRail,
  // rendered below `lg`. Hide zero-count collections except Favorites.
  const pillItems: PillItem[] = React.useMemo(() => {
    if (!counts) return [];
    const items: PillItem[] = [
      { key: "all", label: "All products", count: counts.total, selection: { kind: "all" } },
    ];
    if (counts.collections.usuals > 0) {
      items.push({
        key: "usuals",
        label: "Your usuals",
        count: counts.collections.usuals,
        selection: { kind: "collection", collection: "usuals" },
      });
    }
    items.push({
      key: "favorites",
      label: "Favorites",
      count: counts.collections.favorites,
      selection: { kind: "collection", collection: "favorites" },
    });
    if (counts.collections.new > 0) {
      items.push({
        key: "new",
        label: "New this month",
        count: counts.collections.new,
        selection: { kind: "collection", collection: "new" },
      });
    }
    if (counts.collections.deals > 0) {
      items.push({
        key: "deals",
        label: "Deals",
        count: counts.collections.deals,
        selection: { kind: "collection", collection: "deals" },
      });
    }
    for (const c of counts.categories) {
      items.push({
        key: `cat-${c.name}`,
        label: c.name,
        count: c.count,
        selection: { kind: "category", name: c.name },
      });
    }
    for (const l of counts.lockedCategories) {
      items.push({
        key: `locked-${l.id}`,
        label: l.name,
        count: null,
        selection: { kind: "locked", id: l.id },
        locked: true,
      });
    }
    return items;
  }, [counts]);

  return (
    <div className="flex flex-col min-h-full">
      <div className="flex-1 p-6">
        {/* Header */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-navy">Shop</h1>
            <p className="text-sm text-navy/70 mt-1">
              Browse products from {activeSeller?.tenant.name}
            </p>
          </div>
          <div className="flex flex-1 flex-wrap items-center justify-end gap-3 sm:flex-nowrap">
            <ShopSearch value={search} onCommit={setSearch} total={counts?.total} />

            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="h-10 rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-buyer-500 focus:outline-none focus:ring-1 focus:ring-buyer-500"
            >
              <option value="best">Best for you</option>
              <option value="name_asc">Name A-Z</option>
              <option value="name_desc">Name Z-A</option>
              <option value="price_asc">Price: Low to High</option>
              <option value="price_desc">Price: High to Low</option>
            </select>

            {/* View toggle */}
            <div className="flex items-center rounded-lg border border-surface-border bg-white">
              <button
                onClick={() => handleSetViewMode("grid")}
                className={`rounded-l-lg p-2.5 transition-colors ${viewMode === "grid" ? "bg-buyer-50 text-buyer-600" : "text-navy/70 hover:text-navy"}`}
              >
                <Grid3X3 className="h-4 w-4" />
              </button>
              <button
                onClick={() => handleSetViewMode("list")}
                className={`rounded-r-lg p-2.5 transition-colors ${viewMode === "list" ? "bg-buyer-50 text-buyer-600" : "text-navy/70 hover:text-navy"}`}
              >
                <List className="h-4 w-4" />
              </button>
            </div>

            {/* Density control — grid mode only */}
            {viewMode === "grid" && (
              <div
                className="flex items-center rounded-lg border border-surface-border bg-white"
                data-testid="density-toggle"
              >
                <button
                  onClick={() => handleSetDensity("sm")}
                  title="Compact"
                  aria-label="Compact"
                  data-testid="density-sm"
                  className={`rounded-l-lg px-2.5 py-2 text-xs font-semibold transition-colors ${density === "sm" ? "bg-buyer-50 text-buyer-600" : "text-navy/70 hover:text-navy"}`}
                >
                  S
                </button>
                <button
                  onClick={() => handleSetDensity("md")}
                  title="Standard"
                  aria-label="Standard"
                  data-testid="density-md"
                  className={`px-2.5 py-2 text-xs font-semibold transition-colors ${density === "md" ? "bg-buyer-50 text-buyer-600" : "text-navy/70 hover:text-navy"}`}
                >
                  M
                </button>
                <button
                  onClick={() => handleSetDensity("lg")}
                  title="Large"
                  aria-label="Large"
                  data-testid="density-lg"
                  className={`rounded-r-lg px-2.5 py-2 text-xs font-semibold transition-colors ${density === "lg" ? "bg-buyer-50 text-buyer-600" : "text-navy/70 hover:text-navy"}`}
                >
                  L
                </button>
              </div>
            )}
          </div>
        </div>

        {/* P5-07: running-low strip — same /buyer/shelf data as Your Shelf */}
        <RunningLowStrip sellerSlug={sellerSlug} cart={cart} />

        <div className="lg:grid lg:grid-cols-[210px_1fr] lg:gap-5">
          {/* Category rail (>= lg) */}
          <div className="hidden lg:block">
            <CategoryRail counts={counts} selection={selection} onSelect={setSelection} />
          </div>

          <div className="min-w-0">
            {/* Mobile/tablet: horizontal pill rail reusing the same selection model */}
            {pillItems.length > 0 && (
              <div className="mb-4 flex gap-2 overflow-x-auto pb-1 lg:hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {pillItems.map((item) => (
                  <button
                    key={item.key}
                    onClick={() => setSelection(item.selection)}
                    className={`flex flex-shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                      isSameSelection(selection, item.selection)
                        ? "border-buyer-500 bg-buyer-500 text-white"
                        : item.locked
                          ? "border-surface-border bg-white text-navy/40"
                          : "border-surface-border bg-white text-navy/70 hover:border-buyer-300 hover:text-buyer-600"
                    }`}
                  >
                    {item.locked && <Lock className="h-3 w-3" />}
                    {item.label}
                    {item.count != null && (
                      <span className="text-[10px] opacity-70">({item.count})</span>
                    )}
                  </button>
                ))}
              </div>
            )}

            {/* P5-04 deal banner */}
            {activePromo && (
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-buyer-200 bg-buyer-50 px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className="rounded-full bg-buyer-500 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
                    Deal
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-navy">
                      {activePromo.bannerText ?? activePromo.name}
                    </p>
                    <p className="text-xs text-navy/70">
                      {promotionRuleLabel(activePromo)} · applied automatically at checkout · ends{" "}
                      {new Date(activePromo.endsAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setSelection({ kind: "collection", collection: "deals" })}
                  className="flex-shrink-0 rounded-lg border border-buyer-300 bg-white px-3 py-1.5 text-xs font-semibold text-buyer-700 hover:bg-buyer-100 transition-colors"
                >
                  Shop the deal
                </button>
              </div>
            )}

            {/* W7b: regulated categories the buyer isn't licensed for */}
            {lockedCategories.length > 0 && (
              <LockedCategoriesTile
                categories={lockedCategories}
                sellerName={activeSeller?.tenant.name}
              />
            )}

            {selection.kind === "locked" ? (
              /* Locked-category info panel — never requests product data. */
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-surface-border bg-white p-12 text-center">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-700">
                  <Lock className="h-5 w-5" />
                </div>
                <h2 className="mb-1 text-lg font-semibold text-navy">
                  {lockedCategory?.name ?? "Locked category"}
                </h2>
                <p className="mb-1 text-sm text-navy/70">
                  {lockedStatusCopy(lockedCategory?.status ?? "NONE")}
                </p>
                <p className="mb-4 max-w-sm text-sm text-navy/70">
                  These products unlock once {activeSeller?.tenant.name ?? "your seller"} verifies
                  your license.
                </p>
                <Link
                  href={`/buyer/portal/${sellerSlug}/licenses`}
                  className="text-sm font-semibold text-buyer-600 hover:underline"
                >
                  Manage licenses
                </Link>
              </div>
            ) : (
              <>
                {/* Results count */}
                {meta && (
                  <p className="mb-4 text-xs text-navy/70">
                    Showing {meta.total === 0 ? 0 : (page - 1) * limit + 1} to{" "}
                    {Math.min(page * limit, meta.total)} of {meta.total} products
                  </p>
                )}

                {/* Loading / Error / Empty / Products */}
                {isError ? (
                  <div className="rounded-xl border border-danger/30 bg-danger-bg p-8 text-center">
                    <p className="text-sm text-danger">
                      Failed to load products. Please try again later.
                    </p>
                  </div>
                ) : isLoading ? (
                  <div className="flex items-center justify-center py-16">
                    <Loader2 className="h-8 w-8 animate-spin text-buyer-500" />
                  </div>
                ) : products.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-surface-border bg-white p-12 text-center">
                    <Package className="mx-auto mb-4 h-12 w-12 text-navy/20" />
                    <h2 className="text-lg font-semibold text-navy mb-2">No products found</h2>
                    <p className="text-sm text-navy/70 mb-4">
                      {search || selection.kind !== "all"
                        ? "Try adjusting your search or filters."
                        : "No products available from this seller yet."}
                    </p>
                    {(search || selection.kind !== "all") && (
                      <button
                        onClick={() => {
                          setSearch("");
                          setSelection({ kind: "all" });
                        }}
                        className="text-sm text-buyer-500 hover:underline"
                      >
                        Clear all filters
                      </button>
                    )}
                  </div>
                ) : viewMode === "grid" ? (
                  <div className={GRID_CLASS_BY_DENSITY[density]} data-testid="product-grid">
                    {products.map((p) => (
                      <ProductTile
                        key={p.id}
                        product={p}
                        sellerSlug={sellerSlug}
                        size={density}
                        cartItem={cart.items.find((i) => i.productId === p.id)}
                        promoRules={promoRules}
                        promotions={promotions}
                        estimate={estimateByProduct.get(p.id)}
                        isFavorite={favoriteIds.has(p.id)}
                        onAdd={() =>
                          cart.addItem({
                            productId: p.id,
                            qty: p.unitsPerBox ? p.unitsPerBox : 1,
                            name: p.name,
                            unit: p.unit,
                            thumbnailUrl: p.thumbnailUrl,
                            unitsPerBox: p.unitsPerBox,
                            boxes: p.unitsPerBox ? 1 : undefined,
                            pieces: p.unitsPerBox ? 0 : undefined,
                          })
                        }
                        onUpdateQty={(qty) => cart.updateQty(p.id, qty)}
                        onToggleFavorite={() => toggleFavorite(p.id)}
                        isAlertSubscribed={alertIds.has(p.id)}
                        onToggleStockAlert={() => toggleStockAlert(p.id)}
                      />
                    ))}
                  </div>
                ) : (
                  /* List view */
                  <div className="rounded-xl border border-surface-border bg-white overflow-hidden">
                    <div className="overflow-x-auto">
                    <table className="w-full min-w-[640px]">
                      <thead>
                        <tr className="border-b border-surface-border bg-surface-raised text-xs text-navy/70 uppercase tracking-wider">
                          <th className="px-4 py-2.5 text-left">Product</th>
                          <th className="px-4 py-2.5 text-left w-28">Category</th>
                          <th className="px-4 py-2.5 text-left w-24">SKU</th>
                          <th className="px-4 py-2.5 text-right w-28">Price</th>
                          <th className="px-4 py-2.5 text-right w-44">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-surface-border">
                        {products.map((p) => {
                          const qty = cart.getItemQty(p.id);
                          const cartItem = cart.items.find((i) => i.productId === p.id);
                          const priced = deriveTilePrice(p, promoRules, cartItem);
                          return (
                            <tr
                              key={p.id}
                              className="hover:bg-surface-raised/50"
                              data-testid="product-tile"
                            >
                              <td className="px-4 py-3">
                                <Link
                                  href={`/buyer/portal/${sellerSlug}/shop/${p.id}`}
                                  data-testid="product-tile-link"
                                  className="flex items-center gap-3"
                                >
                                  <div className="h-10 w-10 flex-shrink-0 rounded-lg bg-surface-raised flex items-center justify-center overflow-hidden">
                                    {p.thumbnailUrl ? (
                                      <img
                                        src={p.thumbnailUrl}
                                        alt=""
                                        className="h-full w-full object-cover"
                                        style={{
                                          objectPosition: objectPositionForUrl(p.thumbnailUrl),
                                        }}
                                      />
                                    ) : (
                                      <Package className="h-5 w-5 text-navy/15" />
                                    )}
                                  </div>
                                  <div>
                                    <p className="text-sm font-medium text-navy">{p.name}</p>
                                    <p className="text-xs text-navy/70">per {p.unit}</p>
                                  </div>
                                </Link>
                              </td>
                              <td className="px-4 py-3 text-xs text-navy/70">
                                {p.category ?? "N/A"}
                              </td>
                              <td className="px-4 py-3 text-xs text-navy/70">{p.sku ?? "N/A"}</td>
                              <td className="px-4 py-3 text-right">
                                {priced.originalPrice != null && (
                                  <p className="text-[11px] text-navy/40 line-through">
                                    {fmt(priced.originalPrice)}
                                  </p>
                                )}
                                <p className="text-sm font-semibold text-navy">
                                  {fmt(priced.unitPrice)}
                                </p>
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex items-center justify-end gap-2">
                                  <button
                                    onClick={() => toggleFavorite(p.id)}
                                    className={`rounded p-1.5 transition-colors ${
                                      favoriteIds.has(p.id)
                                        ? "text-danger hover:bg-danger-bg"
                                        : "text-navy/30 hover:text-danger"
                                    }`}
                                    title={
                                      favoriteIds.has(p.id)
                                        ? "Remove from favorites"
                                        : "Add to favorites"
                                    }
                                  >
                                    <Heart
                                      className={`h-4 w-4 ${favoriteIds.has(p.id) ? "fill-current" : ""}`}
                                    />
                                  </button>
                                  {qty > 0 ? (
                                    <QtyStepper
                                      qty={qty}
                                      onUpdate={(n) => cart.updateQty(p.id, n)}
                                      onRemove={() => cart.updateQty(p.id, 0)}
                                      size="sm"
                                    />
                                  ) : (
                                    <button
                                      onClick={() =>
                                        cart.addItem({
                                          productId: p.id,
                                          qty: p.unitsPerBox ? p.unitsPerBox : 1,
                                          name: p.name,
                                          unit: p.unit,
                                          thumbnailUrl: p.thumbnailUrl,
                                          unitsPerBox: p.unitsPerBox,
                                          boxes: p.unitsPerBox ? 1 : undefined,
                                          pieces: p.unitsPerBox ? 0 : undefined,
                                        })
                                      }
                                      className="flex items-center gap-1 rounded-lg bg-buyer-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-buyer-600 transition-colors"
                                    >
                                      <Plus className="h-3.5 w-3.5" /> Add
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    </div>
                  </div>
                )}

                {/* Pagination */}
                {meta && meta.totalPages > 1 && (
                  <div className="mt-6 flex items-center justify-between">
                    <p className="text-sm text-navy/70">
                      Page {meta.page} of {meta.totalPages}
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setPage((p) => p - 1)}
                        disabled={page === 1}
                        className="flex h-8 w-8 items-center justify-center rounded-lg border border-surface-border bg-white text-navy/70 hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                      <span className="text-sm text-navy">
                        {meta.page} / {meta.totalPages}
                      </span>
                      <button
                        onClick={() => setPage((p) => p + 1)}
                        disabled={page === meta.totalPages}
                        className="flex h-8 w-8 items-center justify-center rounded-lg border border-surface-border bg-white text-navy/70 hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Sticky cart bar */}
      {cart.itemCount > 0 && (
        <div className="sticky bottom-0 border-t border-surface-border bg-white px-6 py-3 shadow-lg">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-buyer-500 text-white">
                <ShoppingCart className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-semibold text-navy">
                  {cart.totalQty} {cart.totalQty === 1 ? "item" : "items"} in cart
                </p>
                <p className="text-xs text-navy/70">
                  {cart.itemCount} {cart.itemCount === 1 ? "product" : "products"}
                </p>
              </div>
            </div>
            <Button onClick={() => router.push(`/buyer/portal/${sellerSlug}/cart`)}>
              <ShoppingCart className="mr-1.5 h-4 w-4" /> View Cart
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
