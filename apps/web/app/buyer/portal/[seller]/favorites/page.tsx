"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Heart,
  Plus,
  Minus,
  Package,
  Loader2,
  Trash2,
  Store,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@routeflow/ui/web";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import {
  useBuyerFavorites,
  useBuyerRemoveFavorite,
  type BuyerFavoriteItem,
} from "@/lib/api/buyer";
import { useBuyerCart } from "@/lib/buyer-cart";

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function FavoriteCard({
  item,
  cartQty,
  onAdd,
  onUpdateQty,
  onRemoveFavorite,
  isRemoving,
}: {
  item: BuyerFavoriteItem;
  cartQty: number;
  onAdd: () => void;
  onUpdateQty: (qty: number) => void;
  onRemoveFavorite: () => void;
  isRemoving: boolean;
}) {
  return (
    <div className="group flex flex-col rounded-xl border border-surface-border bg-white overflow-hidden hover:shadow-md transition-shadow">
      {/* Image */}
      <div className="relative aspect-square bg-surface-raised flex items-center justify-center overflow-hidden">
        {item.thumbnailUrl ? (
          <img src={item.thumbnailUrl} alt={item.name} className="h-full w-full object-cover" />
        ) : (
          <Package className="h-12 w-12 text-navy/15" />
        )}
        {/* Remove favorite button */}
        <button
          onClick={onRemoveFavorite}
          disabled={isRemoving}
          className="absolute top-2 right-2 flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-danger shadow-sm hover:bg-danger hover:text-white transition-colors disabled:opacity-50"
          title="Remove from favorites"
        >
          <Heart className="h-4 w-4 fill-current" />
        </button>
        {item.category && (
          <span className="absolute top-2 left-2 rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-medium text-navy/70 shadow-sm">
            {item.category}
          </span>
        )}
      </div>

      {/* Info */}
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-navy line-clamp-2">{item.name}</h3>
          {item.sku && (
            <p className="text-[11px] text-navy/40 mt-0.5">SKU: {item.sku}</p>
          )}
        </div>

        <div className="flex items-end justify-between gap-2">
          <div>
            <p className="text-lg font-bold text-navy">{fmt(item.buyerPrice)}</p>
            <p className="text-[11px] text-navy/40">per {item.unit}</p>
          </div>

          {cartQty > 0 ? (
            <div className="flex items-center gap-1 rounded-lg border border-buyer-200 bg-buyer-50">
              <button
                onClick={() => onUpdateQty(cartQty - 1)}
                className="rounded-l-lg p-1.5 text-buyer-600 hover:bg-buyer-100 transition-colors"
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
              <span className="min-w-[28px] text-center text-sm font-semibold text-buyer-700">
                {cartQty}
              </span>
              <button
                onClick={() => onUpdateQty(cartQty + 1)}
                className="rounded-r-lg p-1.5 text-buyer-600 hover:bg-buyer-100 transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
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

export default function BuyerFavoritesPage() {
  const params = useParams();
  const router = useRouter();
  const { buyer, activeSeller, isLoading: authLoading } = useBuyerAuth();
  const sellerSlug = params.seller as string;

  const { data: favorites, isLoading, isError } = useBuyerFavorites();
  const removeFavorite = useBuyerRemoveFavorite();
  const cart = useBuyerCart(buyer?.id, sellerSlug);

  const [removingId, setRemovingId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!authLoading && !activeSeller) router.push("/buyer/portal");
  }, [authLoading, activeSeller, router]);

  const handleRemove = async (productId: string) => {
    setRemovingId(productId);
    try {
      await removeFavorite.mutateAsync(productId);
    } catch {
      // Error handled by TanStack Query
    } finally {
      setRemovingId(null);
    }
  };

  if (authLoading || isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-buyer-500" />
      </div>
    );
  }

  const items = favorites ?? [];

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy">Favorites</h1>
        <p className="text-sm text-navy/60 mt-1">
          Your saved products from {activeSeller?.tenant.name}
        </p>
      </div>

      {isError ? (
        <div className="rounded-xl border border-danger/30 bg-danger-bg p-8 text-center">
          <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-danger" />
          <p className="text-sm text-danger">Failed to load favorites.</p>
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-surface-border bg-white p-12 text-center">
          <Heart className="mx-auto mb-4 h-12 w-12 text-navy/20" />
          <h2 className="text-lg font-semibold text-navy mb-2">No favorites yet</h2>
          <p className="text-sm text-navy/60 mb-4">
            Browse the shop and tap the heart icon on products you want to save.
          </p>
          <Button
            className="bg-buyer-500 hover:bg-buyer-600 focus-visible:ring-buyer-500"
            onClick={() => router.push(`/buyer/portal/${sellerSlug}/shop`)}
          >
            <Store className="mr-1.5 h-4 w-4" /> Browse Products
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {items.map((item) => (
            <FavoriteCard
              key={item.id}
              item={item}
              cartQty={cart.getItemQty(item.productId)}
              onAdd={() =>
                cart.addItem({
                  productId: item.productId,
                  qty: 1,
                  name: item.name,
                  unit: item.unit,
                  thumbnailUrl: item.thumbnailUrl,
                })
              }
              onUpdateQty={(qty) => cart.updateQty(item.productId, qty)}
              onRemoveFavorite={() => handleRemove(item.productId)}
              isRemoving={removingId === item.productId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
