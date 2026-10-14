"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  ShoppingCart,
  Trash2,
  Package,
  Loader2,
  AlertTriangle,
  Store,
} from "lucide-react";
import { Button } from "@routeflow/ui/web";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import { useBuyerCart } from "@/lib/buyer-cart";
import { BUYER_QTY_SPLIT_MISMATCH_COPY, cartOrderItems } from "@/lib/buyer-cart-line";
import { CartRowQty } from "../_components/CartRowQty";
import {
  BUYER_ORDER_CONFLICT_COPY,
  BUYER_ORDER_CONFLICT_NO_ID_COPY,
  buyerOrderConflict,
} from "@/lib/buyer-order-conflict";
import {
  useBuyerProducts,
  useBuyerCreateOrder,
  useBuyerActiveOrder,
  useBuyerPromotions,
  toPromotionRules,
} from "@/lib/api/buyer";
import type { FulfilmentMethod } from "@routeflow/types";
import { computeLineSubtotal, normalizeBoxesPieces, applyBestPromotion } from "@routeflow/pricing";
import { useBuyerSellerCapabilities } from "@/lib/api/buyer-capabilities";
import { objectPositionForUrl } from "@/lib/image-focal";
import {
  FULFIL_METHOD_LABEL,
  FULFIL_METHOD_NOT_OFFERED_COPY,
  buyerFulfilmentChoice,
  isFulfilMethodNotOffered,
} from "@/lib/buyer-fulfilment";
import { buyerBlockedMessage, parseSellingRestricted } from "@/lib/api/selling-restricted";
import { API_ERROR_CODES } from "@routeflow/types";
import { isSellerUnavailableRefusal, sellerUnavailableCopy } from "@/lib/seller-unavailable";
import { BUYER_INSUFFICIENT_STOCK_COPY } from "@/lib/buyer-backorder";
import {
  SellerUnavailableLine,
  useSellerAcceptingOrders,
} from "@/components/SellerUnavailableLine";

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

  const [notes, setNotes] = React.useState("");
  const [deliveryDate, setDeliveryDate] = React.useState("");
  const [urgent, setUrgent] = React.useState(false);
  const [forceNew, setForceNew] = React.useState(false);
  const [orderPlaced, setOrderPlaced] = React.useState<{ id: string; orderNumber: string } | null>(
    null,
  );
  const [orderError, setOrderError] = React.useState<string | null>(null);
  // An idempotency refusal means the order already exists: fixed copy, linked when its id is known.
  const [conflict, setConflict] = React.useState<{ orderId?: string } | null>(null);

  // Order ahead: the seller's offer from the ONE buyer capability source (GET /buyer/capabilities).
  // Loading / error / 503 => no data => no choice and no fulfillPath (the server default applies).
  const { data: capability, refetch: refetchCapability } = useBuyerSellerCapabilities();
  // SA-733r6: a paused seller takes no online orders; the quiet line above says so and Checkout is disabled.
  const sellerAccepting = useSellerAcceptingOrders();
  const choice = buyerFulfilmentChoice(capability);
  const [pickedMethod, setPickedMethod] = React.useState<FulfilmentMethod | null>(null);
  const fulfillPath =
    pickedMethod && choice.methods.includes(pickedMethod) ? pickedMethod : choice.defaultMethod;

  // Read the active order for the CHOSEN path (the server's merge search is path-scoped), so the
  // banner can only name an order this cart would really fold into.
  const { data: activeOrder } = useBuyerActiveOrder(fulfillPath ?? undefined);

  // Whether we'll merge into the existing order
  // The server folds a buyer cart only into an order on the SAME fulfil path, so with a path being
  // sent a differing active order is not a merge target. No path sent => today's rule.
  const pathMatches = !fulfillPath || activeOrder?.fulfillPath === fulfillPath;
  const mergeable = activeOrder != null && pathMatches;
  const willMerge = !forceNew && mergeable;

  // Resolve prices for exactly the cart's products. This MUST be an id filter:
  // a plain page of the catalog silently omits any product outside it, and the
  // lookup below then prices those lines at 0.
  const cartProductIds = React.useMemo(() => cart.items.map((i) => i.productId), [cart.items]);
  const { data: productsResult, isSuccess: catalogLoaded } = useBuyerProducts(
    cartProductIds.length > 0 ? { ids: cartProductIds } : { limit: 0 },
  );

  // State portal limits (spec §4): a line the catalog no longer returns for this buyer is taken out of the cart, but
  // only after a SUCCESSFUL load (a failed fetch removes nothing), and the buyer is told calmly, by name, once.
  const [removedNames, setRemovedNames] = React.useState<string[]>([]);
  React.useEffect(() => {
    if (!catalogLoaded || cartProductIds.length === 0) return;
    const known = new Set((productsResult?.data ?? []).map((p) => p.id));
    const gone = cart.items.filter((i) => !known.has(i.productId));
    if (gone.length === 0) return;
    for (const g of gone) cart.removeItem(g.productId);
    setRemovedNames((prev) => [...prev, ...gone.map((g) => g.name)]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per loaded catalog result
  }, [catalogLoaded, productsResult]);
  // An older Add (dashboard / favorites) may have stored a boxed product without its pack size;
  // give it the catalog's pack as whole Cases BEFORE it is priced, so the row, the subtotal and
  // the payload agree.
  const { adoptCatalogPacks } = cart;
  React.useEffect(() => {
    if (!catalogLoaded) return;
    adoptCatalogPacks(new Map((productsResult?.data ?? []).map((p) => [p.id, p.unitsPerBox])));
  }, [catalogLoaded, productsResult, adoptCatalogPacks]);
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
      const norm = normalizeBoxesPieces({
        boxes: item.boxes ?? null,
        pieces: item.pieces ?? null,
        qty: item.qty,
        unitsPerBox,
      });
      const qtyPieces = norm.qty;
      // Whole selling units on the line — boxes for a boxed line (mixed
      // lines count ONLY full boxes; loose pieces never earn a free unit),
      // qty itself for a piece line. Feeds the BUY_N_GET_M gate.
      const qtyUnits = norm.boxes != null ? norm.boxes : norm.qty;
      const lineArgs = {
        qty: item.qty,
        boxes: item.boxes ?? null,
        pieces: item.pieces ?? null,
        unitsPerBox,
      };
      const promo = applyBestPromotion(base, promoRules, {
        productId: item.productId,
        category: meta?.category ?? null,
        qtyPieces,
        qtyUnits,
        // REG-B109: select by the money this line actually bills — the SAME
        // denomination `lineArgs` bills with below, so a mixed box+piece line's
        // loose pieces count in the comparison instead of being dropped.
        boxes: lineArgs.boxes,
        pieces: lineArgs.pieces,
        unitsPerBox: lineArgs.unitsPerBox,
      });
      const net = promo.unitPrice;
      const original = promo.originalPrice; // null when no promo applied (incl. BUY_N_GET_M)
      const freeUnits = promo.freeUnits ?? 0;
      return {
        item,
        base,
        net,
        original,
        unresolved,
        freeUnits,
        appliedPromoId: promo.appliedPromoId,
        // freeUnits reduces the SUBTOTAL (whole selling units), never the
        // unit price — never re-derive qty × unitPrice for this line.
        lineSubtotal: computeLineSubtotal({ unitPrice: net, ...lineArgs, freeUnits }),
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
    setConflict(null);
    try {
      const result = await createOrder.mutateAsync({
        items: cartOrderItems(cart.items),
        notes: notes || undefined,
        urgent,
        requestedDeliveryDate: deliveryDate || undefined,
        status: "PENDING",
        forceNew,
        ...(fulfillPath ? { fulfillPath } : {}),
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
      const existing = buyerOrderConflict(err);
      if (existing) {
        setConflict(existing);
        return;
      }
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
      // Row 531: the server refused a cart whose qty and box split disagree; nothing was saved.
      if (err?.response?.status === 400 && data?.code === API_ERROR_CODES.QTY_SPLIT_MISMATCH) {
        setOrderError(BUYER_QTY_SPLIT_MISMATCH_COPY);
        return;
      }
      // OOS PR2 (R4): a stock refusal is coded; show the portal's own fixed copy, never a raw server string.
      if (err?.response?.status === 409 && data?.code === API_ERROR_CODES.INSUFFICIENT_STOCK) {
        setOrderError(BUYER_INSUFFICIENT_STOCK_COPY);
        return;
      }
      // A paused seller: the one seller-unavailable sentence (the toast is opted out), then re-read the capability so
      // the line and the disabled button show the same state.
      if (isSellerUnavailableRefusal(err)) {
        setOrderError(sellerUnavailableCopy(activeSeller?.tenant.name));
        void refetchCapability?.();
        return;
      }
      const restricted = parseSellingRestricted(err);
      if (restricted) {
        setOrderError(buyerBlockedMessage(restricted));
        return;
      }
      if (isFulfilMethodNotOffered(err)) {
        setOrderError(FULFIL_METHOD_NOT_OFFERED_COPY);
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

  // Calm and non-error: no toast, no red; its only action is OK.
  const removedNotice =
    removedNames.length > 0 ? (
      <div
        role="status"
        data-testid="cart-removed-notice"
        className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface-raised px-4 py-3 text-sm text-navy"
      >
        <span>
          Some items are no longer available to you, so we took them out of your cart:{" "}
          {removedNames.join(", ")}.
        </span>
        <button
          type="button"
          className="font-medium text-brand-600 hover:underline"
          onClick={() => setRemovedNames([])}
        >
          OK
        </button>
      </div>
    ) : null;

  if (cart.items.length === 0) {
    return (
      <div className="p-6">
        {removedNotice}
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
      {removedNotice}

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

      {forceNew && mergeable && (
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
        {/* min-w-0: below lg the grid is one auto column, which grew to the items table's 640px min-width and made the whole page (and the refusal banner) scroll sideways at 390px. */}
        <div className="min-w-0 lg:col-span-2">
          <div className="rounded-xl border border-surface-border bg-white overflow-hidden">
            <div className="overflow-x-auto">
              <table role="table" className="w-full max-md:block md:min-w-[640px]">
                <thead role="rowgroup" className="max-md:hidden">
                  <tr
                    role="row"
                    className="border-b border-surface-border bg-surface-raised text-xs text-navy/70 uppercase tracking-wider"
                  >
                    <th role="columnheader" className="px-4 py-2.5 text-left">
                      Product
                    </th>
                    <th role="columnheader" className="px-4 py-2.5 text-center w-32">
                      Qty
                    </th>
                    <th role="columnheader" className="px-4 py-2.5 text-right w-24">
                      Price
                    </th>
                    <th role="columnheader" className="px-4 py-2.5 text-right w-24">
                      Subtotal
                    </th>
                    <th role="columnheader" className="px-4 py-2.5 w-12"></th>
                  </tr>
                </thead>
                <tbody role="rowgroup" className="divide-y divide-surface-border max-md:block">
                  {cart.items.map((item) => {
                    const priced = lineByProduct.get(item.productId);
                    const price = priced?.net ?? 0;
                    const original = priced?.original ?? null;
                    const freeUnits = priced?.freeUnits ?? 0;
                    return (
                      <tr
                        role="row"
                        key={item.productId}
                        className="hover:bg-surface-raised/50 max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-4 max-md:gap-y-2 max-md:p-3"
                      >
                        <td role="cell" className="px-4 py-3 max-md:w-full max-md:p-0">
                          <div className="flex items-center gap-3">
                            <div className="h-10 w-10 flex-shrink-0 rounded-lg bg-surface-raised flex items-center justify-center overflow-hidden">
                              {item.thumbnailUrl ? (
                                <img
                                  src={item.thumbnailUrl}
                                  alt=""
                                  className="h-full w-full object-cover"
                                  style={{
                                    objectPosition: objectPositionForUrl(item.thumbnailUrl),
                                  }}
                                />
                              ) : (
                                <Package className="h-5 w-5 text-navy/15" />
                              )}
                            </div>
                            <div>
                              <p className="text-sm font-medium text-navy">{item.name}</p>
                              <p className="text-xs text-navy/70">per {item.unit}</p>
                              {freeUnits > 0 && (
                                <p className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-buyer-50 px-1.5 py-0.5 text-[10px] font-semibold text-buyer-700">
                                  {freeUnits} free
                                </p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td
                          role="cell"
                          className="px-4 py-3 max-md:w-full max-md:min-w-0 max-md:p-0"
                        >
                          <CartRowQty
                            item={item}
                            name={item.name}
                            onCount={(n) => cart.updateQty(item.productId, n)}
                            onUnit={(unit) => cart.setUnit(item.productId, unit)}
                            onRemove={() => cart.removeItem(item.productId)}
                          />
                        </td>
                        <td
                          role="cell"
                          className="px-4 py-3 text-right text-sm max-md:p-0 max-md:text-left"
                        >
                          <span className="block text-[10px] uppercase tracking-wider text-navy/60 md:hidden">
                            Price
                          </span>
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
                        <td
                          role="cell"
                          className="px-4 py-3 text-right text-sm font-medium text-navy max-md:p-0 max-md:text-left"
                        >
                          <span className="block text-[10px] font-normal uppercase tracking-wider text-navy/60 md:hidden">
                            Subtotal
                          </span>
                          {priced?.unresolved ? (
                            <span className="text-navy/40">—</span>
                          ) : (
                            fmt(priced?.lineSubtotal ?? 0)
                          )}
                        </td>
                        <td role="cell" className="px-4 py-3 max-md:ml-auto max-md:p-0">
                          <button
                            onClick={() => cart.removeItem(item.productId)}
                            aria-label={`Remove ${item.name}`}
                            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded p-1.5 text-navy/30 hover:bg-danger-bg hover:text-danger transition-colors"
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
        </div>

        {/* Order options + summary */}
        <div className="min-w-0 space-y-4">
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

            {choice.showChoice && (
              <fieldset>
                <legend className="block text-xs text-navy/70 mb-1">How do you want it?</legend>
                <div className="space-y-1.5">
                  {choice.methods.map((m) => (
                    <label
                      key={m}
                      className="flex items-center gap-2 cursor-pointer text-sm text-navy"
                    >
                      <input
                        type="radio"
                        name="fulfillPath"
                        value={m}
                        checked={fulfillPath === m}
                        onChange={() => setPickedMethod(m)}
                        className="h-4 w-4 accent-buyer-500"
                      />
                      {FULFIL_METHOD_LABEL[m]}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

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
            <SellerUnavailableLine className="rounded-lg bg-surface-raised px-3 py-2 text-xs text-navy/80" />
            <Button
              className="w-full bg-buyer-500 hover:bg-buyer-600 focus-visible:ring-buyer-500"
              onClick={handlePlaceOrder}
              loading={createOrder.isPending}
              disabled={createOrder.isPending || !sellerAccepting}
              aria-describedby={sellerAccepting ? undefined : "seller-unavailable-line"}
            >
              {willMerge ? "Add to existing order" : "Place Order"}
            </Button>
          </div>

          {conflict && (
            <div role="alert" className="rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger">
              {conflict.orderId ? (
                <Link
                  href={`/buyer/portal/${sellerSlug}/orders/${conflict.orderId}`}
                  className="underline"
                >
                  {BUYER_ORDER_CONFLICT_COPY}
                </Link>
              ) : (
                BUYER_ORDER_CONFLICT_NO_ID_COPY
              )}
            </div>
          )}

          {orderError && (
            <div role="alert" className="rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger">
              {orderError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
