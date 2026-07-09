"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Search,
  Grid3X3,
  List,
  ShoppingCart,
  Plus,
  Minus,
  Loader2,
  Package,
  ChevronLeft,
  ChevronRight,
  X,
  Heart,
  Lock,
} from "lucide-react";
import { Button } from "@routeflow/ui/web";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import {
  useBuyerProducts,
  useBuyerCategories,
  useBuyerFavorites,
  useBuyerAddFavorite,
  useBuyerRemoveFavorite,
  type BuyerProduct,
  type LockedCategory,
} from "@/lib/api/buyer";
import { useBuyerCart } from "@/lib/buyer-cart";
import { objectPositionForUrl } from "@/lib/image-focal";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

// ─── Quantity Stepper ─────────────────────────────────────────────────────────

function QtyStepper({
  qty,
  onUpdate,
  onRemove,
  size = "md",
}: {
  qty: number;
  onUpdate: (qty: number) => void;
  onRemove: () => void;
  size?: "sm" | "md";
}) {
  const [inputVal, setInputVal] = React.useState(String(qty));

  // Keep in sync when external qty changes (e.g. cart updated from elsewhere)
  React.useEffect(() => {
    setInputVal(String(qty));
  }, [qty]);

  const commit = (raw: string) => {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n > 0) {
      onUpdate(n);
      setInputVal(String(n));
    } else {
      // Revert to current qty if invalid
      setInputVal(String(qty));
    }
  };

  const btnCls =
    size === "sm"
      ? "p-1 text-buyer-600 hover:bg-buyer-100 transition-colors"
      : "p-1.5 text-buyer-600 hover:bg-buyer-100 transition-colors";

  const iconCls = size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5";
  const inputW = size === "sm" ? "w-7" : "w-8";

  return (
    <div className="flex items-center gap-1">
      {/* Red X remove button */}
      <button
        onClick={onRemove}
        className="flex items-center justify-center rounded p-0.5 text-danger/60 hover:bg-danger/10 hover:text-danger transition-colors"
        title="Remove from cart"
      >
        <X className={iconCls} />
      </button>

      {/* Stepper group */}
      <div
        className={`flex items-center rounded-lg border border-buyer-200 bg-buyer-50 ${size === "sm" ? "gap-0" : "gap-0"}`}
      >
        <button
          onClick={() => {
            if (qty > 1) onUpdate(qty - 1);
          }}
          className={`rounded-l-lg ${btnCls}`}
          disabled={qty <= 1}
        >
          <Minus className={iconCls} />
        </button>
        <input
          type="number"
          min={1}
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setInputVal(String(qty));
              e.currentTarget.blur();
            }
          }}
          className={`${inputW} border-none bg-transparent text-center text-sm font-semibold text-buyer-700 focus:outline-none focus:ring-1 focus:ring-buyer-400 rounded [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
        />
        <button onClick={() => onUpdate(qty + 1)} className={`rounded-r-lg ${btnCls}`}>
          <Plus className={iconCls} />
        </button>
      </div>
    </div>
  );
}

// ─── Product Card ─────────────────────────────────────────────────────────────

function ProductCard({
  product,
  cartQty,
  isFavorite,
  onAdd,
  onUpdateQty,
  onToggleFavorite,
}: {
  product: BuyerProduct;
  cartQty: number;
  isFavorite: boolean;
  onAdd: () => void;
  onUpdateQty: (qty: number) => void;
  onToggleFavorite: () => void;
}) {
  return (
    <div className="group flex flex-col rounded-xl border border-surface-border bg-white overflow-hidden hover:shadow-md transition-shadow">
      {/* Image */}
      <div className="relative aspect-square bg-surface-raised flex items-center justify-center overflow-hidden">
        {product.thumbnailUrl ? (
          <img
            src={product.thumbnailUrl}
            alt={product.name}
            className="h-full w-full object-cover"
            style={{ objectPosition: objectPositionForUrl(product.thumbnailUrl) }}
          />
        ) : (
          <Package className="h-12 w-12 text-navy/15" />
        )}
        {/* Favorite heart */}
        <button
          onClick={onToggleFavorite}
          className={`absolute top-2 right-2 flex h-8 w-8 items-center justify-center rounded-full shadow-sm transition-colors ${
            isFavorite
              ? "bg-danger/10 text-danger hover:bg-danger hover:text-white"
              : "bg-white/90 text-navy/30 hover:text-danger"
          }`}
          title={isFavorite ? "Remove from favorites" : "Add to favorites"}
        >
          <Heart className={`h-4 w-4 ${isFavorite ? "fill-current" : ""}`} />
        </button>
        {product.category && (
          <span className="absolute top-2 left-2 rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-medium text-navy/70 shadow-sm">
            {product.category}
          </span>
        )}
        {product.isFeatured && (
          <span className="absolute bottom-2 left-2 rounded-full bg-amber-400 px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm">
            Featured
          </span>
        )}
      </div>

      {/* Info */}
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-navy line-clamp-2">{product.name}</h3>
          {product.sku && <p className="text-[11px] text-navy/70 mt-0.5">SKU: {product.sku}</p>}
        </div>

        <div className="flex items-end justify-between gap-2">
          <div>
            <p className="text-lg font-bold text-navy">{fmt(product.buyerPrice)}</p>
            <p className="text-[11px] text-navy/70">
              per {product.unit}
              {product.unitsPerBox ? ` (${product.unitsPerBox}/box)` : ""}
            </p>
          </div>

          {cartQty > 0 ? (
            <QtyStepper qty={cartQty} onUpdate={onUpdateQty} onRemove={() => onUpdateQty(0)} />
          ) : (
            <button
              onClick={onAdd}
              className="flex items-center gap-1.5 rounded-lg bg-buyer-500 px-3 py-2 text-xs font-semibold text-white hover:bg-buyer-600 transition-colors"
            >
              <Plus className="h-3.5 w-3.5" /> Add
            </button>
          )}
        </div>
      </div>
    </div>
  );
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

  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [category, setCategory] = React.useState("");
  const [sort, setSort] = React.useState("name_asc");
  const [page, setPage] = React.useState(1);
  const [viewMode, setViewMode] = React.useState<"grid" | "list">("grid");
  const limit = 20;

  // Debounce search
  React.useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  // Reset page on filter change
  React.useEffect(() => {
    setPage(1);
  }, [category, sort]);

  const {
    data: result,
    isLoading,
    isError,
  } = useBuyerProducts({
    search: debouncedSearch || undefined,
    category: category || undefined,
    page,
    limit,
    sort,
  });
  const { data: categories = [] } = useBuyerCategories();
  const { data: favorites } = useBuyerFavorites();
  const addFavorite = useBuyerAddFavorite();
  const removeFavorite = useBuyerRemoveFavorite();

  const cart = useBuyerCart(buyer?.id, sellerSlug);

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

  // Redirect checks
  React.useEffect(() => {
    if (!authLoading && !activeSeller) router.push("/buyer/portal");
  }, [authLoading, activeSeller, router]);

  const products = result?.data ?? [];
  const meta = result?.meta;

  return (
    <div className="flex flex-col min-h-full">
      <div className="flex-1 p-6">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-navy">Shop</h1>
          <p className="text-sm text-navy/70 mt-1">
            Browse products from {activeSeller?.tenant.name}
          </p>
        </div>

        {/* Search + filters bar */}
        <div className="mb-4 flex flex-wrap items-center gap-3">
          {/* Search */}
          <div className="relative flex-1 min-w-[260px]">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-navy/70" />
            <input
              type="search"
              placeholder="Search products by name, SKU, or barcode..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-10 w-full rounded-lg border border-surface-border bg-white pl-10 pr-3 text-sm text-navy placeholder:text-navy/70 focus:border-buyer-500 focus:outline-none focus:ring-1 focus:ring-buyer-500"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-navy/70 hover:text-navy"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Sort */}
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="h-10 rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-buyer-500 focus:outline-none focus:ring-1 focus:ring-buyer-500"
          >
            <option value="name_asc">Name A-Z</option>
            <option value="name_desc">Name Z-A</option>
            <option value="price_asc">Price: Low to High</option>
            <option value="price_desc">Price: High to Low</option>
          </select>

          {/* View toggle */}
          <div className="flex items-center rounded-lg border border-surface-border bg-white">
            <button
              onClick={() => setViewMode("grid")}
              className={`rounded-l-lg p-2.5 transition-colors ${viewMode === "grid" ? "bg-buyer-50 text-buyer-600" : "text-navy/70 hover:text-navy"}`}
            >
              <Grid3X3 className="h-4 w-4" />
            </button>
            <button
              onClick={() => setViewMode("list")}
              className={`rounded-r-lg p-2.5 transition-colors ${viewMode === "list" ? "bg-buyer-50 text-buyer-600" : "text-navy/70 hover:text-navy"}`}
            >
              <List className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Category pills */}
        {categories.length > 0 && (
          <div className="mb-5 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {["", ...categories].map((c) => (
              <button
                key={c || "__all__"}
                onClick={() => {
                  setCategory(c);
                  setPage(1);
                }}
                className={`flex-shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                  category === c
                    ? "border-buyer-500 bg-buyer-500 text-white"
                    : "border-surface-border bg-white text-navy/70 hover:border-buyer-300 hover:text-buyer-600"
                }`}
              >
                {c || "All"}
              </button>
            ))}
          </div>
        )}

        {/* W7b: regulated categories the buyer isn't licensed for */}
        {result?.hiddenCategories && result.hiddenCategories.length > 0 && (
          <LockedCategoriesTile
            categories={result.hiddenCategories}
            sellerName={activeSeller?.tenant.name}
          />
        )}

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
            <p className="text-sm text-danger">Failed to load products. Please try again later.</p>
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
              {search || category
                ? "Try adjusting your search or filters."
                : "No products available from this seller yet."}
            </p>
            {(search || category) && (
              <button
                onClick={() => {
                  setSearch("");
                  setCategory("");
                }}
                className="text-sm text-buyer-500 hover:underline"
              >
                Clear all filters
              </button>
            )}
          </div>
        ) : viewMode === "grid" ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {products.map((p) => (
              <ProductCard
                key={p.id}
                product={p}
                cartQty={cart.getItemQty(p.id)}
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
              />
            ))}
          </div>
        ) : (
          /* List view */
          <div className="rounded-xl border border-surface-border bg-white overflow-hidden">
            <table className="w-full">
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
                  return (
                    <tr key={p.id} className="hover:bg-surface-raised/50">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="h-10 w-10 flex-shrink-0 rounded-lg bg-surface-raised flex items-center justify-center overflow-hidden">
                            {p.thumbnailUrl ? (
                              <img
                                src={p.thumbnailUrl}
                                alt=""
                                className="h-full w-full object-cover"
                                style={{ objectPosition: objectPositionForUrl(p.thumbnailUrl) }}
                              />
                            ) : (
                              <Package className="h-5 w-5 text-navy/15" />
                            )}
                          </div>
                          <div>
                            <p className="text-sm font-medium text-navy">{p.name}</p>
                            <p className="text-xs text-navy/70">per {p.unit}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-navy/70">{p.category ?? "N/A"}</td>
                      <td className="px-4 py-3 text-xs text-navy/70">{p.sku ?? "N/A"}</td>
                      <td className="px-4 py-3 text-right text-sm font-semibold text-navy">
                        {fmt(p.buyerPrice)}
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
                              favoriteIds.has(p.id) ? "Remove from favorites" : "Add to favorites"
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
