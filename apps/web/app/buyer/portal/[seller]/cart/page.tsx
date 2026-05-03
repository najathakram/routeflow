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
import { useBuyerProducts, useBuyerCreateOrder, useBuyerActiveOrder } from "@/lib/api/buyer";
import { computeLineSubtotal } from "@/lib/pricing";

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
  const [orderPlaced, setOrderPlaced] = React.useState<{ id: string; orderNumber: string } | null>(null);
  const [orderError, setOrderError] = React.useState<string | null>(null);

  // Whether we'll merge into the existing order
  const willMerge = !forceNew && activeOrder != null;

  // Fetch products matching cart items only (not the entire catalog)
  // We pass the cart product IDs as a search hint so the API doesn't return thousands of items
  const cartProductIds = React.useMemo(() => cart.items.map((i) => i.productId), [cart.items]);
  const { data: productsResult } = useBuyerProducts(
    cartProductIds.length > 0 ? { limit: 100 } : { limit: 0 },
  );

  // Build price map from available products
  const priceMap = React.useMemo(() => {
    const map = new Map<string, number>();
    if (productsResult?.data) {
      for (const p of productsResult.data) {
        map.set(p.id, p.buyerPrice);
      }
    }
    return map;
  }, [productsResult]);

  const subtotal = cart.items.reduce((sum, item) => {
    const price = priceMap.get(item.productId) ?? 0;
    return (
      sum +
      computeLineSubtotal({
        unitPrice: price,
        qty: item.qty,
        boxes: item.boxes ?? null,
        pieces: item.pieces ?? null,
        unitsPerBox: item.unitsPerBox ?? null,
      })
    );
  }, 0);

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
      setOrderError(
        err?.response?.data?.message ?? "Failed to create order. Please try again.",
      );
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
          <p className="text-sm text-navy/60 mb-6">
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
          className="mb-4 flex items-center gap-1.5 text-sm text-navy/60 hover:text-navy transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Shop
        </button>
        <div className="rounded-xl border border-dashed border-surface-border bg-white p-12 text-center">
          <ShoppingCart className="mx-auto mb-4 h-12 w-12 text-navy/20" />
          <h2 className="text-lg font-semibold text-navy mb-2">Your cart is empty</h2>
          <p className="text-sm text-navy/60 mb-4">Add products from the shop to get started.</p>
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
        className="mb-4 flex items-center gap-1.5 text-sm text-navy/60 hover:text-navy transition-colors"
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
          <p className="text-sm text-navy/60">A new order will be created.</p>
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
                <tr className="border-b border-surface-border bg-surface-raised text-xs text-navy/50 uppercase tracking-wider">
                  <th className="px-4 py-2.5 text-left">Product</th>
                  <th className="px-4 py-2.5 text-center w-32">Qty</th>
                  <th className="px-4 py-2.5 text-right w-24">Price</th>
                  <th className="px-4 py-2.5 text-right w-24">Subtotal</th>
                  <th className="px-4 py-2.5 w-12"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {cart.items.map((item) => {
                  const price = priceMap.get(item.productId) ?? 0;
                  return (
                    <tr key={item.productId} className="hover:bg-surface-raised/50">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="h-10 w-10 flex-shrink-0 rounded-lg bg-surface-raised flex items-center justify-center overflow-hidden">
                            {item.thumbnailUrl ? (
                              <img src={item.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                            ) : (
                              <Package className="h-5 w-5 text-navy/15" />
                            )}
                          </div>
                          <div>
                            <p className="text-sm font-medium text-navy">{item.name}</p>
                            <p className="text-xs text-navy/40">per {item.unit}</p>
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
                                  className="rounded p-1 text-navy/40 hover:bg-surface-raised"
                                >
                                  <Minus className="h-3 w-3" />
                                </button>
                                <input
                                  type="number" min={0}
                                  value={item.boxes ?? 0}
                                  onChange={(e) => {
                                    const b = Math.max(0, Number(e.target.value));
                                    const p = item.pieces ?? 0;
                                    const qty = b * item.unitsPerBox! + p;
                                    if (qty > 0) cart.addItem({ ...item, qty, boxes: b, pieces: p });
                                  }}
                                  className="w-10 rounded border border-surface-border bg-white px-1 py-0.5 text-center text-xs text-navy"
                                />
                                <button
                                  onClick={() => {
                                    const b = (item.boxes ?? 0) + 1;
                                    const p = item.pieces ?? 0;
                                    cart.addItem({ ...item, qty: b * item.unitsPerBox! + p, boxes: b, pieces: p });
                                  }}
                                  className="rounded p-1 text-navy/40 hover:bg-surface-raised"
                                >
                                  <Plus className="h-3 w-3" />
                                </button>
                                <span className="text-navy/40 ml-0.5">box</span>
                              </div>
                              <span className="text-navy/30">+</span>
                              <div className="flex items-center gap-0.5">
                                <input
                                  type="number" min={0} max={(item.unitsPerBox ?? 1) - 1}
                                  value={item.pieces ?? 0}
                                  onChange={(e) => {
                                    const b = item.boxes ?? 0;
                                    const p = Math.max(0, Math.min(Number(e.target.value), (item.unitsPerBox ?? 1) - 1));
                                    const qty = b * item.unitsPerBox! + p;
                                    if (qty > 0) cart.addItem({ ...item, qty, boxes: b, pieces: p });
                                  }}
                                  className="w-10 rounded border border-surface-border bg-white px-1 py-0.5 text-center text-xs text-navy"
                                />
                                <span className="text-navy/40">pcs</span>
                              </div>
                            </div>
                            <p className="text-[10px] text-navy/40">= {item.qty} {item.unit}</p>
                          </div>
                        ) : (
                          // Simple qty input
                          <div className="flex items-center justify-center gap-1">
                            <button
                              onClick={() => cart.updateQty(item.productId, item.qty - 1)}
                              className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy"
                            >
                              <Minus className="h-3.5 w-3.5" />
                            </button>
                            <input
                              type="number"
                              min={1}
                              value={item.qty}
                              onChange={(e) => cart.updateQty(item.productId, Math.max(1, Number(e.target.value)))}
                              className="w-14 rounded border border-surface-border bg-white px-2 py-1 text-center text-sm text-navy"
                            />
                            <button
                              onClick={() => cart.updateQty(item.productId, item.qty + 1)}
                              className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy"
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-navy/70">{fmt(price)}</td>
                      <td className="px-4 py-3 text-right text-sm font-medium text-navy">
                        {fmt(
                          computeLineSubtotal({
                            unitPrice: price,
                            qty: item.qty,
                            boxes: item.boxes ?? null,
                            pieces: item.pieces ?? null,
                            unitsPerBox: item.unitsPerBox ?? null,
                          }),
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
              <label className="block text-xs text-navy/50 mb-1">Requested Delivery Date</label>
              <input
                type="date"
                value={deliveryDate}
                onChange={(e) => setDeliveryDate(e.target.value)}
                className="h-9 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-buyer-500 focus:outline-none focus:ring-1 focus:ring-buyer-500"
              />
            </div>

            <div>
              <label className="block text-xs text-navy/50 mb-1">Order Notes</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Special instructions..."
                rows={3}
                className="w-full rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/40 focus:border-buyer-500 focus:outline-none focus:ring-1 focus:ring-buyer-500"
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
            <div className="flex justify-between text-sm">
              <span className="text-navy/60">Subtotal ({cart.totalQty} items)</span>
              <span className="font-medium text-navy">{fmt(subtotal)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-navy/60">Tax</span>
              <span className="text-navy/50">Calculated at checkout</span>
            </div>
            <div className="border-t border-surface-border pt-3 flex justify-between">
              <span className="text-sm font-semibold text-navy">Estimated Total</span>
              <span className="text-lg font-bold text-navy">{fmt(subtotal)}</span>
            </div>
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
