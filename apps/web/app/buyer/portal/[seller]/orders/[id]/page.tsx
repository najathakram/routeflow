"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Package,
  Clock,
  CheckCircle2,
  Truck,
  XCircle,
  AlertTriangle,
  Edit3,
  Minus,
  Plus,
  Loader2,
  Search,
  Trash2,
  FileText,
  MessageSquarePlus,
} from "lucide-react";
import { Badge, Button, Modal, useToast } from "@routeflow/ui/web";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import {
  useBuyerOrder,
  useBuyerCancelOrder,
  useBuyerUpdateOrderItems,
  useBuyerProducts,
  useBuyerCreateChangeRequest,
  type BuyerOrder,
} from "@/lib/api/buyer";
import { computeLineSubtotal, normalizeBoxesPieces } from "@/lib/pricing";
import { describeChangeRequest, describeResolution } from "@/lib/change-requests";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_STEPS = [
  "PENDING",
  "CONFIRMED",
  "OUT_FOR_DELIVERY",
  "PARTIALLY_DELIVERED",
  "DELIVERED",
];

interface BuyerEditLine {
  unitPrice: number;
  qty: number;
  unitsPerBox?: number | null;
  boxSplit?: boolean;
  /** BUY_N_GET_M snapshot on the loaded line + the whole-unit count it was earned at. */
  promoFreeUnits?: number | null;
  promoBaseUnits?: number | null;
}

/**
 * Only prorate lines the server will prorate: those stored box-aware (boxSplit).
 * Selling-unit and newly-added lines stay unitPrice*qty, matching the server's
 * denomination gate — otherwise the preview and the saved total would disagree.
 */
function buyerLineSplit(item: BuyerEditLine): { boxes: number | null; pieces: number | null } {
  const upb = Number(item.unitsPerBox ?? 0);
  if (upb > 1 && item.boxSplit) {
    const s = normalizeBoxesPieces({ qty: item.qty, unitsPerBox: upb });
    return { boxes: s.boxes, pieces: s.pieces };
  }
  return { boxes: null, pieces: null };
}

/**
 * BUY_N_GET_M free units for the edit preview, rescaled when the buyer changes
 * the qty: the snapshot was earned at `promoBaseUnits` whole selling units, so a
 * shrunk line earns proportionally fewer and a grown one never earns MORE than
 * was agreed (mirrors the order engine's `rescaleBogoFreeUnits` fallback and the
 * invoice edit form). Capped at units − 1 — the buyer always pays the N in every
 * (N + M), so no line is ever entirely free.
 */
function buyerLineFreeUnits(item: BuyerEditLine, boxes: number | null): number {
  const stored = Math.max(0, Math.trunc(Number(item.promoFreeUnits ?? 0) || 0));
  if (stored <= 0) return 0;
  const units = Math.trunc(Number(boxes != null ? boxes : item.qty) || 0);
  if (units <= 0) return 0;
  const base = Math.max(0, Math.trunc(Number(item.promoBaseUnits ?? units) || 0));
  const earned = base > 0 ? Math.floor((stored * units) / base) : stored;
  return Math.min(stored, earned, units - 1);
}

/** The free whole units `buyerLineAmount` nets off this line — also the label. */
function buyerLineAmountFreeUnits(item: BuyerEditLine): number {
  return buyerLineFreeUnits(item, buyerLineSplit(item).boxes);
}

/**
 * Boxed-aware line amount for the edit preview: a boxed line prices by the BOX
 * (unitPrice is the box price, qty is the piece count), so it prorates as
 * `unitPrice * (boxes + pieces / unitsPerBox)`. Matches the server on save; a
 * plain unitPrice*qty over-shows boxed lines by unitsPerBox.
 */
function buyerLineAmount(item: BuyerEditLine): number {
  const upb = Number(item.unitsPerBox ?? 0);
  const split = buyerLineSplit(item);
  return computeLineSubtotal({
    unitPrice: item.unitPrice,
    qty: item.qty,
    boxes: split.boxes,
    pieces: split.pieces,
    unitsPerBox: upb,
    // BUY_N_GET_M: free whole units come off before pricing, exactly like the
    // server — without this a 12-box line with 2 free previews at full price.
    freeUnits: buyerLineFreeUnits(item, split.boxes),
  });
}

function getStatusVariant(s: string): "success" | "warning" | "danger" | "neutral" {
  if (s === "DELIVERED" || s === "COMPLETED") return "success";
  if (s === "PARTIALLY_DELIVERED") return "warning";
  if (s === "PENDING" || s === "CONFIRMED" || s === "OUT_FOR_DELIVERY") return "warning";
  if (s === "CANCELLED") return "danger";
  return "neutral";
}

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

function formatStatus(s: string) {
  return s
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Status Timeline ──────────────────────────────────────────────────────────

function OrderTimeline({ status }: { status: string }) {
  const isCancelled = status === "CANCELLED";
  const currentIdx = STATUS_STEPS.indexOf(status);

  const icons = [
    { icon: Clock, label: "Pending" },
    { icon: CheckCircle2, label: "Confirmed" },
    { icon: Truck, label: "Out for Delivery" },
    { icon: Package, label: "Partial Delivery" },
    { icon: CheckCircle2, label: "Delivered" },
  ];

  return (
    <div className="flex items-center justify-between gap-0">
      {icons.map((step, i) => {
        const Icon = step.icon;
        const isComplete = !isCancelled && i <= currentIdx;
        const isCurrent = !isCancelled && i === currentIdx;

        return (
          <React.Fragment key={step.label}>
            {i > 0 && (
              <div
                className={`flex-1 h-0.5 ${isComplete ? "bg-buyer-500" : "bg-surface-border"}`}
              />
            )}
            <div className="flex flex-col items-center gap-1">
              <div
                className={`flex h-9 w-9 items-center justify-center rounded-full border-2 transition-colors ${
                  isCurrent
                    ? "border-buyer-500 bg-buyer-50 text-buyer-600"
                    : isComplete
                      ? "border-buyer-500 bg-buyer-500 text-white"
                      : "border-surface-border bg-white text-navy/30"
                }`}
              >
                <Icon className="h-4 w-4" />
              </div>
              <span
                className={`text-[10px] font-medium ${isCurrent ? "text-buyer-600" : isComplete ? "text-navy" : "text-navy/70"}`}
              >
                {step.label}
              </span>
            </div>
          </React.Fragment>
        );
      })}
      {isCancelled && (
        <div className="flex flex-col items-center gap-1 ml-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-danger bg-danger-bg text-danger">
            <XCircle className="h-4 w-4" />
          </div>
          <span className="text-[10px] font-medium text-danger">Cancelled</span>
        </div>
      )}
    </div>
  );
}

// ─── Request-a-change modal (P5-10) ───────────────────────────────────────────
// Files a post-dispatch ChangeRequest (P5-09 engine). Deliberately shows NO
// prices anywhere (not even catalog prices in the search results): an added
// line is priced by the SERVER at approval through the one buyer pricing path
// (tier -> sticky -> promo) — a client-side preview would be a second pricing
// derivation that can drift from the merged result.

type CrFormType = "ADD_ITEM" | "CHANGE_QTY" | "REMOVE_ITEM" | "NOTE";

const CR_TYPE_OPTIONS: Array<{ value: CrFormType; label: string }> = [
  { value: "ADD_ITEM", label: "Add an item" },
  { value: "CHANGE_QTY", label: "Change a quantity" },
  { value: "REMOVE_ITEM", label: "Remove an item" },
  { value: "NOTE", label: "Note for the driver" },
];

function RequestChangeModal({
  order,
  open,
  onClose,
  onFiled,
}: {
  order: BuyerOrder;
  open: boolean;
  onClose: () => void;
  onFiled: () => void;
}) {
  const createCr = useBuyerCreateChangeRequest();
  const [type, setType] = React.useState<CrFormType>("ADD_ITEM");
  const [orderItemId, setOrderItemId] = React.useState("");
  const [qty, setQty] = React.useState(1);
  const [note, setNote] = React.useState("");
  const [formError, setFormError] = React.useState<string | null>(null);
  const [product, setProduct] = React.useState<{ id: string; name: string } | null>(null);
  const [search, setSearch] = React.useState("");
  const [searchDebounced, setSearchDebounced] = React.useState("");

  React.useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const showSearch = open && type === "ADD_ITEM" && !product && searchDebounced.length >= 2;
  const { data: searchResults } = useBuyerProducts(
    showSearch ? { search: searchDebounced, limit: 6 } : { limit: 0 },
  );

  // Only active, not-yet-delivered lines can be changed/removed — the server
  // hard-blocks delivered lines at approval (409 LINE_ALREADY_DELIVERED).
  const changeableLines = order.lineItems.filter(
    (li) => li.status !== "CANCELLED" && Number(li.deliveredQty ?? 0) === 0,
  );
  const selectedLine = changeableLines.find((li) => li.id === orderItemId);

  const isValid =
    type === "ADD_ITEM"
      ? !!product && qty >= 1
      : type === "NOTE"
        ? note.trim().length > 0
        : !!selectedLine && (type === "REMOVE_ITEM" || qty >= 1);

  const resetAndClose = () => {
    setType("ADD_ITEM");
    setOrderItemId("");
    setQty(1);
    setNote("");
    setProduct(null);
    setSearch("");
    setFormError(null);
    onClose();
  };

  const handleSubmit = async () => {
    if (!isValid || createCr.isPending) return;
    setFormError(null);
    try {
      await createCr.mutateAsync({
        orderId: order.id,
        type,
        ...(type === "ADD_ITEM" ? { productId: product!.id, qty } : {}),
        ...(type === "CHANGE_QTY" ? { orderItemId, qty } : {}),
        ...(type === "REMOVE_ITEM" ? { orderItemId } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onFiled();
      resetAndClose();
    } catch (err: any) {
      const code = err?.response?.data?.code;
      if (code === "EDIT_WINDOW_OPEN") {
        setFormError(
          "This order can still be edited directly — close this and use “Edit Items” instead.",
        );
      } else if (code === "CHANGE_WINDOW_CLOSED") {
        setFormError(
          "The delivery run for this order has ended — changes can no longer be requested.",
        );
      } else {
        setFormError(err?.response?.data?.message ?? "Failed to send the change request.");
      }
    }
  };

  return (
    <Modal
      open={open}
      onClose={resetAndClose}
      title="Request a change"
      description="Your order is out for delivery, so changes need the seller's confirmation."
      footer={
        <>
          <Button variant="secondary" onClick={resetAndClose}>
            Cancel
          </Button>
          <Button
            className="bg-buyer-500 hover:bg-buyer-600 focus-visible:ring-buyer-500"
            onClick={handleSubmit}
            disabled={!isValid}
            loading={createCr.isPending}
          >
            Send Request
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Type picker */}
        <div className="grid grid-cols-2 gap-2">
          {CR_TYPE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                setType(opt.value);
                setFormError(null);
                setOrderItemId("");
                setQty(1);
                setProduct(null);
                setSearch("");
              }}
              className={`rounded-lg border px-3 py-2 text-left text-sm font-medium transition-colors ${
                type === opt.value
                  ? "border-buyer-500 bg-buyer-50 text-buyer-600"
                  : "border-surface-border bg-white text-navy/70 hover:text-navy"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* ADD_ITEM: product search (NO prices shown) + qty */}
        {type === "ADD_ITEM" && (
          <div className="space-y-2">
            {product ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-surface-border bg-surface-raised px-3 py-2">
                <span className="text-sm font-medium text-navy truncate">{product.name}</span>
                <button
                  type="button"
                  onClick={() => setProduct(null)}
                  className="text-xs font-medium text-navy/60 hover:text-navy"
                >
                  Change
                </button>
              </div>
            ) : (
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-navy/30" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search products (name, SKU, barcode)..."
                  className="w-full rounded-lg border border-surface-border bg-white py-2 pl-10 pr-4 text-sm text-navy placeholder:text-navy/70 focus:border-buyer-300 focus:outline-none focus:ring-1 focus:ring-buyer-200"
                />
              </div>
            )}
            {showSearch && (searchResults?.data?.length ?? 0) > 0 && (
              <div className="max-h-40 overflow-y-auto rounded-lg border border-surface-border bg-white shadow-lg">
                {searchResults!.data.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setProduct({ id: p.id, name: p.name });
                      setSearch("");
                    }}
                    className="flex w-full items-center gap-3 border-b border-surface-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-surface-raised"
                  >
                    <Plus className="h-4 w-4 flex-shrink-0 text-buyer-500" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-navy">{p.name}</p>
                      <p className="text-[11px] text-navy/70">
                        {p.sku ? `SKU: ${p.sku} · ` : ""}
                        {p.unit}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {showSearch && searchResults?.data?.length === 0 && (
              <p className="py-1 text-center text-xs text-navy/70">No products found</p>
            )}
            {product && (
              <label className="flex items-center gap-2 text-sm text-navy">
                Quantity
                <input
                  type="number"
                  min={1}
                  value={qty}
                  onChange={(e) => setQty(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                  className="w-20 rounded border border-surface-border bg-white px-2 py-1 text-center text-sm text-navy"
                />
              </label>
            )}
          </div>
        )}

        {/* CHANGE_QTY / REMOVE_ITEM: pick a line */}
        {(type === "CHANGE_QTY" || type === "REMOVE_ITEM") && (
          <div className="space-y-2">
            {changeableLines.length === 0 ? (
              <p className="text-sm text-navy/70">No lines on this order can still be changed.</p>
            ) : (
              <select
                value={orderItemId}
                onChange={(e) => {
                  setOrderItemId(e.target.value);
                  const li = changeableLines.find((l) => l.id === e.target.value);
                  if (li && type === "CHANGE_QTY") setQty(Math.max(1, Number(li.qty)));
                }}
                className="w-full rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy focus:border-buyer-300 focus:outline-none"
              >
                <option value="">Select an item…</option>
                {changeableLines.map((li) => (
                  <option key={li.id} value={li.id}>
                    {li.product.name} (qty {Number(li.qty)})
                  </option>
                ))}
              </select>
            )}
            {type === "CHANGE_QTY" && selectedLine && (
              <label className="flex items-center gap-2 text-sm text-navy">
                New quantity
                <input
                  type="number"
                  min={1}
                  value={qty}
                  onChange={(e) => setQty(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                  className="w-20 rounded border border-surface-border bg-white px-2 py-1 text-center text-sm text-navy"
                />
                <span className="text-xs text-navy/60">currently {Number(selectedLine.qty)}</span>
              </label>
            )}
          </div>
        )}

        {/* Note — required for NOTE, optional context otherwise */}
        <label className="block text-sm text-navy">
          {type === "NOTE" ? "Note" : "Note (optional)"}
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={1000}
            placeholder={type === "NOTE" ? "What should the driver know?" : "Anything else?"}
            className="mt-1 w-full rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/50 focus:border-buyer-300 focus:outline-none"
          />
        </label>

        {formError && (
          <div className="flex items-center gap-2 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            {formError}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BuyerOrderDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { activeSeller, isLoading: authLoading } = useBuyerAuth();
  const sellerSlug = params.seller as string;
  const orderId = params.id as string;

  const { data: order, isLoading, isError } = useBuyerOrder(orderId);
  const cancelOrder = useBuyerCancelOrder();
  const updateItems = useBuyerUpdateOrderItems();

  const [editMode, setEditMode] = React.useState(false);
  const [editItems, setEditItems] = React.useState<
    Array<
      BuyerEditLine & {
        productId: string;
        name: string;
        unit: string;
      }
    >
  >([]);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [addSearch, setAddSearch] = React.useState("");
  const [addSearchDebounced, setAddSearchDebounced] = React.useState("");
  const [crOpen, setCrOpen] = React.useState(false);
  const { toast } = useToast();

  // Debounce product search for adding items
  React.useEffect(() => {
    const t = setTimeout(() => setAddSearchDebounced(addSearch), 300);
    return () => clearTimeout(t);
  }, [addSearch]);

  const showProductSearch = editMode && addSearchDebounced.length >= 2;
  const { data: searchResults } = useBuyerProducts(
    showProductSearch ? { search: addSearchDebounced, limit: 6 } : { limit: 0 },
  );

  // Redirect checks
  React.useEffect(() => {
    if (!authLoading && !activeSeller) router.push("/buyer/portal");
  }, [authLoading, activeSeller, router]);

  React.useEffect(() => {
    if (!authLoading && activeSeller && activeSeller.tenant.slug !== sellerSlug) {
      router.push("/buyer/portal");
    }
  }, [authLoading, activeSeller, sellerSlug, router]);

  // Buyer direct edit: DRAFT/PENDING only, AND the P5-08 server edit window
  // must still be open (it closes when the run dispatches). Older API without
  // editWindow falls back to the pure status check.
  const canEdit =
    order &&
    (order.status === "DRAFT" || order.status === "PENDING") &&
    (order.editWindow?.editable ?? true);
  // P5-10: change requests exist exactly where direct editing ended — mirror
  // the server's create gate (run IN_PROGRESS + order still deliverable).
  const canRequestChange =
    !!order &&
    order.routeRun?.status === "IN_PROGRESS" &&
    ["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"].includes(order.status);
  const showDeliveryProgress =
    order &&
    (order.status === "PARTIALLY_DELIVERED" ||
      order.status === "OUT_FOR_DELIVERY" ||
      order.status === "DELIVERED");
  const canCancel = canEdit;

  const enterEditMode = () => {
    if (!order) return;
    setActionError(null);
    setEditItems(
      order.lineItems
        .filter((li) => li.status !== "CANCELLED")
        .map((li) => ({
          productId: li.productId,
          qty: Number(li.qty),
          name: li.product.name,
          unit: li.product.unit,
          unitPrice: Number(li.unitPrice),
          unitsPerBox: li.product.unitsPerBox ?? null,
          boxSplit: li.boxes != null || li.pieces != null,
          // BUY_N_GET_M snapshot + the whole-unit count it was earned at, so the
          // preview keeps the reduced subtotal the read-only row already shows.
          promoFreeUnits: li.promoFreeUnits ?? null,
          promoBaseUnits: li.promoFreeUnits
            ? Math.trunc(Number(li.boxes != null ? li.boxes : li.qty) || 0)
            : null,
        })),
    );
    setEditMode(true);
  };

  const handleSaveEdit = async () => {
    if (!order) return;
    setActionError(null);
    try {
      await updateItems.mutateAsync({
        orderId: order.id,
        items: editItems.map((i) => ({ productId: i.productId, qty: i.qty })),
      });
      setEditMode(false);
    } catch (err: any) {
      const data = err?.response?.data;
      if (err?.response?.status === 409 && data?.code === "REGULATED_AUTH_REQUIRED") {
        const names = (data.blockedCategories ?? [])
          .map((b: { categoryName: string }) => b.categoryName)
          .join(", ");
        setActionError(
          `This order includes regulated items${names ? ` (${names})` : ""} that need a verified license. Submit or renew it on the Licenses page, then try again.`,
        );
        return;
      }
      setActionError(data?.message ?? "Failed to update order items.");
    }
  };

  const handleCancel = async () => {
    if (!order) return;
    setActionError(null);
    try {
      await cancelOrder.mutateAsync(order.id);
      setCancelOpen(false);
    } catch (err: any) {
      setCancelOpen(false);
      setActionError(err?.response?.data?.message ?? "Failed to cancel order.");
    }
  };

  if (authLoading || isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-buyer-500" />
      </div>
    );
  }

  if (isError || !order) {
    return (
      <div className="p-6">
        <div className="rounded-lg bg-danger-bg px-4 py-3 text-sm text-danger">
          Failed to load order.
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl">
      {/* Back + header */}
      <button
        onClick={() => router.push(`/buyer/portal/${sellerSlug}/orders`)}
        className="mb-4 flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Orders
      </button>

      <div className="flex items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-navy">{order.orderNumber}</h1>
          <p className="text-sm text-navy/70 mt-0.5">
            Placed {formatDate(order.createdAt)}
            {order.requestedDeliveryDate && (
              <> · Delivery requested {formatDate(order.requestedDeliveryDate)}</>
            )}
          </p>
        </div>
        <Badge variant={getStatusVariant(order.status)}>{formatStatus(order.status)}</Badge>
      </div>

      {/* Status timeline */}
      <div className="mb-8 rounded-xl border border-surface-border bg-white p-6">
        <OrderTimeline status={order.status} />
      </div>

      {/* P5-10: change requests filed after dispatch — PENDING (amber) flips to
          Approved (green) / Declined + reason (red) once resolved. */}
      {(order.changeRequests?.length ?? 0) > 0 && (
        <div className="mb-6 overflow-hidden rounded-xl border border-surface-border bg-white">
          <div className="border-b border-surface-border bg-surface-raised px-4 py-3">
            <h2 className="text-sm font-semibold text-navy">Change requests</h2>
          </div>
          <ul className="divide-y divide-surface-border">
            {order.changeRequests!.map((cr) => {
              const { title, detail } = describeChangeRequest(cr, order.lineItems);
              const outcome = describeResolution(cr);
              return (
                <li key={cr.id} className="flex items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-navy">{title}</p>
                    {detail && <p className="mt-0.5 text-xs text-navy/70">{detail}</p>}
                    <p className="mt-0.5 text-[11px] text-navy/50">
                      Requested {new Date(cr.createdAt).toLocaleString()}
                    </p>
                    {outcome && (
                      <p
                        className={`mt-1 text-xs font-medium ${
                          cr.status === "DECLINED" ? "text-danger" : "text-success"
                        }`}
                      >
                        {outcome}
                      </p>
                    )}
                  </div>
                  <Badge status={cr.status} />
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Order summary cards */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: "Subtotal", value: fmt(Number(order.subtotal)) },
          { label: "Tax", value: fmt(Number(order.tax)) },
          {
            label: "Discount",
            value:
              Number(order.discountAmount) > 0 ? `-${fmt(Number(order.discountAmount))}` : fmt(0),
          },
          { label: "Total", value: fmt(Number(order.total)), bold: true },
        ].map((c) => (
          <div key={c.label} className="rounded-xl border border-surface-border bg-white p-4">
            <p className="text-xs text-navy/70 mb-1">{c.label}</p>
            <p className={`text-lg ${c.bold ? "font-bold text-navy" : "text-navy/80"}`}>
              {c.value}
            </p>
          </div>
        ))}
      </div>

      {order.urgent && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning-bg px-4 py-2.5 text-sm text-warning">
          <AlertTriangle className="h-4 w-4" /> This order is marked as urgent
        </div>
      )}

      {order.notes && (
        <div className="mb-4 rounded-xl border border-surface-border bg-white p-4">
          <p className="text-xs text-navy/70 mb-1">Order Notes</p>
          <p className="text-sm text-navy">{order.notes}</p>
        </div>
      )}

      {/* Action error */}
      {actionError && (
        <div className="mb-4 flex items-center gap-2 rounded-lg bg-danger-bg px-4 py-2.5 text-sm text-danger">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          {actionError}
        </div>
      )}

      {/* Line items */}
      <div className="rounded-xl border border-surface-border bg-white overflow-hidden mb-6">
        <div className="flex items-center justify-between border-b border-surface-border bg-surface-raised px-4 py-3">
          <h2 className="text-sm font-semibold text-navy">
            Items ({order.lineItems.filter((li) => li.status !== "CANCELLED").length})
          </h2>
          {canEdit && !editMode && (
            <Button variant="secondary" size="sm" onClick={enterEditMode}>
              <Edit3 className="mr-1.5 h-3.5 w-3.5" /> Edit Items
            </Button>
          )}
          {!canEdit && canRequestChange && !editMode && (
            <Button variant="secondary" size="sm" onClick={() => setCrOpen(true)}>
              <MessageSquarePlus className="mr-1.5 h-3.5 w-3.5" /> Request a change
            </Button>
          )}
          {editMode && (
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => setEditMode(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                className="bg-buyer-500 hover:bg-buyer-600 focus-visible:ring-buyer-500"
                onClick={handleSaveEdit}
                loading={updateItems.isPending}
              >
                Save Changes
              </Button>
            </div>
          )}
        </div>

        <table className="w-full">
          <thead>
            <tr className="border-b border-surface-border text-xs text-navy/70 uppercase tracking-wider">
              <th className="px-4 py-2.5 text-left">Product</th>
              <th className="px-4 py-2.5 text-right w-20">
                {showDeliveryProgress ? "Ordered" : "Qty"}
              </th>
              {showDeliveryProgress && (
                <>
                  <th className="px-4 py-2.5 text-right w-20">Delivered</th>
                  <th className="px-4 py-2.5 text-right w-20">Remaining</th>
                </>
              )}
              <th className="px-4 py-2.5 text-right w-28">Unit Price</th>
              <th className="px-4 py-2.5 text-right w-28">Subtotal</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {editMode
              ? editItems.map((item) => (
                  <tr key={item.productId} className="hover:bg-surface-raised/50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() =>
                            setEditItems((prev) =>
                              prev.filter((i) => i.productId !== item.productId),
                            )
                          }
                          className="rounded p-1 text-danger/40 hover:bg-danger-bg hover:text-danger transition-colors"
                          title="Remove item"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                        <span className="text-sm font-medium text-navy">{item.name}</span>
                        {/* BUY_N_GET_M: the preview subtotal already nets these off. */}
                        {buyerLineAmountFreeUnits(item) > 0 && (
                          <span className="inline-flex items-center rounded-full bg-buyer-50 px-1.5 py-0.5 text-[10px] font-semibold text-buyer-700">
                            {buyerLineAmountFreeUnits(item)} free
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() =>
                            setEditItems((prev) =>
                              prev.map((i) =>
                                i.productId === item.productId
                                  ? { ...i, qty: Math.max(1, i.qty - 1) }
                                  : i,
                              ),
                            )
                          }
                          className="rounded p-1 text-navy/70 hover:bg-surface-raised hover:text-navy"
                        >
                          <Minus className="h-3.5 w-3.5" />
                        </button>
                        <input
                          type="number"
                          min={1}
                          value={item.qty}
                          onChange={(e) => {
                            const v = Math.max(1, Number(e.target.value));
                            setEditItems((prev) =>
                              prev.map((i) =>
                                i.productId === item.productId ? { ...i, qty: v } : i,
                              ),
                            );
                          }}
                          className="w-14 rounded border border-surface-border bg-white px-2 py-1 text-center text-sm text-navy"
                        />
                        <button
                          onClick={() =>
                            setEditItems((prev) =>
                              prev.map((i) =>
                                i.productId === item.productId ? { ...i, qty: i.qty + 1 } : i,
                              ),
                            )
                          }
                          className="rounded p-1 text-navy/70 hover:bg-surface-raised hover:text-navy"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-navy/70">
                      {item.unitPrice ? fmt(item.unitPrice) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-navy">
                      {item.unitPrice ? fmt(buyerLineAmount(item)) : "—"}
                    </td>
                  </tr>
                ))
              : order.lineItems.map((li) => (
                  <tr
                    key={li.id}
                    className={`hover:bg-surface-raised/50 ${li.status === "CANCELLED" ? "opacity-40 line-through" : ""}`}
                  >
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-navy">{li.product.name}</p>
                      <p className="text-xs text-navy/70">
                        {li.product.unit}
                        {li.priceType !== "STANDARD" && (
                          <span
                            className={`ml-1.5 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                              li.priceType === "DISCOUNTED"
                                ? "bg-success-bg text-success"
                                : "bg-buyer-50 text-buyer-600"
                            }`}
                          >
                            {li.priceType === "DISCOUNTED"
                              ? "Discounted"
                              : li.priceType === "PROMO"
                                ? "Promo"
                                : "Special"}
                          </span>
                        )}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-navy">
                      <span>{Number(li.qty)}</span>
                      {li.boxes != null && li.boxes > 0 && (
                        <p className="text-[10px] text-navy/70">
                          {li.boxes} box{li.boxes > 1 ? "es" : ""}
                          {li.pieces ? ` + ${li.pieces} pcs` : ""}
                        </p>
                      )}
                      {/* BUY_N_GET_M: without this the reduced subtotal reads as a
                          pricing error to the buyer. */}
                      {Number(li.promoFreeUnits ?? 0) > 0 && (
                        <p className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-buyer-50 px-1.5 py-0.5 text-[10px] font-semibold text-buyer-700">
                          {Number(li.promoFreeUnits)} free
                        </p>
                      )}
                    </td>
                    {showDeliveryProgress && (
                      <>
                        <td className="px-4 py-3 text-right text-sm text-success font-medium">
                          {Number(li.deliveredQty ?? 0)}
                        </td>
                        <td className="px-4 py-3 text-right text-sm">
                          {(() => {
                            const remaining = Number(li.qty) - Number(li.deliveredQty ?? 0);
                            return remaining > 0 ? (
                              <span className="text-warning font-medium">{remaining}</span>
                            ) : (
                              <span className="text-success">0</span>
                            );
                          })()}
                        </td>
                      </>
                    )}
                    <td className="px-4 py-3 text-right text-sm text-navy/70">
                      {fmt(Number(li.unitPrice))}
                      {li.originalPrice && Number(li.originalPrice) > Number(li.unitPrice) && (
                        <span className="ml-1 text-xs text-navy/70 line-through">
                          {fmt(Number(li.originalPrice))}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-navy">
                      {fmt(Number(li.subtotal))}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>

        {/* Inline product search (edit mode only) */}
        {editMode && (
          <div className="border-t border-surface-border p-4 bg-surface-raised/30">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-navy/30" />
              <input
                type="text"
                value={addSearch}
                onChange={(e) => setAddSearch(e.target.value)}
                placeholder="Search products to add (name, SKU, barcode)..."
                className="w-full rounded-lg border border-surface-border bg-white py-2 pl-10 pr-4 text-sm text-navy placeholder:text-navy/70 focus:border-buyer-300 focus:outline-none focus:ring-1 focus:ring-buyer-200"
              />
            </div>
            {showProductSearch && searchResults?.data && searchResults.data.length > 0 && (
              <div className="mt-2 rounded-lg border border-surface-border bg-white shadow-lg max-h-48 overflow-y-auto">
                {searchResults.data
                  .filter((p) => !editItems.some((ei) => ei.productId === p.id))
                  .map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        setEditItems((prev) => [
                          ...prev,
                          {
                            productId: p.id,
                            qty: 1,
                            name: p.name,
                            unit: p.unit,
                            unitPrice: p.buyerPrice,
                          },
                        ]);
                        setAddSearch("");
                      }}
                      className="w-full flex items-center gap-3 px-3 py-2 text-left text-sm hover:bg-surface-raised transition-colors border-b border-surface-border last:border-b-0"
                    >
                      <Plus className="h-4 w-4 text-buyer-500 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-navy truncate">{p.name}</p>
                        <p className="text-[11px] text-navy/70">
                          {p.sku ? `SKU: ${p.sku} · ` : ""}
                          {p.unit} ·{" "}
                          {new Intl.NumberFormat("en-US", {
                            style: "currency",
                            currency: "USD",
                          }).format(p.buyerPrice)}
                        </p>
                      </div>
                    </button>
                  ))}
                {searchResults.data.every((p) => editItems.some((ei) => ei.productId === p.id)) && (
                  <p className="px-3 py-2 text-xs text-navy/70 text-center">
                    All results already in order
                  </p>
                )}
              </div>
            )}
            {showProductSearch && searchResults?.data?.length === 0 && (
              <p className="mt-2 text-xs text-navy/70 text-center py-2">No products found</p>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      {canCancel && (
        <div className="flex justify-end">
          <Button variant="danger" onClick={() => setCancelOpen(true)}>
            Cancel Order
          </Button>
        </div>
      )}

      {/* Cancel confirmation */}
      <Modal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancel Order?"
        description={`Cancel order ${order.orderNumber}?`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCancelOpen(false)}>
              Keep Order
            </Button>
            <Button variant="danger" onClick={handleCancel} loading={cancelOrder.isPending}>
              Cancel Order
            </Button>
          </>
        }
      >
        <p className="text-sm text-navy/70">
          This will cancel your order <strong>{order.orderNumber}</strong>. This action cannot be
          undone.
        </p>
      </Modal>

      <RequestChangeModal
        order={order}
        open={crOpen}
        onClose={() => setCrOpen(false)}
        onFiled={() =>
          toast({
            title: "Change request sent",
            description: "The seller will confirm it with your driver.",
            variant: "success",
          })
        }
      />
    </div>
  );
}
