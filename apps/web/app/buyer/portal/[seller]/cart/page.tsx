"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  ShoppingCart,
  Trash2,
  Minus,
  Plus,
  Package,
  Loader2,
  AlertTriangle,
  Store,
} from "lucide-react";
import { Button } from "@routeflow/ui/web";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import { useBuyerCart } from "@/lib/buyer-cart";
import {
  useBuyerProducts,
  useBuyerCreateOrder,
  useBuyerActiveOrder,
  useBuyerPromotions,
  toPromotionRules,
} from "@/lib/api/buyer";
import { computeLineSubtotal, normalizeBoxesPieces, applyBestPromotion } from "@/lib/pricing";
import { objectPositionForUrl } from "@/lib/image-focal";

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

export default function BuyerCartPage() {
  const params = useParams();
  const router = useRouter();
  const { buyer, activeSeller, isLoading: authLoading } = useBuyerAuth();
  const sellerSlug = params.seller as string;

  const cart = useBuyerCart(buyer?.id, sellerSlug);
  const createOrder = useBuyerCreateOrder();
  const { data: activeOrder } = useBuyerActiveOrder();

  const [notes, setNotes] = React.useState("");
  const [deliveryDate, setDeliveryDate] = React.useState("");
  const [urgent, setUrgent] = React.useState(false);
  const [forceNew, setForceNew] = React.useState(false);
  const [orderPlaced, setOrderPlaced] = React.useState<{ id: string; orderNumber: string } | null>(
    null,
  );
  const [orderError, setOrderError] = React.useState<string | null>(null);

  // Whether we'll merge into the existing order
  const willMerge = !forceNew && activeOrder != null;

  // Resolve prices for exactly the cart's products. This MUST be an id filter:
  // a plain page of the catalog silently omits any product outside it, and the
  // lookup below then prices those lines at 0.
  const cartProductIds = React.useMemo(() => cart.items.map((i) => i.productId), [cart.items]);
  const { data: productsResult } = useBuyerProducts(
    cartProductIds.length > 0 ? { ids: cartProductIds } : { limit: 0 },
  );
  const { data: promotions } = useBuyerPromotions();

  // Catalog meta (price/category/box) keyed by product id — category drives
  // CATEGORY-scoped promo matching, unitsPerBox drives boxed proration.
  const productMeta = React.useMemo(() => {
    const map = new Map<
      string,
      { buyerPrice: number; category: string | null; unitsPerBox: number | null }
    >();
    for (const p of productsResult?.data ?? []) {
      map.set(p.id, {
        buyerPrice: p.buyerPrice,
        category: p.category,
        unitsPerBox: p.unitsPerBox,
      });
    }
    return map;
  }, [productsResult]);

  // P5-04: evaluate the best active promotion per line via the SAME pricing.ts
  // helper the server uses at order-write, so the displayed savings equals the
  // billed savings to the cent. `net` is the promo-adjusted selling-unit price;
  // `original` is the pre-promo price for the strikethrough (null = no promo).
  const promoRules = React.useMemo(() => toPromotionRules(promotions), [promotions]);

  const pricedLines = React.useMemo(() => {
    return cart.items.map((item) => {
      const meta = productMeta.get(item.productId);
      // No catalog row = the product was removed, deactivated, or is gated by
      // the regulated-category rules. Never quietly price it at 0 — say so.
      const unresolved = meta == null;
      const base = meta?.buyerPrice ?? 0;
      const unitsPerBox = item.unitsPerBox ?? meta?.unitsPerBox ?? null;
      const qtyPieces = normalizeBoxesPieces({
        boxes: item.boxes ?? null,
        pieces: item.pieces ?? null,
        qty: item.qty,
        unitsPerBox,
      }).qty;
      const promo = applyBestPromotion(base, promoRules, {
        productId: item.productId,
        category: meta?.category ?? null,
        qtyPieces,
      });
      const lineArgs = {
        qty: item.qty,
        boxes: item.boxes ?? null,
        pieces: item.pieces ?? null,
        unitsPerBox,
      };
      const net = promo.unitPrice;
      const original = promo.originalPrice; // null when no promo applied
      return {
        item,
        base,
        net,
        original,
        unresolved,
        appliedPromoId: promo.appliedPromoId,
        lineSubtotal: computeLineSubtotal({ unitPrice: net, ...lineArgs }),
        lineOriginalSubtotal: computeLineSubtotal({ unitPrice: original ?? net, ...lineArgs }),
      };
    });
  }, [cart.items, productMeta, promoRules]);

  const lineByProduct = React.useMemo(
    () => new Map(pricedLines.map((l) => [l.item.productId, l])),
    [pricedLines],
  );

  // Unpriceable lines are excluded rather than counted as $0, so the estimate
  // never understates what the seller will actually invoice.
  const unresolvedCount = pricedLines.filter((l) => l.unresolved).length;
  const subtotal = pricedLines.reduce((sum, l) => sum + (l.unresolved ? 0 : l.lineSubtotal), 0);
  const savings = pricedLines.reduce(
    (sum, l) => sum + (l.unresolved ? 0 : l.lineOriginalSubtotal - l.lineSubtotal),
    0,
  );

  // Redirect checks
  React.useEffect(() => {
    if (!authLoading && !activeSeller) router.push("/buyer/portal");
  }, [authLoading, activeSeller, router]);

  const handlePlaceOrder = async () => {
    setOrderError(null);
    try {
      const result = await createOrder.mutateAsync({
        items: cart.items.map((i) => ({
          productId: i.productId,
          qty: i.qty,
          ...(i.boxes != null ? { boxes: i.boxes } : {}),
          ...(i.pieces != null ? { pieces: i.pieces } : {}),
        })),
        notes: notes || undefined,
        urgent,
        requestedDeliveryDate: deliveryDate || undefined,
        status: "PENDING",
        forceNew,
      });

      // Clear cart ONLY after confirmed success to avoid data loss on network failure
      cart.clearCart();

      if (willMerge && activeOrder) {
        router.push(`/buyer/portal/${sellerSlug}/orders/${activeOrder.id}`);
      } else {
        setOrderPlaced(result);
      }
    } catch (err: any) {
      const data = err?.response?.data;
      // A regulated line the buyer isn't licensed for (e.g. a stale cart item whose
      // license lapsed) — point them at the Licenses page instead of a generic retry.
      if (err?.response?.status === 409 && data?.code === "REGULATED_AUTH_REQUIRED") {
        const names = (data.blockedCategories ?? [])
          .map((b: { categoryName: string }) => b.categoryName)
          .join(", ");
        setOrderError(
          `Your order includes regulated items${names ? ` (${names})` : ""} that need a verified license. Submit or renew it on the Licenses page, then try again.`,
        );
        return;
      }
      setOrderError(data?.message ?? "Failed to create order. Please try again.");
    }
  };

  if (authLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-buyer-500" />
      </div>
    );
  }

  // Success state
  if (orderPlaced) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <div className="rounded-xl border border-success/30 bg-success-bg/50 p-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-success/10">
            <ShoppingCart className="h-8 w-8 text-success" />
          </div>
          <h2 className="text-xl font-bold text-navy mb-2">Order Placed!</h2>
          <p className="text-sm text-navy/70 mb-6">
            Your order <strong>{orderPlaced.orderNumber}</strong> has been submitted.
          </p>
          <div className="flex items-center justify-center gap-3">
            <Button
              variant="secondary"
              onClick={() => router.push(`/buyer/portal/${sellerSlug}/orders/${orderPlaced.id}`)}
            >
              View Order
            </Button>
            <Button
              className="bg-buyer-500 hover:bg-buyer-600 focus-visible:ring-buyer-500"
              onClick={() => router.push(`/buyer/portal/${sellerSlug}/shop`)}
            >
              <Store className="mr-1.5 h-4 w-4" /> Continue Shopping
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Empty cart
  if (cart.items.length === 0) {
    return (
      <div className="p-6">
        <button
          onClick={() => router.push(`/buyer/portal/${sellerSlug}/shop`)}
          className="mb-4 flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Shop
        </button>
        <div className="rounded-xl border border-dashed border-surface-border bg-white p-12 text-center">
          <ShoppingCart className="mx-auto mb-4 h-12 w-12 text-navy/20" />
          <h2 className="text-lg font-semibold text-navy mb-2">Your cart is empty</h2>
          <p className="text-sm text-navy/70 mb-4">Add products from the shop to get started.</p>
          <Button
            className="bg-buyer-500 hover:bg-buyer-600 focus-visible:ring-buyer-500"
            onClick={() => router.push(`/buyer/portal/${sellerSlug}/shop`)}
          >
            <Store className="mr-1.5 h-4 w-4" /> Browse Products
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl">
      <button
        onClick={() => router.push(`/buyer/portal/${sellerSlug}/shop`)}
        className="mb-4 flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" /> Continue Shopping
      </button>

      <h1 className="text-2xl font-bold text-navy mb-4">Cart</h1>

      {/* Active order merge banner */}
      {willMerge && activeOrder && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-buyer-200 bg-buyer-50 px-4 py-3">
          <div className="flex items-center gap-2 text-sm text-buyer-700">
            <ShoppingCart className="h-4 w-4 flex-shrink-0" />
            <span>
              Items will be added to your existing order{" "}
              <strong>#{(activeOrder as any).orderNumber ?? activeOrder.id.slice(0, 8)}</strong>
            </span>
          </div>
          <button
            onClick={() => setForceNew(true)}
            className="text-xs font-medium text-buyer-500 hover:text-buyer-700 underline whitespace-nowrap"
          >
            Create new order instead
          </button>
        </div>
      )}

      {forceNew && activeOrder && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-surface-border bg-surface-raised px-4 py-3">
          <p className="text-sm text-navy/70">A new order will be created.</p>
          <button
            onClick={() => setForceNew(false)}
            className="text-xs font-medium text-buyer-500 hover:text-buyer-700 underline whitespace-nowrap"
          >
            Add to existing order instead
          </button>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Items */}
        <div className="lg:col-span-2">
          <div className="rounded-xl border border-surface-border bg-white overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-surface-border bg-surface-raised text-xs text-navy/70 uppercase tracking-wider">
                  <th className="px-4 py-2.5 text-left">Product</th>
                  <th className="px-4 py-2.5 text-center w-32">Qty</th>
                  <th className="px-4 py-2.5 text-right w-24">Price</th>
                  <th className="px-4 py-2.5 text-right w-24">Subtotal</th>
                  <th className="px-4 py-2.5 w-12"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {cart.items.map((item) => {
                  const priced = lineByProduct.get(item.productId);
                  const price = priced?.net ?? 0;
                  const original = priced?.original ?? null;
                  return (
                    <tr key={item.productId} className="hover:bg-surface-raised/50">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="h-10 w-10 flex-shrink-0 rounded-lg bg-surface-raised flex items-center justify-center overflow-hidden">
                            {item.thumbnailUrl ? (
                              <img
                                src={item.thumbnailUrl}
                                alt=""
                                className="h-full w-full object-cover"
                                style={{ objectPosition: objectPositionForUrl(item.thumbnailUrl) }}
                              />
                            ) : (
                              <Package className="h-5 w-5 text-navy/15" />
                            )}
                          </div>
                          <div>
                            <p className="text-sm font-medium text-navy">{item.name}</p>
                            <p className="text-xs text-navy/70">per {item.unit}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {item.unitsPerBox && item.unitsPerBox > 0 ? (
                          // Boxes + Pieces input
                          <div className="flex flex-col items-center gap-1">
                            <div className="flex items-center gap-1.5 text-xs">
                              <div className="flex items-center gap-0.5">
                                <button
                                  onClick={() => {
                                    const b = Math.max(0, (item.boxes ?? 0) - 1);
                                    const p = item.pieces ?? 0;
                                    const qty = b * item.unitsPerBox! + p;
                                    if (qty > 0) {
                                      cart.addItem({ ...item, qty, boxes: b, pieces: p });
                                    } else {
                                      cart.removeItem(item.productId);
                                    }
                                  }}
                                  className="rounded p-1 text-navy/70 hover:bg-surface-raised"
                                >
                                  <Minus className="h-3 w-3" />
                                </button>
                                <input
                                  type="number"
                                  min={0}
                                  value={item.boxes ?? 0}
                                  onChange={(e) => {
                                    const b = Math.max(0, Number(e.target.value));
                                    const p = item.pieces ?? 0;
                                    const qty = b * item.unitsPerBox! + p;
                                    if (qty > 0)
                                      cart.addItem({ ...item, qty, boxes: b, pieces: p });
                                  }}
                                  className="w-10 rounded border border-surface-border bg-white px-1 py-0.5 text-center text-xs text-navy"
                                />
                                <button
                                  onClick={() => {
                                    const b = (item.boxes ?? 0) + 1;
                                    const p = item.pieces ?? 0;
                                    cart.addItem({
                                      ...item,
                                      qty: b * item.unitsPerBox! + p,
                                      boxes: b,
                                      pieces: p,
                                    });
                                  }}
                                  className="rounded p-1 text-navy/70 hover:bg-surface-raised"
                                >
                                  <Plus className="h-3 w-3" />
                                </button>
                                <span className="text-navy/70 ml-0.5">box</span>
                              </div>
                              <span className="text-navy/30">+</span>
                              <div className="flex items-center gap-0.5">
                                <input
                                  type="number"
                                  min={0}
                                  max={(item.unitsPerBox ?? 1) - 1}
                                  value={item.pieces ?? 0}
                                  onChange={(e) => {
                                    const b = item.boxes ?? 0;
                                    const p = Math.max(
                                      0,
                                      Math.min(Number(e.target.value), (item.unitsPerBox ?? 1) - 1),
                                    );
                                    const qty = b * item.unitsPerBox! + p;
                                    if (qty > 0)
                                      cart.addItem({ ...item, qty, boxes: b, pieces: p });
                                  }}
                                  className="w-10 rounded border border-surface-border bg-white px-1 py-0.5 text-center text-xs text-navy"
                                />
                                <span className="text-navy/70">pcs</span>
                              </div>
                            </div>
                            <p className="text-[10px] text-navy/70">
                              = {item.qty} {item.unit}
                            </p>
                          </div>
                        ) : (
                          // Simple qty input
                          <div className="flex items-center justify-center gap-1">
                            <button
                              onClick={() => cart.updateQty(item.productId, item.qty - 1)}
                              className="rounded p-1.5 text-navy/70 hover:bg-surface-raised hover:text-navy"
                            >
                              <Minus className="h-3.5 w-3.5" />
                            </button>
                            <input
                              type="number"
                              min={1}
                              value={item.qty}
                              onChange={(e) =>
                                cart.updateQty(item.productId, Math.max(1, Number(e.target.value)))
                              }
                              className="w-14 rounded border border-surface-border bg-white px-2 py-1 text-center text-sm text-navy"
                            />
                            <button
                              onClick={() => cart.updateQty(item.productId, item.qty + 1)}
                              className="rounded p-1.5 text-navy/70 hover:bg-surface-raised hover:text-navy"
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-sm">
                        {priced?.unresolved ? (
                          <span className="text-[11px] text-navy/50">Price unavailable</span>
                        ) : original != null && original > price ? (
                          <span className="flex flex-col items-end leading-tight">
                            <span className="text-[11px] text-navy/40 line-through">
                              {fmt(original)}
                            </span>
                            <span className="font-medium text-buyer-600">{fmt(price)}</span>
                          </span>
                        ) : (
                          <span className="text-navy/70">{fmt(price)}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-sm font-medium text-navy">
                        {priced?.unresolved ? (
                          <span className="text-navy/40">—</span>
                        ) : (
                          fmt(priced?.lineSubtotal ?? 0)
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => cart.removeItem(item.productId)}
                          className="rounded p-1.5 text-navy/30 hover:bg-danger-bg hover:text-danger transition-colors"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Order options + summary */}
        <div className="space-y-4">
          {/* Options */}
          <div className="rounded-xl border border-surface-border bg-white p-4 space-y-4">
            <h3 className="text-sm font-semibold text-navy">Order Options</h3>

            <div>
              <label className="block text-xs text-navy/70 mb-1">Requested Delivery Date</label>
              <input
                type="date"
                value={deliveryDate}
                onChange={(e) => setDeliveryDate(e.target.value)}
                className="h-9 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-buyer-500 focus:outline-none focus:ring-1 focus:ring-buyer-500"
              />
            </div>

            <div>
              <label className="block text-xs text-navy/70 mb-1">Order Notes</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Special instructions..."
                rows={3}
                className="w-full rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/70 focus:border-buyer-500 focus:outline-none focus:ring-1 focus:ring-buyer-500"
              />
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={urgent}
                onChange={(e) => setUrgent(e.target.checked)}
                className="h-4 w-4 rounded border-navy/30 accent-buyer-500"
              />
              <span className="text-sm text-navy">
                <AlertTriangle className="inline h-3.5 w-3.5 text-warning mr-1" />
                Mark as urgent
              </span>
            </label>
          </div>

          {/* Summary */}
          <div className="rounded-xl border border-surface-border bg-white p-4 space-y-3">
            <h3 className="text-sm font-semibold text-navy">Order Summary</h3>
            {savings > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-navy/70">Items</span>
                <span className="text-navy/70 line-through">{fmt(subtotal + savings)}</span>
              </div>
            )}
            {savings > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-buyer-600">Promotion savings</span>
                <span className="font-medium text-buyer-600">−{fmt(savings)}</span>
              </div>
            )}
            <div className="flex justify-between text-sm">
              <span className="text-navy/70">Subtotal ({cart.totalQty} items)</span>
              <span className="font-medium text-navy">{fmt(subtotal)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-navy/70">Tax</span>
              <span className="text-navy/70">Calculated at checkout</span>
            </div>
            <div className="border-t border-surface-border pt-3 flex justify-between">
              <span className="text-sm font-semibold text-navy">Estimated Total</span>
              <span className="text-lg font-bold text-navy">{fmt(subtotal)}</span>
            </div>
            {unresolvedCount > 0 && (
              <p className="text-xs text-navy/60">
                {unresolvedCount === 1
                  ? "1 item isn't priced here and is excluded from this estimate."
                  : `${unresolvedCount} items aren't priced here and are excluded from this estimate.`}{" "}
                Your seller will confirm the price when they review the order.
              </p>
            )}
          </div>

          {/* Actions */}
          <div className="space-y-2">
            <Button
              className="w-full bg-buyer-500 hover:bg-buyer-600 focus-visible:ring-buyer-500"
              onClick={handlePlaceOrder}
              loading={createOrder.isPending}
              disabled={createOrder.isPending}
            >
              {willMerge ? "Add to existing order" : "Place Order"}
            </Button>
          </div>

          {orderError && (
            <div className="rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger">
              {orderError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
