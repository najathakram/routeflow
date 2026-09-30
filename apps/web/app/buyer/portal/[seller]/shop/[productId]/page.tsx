"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Heart, Loader2, Package } from "lucide-react";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import {
  useBuyerProduct,
  useBuyerPromotions,
  useBuyerFavorites,
  useBuyerAddFavorite,
  useBuyerRemoveFavorite,
  useBuyerStockAlerts,
  useSubscribeStockAlert,
  useUnsubscribeStockAlert,
  toPromotionRules,
} from "@/lib/api/buyer";
import { useBuyerCart } from "@/lib/buyer-cart";
import { deriveTilePrice } from "../_components/tile-pricing";
import { ProductGallery } from "./_components/ProductGallery";
import { DetailActions } from "./_components/DetailActions";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

/** Same copy/colors as the shop tile's stockText — kept in sync deliberately. */
function stockText(
  status: "IN_STOCK" | "LOW" | "OUT_OF_STOCK" | undefined,
  stockLeft: number | null | undefined,
): { label: string; cls: string } {
  const s = status ?? "IN_STOCK";
  if (s === "OUT_OF_STOCK") return { label: "Out of stock", cls: "text-danger" };
  if (s === "LOW")
    return {
      label: stockLeft != null ? `Only ${stockLeft} left` : "Low stock",
      cls: "text-warning",
    };
  return { label: "In stock", cls: "text-success" };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BuyerProductDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { buyer, activeSeller, isLoading: authLoading } = useBuyerAuth();
  const sellerSlug = params.seller as string;
  const productId = params.productId as string;
  const backHref = `/buyer/portal/${sellerSlug}/shop`;

  const { data: product, isLoading, isError, error } = useBuyerProduct(productId);
  const { data: promotions } = useBuyerPromotions();
  const { data: favorites } = useBuyerFavorites();
  const addFavorite = useBuyerAddFavorite();
  const removeFavorite = useBuyerRemoveFavorite();
  const { data: stockAlerts } = useBuyerStockAlerts();
  const subscribeStockAlert = useSubscribeStockAlert();
  const unsubscribeStockAlert = useUnsubscribeStockAlert();

  const cart = useBuyerCart(buyer?.id, sellerSlug);
  const promoRules = React.useMemo(() => toPromotionRules(promotions), [promotions]);

  const isFavorite = (favorites ?? []).some((f) => f.productId === productId);
  const toggleFavorite = () => {
    if (isFavorite) removeFavorite.mutate(productId);
    else addFavorite.mutate(productId);
  };

  // `alertSubscribed` comes straight off the detail payload (server-resolved);
  // fall back to the shared stock-alerts list while the detail query is still
  // in flight / for a snappier toggle after mutation invalidation.
  const isAlertSubscribed =
    product?.alertSubscribed ?? (stockAlerts?.productIds ?? []).includes(productId);
  const toggleStockAlert = () => {
    if (isAlertSubscribed) unsubscribeStockAlert.mutate(productId);
    else subscribeStockAlert.mutate(productId);
  };

  // Redirect checks — mirror shop/page.tsx and orders/[id]/page.tsx.
  React.useEffect(() => {
    if (!authLoading && !activeSeller) router.push("/buyer/portal");
  }, [authLoading, activeSeller, router]);

  React.useEffect(() => {
    if (!authLoading && activeSeller && activeSeller.tenant.slug !== sellerSlug) {
      router.push("/buyer/portal");
    }
  }, [authLoading, activeSeller, sellerSlug, router]);

  const cartItem = cart.items.find((i) => i.productId === productId);

  // The endpoint is already tenant/link/license-gated: 404 means "doesn't
  // exist or you can't see it" and the seller-context guard 403s when the
  // buyer/seller relationship itself is invalid. Both render the same
  // non-leaking "not available" card — never distinguish them in copy.
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  const notAvailable = isError && (status === 404 || status === 403);

  const backLink = (
    <Link
      href={backHref}
      className="mb-4 inline-flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
    >
      <ArrowLeft className="h-4 w-4" /> Back to shop
    </Link>
  );

  if (authLoading || isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-buyer-500" />
      </div>
    );
  }

  if (notAvailable) {
    return (
      <div className="p-6 max-w-4xl">
        {backLink}
        <div className="rounded-xl border border-dashed border-surface-border bg-white p-12 text-center">
          <Package className="mx-auto mb-4 h-12 w-12 text-navy/20" />
          <h2 className="mb-2 text-lg font-semibold text-navy">Product not available</h2>
          <p className="text-sm text-navy/70">
            This product may have been removed or isn&apos;t available to you right now.
          </p>
        </div>
      </div>
    );
  }

  if (isError || !product) {
    return (
      <div className="p-6 max-w-4xl">
        {backLink}
        <div className="rounded-lg bg-danger-bg px-4 py-3 text-sm text-danger">
          Failed to load product. Please try again later.
        </div>
      </div>
    );
  }

  const images = product.imageUrls?.length
    ? product.imageUrls
    : product.thumbnailUrl
      ? [product.thumbnailUrl]
      : [];
  const stock = stockText(product.stockStatus, product.stockLeft);

  return (
    <div data-testid="product-detail-page" className="p-6 max-w-5xl">
      {backLink}

      <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
        <ProductGallery images={images} name={product.name} />

        <div className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <h1 data-testid="product-detail-name" className="text-2xl font-bold text-navy">
              {product.name}
            </h1>
            <button
              onClick={toggleFavorite}
              className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border transition-colors ${
                isFavorite
                  ? "border-danger/30 bg-danger/10 text-danger hover:bg-danger hover:text-white"
                  : "border-surface-border bg-white text-navy/30 hover:text-danger"
              }`}
              title={isFavorite ? "Remove from favorites" : "Add to favorites"}
            >
              <Heart className={`h-4 w-4 ${isFavorite ? "fill-current" : ""}`} />
            </button>
          </div>

          {(product.sku || product.barcode) && (
            <p className="text-xs text-navy/70">
              {product.sku ? `SKU: ${product.sku}` : ""}
              {product.sku && product.barcode ? " · " : ""}
              {product.barcode ? `Barcode: ${product.barcode}` : ""}
            </p>
          )}

          <p className={`text-sm font-medium ${stock.cls}`}>{stock.label}</p>

          <DetailActions
            product={product}
            cartItem={cartItem}
            promoRules={promoRules}
            promotions={promotions}
            onAdd={() =>
              cart.addItem({
                productId: product.id,
                qty: product.unitsPerBox ? product.unitsPerBox : 1,
                name: product.name,
                unit: product.unit,
                thumbnailUrl: product.thumbnailUrl,
                unitsPerBox: product.unitsPerBox,
                boxes: product.unitsPerBox ? 1 : undefined,
                pieces: product.unitsPerBox ? 0 : undefined,
              })
            }
            onUpdateQty={(qty) => cart.updateQty(product.id, qty)}
            isAlertSubscribed={isAlertSubscribed}
            onToggleStockAlert={toggleStockAlert}
          />

          {product.description && (
            <div className="border-t border-surface-border pt-4">
              <p className="whitespace-pre-line text-sm text-navy/80">{product.description}</p>
            </div>
          )}

          {/* Variants are themselves catalog products (self-referential Product
              rows) fetchable via the same GET /buyer/products/:id endpoint — see
              deviations note — so each row links to its own detail page. */}
          {product.variants.length > 0 && (
            <div className="border-t border-surface-border pt-4">
              <h2 className="mb-2 text-sm font-semibold text-navy">Variants</h2>
              <ul className="divide-y divide-surface-border rounded-lg border border-surface-border bg-white">
                {product.variants.map((v) => {
                  // Same cent-exact path as the variant's own tile/detail page —
                  // never the raw `buyerPrice`, or a promoted variant reads high here.
                  const vPriced = deriveTilePrice(
                    v,
                    promoRules,
                    cart.items.find((i) => i.productId === v.id),
                  );
                  return (
                    <li key={v.id}>
                      <Link
                        href={`/buyer/portal/${sellerSlug}/shop/${v.id}`}
                        className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm hover:bg-surface-raised transition-colors"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium text-navy">{v.name}</p>
                          {v.sku && <p className="text-[11px] text-navy/70">SKU: {v.sku}</p>}
                        </div>
                        <span className="flex-shrink-0 text-sm font-semibold text-navy">
                          {fmt(vPriced.unitPrice)}
                          {vPriced.originalPrice != null && (
                            <span className="ml-1.5 text-xs font-normal text-navy/40 line-through">
                              {fmt(vPriced.originalPrice)}
                            </span>
                          )}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
