"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  AlertTriangle,
  User,
  Package,
  FileText,
  CheckCircle2,
  XCircle,
  Loader2,
  Pencil,
  RefreshCcw,
  Search,
  RotateCcw,
  Trash2,
  Truck,
  Calendar,
  Download,
  Mail,
  MessageCircle,
  Phone,
  Send,
  X,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  Modal,
  Select,
  cn,
  useToast,
  type BadgeStatus,
} from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import {
  useOrder,
  useUpdateOrderStatus,
  useUpdateOrderItems,
  useReopenOrder,
  useDeleteOrder,
  useUpdateOrderShipment,
  useCustomerPriceHistory,
  useResolveChangeRequest,
  useCancelImpact,
  usePatchOrderCommissionRate,
  usePatchOrderFulfillPath,
  type OrderItem,
  type ItemUpdate,
  type CustomerPriceHistory,
} from "@/lib/api/orders";
import { useAuth } from "@/lib/auth-context";
import { useHasAddon } from "@/lib/api/tobacco";
import { SALES_AGENTS_ADDON } from "@/lib/api/addons";
import { describeCancelImpact } from "@/lib/cancel-impact";
import { fmtCalendarDate, isInternalEmail } from "@/lib/formatting";
import { formatMoney, formatQty } from "@/lib/format";
import {
  describeChangeRequest,
  describeResolution,
  type ChangeRequest,
  type ChangeRequestResolveAction,
} from "@/lib/change-requests";
import { useCreateInvoiceFromOrder, useSendInvoice, useSendInvoiceEmail } from "@/lib/api/invoices";
import { LicenseGuardModal } from "../_components/LicenseGuardModal";
import { parseRegulatedAuthError, type BlockedCategory } from "@/lib/api/authorizations";
import { useProducts } from "@/lib/api/products";
import {
  computeLineSubtotal,
  formatQtySplit,
  getTierPrice,
  normalizeBoxesPieces,
  roundMoney,
} from "@/lib/pricing";
import { useCustomer, useCustomerPrices } from "@/lib/api/customers";
import { useMarginConfig, floorForCategory } from "@/lib/api/margin";
import { MarginHint } from "@/components/MarginHint";
import { MoneyInput, DecimalInput } from "@/components/MoneyInput";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { InlineCreateProductModal } from "@/components/InlineCreateProductModal";
import { resolveProductByCode } from "@/lib/barcode-resolve";
import { ShipmentCard } from "@/components/ShipmentCard";
import { SplitInvoiceModal } from "../_components/SplitInvoiceModal";
import { InvoicePreviewModal, DivergenceNote } from "../../_components/LinkedDocPreviewModal";
import { apiClient } from "@/lib/api-client";
import { CreditNotePicker, type CreditSelection } from "../_components/CreditNotePicker";

// ─── Send Invoice Modal ────────────────────────────────────────────────────────

interface InvoiceModalData {
  invoiceId: string;
  invoiceNumber: string;
  total: number;
  customerName: string;
  customerPhone?: string | null;
  customerMobile?: string | null;
  customerEmail?: string | null;
}

function SendInvoiceModal({ data, onClose }: { data: InvoiceModalData; onClose: () => void }) {
  const { toast } = useToast();
  const sendInvoice = useSendInvoice();
  const sendInvoiceEmail = useSendInvoiceEmail();
  const [pdfLoading, setPdfLoading] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  const [emailSent, setEmailSent] = React.useState(false);

  const phone = data.customerMobile || data.customerPhone;
  const totalFmt = formatMoney(data.total);
  const invoiceMsg = encodeURIComponent(
    `Hi ${data.customerName}, your invoice ${data.invoiceNumber} for ${totalFmt} is ready. Please let us know if you have any questions.`,
  );

  async function handleSend() {
    sendInvoice.mutate(data.invoiceId, {
      onSuccess: () => {
        setSent(true);
        toast({ title: "Invoice marked as sent", variant: "success" });
      },
      onError: (e) => toast({ title: e.message, variant: "error" }),
    });
  }

  function handleSendEmail() {
    sendInvoiceEmail.mutate(
      { id: data.invoiceId, email: data.customerEmail! },
      {
        onSuccess: (res) => {
          setEmailSent(true);
          setSent(true);
          toast({
            title: "Invoice emailed",
            description: `Sent to ${res.sentTo}`,
            variant: "success",
          });
        },
        onError: (e: any) =>
          toast({
            title: "Failed to send email",
            description: e?.response?.data?.message || e.message,
            variant: "error",
          }),
      },
    );
  }

  async function handleDownload() {
    setPdfLoading(true);
    try {
      // Two-step: ask the API to render the PDF, then fetch the bytes through
      // the authenticated apiClient. Cannot `window.open(url)` directly — the
      // storage endpoint requires a JWT (RF-075) and a top-level new-tab
      // navigation has no token in localStorage scope, so it returns 401.
      const meta = await apiClient.get<{ url: string }>(`/invoices/${data.invoiceId}/pdf`);
      if (!meta.data?.url) throw new Error("No PDF URL returned");
      const pdfRes = await apiClient.get<Blob>(meta.data.url, { responseType: "blob" });
      const blobUrl = URL.createObjectURL(pdfRes.data);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `invoice-${data.invoiceId}.pdf`;
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch {
      toast({ title: "Could not generate PDF", variant: "error" });
    } finally {
      setPdfLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 backdrop-blur-sm sm:items-center">
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-surface-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-navy">Invoice Ready</h2>
            <p className="mt-0.5 text-sm text-navy/70">
              {data.invoiceNumber} · {totalFmt} · {data.customerName}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-navy/70 hover:text-navy transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Options */}
        <div className="px-5 py-4 space-y-2">
          {sent ? (
            <div className="flex items-center gap-2 rounded-lg bg-success-bg px-4 py-3 text-sm font-medium text-success">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              Invoice marked as sent
            </div>
          ) : (
            <button
              onClick={handleSend}
              disabled={sendInvoice.isPending}
              className="flex w-full items-center gap-3 rounded-xl border border-surface-border bg-white px-4 py-3 text-left transition-colors hover:bg-brand-50 hover:border-brand-300 disabled:opacity-50"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-100">
                {sendInvoice.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin text-brand-600" />
                ) : (
                  <Send className="h-4 w-4 text-brand-600" />
                )}
              </div>
              <div>
                <p className="text-sm font-medium text-navy">Mark as Sent</p>
                <p className="text-xs text-navy/70">Record invoice as sent to customer</p>
              </div>
            </button>
          )}

          {/* WhatsApp */}
          {phone && (
            <a
              href={`https://wa.me/${phone.replace(/\D/g, "")}?text=${invoiceMsg}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex w-full items-center gap-3 rounded-xl border border-surface-border bg-white px-4 py-3 text-left transition-colors hover:bg-[#e7f9e7] hover:border-[#25D366]/40"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#e7f9e7]">
                <MessageCircle className="h-4 w-4 text-[#25D366]" />
              </div>
              <div>
                <p className="text-sm font-medium text-navy">Send via WhatsApp</p>
                <p className="text-xs text-navy/70">{phone}</p>
              </div>
            </a>
          )}

          {/* Email */}
          {data.customerEmail &&
            (emailSent ? (
              <div className="flex items-center gap-2 rounded-lg bg-success-bg px-4 py-3 text-sm font-medium text-success">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                Email sent to {data.customerEmail}
              </div>
            ) : (
              <button
                onClick={handleSendEmail}
                disabled={sendInvoiceEmail.isPending}
                className="flex w-full items-center gap-3 rounded-xl border border-surface-border bg-white px-4 py-3 text-left transition-colors hover:bg-surface-raised disabled:opacity-50"
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-raised">
                  {sendInvoiceEmail.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin text-navy/70" />
                  ) : (
                    <Mail className="h-4 w-4 text-navy/70" />
                  )}
                </div>
                <div>
                  <p className="text-sm font-medium text-navy">Send via Email</p>
                  <p className="text-xs text-navy/70">{data.customerEmail}</p>
                </div>
              </button>
            ))}

          {/* SMS */}
          {phone && (
            <a
              href={`sms:${phone}?body=${invoiceMsg}`}
              className="flex w-full items-center gap-3 rounded-xl border border-surface-border bg-white px-4 py-3 text-left transition-colors hover:bg-surface-raised"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-raised">
                <Phone className="h-4 w-4 text-navy/70" />
              </div>
              <div>
                <p className="text-sm font-medium text-navy">Send via Text</p>
                <p className="text-xs text-navy/70">{phone}</p>
              </div>
            </a>
          )}

          {/* Download PDF */}
          <button
            onClick={handleDownload}
            disabled={pdfLoading}
            className="flex w-full items-center gap-3 rounded-xl border border-surface-border bg-white px-4 py-3 text-left transition-colors hover:bg-surface-raised disabled:opacity-50"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-raised">
              {pdfLoading ? (
                <Loader2 className="h-4 w-4 animate-spin text-navy/70" />
              ) : (
                <Download className="h-4 w-4 text-navy/70" />
              )}
            </div>
            <div>
              <p className="text-sm font-medium text-navy">Download PDF</p>
              <p className="text-xs text-navy/70">Save a copy to your device</p>
            </div>
          </button>
        </div>

        {/* Footer */}
        <div className="border-t border-surface-border px-5 py-3">
          <button
            onClick={onClose}
            className="w-full rounded-lg px-4 py-2 text-sm text-navy/70 hover:text-navy hover:bg-surface-raised transition-colors"
          >
            Skip — I&apos;ll send it later
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

type ApiOrderStatus =
  | "DRAFT"
  | "PENDING"
  | "CONFIRMED"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "CANCELLED";

interface EditItemState {
  id: string; // real DB id for existing items; temp "new-{uuid}" for new items
  isNew?: boolean;
  /** True for a free-text, non-catalog line (no productId; { name, qty, unitPrice }). */
  isUnlisted?: boolean;
  originalProductId: string;
  originalProductName: string;
  originalQty: number;
  /** The line's own denomination, restored when a substitution is undone (a
   *  substitute re-denominates the line against ITS case size). */
  originalUnitsPerBox?: number | null;
  originalBoxSplit?: boolean;
  /** The line's own price, restored alongside the denomination when a
   *  substitution is undone — otherwise the original product would save at the
   *  SUBSTITUTE's price (the UPDATE branch sees `priceChanged` and sends it). */
  originalUnitPrice?: number;
  originalBasePrice?: number;
  originalOverrideReason?: string;
  productId: string;
  productName: string;
  qty: number;
  unitPrice: number;
  /** List/catalog price for this line — the strikethrough baseline and the
   * amount-off anchor. `originalPrice ?? unitPrice` when loaded from the order. */
  basePrice: number;
  /** Optional note explaining a price override (DRAFT only). */
  overrideReason?: string;
  cancelled: boolean;
  substituteProductId?: string;
  notes?: string;
  /** Product cost (per piece) + packaging + category for the live margin hint. */
  unitCost?: number | null;
  unitsPerBox?: number | null;
  category?: string | null;
  /** True when the loaded line was stored with a box/piece split (qty is in
   *  pieces). Gates boxed proration so selling-unit lines aren't misread. */
  boxSplit?: boolean;
  /** BUY_N_GET_M snapshot on the loaded line + the whole selling-unit count it
   *  was earned at. The preview MUST net these off or a BOGO line shows at full
   *  price and disagrees with both the stored subtotal and the server on save. */
  promoFreeUnits?: number | null;
  promoBaseUnits?: number | null;
}

// ─── Boxed proration helpers ──────────────────────────────────────────────────
// A boxed line's `qty` is the total piece count while `unitPrice` is the BOX
// price. Derive boxes/pieces from qty so both the preview and the save payload
// prorate as `unitPrice * (boxes + pieces / unitsPerBox)` — a plain qty*unitPrice
// over-charges boxed lines by unitsPerBox (money-discipline rule).

// `boxSplit` gates proration: only lines that were STORED with a box/piece split
// have `qty` denominated in pieces. A boxed line added via this builder without a
// split keeps `qty` in selling units (boxes) — re-deriving pieces from it would
// under-charge, so we leave those as a plain unitPrice*qty line.
function editBoxedSplit(it: { qty: number; unitsPerBox?: number | null; boxSplit?: boolean }): {
  boxes: number | null;
  pieces: number | null;
} {
  const upb = Number(it.unitsPerBox ?? 0);
  if (upb > 1 && it.boxSplit) {
    const s = normalizeBoxesPieces({ qty: it.qty, unitsPerBox: upb });
    return { boxes: s.boxes, pieces: s.pieces };
  }
  return { boxes: null, pieces: null };
}

/** DTO fragment: send boxes/pieces ONLY for boxed, box-split lines so the server prorates. */
function boxedDtoFields(it: { qty: number; unitsPerBox?: number | null; boxSplit?: boolean }): {
  boxes?: number;
  pieces?: number;
} {
  const { boxes, pieces } = editBoxedSplit(it);
  return boxes != null ? { boxes, pieces: pieces ?? 0 } : {};
}

/**
 * The substitution payload — shared by BOTH save paths (Save Draft/Save and
 * Save & Publish) so they can never drift apart again.
 *
 * Carries the box split (already re-denominated against the SUBSTITUTE's case
 * size when the product was picked, so the split the server prices is the one
 * the preview shows — a bare `qty` bills the substitute's BOX price per piece)
 * plus any operator override in EITHER direction. Mirrors mobile's
 * `buildOrderItemDiff` substitute branch exactly; the server maps below-base to
 * DISCOUNTED and above-base to MANUAL, so dropping an upsell here would silently
 * bill the substitute's list price.
 */
function substituteDtoUpdate(it: EditItemState): ItemUpdate {
  return {
    id: it.id,
    substituteProductId: it.substituteProductId,
    qty: it.qty,
    ...boxedDtoFields(it),
    ...(isPriceOverridden(it)
      ? { unitPrice: it.unitPrice, overrideReason: it.overrideReason }
      : {}),
  };
}

/** An override is any net unit price DIVERGING from the line's base — a discount
 *  below it or an operator upsell above it (same EPS test as `PriceEditRow` and
 *  mobile's `buildOrderItemDiff`; a downward-only test drops upsells). */
function isPriceOverridden(it: { unitPrice: number; basePrice: number }): boolean {
  return Math.abs(it.unitPrice - it.basePrice) > 0.0001;
}

/**
 * The line's own price, for the Undo handlers. Substituting rewrites unitPrice /
 * basePrice / overrideReason to the SUBSTITUTE's; without this an abandoned
 * substitution leaves the original product carrying the substitute's price, and
 * the plain UPDATE branch (which fires on `priceChanged`) saves it.
 */
function restoredPrice(it: EditItemState): Partial<EditItemState> {
  return {
    ...(it.originalUnitPrice != null ? { unitPrice: it.originalUnitPrice } : {}),
    ...(it.originalBasePrice != null ? { basePrice: it.originalBasePrice } : {}),
    overrideReason: it.originalOverrideReason,
  };
}

/**
 * BUY_N_GET_M free units for the edit preview, rescaled when the operator edits
 * the qty: the snapshot was earned at `promoBaseUnits` whole selling units, so a
 * shrunk line earns proportionally fewer and a grown one never earns MORE than
 * was agreed (mirrors the order engine's `rescaleBogoFreeUnits` fallback and the
 * invoice edit form). Capped at units − 1 — the buyer always pays the N in every
 * (N + M). A pending SUBSTITUTION earns nothing: the snapshot belongs to the
 * product being replaced, and undoing the substitution restores it.
 */
function editLineFreeUnits(it: {
  qty: number;
  unitsPerBox?: number | null;
  boxSplit?: boolean;
  substituteProductId?: string;
  promoFreeUnits?: number | null;
  promoBaseUnits?: number | null;
}): number {
  if (it.substituteProductId) return 0;
  const stored = Math.max(0, Math.trunc(Number(it.promoFreeUnits ?? 0) || 0));
  if (stored <= 0) return 0;
  const { boxes } = editBoxedSplit(it);
  const units = Math.trunc(Number(boxes != null ? boxes : it.qty) || 0);
  if (units <= 0) return 0;
  const base = Math.max(0, Math.trunc(Number(it.promoBaseUnits ?? units) || 0));
  const earned = base > 0 ? Math.floor((stored * units) / base) : stored;
  return Math.min(stored, earned, units - 1);
}

/** Boxed-aware line subtotal for the edit preview (matches server pricing). */
function editLineSubtotal(it: {
  unitPrice: number;
  qty: number;
  unitsPerBox?: number | null;
  boxSplit?: boolean;
  substituteProductId?: string;
  promoFreeUnits?: number | null;
  promoBaseUnits?: number | null;
}): number {
  const { boxes, pieces } = editBoxedSplit(it);
  return computeLineSubtotal({
    unitPrice: it.unitPrice,
    qty: it.qty,
    boxes,
    pieces,
    unitsPerBox: it.unitsPerBox ?? null,
    // BUY_N_GET_M: free whole units come off before pricing, exactly like the
    // server — a plain qty*unitPrice previews a BOGO line at full price.
    freeUnits: editLineFreeUnits(it),
  });
}

// ─── Demote reason modal ──────────────────────────────────────────────────────

function DemoteReasonModal({
  open,
  onClose,
  onConfirm,
  loading,
  targetStatus,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  loading: boolean;
  targetStatus: string;
}) {
  const [reason, setReason] = React.useState("");

  const label: Record<string, string> = {
    PENDING: "Return to Pending",
    CONFIRMED: "Return to Confirmed",
  };
  const description: Record<string, string> = {
    PENDING: "Why is this order being returned to pending?",
    CONFIRMED: "Why is this order being returned to confirmed?",
  };

  React.useEffect(() => {
    if (open) setReason("");
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-xl">
        <div className="border-b border-surface-border px-5 py-4">
          <h2 className="text-base font-semibold text-navy">
            {label[targetStatus] ?? "Change Status"}
          </h2>
          <p className="mt-1 text-sm text-navy/70">
            {description[targetStatus] ?? "Reason for this status change."}
          </p>
        </div>
        <div className="px-5 py-4">
          <label className="block text-sm font-medium text-navy/80 mb-1.5">Reason</label>
          <textarea
            className="w-full resize-none rounded-lg border border-surface-border bg-surface-raised px-3 py-2 text-sm text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-brand-500"
            rows={3}
            placeholder="e.g. Customer called to request a change..."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-surface-border px-5 py-3">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => onConfirm(reason)}
            disabled={!reason.trim()}
            loading={loading}
          >
            Confirm
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Commission rate override (staff + sales_agents addon only) ───────────────

function CommissionEditModal({
  open,
  onClose,
  orderId,
  currentValue,
}: {
  open: boolean;
  onClose: () => void;
  orderId: string;
  currentValue: number | null;
}) {
  const { toast } = useToast();
  const patchCommission = usePatchOrderCommissionRate();
  const [value, setValue] = React.useState<number | null>(currentValue);

  React.useEffect(() => {
    if (open) setValue(currentValue);
  }, [open, currentValue]);

  // The server resyncs every issued invoice of the order in the same tx
  // (setCommissionRate → syncOrderInvoices) — this just refetches via the
  // hook's invalidation; it never predicts the ledger effect client-side.
  const save = (commissionRatePct: number | null) => {
    patchCommission.mutate(
      { id: orderId, commissionRatePct },
      {
        onSuccess: () => {
          toast({ title: "Commission rate updated", variant: "success" });
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Commission rate override"
      description="Percent of the goods subtotal for this order only. 0 = exempt (no commission); blank = the customer/agent default rate."
      className="max-w-sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={patchCommission.isPending}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => save(null)}
            disabled={patchCommission.isPending}
          >
            Clear override
          </Button>
          <Button size="sm" onClick={() => save(value)} loading={patchCommission.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-1">
        <label className="block text-xs font-medium text-navy/70" htmlFor="order-commission-rate">
          Commission rate %
        </label>
        <DecimalInput
          id="order-commission-rate"
          value={value}
          onChange={setValue}
          decimals={2}
          min={0}
          max={100}
          placeholder="Agent / customer default"
          className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>
    </Modal>
  );
}

// ─── Substitute product picker ────────────────────────────────────────────────

/**
 * A picker row. `unitsPerBox` comes along so the caller can re-denominate the
 * line against the SUBSTITUTE's case size (the server prices the split with it,
 * not the replaced product's), and the tier ladder so it can resolve THIS
 * customer's price for the substitute instead of billing list.
 */
interface SubstituteOption {
  id: string;
  name: string;
  sku?: string;
  pricePerUnit: number;
  unitsPerBox?: number | null;
  priceTier2?: number | string | null;
  priceTier3?: number | string | null;
  priceTier4?: number | string | null;
  priceTier5?: number | string | null;
}

function SubstitutePicker({
  onSelect,
  onClose,
}: {
  onSelect: (product: SubstituteOption) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data } = useProducts({ search: debouncedSearch || undefined, isActive: true });

  return (
    <div className="mt-2 rounded-lg border border-surface-border bg-white shadow-md">
      <div className="flex items-center gap-2 border-b border-surface-border px-3 py-2">
        <Search className="h-4 w-4 shrink-0 text-navy/30" />
        <input
          autoFocus
          className="w-full bg-transparent text-sm text-navy placeholder:text-navy/30 focus:outline-none"
          placeholder="Search products..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="max-h-48 overflow-y-auto">
        {data?.data?.length === 0 && (
          <p className="px-3 py-2 text-sm text-navy/70">No products found.</p>
        )}
        {data?.data?.map((p: SubstituteOption) => (
          <button
            key={p.id}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-surface-raised"
            onClick={() => {
              onSelect(p);
              onClose();
            }}
          >
            <div>
              <span className="font-medium text-navy">{p.name}</span>
              {p.sku && <span className="ml-2 text-xs text-navy/70">{p.sku}</span>}
            </div>
            <span className="text-xs text-navy">{formatMoney(p.pricePerUnit)}</span>
          </button>
        ))}
      </div>
      <div className="border-t border-surface-border px-3 py-2">
        <button className="text-xs text-navy/70 hover:text-navy" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Edit mode line items ──────────────────────────────────────────────────────

// ─── Per-line price / discount editor (DRAFT only) ────────────────────────────
// Single source of truth is the line's `unitPrice`. The "$ off / unit" field is a
// lens over `basePrice - unitPrice`; both inputs resolve to one net unit price,
// which is what the server stores (net unitPrice + originalPrice strikethrough).
function PriceEditRow({
  basePrice,
  unitPrice,
  overrideReason,
  onPriceChange,
  onReasonChange,
  unitCost,
  unitsPerBox,
  floor,
}: {
  basePrice: number;
  unitPrice: number;
  overrideReason?: string;
  onPriceChange: (netPrice: number) => void;
  onReasonChange: (reason: string) => void;
  unitCost?: number | null;
  unitsPerBox?: number | null;
  floor?: number;
}) {
  // "Sell anyway" acknowledges a below-floor price for this session; the override
  // is logged via overrideReason so reports can isolate below-floor sales.
  const [floorAcked, setFloorAcked] = React.useState(false);
  // Cost eye — cost/margin hidden by default; per-row reveal, never persisted.
  const [costRevealed, setCostRevealed] = React.useState(false);

  // Price ↔ $-off lens on MoneyInput: each field keeps its own draft while
  // focused (typing is never reformatted — the old toFixed(2) echo effect here
  // was the "type 2.50, get 2.05" bug); the unfocused sibling re-syncs from
  // the parent's unitPrice.
  const offValue = unitPrice < basePrice ? roundMoney(basePrice - unitPrice) : null;

  const commitPrice = (v: number | null) => {
    if (v == null) {
      onPriceChange(basePrice); // empty → clear override
      return;
    }
    onPriceChange(roundMoney(Math.max(0, v)));
  };

  const commitOff = (v: number | null) => {
    if (v == null || v <= 0) {
      onPriceChange(basePrice); // no discount → back to list price
      return;
    }
    onPriceChange(roundMoney(Math.max(0, basePrice - v)));
  };

  const overridden = Math.abs(unitPrice - basePrice) > 0.0001;
  const isUpsell = unitPrice > basePrice + 0.0001;

  return (
    <div className="ml-11 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
      <label className="flex items-center gap-1.5 text-navy/70">
        <span>Unit price</span>
        <span className="flex items-center rounded border border-surface-border bg-white px-1.5 focus-within:ring-1 focus-within:ring-brand-500">
          <span className="text-navy/40">$</span>
          <MoneyInput
            value={unitPrice}
            onChange={commitPrice}
            className="w-16 rounded-none border-0 bg-transparent px-0 py-1 text-right text-xs focus:ring-0"
          />
        </span>
      </label>
      <label className="flex items-center gap-1.5 text-navy/70">
        <span>$ off / unit</span>
        <span className="flex items-center rounded border border-surface-border bg-white px-1.5 focus-within:ring-1 focus-within:ring-brand-500">
          <span className="text-navy/40">−$</span>
          <MoneyInput
            value={offValue}
            onChange={commitOff}
            placeholder="0.00"
            className="w-14 rounded-none border-0 bg-transparent px-0 py-1 text-right text-xs placeholder:text-navy/40 focus:ring-0"
          />
        </span>
      </label>
      {overridden && (
        <>
          {isUpsell ? (
            // Upsell: green "+$X" instead of a struck-through "was" (which would
            // read as a discount). The base is hidden from the customer server-side.
            <span className="font-medium text-emerald-600">
              Upsell +${(unitPrice - basePrice).toFixed(2)}
            </span>
          ) : (
            <span className="text-navy/50">
              was <span className="line-through">${basePrice.toFixed(2)}</span>
            </span>
          )}
          <input
            type="text"
            value={overrideReason ?? ""}
            onChange={(e) => onReasonChange(e.target.value)}
            placeholder="reason (optional)"
            className="min-w-0 flex-1 rounded border border-surface-border bg-white px-2 py-1 text-navy outline-none placeholder:text-navy/40"
          />
        </>
      )}
      {/* Live cost & margin — the negotiation floor (pos-cost-roles-spec §1) */}
      {floor != null && (
        <div className="basis-full">
          <MarginHint
            unitPrice={unitPrice}
            unitCost={unitCost}
            unitsPerBox={unitsPerBox}
            floor={floor}
            acked={floorAcked}
            onSetToFloor={(floorPrice) => onPriceChange(floorPrice)}
            onSellAnyway={() => {
              setFloorAcked(true);
              if (!overrideReason) onReasonChange("Below margin floor - approved");
            }}
            concealed={!costRevealed}
            onToggleConcealed={() => setCostRevealed((v) => !v)}
          />
        </div>
      )}
    </div>
  );
}

function EditableLineItems({
  items,
  onChange,
  onAdd,
  onDelete,
  canEditPrice,
  priceHistory,
  tierPriceFor,
  isSpecialTierFor,
}: {
  items: EditItemState[];
  onChange: (items: EditItemState[]) => void;
  onAdd: (item: EditItemState) => void;
  /** Remove a line entirely. New (unsaved) items vanish immediately; existing ones
   *  are queued for a DELETE action on save (hard-delete if uninvoiced, else CANCEL). */
  onDelete: (id: string) => void;
  /** Per-line price + discount editing is offered on editable orders (DRAFT/PENDING/CONFIRMED). */
  canEditPrice: boolean;
  /** Remembered per-customer prices — pre-fills a scanned line's price. */
  priceHistory?: CustomerPriceHistory;
  /** This customer's contracted price for a product (per-product tier override,
   *  else the customer's tier). Mirrors mobile's `tierPriceFor`. */
  tierPriceFor: (product: SubstituteOption) => number;
  /** True when this customer's effective tier for the product is not tier 1 — a
   *  contracted price a stale remembered price must never outrank. */
  isSpecialTierFor: (product: SubstituteOption) => boolean;
}) {
  // Scroll the just-scanned/added row into view so rapid scanning stays visible.
  const rowRefs = React.useRef<Map<string, HTMLDivElement>>(new Map());
  const [scrollToId, setScrollToId] = React.useState<string | null>(null);
  // Live cost/margin floor for the edit builder (pos-cost-roles-spec §1).
  const { data: marginConfig } = useMarginConfig();
  React.useEffect(() => {
    if (!scrollToId) return;
    rowRefs.current.get(scrollToId)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setScrollToId(null);
  }, [scrollToId, items]);
  const [substituteOpenId, setSubstituteOpenId] = React.useState<string | null>(null);
  const [addSearch, setAddSearch] = React.useState("");
  const [addOpen, setAddOpen] = React.useState(false);
  const [addLoading, setAddLoading] = React.useState(false);
  const [createProductOpen, setCreateProductOpen] = React.useState(false);
  const [createProductInitialSku, setCreateProductInitialSku] = React.useState("");
  // Custom (unlisted) item inline form
  const [customFormOpen, setCustomFormOpen] = React.useState(false);
  const [customName, setCustomName] = React.useState("");
  const [customPrice, setCustomPrice] = React.useState("");
  const [customQty, setCustomQty] = React.useState("1");
  const [customError, setCustomError] = React.useState("");
  const addRef = React.useRef<HTMLDivElement>(null);
  const addInputRef = React.useRef<HTMLInputElement>(null);
  // Digit runs that look like a scanned code query the candidate-aware
  // `scanCode` search — a suffix-less wedge scan lands here via the dropdown,
  // and the raw decode contains-misses when the camera's digit count differs
  // from the stored shape (iOS 13-digit vs 12-digit codes in numeric names).
  const addTermIsScanCode = /^\d{8,14}$/.test(addSearch.trim());
  const { data: productsData } = useProducts({
    search: addTermIsScanCode ? undefined : addSearch || undefined,
    scanCode: addTermIsScanCode ? addSearch.trim() : undefined,
    limit: 20,
    isActive: true,
  });
  const products: any[] = (productsData as any)?.data ?? [];

  // Auto-focus the scan input when the component mounts (edit mode opened)
  React.useEffect(() => {
    const t = setTimeout(() => addInputRef.current?.focus(), 100);
    return () => clearTimeout(t);
  }, []);

  React.useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (addRef.current && !addRef.current.contains(e.target as Node)) setAddOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function addProduct(p: any) {
    // If this product is already in the list (not cancelled), increment qty instead of adding duplicate
    const existing = items.find((it) => it.productId === p.id && !it.cancelled);
    if (existing) {
      onChange(items.map((it) => (it.id === existing.id ? { ...it, qty: it.qty + 1 } : it)));
      setScrollToId(existing.id);
    } else {
      // This customer's contracted price is the line's BASE — pinning the base
      // to list made every tier add look like an operator override, so the
      // server stored it MANUAL instead of resolving the tier as SPECIAL.
      // Pre-fill the remembered price over it only when it is a genuine
      // discount (below the tier price) or upsell (above list) and no
      // contracted tier applies — a stale memory must never outrank a tier
      // price. Mirrors mobile's `addPickedToDraft`.
      const list = Number(p.pricePerUnit ?? 0);
      const base = tierPriceFor(p);
      const hist = priceHistory?.[p.id];
      const startPrice =
        !isSpecialTierFor(p) && hist != null && (hist.lastPrice < base || hist.lastPrice > list)
          ? hist.lastPrice
          : base;
      const newId = `new-${Date.now()}-${Math.random()}`;
      onAdd({
        id: newId,
        isNew: true,
        originalProductId: p.id,
        originalProductName: p.name,
        originalQty: 1,
        productId: p.id,
        productName: p.name,
        qty: 1,
        unitPrice: startPrice,
        basePrice: base,
        originalUnitPrice: startPrice,
        originalBasePrice: base,
        // Carry the case size so a later substitution re-denominates this
        // line's selling-unit qty correctly (boxSplit stays unset — a plain
        // new line still bills in selling units and sends no split).
        unitsPerBox: p.unitsPerBox == null ? null : Number(p.unitsPerBox),
        originalUnitsPerBox: p.unitsPerBox == null ? null : Number(p.unitsPerBox),
        cancelled: false,
      });
      setScrollToId(newId);
    }
    setAddSearch("");
    setAddOpen(false);
    // Refocus for next scan — use two timeouts: first after state settles, second as fallback
    setTimeout(() => addInputRef.current?.focus(), 80);
    setTimeout(() => addInputRef.current?.focus(), 200);
  }

  async function handleScanEnter() {
    const code = addSearch.trim();
    if (!code) return;
    setAddLoading(true);
    try {
      // Shared lib ladder: barcode endpoint → candidate-aware scanCode search.
      // Replaces the inline copy that swallowed 5xx/network as "not found" and
      // skipped unitSku on the exact-match check.
      const result = await resolveProductByCode(code);
      if (!result.notFound && result.product) {
        if (result.ambiguous) {
          // Several substring hits — this surface has always offered the
          // dropdown as its picker. Keep the code visible but SELECTED, so the
          // next wedge scan (which types) overwrites it instead of appending:
          // the operator can pick a row OR just scan the next label.
          setAddOpen(true);
          setTimeout(() => addInputRef.current?.select(), 50);
          return;
        }
        addProduct(result.product);
        return;
      }
      // Nothing found — open create-product modal with scanned code as SKU
      setCreateProductInitialSku(code);
      setCreateProductOpen(true);
    } catch {
      // Network / 5xx: keep the code selected for an easy rescan; don't treat
      // a transient failure as "product doesn't exist".
      setTimeout(() => addInputRef.current?.select(), 50);
    } finally {
      setAddLoading(false);
    }
  }

  function update(id: string, patch: Partial<EditItemState>) {
    onChange(items.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  function addCustom() {
    const name = customName.trim();
    const price = parseFloat(customPrice);
    const qty = parseInt(customQty, 10);
    if (!name) {
      setCustomError("Enter an item name");
      return;
    }
    if (isNaN(price) || price < 0) {
      setCustomError("Enter a valid unit price");
      return;
    }
    if (isNaN(qty) || qty < 1) {
      setCustomError("Enter a quantity of at least 1");
      return;
    }
    const newId = `new-${Date.now()}-${Math.random()}`;
    onAdd({
      id: newId,
      isNew: true,
      isUnlisted: true,
      originalProductId: "",
      originalProductName: name,
      originalQty: qty,
      productId: "",
      productName: name,
      qty,
      unitPrice: price,
      basePrice: price,
      originalUnitPrice: price,
      originalBasePrice: price,
      cancelled: false,
    });
    setScrollToId(newId);
    setCustomFormOpen(false);
    setCustomName("");
    setCustomPrice("");
    setCustomQty("1");
    setCustomError("");
  }

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div
          key={item.id}
          ref={(el) => {
            if (el) rowRefs.current.set(item.id, el);
            else rowRefs.current.delete(item.id);
          }}
        >
          <div
            className={cn(
              "flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
              item.cancelled
                ? "border-surface-border bg-surface-raised opacity-60"
                : "border-surface-border bg-white",
            )}
          >
            {/* Product icon */}
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-raised">
              <Package className="h-4 w-4 text-navy/30" />
            </div>

            {/* Product name */}
            <div className="flex-1 min-w-0">
              {item.substituteProductId ? (
                <div>
                  <span className="line-through text-xs text-navy/70 mr-1">
                    {item.originalProductName}
                  </span>
                  <span className="text-sm font-medium text-navy">→ {item.productName}</span>
                </div>
              ) : item.isUnlisted && !item.cancelled ? (
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={item.productName}
                    onChange={(e) => update(item.id, { productName: e.target.value })}
                    placeholder="Item name"
                    className="min-w-0 flex-1 rounded border border-surface-border bg-white px-2 py-1 text-sm font-medium text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                  <span className="shrink-0 rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700 ring-1 ring-brand-200">
                    Custom
                  </span>
                </div>
              ) : (
                <span
                  className={cn("text-sm font-medium text-navy", item.cancelled && "line-through")}
                >
                  {item.productName}
                  {item.isUnlisted && (
                    <span className="ml-1.5 rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700 ring-1 ring-brand-200">
                      Custom
                    </span>
                  )}
                </span>
              )}
              {item.cancelled && <span className="text-xs text-danger ml-1.5">Not available</span>}
            </div>

            {/* Qty input */}
            {!item.cancelled && (
              <label className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-navy/40">
                Qty
                <input
                  type="number"
                  min={1}
                  step={1}
                  className="mono w-16 rounded border border-surface-border bg-surface-raised px-2 py-1 text-right text-sm text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                  value={item.qty}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!isNaN(v) && v > 0) update(item.id, { qty: v });
                  }}
                />
              </label>
            )}

            {/* BUY_N_GET_M: name the units the live total below nets off. */}
            {!item.cancelled && editLineFreeUnits(item) > 0 && (
              <span className="shrink-0 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200">
                {editLineFreeUnits(item)} free
              </span>
            )}

            {/* Live line total */}
            {!item.cancelled && (
              <span className="money w-20 shrink-0 text-right text-sm font-semibold text-navy">
                {formatMoney(editLineSubtotal(item))}
              </span>
            )}

            {/* Action buttons */}
            <div className="flex items-center gap-1.5">
              {item.cancelled ? (
                <button
                  className="flex items-center gap-1 rounded px-2 py-1 text-xs text-brand-600 hover:bg-brand-50"
                  onClick={() =>
                    update(item.id, {
                      cancelled: false,
                      // "Not available" only set cancelled:true, so undo just
                      // clears it — restoring product/qty/denomination/price
                      // here would discard edits made before the mis-click.
                      // Only a substituted-then-cancelled line reverts fully.
                      ...(item.substituteProductId
                        ? {
                            productId: item.originalProductId,
                            productName: item.originalProductName,
                            qty: item.originalQty,
                            unitsPerBox: item.originalUnitsPerBox ?? null,
                            boxSplit: item.originalBoxSplit ?? false,
                            ...restoredPrice(item),
                            substituteProductId: undefined,
                          }
                        : {}),
                    })
                  }
                >
                  <RotateCcw className="h-3 w-3" />
                  Undo
                </button>
              ) : (
                <>
                  {!item.substituteProductId && !item.isUnlisted && (
                    <button
                      className="rounded px-2 py-1 text-xs text-navy/70 hover:bg-surface-raised hover:text-navy"
                      onClick={() => setSubstituteOpenId((p) => (p === item.id ? null : item.id))}
                    >
                      Substitute
                    </button>
                  )}
                  {item.substituteProductId && (
                    <button
                      className="flex items-center gap-1 rounded px-2 py-1 text-xs text-brand-600 hover:bg-brand-50"
                      onClick={() =>
                        update(item.id, {
                          productId: item.originalProductId,
                          productName: item.originalProductName,
                          qty: item.originalQty,
                          // Back to the original product's own denomination —
                          // otherwise the line would keep the substitute's case
                          // size and re-price the original against it on save.
                          unitsPerBox: item.originalUnitsPerBox ?? null,
                          boxSplit: item.originalBoxSplit ?? false,
                          ...restoredPrice(item),
                          substituteProductId: undefined,
                        })
                      }
                    >
                      <RotateCcw className="h-3 w-3" />
                      Undo
                    </button>
                  )}
                  <button
                    className="rounded px-2 py-1 text-xs text-danger hover:bg-danger-bg"
                    onClick={() => update(item.id, { cancelled: true })}
                  >
                    Not available
                  </button>
                  <button
                    className="rounded p-1 text-navy/30 hover:text-danger hover:bg-danger-bg transition-colors"
                    title="Delete item"
                    onClick={() => onDelete(item.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Per-line price + discount editor — DRAFT catalog lines, or any unlisted
              line (its price is intrinsic, so always editable in edit mode). */}
          {(canEditPrice || item.isUnlisted) && !item.cancelled && (
            <PriceEditRow
              basePrice={item.basePrice}
              unitPrice={item.unitPrice}
              overrideReason={item.overrideReason}
              onPriceChange={(net) => update(item.id, { unitPrice: net })}
              onReasonChange={(reason) => update(item.id, { overrideReason: reason || undefined })}
              unitCost={item.unitCost}
              unitsPerBox={item.unitsPerBox}
              floor={floorForCategory(marginConfig, item.category)}
            />
          )}

          {/* Per-line note — carried onto the invoice line (buyer-visible). */}
          {!item.cancelled && (
            <div className="ml-11 mt-1">
              <input
                type="text"
                maxLength={500}
                value={item.notes ?? ""}
                onChange={(e) => update(item.id, { notes: e.target.value })}
                placeholder="Note for this line (prints on invoice)"
                className="w-full rounded border border-surface-border bg-white px-2 py-1 text-xs text-navy placeholder:text-navy/40 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
          )}

          {/* Substitute picker */}
          {substituteOpenId === item.id && (
            <SubstitutePicker
              onSelect={(p) => {
                // Re-denominate the line against the SUBSTITUTE's case size, the
                // same way mobile's buildSubstituteLine does: the ordered PIECE
                // count carries across the swap and boxes/pieces are re-derived
                // from the substitute's unitsPerBox. Keeping the replaced
                // product's split would preview one case size while the server
                // (which prices the split with the substitute's) bills another —
                // and on a loose substitute it would send boxes for a product
                // that has none.
                const upb = p.unitsPerBox == null ? null : Number(p.unitsPerBox);
                const lineUpb = Number(item.unitsPerBox ?? 0);
                // A box-split line's qty is already in pieces; a boxed line
                // without a split counts SELLING UNITS (boxes).
                const pieces = item.boxSplit || lineUpb <= 1 ? item.qty : item.qty * lineUpb;
                const split = normalizeBoxesPieces({ qty: pieces, unitsPerBox: upb });
                update(item.id, {
                  substituteProductId: p.id,
                  productId: p.id,
                  productName: p.name,
                  // The customer's contracted price for the SUBSTITUTE, over its
                  // list price as the strikethrough base — same split mobile's
                  // buildSubstituteLine stores. Pinning both to list made every
                  // substitution look un-overridden, so no unitPrice reached the
                  // server and a tier customer silently lost their price.
                  unitPrice: tierPriceFor(p),
                  basePrice: Number(p.pricePerUnit ?? 0),
                  overrideReason: undefined,
                  qty: split.qty,
                  unitsPerBox: upb,
                  boxSplit: split.boxes != null,
                });
                setSubstituteOpenId(null);
              }}
              onClose={() => setSubstituteOpenId(null)}
            />
          )}
        </div>
      ))}

      {/* ── Add Item / Scan row ── */}
      <div ref={addRef} className="relative">
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-brand-300 bg-brand-50 px-3 py-2">
          {addLoading ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-brand-400" />
          ) : (
            <Search className="h-4 w-4 shrink-0 text-brand-400" />
          )}
          <input
            ref={addInputRef}
            type="text"
            placeholder="Scan barcode or type name…"
            value={addSearch}
            onChange={(e) => {
              setAddSearch(e.target.value);
              if (e.target.value) setAddOpen(true);
              else setAddOpen(false);
            }}
            onFocus={() => {
              if (addSearch) setAddOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                handleScanEnter();
              } else if (e.key === "Escape") {
                setAddSearch("");
                setAddOpen(false);
              }
            }}
            className="flex-1 bg-transparent text-sm text-navy placeholder:text-navy/70 outline-none"
          />
        </div>
        {addOpen && products.length > 0 && (
          <div className="absolute left-0 top-full z-50 mt-1 w-full rounded-lg border border-surface-border bg-white shadow-lg">
            <ul className="max-h-52 overflow-y-auto py-1">
              {products.map((p: any) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onMouseDown={() => addProduct(p)}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-brand-50 flex items-center justify-between gap-2"
                  >
                    <span className="font-medium text-navy">{p.name}</span>
                    <span className="text-xs text-navy/70">{p.unit}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* ── Add custom (unlisted) item ── */}
      {customFormOpen ? (
        <div className="space-y-2 rounded-lg border border-dashed border-brand-300 bg-brand-50 px-3 py-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-navy">Custom item</span>
            <button
              type="button"
              onClick={() => {
                setCustomFormOpen(false);
                setCustomError("");
              }}
              className="rounded p-1 text-navy/40 hover:text-danger transition-colors"
              title="Cancel"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[140px] flex-1 space-y-1">
              <label className="block text-[10px] font-medium text-navy/70">Name</label>
              <input
                type="text"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="e.g. Pallet delivery surcharge"
                className="h-9 w-full rounded border border-surface-border bg-white px-2 text-sm text-navy placeholder:text-navy/40 focus:outline-none focus:ring-1 focus:ring-brand-500"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustom();
                  }
                }}
              />
            </div>
            <div className="w-24 space-y-1">
              <label className="block text-[10px] font-medium text-navy/70">Unit price</label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={customPrice}
                onChange={(e) => setCustomPrice(e.target.value)}
                placeholder="0.00"
                className="h-9 w-full rounded border border-surface-border bg-white px-2 text-right text-sm text-navy placeholder:text-navy/40 focus:outline-none focus:ring-1 focus:ring-brand-500"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustom();
                  }
                }}
              />
            </div>
            <div className="w-16 space-y-1">
              <label className="block text-[10px] font-medium text-navy/70">Qty</label>
              <input
                type="number"
                min={1}
                step={1}
                value={customQty}
                onChange={(e) => setCustomQty(e.target.value)}
                className="h-9 w-full rounded border border-surface-border bg-white px-2 text-right text-sm text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustom();
                  }
                }}
              />
            </div>
            <Button type="button" size="sm" onClick={addCustom}>
              Add
            </Button>
          </div>
          {customError && <p className="text-xs text-danger">{customError}</p>}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setCustomFormOpen(true)}
          className="flex items-center gap-1.5 text-sm font-medium text-brand-500 hover:text-brand-600 transition-colors"
        >
          <Pencil className="h-4 w-4" />
          Add custom item
        </button>
      )}

      <InlineCreateProductModal
        isOpen={createProductOpen}
        onClose={() => {
          setCreateProductOpen(false);
          setAddSearch("");
        }}
        onCreated={(product) => {
          addProduct({
            id: product.id,
            name: product.name,
            sku: product.sku,
            unit: product.unit,
            pricePerUnit: product.pricePerUnit,
          });
          setCreateProductOpen(false);
        }}
        initialSku={createProductInitialSku}
      />
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

/**
 * Displayed fulfillment status for an order line. `OrderItem.status` only advances to
 * DELIVERED/PARTIAL via the route delivery flow (completeStop); when an order is marked
 * delivered another way (operator status change, van sale, `/routes` stop-complete) the
 * lines stay at their PENDING default. Derive the shown label from real delivery data
 * (deliveredQty) or the order's terminal state so the page reads consistently — WITHOUT
 * mutating the stored item status (item status stays route-authoritative).
 */
function displayLineStatus(
  li: { status: string; deliveredQty?: number; qty: number },
  orderStatus: string,
): BadgeStatus {
  // A real line-level outcome (route-recorded or explicitly set) always wins.
  if (li.status === "CANCELLED" || li.status === "DELIVERED" || li.status === "PARTIAL")
    return li.status as BadgeStatus;
  // Line still at its PENDING/CONFIRMED default:
  const delivered = Number(li.deliveredQty ?? 0);
  if (delivered > 0) return delivered + 1e-6 >= Number(li.qty) ? "DELIVERED" : "PARTIAL";
  // No per-line delivery recorded, but the whole order is delivered → reflect that.
  if (orderStatus === "DELIVERED") return "DELIVERED";
  return li.status as BadgeStatus;
}

/**
 * Render a date-only field (stored midnight UTC) as its calendar day. Parsing the
 * parts by hand avoids the day-behind shift `new Date(iso)` causes west of UTC.
 */
function formatDateOnly(iso: string): string {
  const [y, m, d] = iso.split("T")[0].split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Map the order's stored credit-note intents into the picker's selection shape. */
function creditSelectionsFromOrder(o: {
  orderCreditNotes?: Array<{ creditNoteId: string; amount?: number | string | null }>;
}): CreditSelection[] {
  return (o.orderCreditNotes ?? []).map((oc) => ({
    creditNoteId: oc.creditNoteId,
    amount: oc.amount != null ? Number(oc.amount) : undefined,
  }));
}

export default function OrderDetailPage({ params }: { params: { id: string } }) {
  const { setTitle } = usePageTitle();
  const { data: order, isLoading, isError } = useOrder(params.id);
  const { data: priceHistory } = useCustomerPriceHistory(order?.customerId);
  // Customer tier pricing (mirrors mobile's edit-items screen): a substituted
  // line prices off the customer's effective tier, not the raw list price.
  const { data: customerDetail } = useCustomer(order?.customerId ?? "");
  const { data: customerPrices } = useCustomerPrices(order?.customerId);
  const cpMap = React.useMemo(() => {
    const m = new Map<string, number | null>();
    for (const cp of (customerPrices ?? []) as Array<{
      productId: string;
      pricingTier: number | null;
    }>) {
      m.set(cp.productId, cp.pricingTier);
    }
    return m;
  }, [customerPrices]);
  const customerTier = (customerDetail as { pricingTier?: number } | undefined)?.pricingTier ?? 1;
  const tierPriceFor = React.useCallback(
    (p: SubstituteOption) => getTierPrice(p, cpMap.get(p.id) ?? customerTier ?? 1),
    [cpMap, customerTier],
  );
  const isSpecialTierFor = React.useCallback(
    (p: SubstituteOption) => (cpMap.get(p.id) ?? customerTier ?? 1) !== 1,
    [cpMap, customerTier],
  );
  const router = useRouter();
  const updateStatus = useUpdateOrderStatus();
  const updateItems = useUpdateOrderItems();
  const reopenOrder = useReopenOrder();
  const deleteOrder = useDeleteOrder();
  const updateShipment = useUpdateOrderShipment();
  const createInvoiceFromOrder = useCreateInvoiceFromOrder();
  const patchFulfillPath = usePatchOrderFulfillPath();
  // Bumped after a SHIP order is marked shipped, to nudge the ShipmentCard's
  // tracking-entry dialog open — see openSignal prop below.
  const [shipmentOpenSignal, setShipmentOpenSignal] = React.useState(0);

  // Order-level commission override (staff + sales_agents addon only — the
  // server independently re-checks both via PlanFlagGuard/parseCommissionRatePct).
  const { user } = useAuth();
  const isStaff = user?.role === "OPERATOR" || user?.role === "TENANT_ADMIN";
  const hasSalesAgents = useHasAddon(SALES_AGENTS_ADDON);
  const [commissionEditOpen, setCommissionEditOpen] = React.useState(false);

  // P5-11: change-request resolution (office side; driver-at-stop is P10 mobile).
  const resolveCr = useResolveChangeRequest();
  const [declineTargetId, setDeclineTargetId] = React.useState<string | null>(null);
  const [declineReason, setDeclineReason] = React.useState("");

  // License guard (W6b): the edit/promote guard can 409 REGULATED_AUTH_REQUIRED.
  const [licenseBlock, setLicenseBlock] = React.useState<BlockedCategory[] | null>(null);
  const licenseRetryRef = React.useRef<(() => void) | null>(null);
  // Opens the guard modal on a REGULATED_AUTH_REQUIRED 409; other errors fall
  // through to the global mutation toast.
  const guardError = (retry: () => void) => (err: unknown) => {
    const blocked = parseRegulatedAuthError(err);
    if (blocked && blocked.length > 0) {
      licenseRetryRef.current = retry;
      setLicenseBlock(blocked);
    }
  };

  // Status tracking — use actual API status directly
  const [localStatus, setLocalStatus] = React.useState<ApiOrderStatus>("PENDING");

  // Item editing
  const [isEditing, setIsEditing] = React.useState(false);
  const [editItems, setEditItems] = React.useState<EditItemState[]>([]);
  const [pendingDeletes, setPendingDeletes] = React.useState<string[]>([]);
  const [draftAutoEntered, setDraftAutoEntered] = React.useState(false);
  // Staff-editable shipping fee (operator/tenant-admin only page). Initialized from
  // the stored order fee whenever edit mode opens; never taxed.
  const [editShippingFee, setEditShippingFee] = React.useState(0);
  // Credit-note selection (edit mode) — initialized from order.orderCreditNotes
  // whenever edit mode opens; `creditsTouched` gates whether it's sent on save
  // (undefined on the wire = leave the server's stored intents untouched).
  const [editCredits, setEditCredits] = React.useState<CreditSelection[]>([]);
  const [creditsTouched, setCreditsTouched] = React.useState(false);

  // Demotion modal
  const [demoteTarget, setDemoteTarget] = React.useState<ApiOrderStatus | null>(null);

  // Cancel confirmation
  const [showCancelConfirm, setShowCancelConfirm] = React.useState(false);
  // Fetched only while the dialog is open, so the page costs nothing extra.
  const cancelImpact = useCancelImpact(order?.id ?? "", showCancelConfirm);
  const cancelCopy = describeCancelImpact(cancelImpact.data);

  // Delete confirmation
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);

  // Invoice send modal (shown after marking delivered)
  const [invoiceModal, setInvoiceModal] = React.useState<InvoiceModalData | null>(null);

  // Split-invoice modal (operator can split an order into multiple invoices)
  const [splitInvoiceOpen, setSplitInvoiceOpen] = React.useState(false);

  // Floating invoice-preview popup (from the Invoices card).
  const [previewInvoiceId, setPreviewInvoiceId] = React.useState<string | null>(null);

  const { toast } = useToast();

  React.useEffect(() => {
    if (order) {
      setTitle(order.orderNumber);
      setLocalStatus(order.status as ApiOrderStatus);
      // Auto-enter edit mode for draft orders so the user can immediately add items
      if (order.status === "DRAFT" && !draftAutoEntered) {
        setDraftAutoEntered(true);
        setEditItems(
          order.lineItems
            .filter((li) => li.status !== "CANCELLED")
            .map((li) => {
              const isUnlisted = !li.productId;
              const label = li.product?.name ?? li.name ?? li.productId ?? "Custom item";
              return {
                id: li.id,
                isUnlisted,
                originalProductId: li.productId ?? "",
                originalProductName: label,
                originalQty: Math.round(Number(li.qty)),
                productId: li.productId ?? "",
                productName: label,
                qty: Math.round(Number(li.qty)),
                unitPrice: Number(li.unitPrice),
                basePrice: Number(li.originalPrice ?? li.unitPrice),
                originalUnitPrice: Number(li.unitPrice),
                originalBasePrice: Number(li.originalPrice ?? li.unitPrice),
                originalOverrideReason: li.overrideReason ?? undefined,
                cancelled: false,
                notes: li.notes,
                overrideReason: li.overrideReason ?? undefined,
                unitCost: li.product?.averageCost != null ? Number(li.product.averageCost) : null,
                // Prefer the line's sale-time box-size snapshot over the live product.
                unitsPerBox: li.unitsPerBox ?? li.product?.unitsPerBox ?? null,
                originalUnitsPerBox: li.unitsPerBox ?? li.product?.unitsPerBox ?? null,
                category: li.product?.category ?? null,
                boxSplit: li.boxes != null || li.pieces != null,
                originalBoxSplit: li.boxes != null || li.pieces != null,
                // BUY_N_GET_M snapshot + the whole-unit count it was earned at.
                promoFreeUnits: li.promoFreeUnits ?? null,
                promoBaseUnits: li.promoFreeUnits
                  ? Math.trunc(Number(li.boxes != null ? li.boxes : li.qty) || 0)
                  : null,
              };
            }),
        );
        setPendingDeletes([]);
        setEditShippingFee(Number(order.shippingFee ?? 0));
        setEditCredits(creditSelectionsFromOrder(order));
        setCreditsTouched(false);
        setIsEditing(true);
      }
    }
  }, [order, setTitle, draftAutoEntered]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-navy/70" />
      </div>
    );
  }

  if (isError || !order) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Order not found.</p>
        <Button variant="secondary" href="/orders">
          Back to Orders
        </Button>
      </div>
    );
  }

  const total = Number(order.total);
  const shippingFee = Number((order as any).shippingFee ?? 0);
  // P5-08 / R1: the server's edit window is authoritative. Items are now editable at
  // every live stage (incl. OUT_FOR_DELIVERY / DELIVERED) — only a CANCELLED order
  // closes it — and post-delivery edits re-sync the linked invoice + ledger server-side.
  // Fall back to the status check when the field isn't present (older API responses).
  const canEdit =
    order?.editWindow?.editable ??
    (localStatus === "DRAFT" || localStatus === "PENDING" || localStatus === "CONFIRMED");

  // Fulfillment path can only change while the order is open — mirrors the
  // server's PATCH /orders/:id/fulfill-path rejection rule exactly.
  const fulfillPathLocked =
    localStatus === "OUT_FOR_DELIVERY" ||
    localStatus === "DELIVERED" ||
    localStatus === "CANCELLED";

  const changeRequests = order.changeRequests ?? [];
  const pendingChangeRequests = changeRequests.filter((cr) => cr.status === "PENDING");

  /**
   * Resolve a change request. G6 race rule: the FIRST resolution wins and
   * locks server-side — a lost race is 409 CHANGE_REQUEST_ALREADY_RESOLVED
   * (typically the driver resolved it at the stop first). We NEVER retry a
   * lost race: toast what happened and let the hook's onSettled invalidation
   * refetch the winning state. REGULATED_AUTH_REQUIRED routes into the
   * existing license-guard modal with a retry, like every other guarded 409
   * on this page. INSUFFICIENT_STOCK / CREDIT_LIMIT_EXCEEDED carry a server
   * message and surface via the global mutation toast — no handling needed.
   */
  function handleResolve(cr: ChangeRequest, action: ChangeRequestResolveAction, reason?: string) {
    const run = () =>
      resolveCr.mutate(
        { orderId: order!.id, crId: cr.id, action, reason },
        {
          onSuccess: () => {
            setDeclineTargetId(null);
            setDeclineReason("");
            toast({
              title:
                action === "DECLINE"
                  ? "Change request declined"
                  : action === "APPROVE_NEXT_DELIVERY"
                    ? "Approved — drafted onto the next delivery"
                    : "Approved — merged into this order",
              variant: "success",
            });
          },
          onError: (err: any) => {
            const code = err?.response?.data?.code;
            if (code === "CHANGE_REQUEST_ALREADY_RESOLVED") {
              toast({
                title: "Already resolved",
                description:
                  "This request was just resolved elsewhere (likely by the driver) — showing the latest state.",
                variant: "error",
              });
              setDeclineTargetId(null);
            } else if (code === "STOP_ALREADY_COMPLETED") {
              toast({
                title: "Stop already completed",
                description:
                  "Too late to change today's delivery — approve as next delivery instead.",
                variant: "error",
              });
            } else if (code === "LINE_ALREADY_DELIVERED") {
              toast({
                title: "Line already delivered",
                description: "The driver has delivered this line — it can no longer be changed.",
                variant: "error",
              });
            } else if (code === "CHANGE_WINDOW_CLOSED") {
              toast({
                title: "Delivery run no longer active",
                description: "The run has ended — this request can only be declined.",
                variant: "error",
              });
            } else {
              guardError(run)(err);
            }
          },
        },
      );
    run();
  }

  // ── Edit mode ──────────────────────────────────────────────────────────────

  function enterEditMode() {
    setEditItems(
      order!.lineItems
        .filter((li) => li.status !== "CANCELLED")
        .map((li) => {
          const isUnlisted = !li.productId;
          const label = li.product?.name ?? li.name ?? li.productId ?? "Custom item";
          return {
            id: li.id,
            isUnlisted,
            originalProductId: li.productId ?? "",
            originalProductName: label,
            originalQty: Math.round(Number(li.qty)),
            productId: li.productId ?? "",
            productName: label,
            qty: Math.round(Number(li.qty)),
            unitPrice: Number(li.unitPrice),
            basePrice: Number(li.originalPrice ?? li.unitPrice),
            originalUnitPrice: Number(li.unitPrice),
            originalBasePrice: Number(li.originalPrice ?? li.unitPrice),
            originalOverrideReason: li.overrideReason ?? undefined,
            cancelled: false,
            notes: li.notes,
            overrideReason: li.overrideReason ?? undefined,
            // unitsPerBox + boxSplit drive boxed proration on save (money fix).
            // Prefer the line's sale-time snapshot over the live product so a later
            // packaging change can't re-price an existing line.
            unitsPerBox: li.unitsPerBox ?? li.product?.unitsPerBox ?? null,
            originalUnitsPerBox: li.unitsPerBox ?? li.product?.unitsPerBox ?? null,
            boxSplit: li.boxes != null || li.pieces != null,
            originalBoxSplit: li.boxes != null || li.pieces != null,
            // BUY_N_GET_M snapshot + the whole-unit count it was earned at.
            promoFreeUnits: li.promoFreeUnits ?? null,
            promoBaseUnits: li.promoFreeUnits
              ? Math.trunc(Number(li.boxes != null ? li.boxes : li.qty) || 0)
              : null,
          };
        }),
    );
    setPendingDeletes([]);
    setEditShippingFee(Number(order!.shippingFee ?? 0));
    setEditCredits(creditSelectionsFromOrder(order!));
    setCreditsTouched(false);
    setIsEditing(true);
  }

  function cancelEditMode() {
    setIsEditing(false);
    setEditItems([]);
    setPendingDeletes([]);
    setEditShippingFee(0);
    setEditCredits([]);
    setCreditsTouched(false);
  }

  function handleDeleteItem(id: string) {
    const item = editItems.find((it) => it.id === id);
    if (!item) return;
    setEditItems((prev) => prev.filter((it) => it.id !== id));
    if (!item.isNew) {
      // Existing saved line — queue a DELETE action on save (falls back to CANCEL if invoiced).
      setPendingDeletes((prev) => [...prev, id]);
    }
  }

  /**
   * The line-item diff for the edit builder — the ONE payload builder both save
   * paths use ("Save Draft"/"Save Changes" and "Save & Publish"), so publishing
   * can never bill differently from saving. Deletes are added by the caller.
   */
  function buildItemUpdates(): ItemUpdate[] {
    const original = order!.lineItems;
    const updates: ItemUpdate[] = [];

    for (const edited of editItems) {
      // A line is overridden when its net unit price diverges from the list/base
      // price in EITHER direction (discount or upsell) — see isPriceOverridden.
      const overridden = isPriceOverridden(edited);
      const newNote = edited.notes?.trim() ? { notes: edited.notes.trim() } : {};
      if (edited.isNew) {
        if (edited.isUnlisted) {
          // New unlisted (ad-hoc) line: no id, no productId — { name, qty, unitPrice }.
          updates.push({
            name: edited.productName.trim(),
            qty: edited.qty,
            unitPrice: edited.unitPrice,
            ...newNote,
          });
        } else {
          // New catalog item: no id — API will create it. Carry the override when present.
          updates.push({
            productId: edited.productId,
            qty: edited.qty,
            ...boxedDtoFields(edited),
            ...(overridden
              ? { unitPrice: edited.unitPrice, overrideReason: edited.overrideReason }
              : {}),
            ...newNote,
          });
        }
        continue;
      }
      const orig = original.find((li) => li.id === edited.id);
      if (!orig) continue;

      const qtyChanged = Math.abs(edited.qty - Number(orig.qty)) > 0.0001;
      const priceChanged = Math.abs(edited.unitPrice - Number(orig.unitPrice)) > 0.0001;
      const nameChanged =
        edited.isUnlisted && edited.productName.trim() !== (orig.name ?? "").trim();
      // "" clears an existing note (the API only applies notes when defined).
      const noteChanged = (edited.notes ?? "").trim() !== ((orig.notes as string) ?? "").trim();
      const notePatch = noteChanged ? { notes: (edited.notes ?? "").trim() } : {};

      if (edited.cancelled) {
        updates.push({ id: edited.id, action: "CANCEL" });
      } else if (edited.substituteProductId) {
        updates.push(substituteDtoUpdate(edited));
      } else if (edited.isUnlisted && (qtyChanged || priceChanged || nameChanged || noteChanged)) {
        // Rename / reprice an existing unlisted line: { id, name?, qty, unitPrice? }.
        updates.push({
          id: edited.id,
          qty: edited.qty,
          ...(nameChanged ? { name: edited.productName.trim() } : {}),
          ...(priceChanged ? { unitPrice: edited.unitPrice } : {}),
          ...notePatch,
        });
      } else if (qtyChanged || priceChanged || noteChanged) {
        updates.push({
          id: edited.id,
          action: "UPDATE",
          qty: edited.qty,
          ...boxedDtoFields(edited),
          ...(priceChanged
            ? { unitPrice: edited.unitPrice, overrideReason: edited.overrideReason }
            : {}),
          ...notePatch,
        });
      }
    }
    return updates;
  }

  function handleSaveItems() {
    // Hard-delete (or CANCEL fallback) for lines the user removed with the trash button.
    const updates: ItemUpdate[] = [
      ...pendingDeletes.map((id): ItemUpdate => ({ id, action: "DELETE" })),
      ...buildItemUpdates(),
    ];

    // Only send shippingFee when it actually changed — avoids no-op churn (and
    // matches the API's "no dto.shippingFee ⇒ keep the stored fee" rule).
    const feeChanged = Math.abs(editShippingFee - Number(order!.shippingFee ?? 0)) > 0.0001;

    if (updates.length === 0 && !feeChanged && !creditsTouched) {
      setIsEditing(false);
      return;
    }

    // replaceAll:false — this screen sends an incremental diff (new items have no
    // id). Without it the API's legacy heuristic would treat an add-only payload
    // as a full replace and delete the untouched lines.
    updateItems.mutate(
      {
        id: order!.id,
        items: updates,
        replaceAll: false,
        ...(feeChanged ? { shippingFee: editShippingFee } : {}),
        // Credit-note selection: only sent when the operator actually touched
        // the picker — undefined on the wire leaves the server's stored
        // intents untouched (see CreditNotePicker / syncOrderCreditSelections).
        ...(creditsTouched ? { appliedCreditNotes: editCredits } : {}),
      },
      {
        onSuccess: () => {
          setIsEditing(false);
          setEditItems([]);
          setEditCredits([]);
          setCreditsTouched(false);
        },
        onError: guardError(() => handleSaveItems()),
      },
    );
  }

  // ── Status handlers ────────────────────────────────────────────────────────

  const handleConfirm = () => {
    updateStatus.mutate(
      { id: order.id, status: "CONFIRMED" },
      { onSuccess: () => setLocalStatus("CONFIRMED"), onError: guardError(() => handleConfirm()) },
    );
  };

  const handleLock = () => {
    updateStatus.mutate(
      { id: order.id, status: "OUT_FOR_DELIVERY" },
      {
        onSuccess: () => {
          setLocalStatus("OUT_FOR_DELIVERY");
          // Nudge the operator straight into tracking entry for a SHIP order —
          // there's nowhere else on this screen prompting for it.
          if (order.fulfillPath === "SHIP") setShipmentOpenSignal((n) => n + 1);
        },
        onError: guardError(() => handleLock()),
      },
    );
  };

  const handleCancel = () => setShowCancelConfirm(true);

  const confirmCancel = () => {
    // Refused cancels (cash already taken) have no confirm action — the dialog
    // just explains and closes.
    if (!cancelCopy.confirmLabel) {
      setShowCancelConfirm(false);
      return;
    }
    updateStatus.mutate(
      { id: order.id, status: "CANCELLED" },
      {
        onSuccess: () => {
          setLocalStatus("CANCELLED");
          setShowCancelConfirm(false);
        },
        onError: (err: any) => {
          // Previously silent: a server refusal produced no toast at all.
          toast({
            title: "Couldn't cancel this order",
            description:
              err?.response?.data?.message ??
              "Please try again, or refresh and check its invoices.",
            variant: "error",
          });
        },
      },
    );
  };

  const handleDeliver = () => {
    updateStatus.mutate(
      { id: order.id, status: "DELIVERED" },
      {
        onSuccess: () => {
          setLocalStatus("DELIVERED");
          // Create the invoice (idempotent — returns existing if already there)
          // then show the send-invoice prompt.
          const invoiceNow = () =>
            createInvoiceFromOrder.mutate(order.id, {
              onSuccess: (invoices: any) => {
                // W4: a mixed regulated order returns sibling invoices; prompt to send
                // the primary (standard/first) one — the rest show on the order detail.
                const invoice = Array.isArray(invoices) ? invoices[0] : invoices;
                if (!invoice) return;
                setInvoiceModal({
                  invoiceId: invoice.id,
                  invoiceNumber: invoice.invoiceNumber,
                  total: Number(invoice.total),
                  customerName: order.customer?.businessName ?? "Customer",
                  customerPhone: order.customer?.phone,
                  customerMobile: order.customer?.mobile,
                  // Import sentinels aren't real inboxes — hide the Email option
                  // rather than offer a send that can only fail.
                  customerEmail: isInternalEmail(order.customer?.email)
                    ? undefined
                    : order.customer?.email,
                });
              },
              onError: (err: unknown) => {
                // The invoice-time backstop can block on an expired/newly-added
                // regulated line — open the license guard (capture/override) and
                // retry invoicing on resolve rather than dead-ending.
                const blocked = parseRegulatedAuthError(err);
                if (blocked && blocked.length > 0) {
                  licenseRetryRef.current = invoiceNow;
                  setLicenseBlock(blocked);
                  return;
                }
                // Non-critical — invoice can be created manually.
                toast({
                  title: "Order delivered. Create the invoice manually from the Invoices page.",
                  variant: "warning",
                });
              },
            });
          invoiceNow();
        },
      },
    );
  };

  const handleDemote = (reason: string) => {
    if (!demoteTarget) return;
    updateStatus.mutate(
      { id: order.id, status: demoteTarget, reason },
      {
        onSuccess: () => {
          setLocalStatus(demoteTarget);
          setDemoteTarget(null);
        },
      },
    );
  };

  /**
   * Shared "Delete order" trigger + inline two-tap confirm, reused across every
   * status block below (delete-any: staff may delete an order in any status —
   * the server 409s only when a linked invoice has recorded payments). No local
   * onError toast here: an error just collapses the confirm back to the trigger
   * and the global mutation-error toast (app/providers.tsx) already surfaces the
   * server's message (e.g. "void the invoice first"), which a hand-written
   * `error.message` here would only shadow with a generic HTTP status string.
   */
  const renderDeleteOrderAction = (confirmMessage: string, successTitle = "Order deleted") =>
    showDeleteConfirm ? (
      <div className="flex items-center gap-2">
        <span className="text-sm text-danger font-medium">{confirmMessage}</span>
        <Button
          size="sm"
          variant="danger"
          loading={deleteOrder.isPending}
          onClick={() => {
            deleteOrder.mutate(order.id, {
              onSuccess: () => {
                toast({ title: successTitle, variant: "success" });
                router.push("/orders");
              },
              onError: () => setShowDeleteConfirm(false),
            });
          }}
        >
          Confirm Delete
        </Button>
        <button
          onClick={() => setShowDeleteConfirm(false)}
          className="text-sm text-navy/70 hover:text-navy transition-colors"
        >
          No
        </button>
      </div>
    ) : (
      <Button
        size="sm"
        variant="ghost"
        leftIcon={<Trash2 className="h-4 w-4" />}
        onClick={() => setShowDeleteConfirm(true)}
      >
        Delete order
      </Button>
    );

  // ── Estimated totals in edit mode ──────────────────────────────────────────

  const editSubtotal = isEditing
    ? roundMoney(
        editItems.filter((it) => !it.cancelled).reduce((s, it) => s + editLineSubtotal(it), 0),
      )
    : Number(order.subtotal);

  const taxRate = order.subtotal > 0 ? Number(order.tax) / Number(order.subtotal) : 0;
  const editTax = isEditing ? editSubtotal * taxRate : Number(order.tax);
  // RF-4: regulated (category) tax the server folded into order.total — the Σ of the
  // non-cancelled lines' snapshotted per-line amounts. Surface it so the displayed
  // Subtotal + Tax + Regulated tax reconciles to the server total. In edit mode this
  // is a best-effort estimate (stored snapshots; the server re-derives it on save).
  const orderCategoryTax = roundMoney(
    order.lineItems
      .filter((li) => li.status !== "CANCELLED")
      .reduce((s, li) => s + Number(li.categoryTaxAmount ?? 0), 0),
  );
  const editTotal = editSubtotal + editTax + orderCategoryTax + editShippingFee;

  return (
    <div className="space-y-5 p-6">
      {/* Back */}
      <Link
        href="/orders"
        className="flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Orders
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="mono text-2xl font-bold tracking-[-0.01em] text-navy">
              {order.orderNumber}
            </h2>
            {order.urgent && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-danger-bg px-2.5 py-1 text-xs font-semibold text-danger">
                <AlertTriangle className="h-3.5 w-3.5" />
                Urgent
              </span>
            )}
            <Badge status={localStatus as BadgeStatus} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2.5 text-sm text-navy/70">
            <span>
              Created{" "}
              {new Date(order.createdAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
            {order.orderDate && (
              <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-surface-border bg-white px-2.5 text-xs font-medium text-navy">
                <Calendar className="h-3.5 w-3.5 text-navy/40" />
                Order date: {formatDateOnly(order.orderDate)}
              </span>
            )}
            {order.requestedDeliveryDate && (
              <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-surface-border bg-white px-2.5 text-xs font-medium text-navy">
                <Calendar className="h-3.5 w-3.5 text-navy/40" />
                Delivery: {formatDateOnly(order.requestedDeliveryDate)}
              </span>
            )}
          </div>
        </div>

        {/* Action bar */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Edit Items button */}
          {canEdit && !isEditing && (
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<Pencil className="h-4 w-4" />}
              onClick={enterEditMode}
            >
              Edit Items
            </Button>
          )}

          {/* P5-08: editing closed once the order is out for delivery (dispatched). */}
          {!canEdit && order?.editWindow?.closedReason === "DISPATCHED" && !isEditing && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
              Out for delivery — editing closed
            </span>
          )}

          {/* P5-08: revision count (append-only edit history). */}
          {!isEditing && (order?.revisions?.length ?? 0) > 0 && (
            <span
              className="inline-flex items-center rounded-full bg-navy/5 px-2 py-1 text-xs font-medium text-navy/70"
              title={order!
                .revisions!.map(
                  (r) =>
                    `v${r.revisionNumber} · ${r.editedByName ?? r.editedByRole ?? "system"} · ${new Date(r.createdAt).toLocaleString()} · ${formatMoney(r.snapshot.total)}`,
                )
                .join("\n")}
            >
              Edited {order!.revisions!.length}×
            </span>
          )}

          {/* P5-11: pending post-dispatch change requests awaiting resolution. */}
          {!isEditing && pendingChangeRequests.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
              {pendingChangeRequests.length} change request
              {pendingChangeRequests.length > 1 ? "s" : ""} pending
            </span>
          )}

          {/* DRAFT actions */}
          {localStatus === "DRAFT" && !isEditing && (
            <>
              <Button
                size="sm"
                leftIcon={<CheckCircle2 className="h-4 w-4" />}
                onClick={() => {
                  const publish = () =>
                    updateStatus.mutate(
                      { id: order.id, status: "PENDING" as any },
                      {
                        onSuccess: () => setLocalStatus("PENDING"),
                        onError: guardError(() => publish()),
                      },
                    );
                  publish();
                }}
                loading={updateStatus.isPending}
              >
                Publish Order
              </Button>
              {showDeleteConfirm ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-danger font-medium">Delete order?</span>
                  <Button
                    size="sm"
                    variant="danger"
                    loading={deleteOrder.isPending}
                    onClick={() => {
                      deleteOrder.mutate(order.id, {
                        onSuccess: () => {
                          toast({ title: "Draft deleted", variant: "success" });
                          router.push("/orders");
                        },
                        onError: (e) => {
                          toast({ title: e.message, variant: "error" });
                          setShowDeleteConfirm(false);
                        },
                      });
                    }}
                  >
                    Confirm Delete
                  </Button>
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    className="text-sm text-navy/70 hover:text-navy transition-colors"
                  >
                    No
                  </button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  leftIcon={<Trash2 className="h-4 w-4" />}
                  onClick={() => setShowDeleteConfirm(true)}
                >
                  Delete Draft
                </Button>
              )}
            </>
          )}

          {/* PENDING actions */}
          {localStatus === "PENDING" && !isEditing && (
            <>
              <Button
                size="sm"
                leftIcon={<CheckCircle2 className="h-4 w-4" />}
                onClick={handleConfirm}
                loading={updateStatus.isPending}
              >
                Confirm Order
              </Button>
              <Button
                size="sm"
                variant="danger"
                leftIcon={<XCircle className="h-4 w-4" />}
                onClick={handleCancel}
              >
                Cancel Order
              </Button>
              {showDeleteConfirm ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-danger font-medium">Delete order?</span>
                  <Button
                    size="sm"
                    variant="danger"
                    loading={deleteOrder.isPending}
                    onClick={() => {
                      deleteOrder.mutate(order.id, {
                        onSuccess: () => {
                          toast({ title: "Order deleted", variant: "success" });
                          router.push("/orders");
                        },
                        onError: (e) => {
                          toast({ title: e.message, variant: "error" });
                          setShowDeleteConfirm(false);
                        },
                      });
                    }}
                  >
                    Confirm Delete
                  </Button>
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    className="text-sm text-navy/70 hover:text-navy transition-colors"
                  >
                    No
                  </button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  leftIcon={<Trash2 className="h-4 w-4" />}
                  onClick={() => setShowDeleteConfirm(true)}
                >
                  Delete
                </Button>
              )}
            </>
          )}

          {/* CONFIRMED actions */}
          {localStatus === "CONFIRMED" && !isEditing && (
            <>
              <div className="flex flex-col items-start gap-1">
                <Button
                  size="sm"
                  variant="secondary"
                  leftIcon={<Truck className="h-4 w-4" />}
                  onClick={handleLock}
                  loading={updateStatus.isPending}
                >
                  {order.fulfillPath === "SHIP" ? "Mark shipped" : "Out for Delivery"}
                </Button>
                {order.fulfillPath === "SHIP" && (
                  <p className="text-[11px] text-navy/50">
                    Sets the order to Out for Delivery — the customer is notified it&apos;s on the
                    way.
                  </p>
                )}
              </div>
              {/* CONFIRMED→PENDING is a demotion — the server rejects it without a
                  reason, so the ONLY path is the DemoteReasonModal. A second
                  "Unconfirm" button used to submit directly (predating the
                  reason rule) and guaranteed a 400 with nowhere to type one. */}
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<RotateCcw className="h-4 w-4" />}
                onClick={() => setDemoteTarget("PENDING")}
                loading={updateStatus.isPending}
              >
                Unconfirm
              </Button>
              <Button
                size="sm"
                variant="danger"
                leftIcon={<XCircle className="h-4 w-4" />}
                onClick={handleCancel}
              >
                Cancel Order
              </Button>
              {renderDeleteOrderAction("Delete this order? This can't be undone.")}
            </>
          )}

          {/* OUT_FOR_DELIVERY actions */}
          {localStatus === "OUT_FOR_DELIVERY" && (
            <>
              <Button
                size="sm"
                leftIcon={<CheckCircle2 className="h-4 w-4" />}
                onClick={handleDeliver}
                loading={updateStatus.isPending}
              >
                {order.fulfillPath === "SHIP" ? "Mark delivered" : "Mark as Delivered"}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<RefreshCcw className="h-4 w-4" />}
                onClick={() => setDemoteTarget("CONFIRMED")}
              >
                {order.fulfillPath === "SHIP" ? "Unmark shipped" : "Return to Confirmed"}
              </Button>
              <Button
                size="sm"
                variant="danger"
                leftIcon={<XCircle className="h-4 w-4" />}
                onClick={handleCancel}
              >
                Cancel Order
              </Button>
              {renderDeleteOrderAction(
                "Delete this order? It's out for delivery — this can't be undone.",
              )}
            </>
          )}

          {/* DELIVERED actions — owner reversed policy 2026-08-25: reopening a
              delivered order is now a legal staff-only reasoned demotion
              (DELIVERED → CONFIRMED), wired through the same DemoteReasonModal
              as every other one-step-back transition. A route-delivered order
              (routeRunStopId on a COMPLETED stop) 409s server-side — that
              surfaces via the standard error toast (app/providers.tsx), no
              special-cased UI needed here. */}
          {localStatus === "DELIVERED" && (
            <>
              <div className="flex flex-col items-start gap-1">
                <Button
                  size="sm"
                  variant="secondary"
                  leftIcon={<RotateCcw className="h-4 w-4" />}
                  onClick={() => setDemoteTarget("CONFIRMED")}
                >
                  Reopen Order
                </Button>
                <p className="text-[11px] text-navy/50">
                  Reopening keeps the invoice — Edit Items re-syncs it. Route-delivered orders
                  reopen from their run stop.
                </p>
              </div>
              {renderDeleteOrderAction(
                "Delete this DELIVERED order? Its delivery record is removed permanently.",
              )}
            </>
          )}

          {/* CANCELLED */}
          {localStatus === "CANCELLED" && (
            <>
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<RotateCcw className="h-4 w-4" />}
                onClick={() => {
                  if (confirm("Reopen this order? It will return to Pending status.")) {
                    reopenOrder.mutate(order.id, {
                      onSuccess: () => setLocalStatus("PENDING"),
                    });
                  }
                }}
                loading={reopenOrder.isPending}
              >
                Reopen Order
              </Button>
              {showDeleteConfirm ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-danger font-medium">Delete order?</span>
                  <Button
                    size="sm"
                    variant="danger"
                    loading={deleteOrder.isPending}
                    onClick={() => {
                      deleteOrder.mutate(order.id, {
                        onSuccess: () => {
                          toast({ title: "Order deleted", variant: "success" });
                          router.push("/orders");
                        },
                        onError: (e) => {
                          toast({ title: e.message, variant: "error" });
                          setShowDeleteConfirm(false);
                        },
                      });
                    }}
                  >
                    Confirm Delete
                  </Button>
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    className="text-sm text-navy/70 hover:text-navy transition-colors"
                  >
                    No
                  </button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  leftIcon={<Trash2 className="h-4 w-4" />}
                  onClick={() => setShowDeleteConfirm(true)}
                >
                  Delete
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* ── Main content ── */}
        <div className="space-y-5 lg:col-span-2">
          {/* Line items */}
          <div className="rounded-lg bg-white p-6 shadow-card">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2.5 text-base font-semibold text-navy">
                Line Items
                {isEditing && (
                  <Badge variant="info" label="Editing" className="normal-case tracking-normal" />
                )}
              </h3>
              {isEditing && (
                <span className="text-xs text-navy/70">
                  Prices &amp; quantities save on{" "}
                  <b className="font-semibold text-navy">
                    {localStatus === "DRAFT" ? "Save Draft" : "Save Changes"}
                  </b>
                </span>
              )}
            </div>
            {isEditing ? (
              <div className="space-y-4">
                <p className="text-sm text-navy/70">
                  Add new items, adjust quantities, substitute or mark as unavailable.
                  {canEdit && " Change a line's price or apply a per-item discount."} Changes are
                  applied when you save.
                </p>
                <EditableLineItems
                  items={editItems}
                  onChange={setEditItems}
                  onAdd={(item) => setEditItems((prev) => [...prev, item])}
                  onDelete={handleDeleteItem}
                  canEditPrice={canEdit}
                  priceHistory={priceHistory}
                  tierPriceFor={tierPriceFor}
                  isSpecialTierFor={isSpecialTierFor}
                />

                {/* Live total preview */}
                <div className="ml-auto w-full max-w-xs rounded-lg border border-surface-border bg-surface-raised px-4 py-3">
                  <div className="flex justify-between text-sm text-navy/70">
                    <span>Subtotal</span>
                    <span className="money text-navy/70">{formatMoney(editSubtotal)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-navy/70 mt-1">
                    <span>Tax ({(taxRate * 100).toFixed(0)}%)</span>
                    <span className="money text-navy/70">{formatMoney(editTax)}</span>
                  </div>
                  {orderCategoryTax > 0 && (
                    <div className="flex justify-between text-sm text-navy/70 mt-1">
                      <span>Regulated tax</span>
                      <span className="money text-navy/70">{formatMoney(orderCategoryTax)}</span>
                    </div>
                  )}
                  {/* Staff-editable shipping fee — never taxed, added after tax. */}
                  <div className="flex items-center justify-between text-sm text-navy/70 mt-1">
                    <label className="flex items-center gap-2">
                      Shipping fee
                      <MoneyInput
                        min={0}
                        placeholder="0.00"
                        value={editShippingFee}
                        onChange={(v) => setEditShippingFee(Math.max(0, v ?? 0))}
                        className="w-20 rounded border border-surface-border bg-white px-2 py-0.5 text-xs text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                      />
                    </label>
                  </div>
                  <div className="flex justify-between text-base font-semibold text-navy border-t border-surface-border mt-2 pt-2">
                    <span>New total</span>
                    <span className="money text-[15px] text-navy">{formatMoney(editTotal)}</span>
                  </div>
                </div>

                {/* Credit notes — same picker as create; initialized from the order's
                    stored intents. Sent on save ONLY when touched (undefined on the
                    wire leaves the server's stored intents untouched). */}
                <CreditNotePicker
                  customerId={order.customerId}
                  value={editCredits}
                  onChange={(next) => {
                    setEditCredits(next);
                    setCreditsTouched(true);
                  }}
                  estimatedOrderTotal={editTotal}
                />

                <div className="flex gap-2 flex-wrap">
                  {localStatus === "DRAFT" ? (
                    <>
                      <Button
                        size="sm"
                        className="bg-amber-500 text-white hover:bg-amber-600"
                        onClick={handleSaveItems}
                        loading={updateItems.isPending}
                      >
                        Save Draft
                      </Button>
                      <Button
                        size="sm"
                        leftIcon={<CheckCircle2 className="h-4 w-4" />}
                        onClick={() => {
                          // Save items first, then publish. Exactly the payload
                          // "Save Draft" sends — deletes and prices included — so
                          // publishing straight from edit mode can't bill differently.
                          const updates: ItemUpdate[] = [
                            ...pendingDeletes.map((id): ItemUpdate => ({ id, action: "DELETE" })),
                            ...buildItemUpdates(),
                          ];
                          const doPublish = () =>
                            updateStatus.mutate(
                              { id: order!.id, status: "PENDING" as any },
                              {
                                onSuccess: () => {
                                  setLocalStatus("PENDING");
                                  setIsEditing(false);
                                  setEditItems([]);
                                  setEditCredits([]);
                                  setCreditsTouched(false);
                                },
                                onError: guardError(() => doPublish()),
                              },
                            );
                          // Carry a shipping-fee edit into the publish save the same
                          // way handleSaveItems does — otherwise publishing straight
                          // from edit mode silently drops the fee the operator typed.
                          const feeChanged =
                            Math.abs(editShippingFee - Number(order!.shippingFee ?? 0)) > 0.0001;
                          const saveThenPublish = () => {
                            if (updates.length > 0 || feeChanged || creditsTouched) {
                              updateItems.mutate(
                                {
                                  id: order!.id,
                                  items: updates,
                                  // replaceAll:false — this is an incremental diff (new
                                  // items have no id, and a fee-only save sends []).
                                  // Without it the API's add-only/empty heuristic treats
                                  // the payload as a full replace and deletes untouched
                                  // lines. Mirrors handleSaveItems.
                                  replaceAll: false,
                                  ...(feeChanged ? { shippingFee: editShippingFee } : {}),
                                  // Same dual-path threading as handleSaveItems — the
                                  // line payload is shared (buildItemUpdates) but this
                                  // flow still assembles its own mutation, so credits
                                  // need the explicit carry-through (shippingFee had
                                  // this exact miss last PR — do not repeat it).
                                  ...(creditsTouched ? { appliedCreditNotes: editCredits } : {}),
                                },
                                {
                                  onSuccess: doPublish,
                                  onError: guardError(() => saveThenPublish()),
                                },
                              );
                            } else {
                              doPublish();
                            }
                          };
                          saveThenPublish();
                        }}
                        loading={updateItems.isPending || updateStatus.isPending}
                      >
                        Publish Order
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={cancelEditMode}
                        disabled={updateItems.isPending || updateStatus.isPending}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" onClick={handleSaveItems} loading={updateItems.isPending}>
                        Save Changes
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={cancelEditMode}
                        disabled={updateItems.isPending}
                      >
                        Cancel
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className="-mx-6 -mb-6 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-surface-border bg-surface-raised">
                    <tr>
                      <th className="overline px-6 py-2.5 text-left">Product</th>
                      <th className="overline px-4 py-2.5 text-right">Qty</th>
                      <th className="overline px-4 py-2.5 text-right">Unit Price</th>
                      <th className="overline px-4 py-2.5 text-right">Line Total</th>
                      <th className="overline px-6 py-2.5 text-left">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-border">
                    {order.lineItems.map((li) => (
                      <tr
                        key={li.id}
                        className={cn(
                          "hover:bg-surface-raised",
                          li.status === "CANCELLED" && "opacity-50",
                        )}
                      >
                        <td className="px-6 py-3">
                          <div className="flex items-center gap-3">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-raised">
                              <Package className="h-4 w-4 text-navy/30" />
                            </div>
                            <div className="min-w-0">
                              <span
                                className={cn(
                                  "font-medium text-navy",
                                  li.status === "CANCELLED" && "line-through",
                                )}
                              >
                                {li.product?.name ?? li.name ?? "Custom item"}
                              </span>
                              {li.notes && (
                                <p className="mt-0.5 text-xs italic text-navy/60">{li.notes}</p>
                              )}
                            </div>
                            {!li.productId && (
                              <span className="rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700 ring-1 ring-brand-200">
                                Custom
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right text-navy/70">
                          {li.boxes != null || li.pieces != null ? (
                            <span title={`${Number(li.qty)} pcs total`}>
                              {formatQtySplit({
                                qty: li.qty,
                                boxes: li.boxes,
                                pieces: li.pieces,
                              })}
                            </span>
                          ) : (
                            <span className="mono">{formatQtySplit({ qty: li.qty })}</span>
                          )}
                          {/* BUY_N_GET_M: name the free units, or the reduced line
                              total reads as a pricing error. */}
                          {Number(li.promoFreeUnits ?? 0) > 0 && (
                            <p className="mt-0.5 text-[10px] font-medium text-amber-700">
                              {Number(li.promoFreeUnits)} free
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex flex-col items-end gap-0.5">
                            {li.priceType === "SPECIAL" ? (
                              <>
                                <span className="strike text-xs">
                                  {formatMoney(li.originalPrice)}
                                </span>
                                <span className="money text-emerald-600">
                                  {formatMoney(li.unitPrice)}
                                </span>
                                <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-200">
                                  Special
                                </span>
                              </>
                            ) : li.priceType === "MANUAL" &&
                              li.originalPrice != null &&
                              Number(li.unitPrice) > Number(li.originalPrice) ? (
                              <>
                                {/* Upsell: sold above list. Operator-only green badge;
                                    no strikethrough — the base is redacted before the
                                    customer ever sees this line. */}
                                <span className="money text-emerald-600">
                                  {formatMoney(li.unitPrice)}
                                </span>
                                <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-200">
                                  Upsell
                                </span>
                              </>
                            ) : (li.priceType === "DISCOUNTED" ||
                                li.priceType === "MANUAL" ||
                                li.priceType === "PROMO") &&
                              li.originalPrice != null ? (
                              <>
                                <span className="strike text-xs">
                                  {formatMoney(li.originalPrice)}
                                </span>
                                <span className="money text-amber-600">
                                  {formatMoney(li.unitPrice)}
                                </span>
                                <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200">
                                  {li.priceType === "MANUAL"
                                    ? "Adjusted"
                                    : li.priceType === "PROMO"
                                      ? "Promo"
                                      : "Discounted"}
                                </span>
                              </>
                            ) : (
                              <span className="money text-navy/70">
                                {formatMoney(li.unitPrice)}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {li.status === "CANCELLED" ? (
                            <span className="text-navy/40">—</span>
                          ) : (
                            <span className="money text-navy">
                              {formatMoney(
                                li.subtotal != null
                                  ? Number(li.subtotal)
                                  : computeLineSubtotal({
                                      unitPrice: Number(li.unitPrice),
                                      qty: Number(li.qty),
                                      boxes: li.boxes ?? null,
                                      pieces: li.pieces ?? null,
                                      // Snapshot upb, never the live product.
                                      unitsPerBox:
                                        li.unitsPerBox ?? li.product?.unitsPerBox ?? null,
                                      // BUY_N_GET_M snapshot, or the fallback bills
                                      // a free-units line at full price.
                                      freeUnits: Math.max(
                                        0,
                                        Math.trunc(Number(li.promoFreeUnits ?? 0) || 0),
                                      ),
                                    }),
                              )}
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-3">
                          <Badge status={displayLineStatus(li, order.status)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t-2 border-surface-border">
                    <tr>
                      <td
                        colSpan={3}
                        className="px-6 py-3 text-right text-sm font-semibold text-navy"
                      >
                        Order Total
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="money text-[15px] font-semibold text-navy">
                          {formatMoney(total)}
                        </span>
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>

          {/* P5-11: post-dispatch change requests + office resolution. */}
          {!isEditing && changeRequests.length > 0 && (
            <Card
              title={`Change Requests${
                pendingChangeRequests.length > 0 ? ` (${pendingChangeRequests.length} pending)` : ""
              }`}
            >
              <ul className="divide-y divide-surface-border">
                {changeRequests.map((cr) => {
                  const { title, detail } = describeChangeRequest(cr, order.lineItems);
                  const outcome = describeResolution(cr);
                  const busy = resolveCr.isPending && resolveCr.variables?.crId === cr.id;
                  // Next-delivery is server-valid only for ADD_ITEM and
                  // CHANGE_QTY increases — hide it otherwise (400 INVALID_RESOLUTION_FOR_TYPE).
                  const currentLine = order.lineItems.find(
                    (li) => li.id === (cr.orderItemId ?? cr.payload.orderItemId),
                  );
                  const canNextDelivery =
                    cr.type === "ADD_ITEM" ||
                    (cr.type === "CHANGE_QTY" &&
                      Number(cr.payload.newQty ?? 0) > Number(currentLine?.qty ?? Infinity));
                  return (
                    <li key={cr.id} className="py-3 first:pt-0 last:pb-0">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-navy">{title}</p>
                          {detail && <p className="mt-0.5 text-xs text-navy/70">{detail}</p>}
                          <p className="mt-0.5 text-[11px] text-navy/50">
                            {cr.requestedByName ?? cr.requestedByRole ?? "Requester"} ·{" "}
                            {new Date(cr.createdAt).toLocaleString()}
                          </p>
                          {outcome && (
                            <p
                              className={`mt-1 text-xs font-medium ${
                                cr.status === "DECLINED" ? "text-danger" : "text-success"
                              }`}
                            >
                              {outcome}
                              {cr.resolvedByName ? ` · by ${cr.resolvedByName}` : ""}
                            </p>
                          )}
                        </div>
                        <Badge status={cr.status} />
                      </div>
                      {cr.status === "PENDING" &&
                        (declineTargetId === cr.id ? (
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <input
                              type="text"
                              value={declineReason}
                              onChange={(e) => setDeclineReason(e.target.value)}
                              placeholder="Decline reason (required, shown to the requester)"
                              maxLength={1000}
                              className="h-8 min-w-[240px] flex-1 rounded border border-surface-border bg-white px-2 text-sm text-navy placeholder:text-navy/50 focus:outline-none focus:ring-2 focus:ring-brand-500"
                            />
                            <Button
                              size="sm"
                              variant="danger"
                              disabled={!declineReason.trim() || busy}
                              loading={busy && resolveCr.variables?.action === "DECLINE"}
                              onClick={() => handleResolve(cr, "DECLINE", declineReason.trim())}
                            >
                              Decline
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setDeclineTargetId(null);
                                setDeclineReason("");
                              }}
                            >
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              disabled={busy}
                              loading={busy && resolveCr.variables?.action === "APPROVE_AT_STOP"}
                              onClick={() => handleResolve(cr, "APPROVE_AT_STOP")}
                            >
                              Approve at stop
                            </Button>
                            {canNextDelivery && (
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={busy}
                                loading={
                                  busy && resolveCr.variables?.action === "APPROVE_NEXT_DELIVERY"
                                }
                                onClick={() => handleResolve(cr, "APPROVE_NEXT_DELIVERY")}
                              >
                                Approve as next delivery
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="danger"
                              disabled={busy}
                              onClick={() => {
                                setDeclineTargetId(cr.id);
                                setDeclineReason("");
                              }}
                            >
                              Decline…
                            </Button>
                          </div>
                        ))}
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          {/* Notes */}
          {order.notes && !isEditing && (
            <Card title="Order Notes">
              <div className="flex items-start gap-3">
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-navy/70" />
                <p className="text-sm text-navy/80 whitespace-pre-line">{order.notes}</p>
              </div>
            </Card>
          )}
        </div>

        {/* ── Sidebar ── */}
        <div className="space-y-4">
          {/* Customer info */}
          <div className="rounded-lg bg-white p-6 shadow-card">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-base font-semibold text-navy">Customer</h3>
              <Link
                href={`/customers/${order.customerId}`}
                className="text-xs font-medium text-brand-500 hover:underline"
              >
                View profile
              </Link>
            </div>
            <div className="flex items-start gap-2">
              <User className="mt-0.5 h-4 w-4 shrink-0 text-navy/40" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-navy">
                  {order.customer?.businessName ?? "—"}
                </p>
                {(order.customer?.contactName ||
                  order.customer?.mobile ||
                  order.customer?.phone) && (
                  <p className="mt-0.5 text-xs text-navy/70">
                    {[order.customer?.contactName, order.customer?.mobile || order.customer?.phone]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Order summary */}
          <Card title="Summary">
            <dl className="space-y-2.5 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-navy/70">Fulfillment</dt>
                <dd className="flex flex-col items-end gap-0.5">
                  <div className="w-40">
                    <Select
                      options={[
                        { value: "ROUTE", label: "Delivery route" },
                        { value: "SHIP", label: "Ship via carrier" },
                      ]}
                      value={order.fulfillPath}
                      disabled={fulfillPathLocked || patchFulfillPath.isPending}
                      title={
                        fulfillPathLocked
                          ? "Fulfillment path can only be changed while the order is open"
                          : undefined
                      }
                      onChange={(e) => {
                        const fulfillPath = e.target.value as "ROUTE" | "SHIP";
                        patchFulfillPath.mutate(
                          { id: order.id, fulfillPath },
                          {
                            onSuccess: () =>
                              toast({ title: "Fulfillment updated", variant: "success" }),
                            onError: (err: any) =>
                              toast({
                                title: "Could not update fulfillment",
                                description: err?.response?.data?.message,
                                variant: "error",
                              }),
                          },
                        );
                      }}
                    />
                  </div>
                  {order.fulfillPath === "SHIP" && (
                    <span className="text-[11px] text-navy/50">
                      Ships via carrier — won&apos;t appear on delivery routes.
                    </span>
                  )}
                </dd>
              </div>
              {order.orderDate && (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-navy/70">Order date</dt>
                  <dd className="font-medium text-navy">{formatDateOnly(order.orderDate)}</dd>
                </div>
              )}
              {hasSalesAgents && (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-navy/70">Commission</dt>
                  <dd className="flex items-center gap-2 font-medium text-navy">
                    {order.commissionRatePct == null
                      ? "Default"
                      : Number(order.commissionRatePct) === 0
                        ? "Exempt (0%)"
                        : `${Number(order.commissionRatePct)}% (override)`}
                    {isStaff && (
                      <button
                        type="button"
                        className="text-xs font-medium text-brand-700 hover:underline"
                        onClick={() => setCommissionEditOpen(true)}
                      >
                        Edit
                      </button>
                    )}
                  </dd>
                </div>
              )}
              {order.requestedDeliveryDate && (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-navy/70">Delivery date</dt>
                  <dd className="font-medium text-navy">
                    {formatDateOnly(order.requestedDeliveryDate)}
                  </dd>
                </div>
              )}
              <div className="flex items-center justify-between gap-3">
                <dt className="text-navy/70">Line items</dt>
                <dd className="mono font-medium text-navy">
                  {order.lineItems.filter((li) => li.status !== "CANCELLED").length}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-navy/70">Total quantity</dt>
                <dd className="mono font-medium text-navy">
                  {formatQty(
                    order.lineItems
                      .filter((li) => li.status !== "CANCELLED")
                      .reduce((s, li) => s + Number(li.qty), 0),
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-navy/70">Subtotal</dt>
                <dd className="money text-navy">{formatMoney(order.subtotal)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-navy/70">Tax</dt>
                <dd className="money text-navy">{formatMoney(order.tax)}</dd>
              </div>
              {orderCategoryTax > 0 && (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-navy/70">Regulated tax</dt>
                  <dd className="money text-navy">{formatMoney(orderCategoryTax)}</dd>
                </div>
              )}
              {shippingFee > 0 && (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-navy/70">Shipping</dt>
                  <dd className="money text-navy">{formatMoney(shippingFee)}</dd>
                </div>
              )}
              <div className="flex items-center justify-between gap-3 border-t border-surface-border pt-2.5">
                <dt className="font-semibold text-navy">Order total</dt>
                <dd className="money text-[15px] font-semibold text-navy">{formatMoney(total)}</dd>
              </div>
            </dl>

            {/* Applied credits — intent (order.orderCreditNotes) vs money already
                moved (Σ CREDIT_NOTE payments across this order's invoices). Credits
                reduce the invoice balance due, never this order total above. */}
            {(order.orderCreditNotes?.length ?? 0) > 0 && (
              <div className="mt-3 space-y-2 border-t border-surface-border pt-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">
                  Applied credits
                </p>
                {order.orderCreditNotes!.map((oc) => {
                  const appliedSoFar = (order.invoices ?? []).reduce((sum, inv) => {
                    const pays = inv.payments ?? [];
                    return (
                      sum +
                      pays
                        .filter((p) => p.creditNoteId === oc.creditNoteId)
                        .reduce((s, p) => s + Number(p.amount), 0)
                    );
                  }, 0);
                  return (
                    <div key={oc.id} className="flex items-start justify-between gap-2 text-xs">
                      <div className="min-w-0">
                        <Link
                          href={`/credit-notes/${oc.creditNoteId}`}
                          className="font-mono font-medium text-brand-600 hover:underline"
                        >
                          {oc.creditNote?.creditNoteNumber ?? oc.creditNoteId.slice(0, 8)}
                        </Link>
                        {oc.creditNote?.reason && (
                          <span
                            className="ml-1.5 truncate text-navy/70"
                            title={oc.creditNote.reason}
                          >
                            {oc.creditNote.reason}
                          </span>
                        )}
                        <div className="text-navy/50">
                          {oc.amount != null
                            ? `Requested ${formatMoney(oc.amount)}`
                            : "Up to remaining"}
                        </div>
                      </div>
                      <span className="shrink-0 font-medium text-navy">
                        {formatMoney(appliedSoFar)} applied
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Carrier shipment — operator records carrier + tracking when goods ship
              via a carrier instead of our own route. Gated so it doesn't render on
              every order: only carrier-shipped (fulfillPath === "SHIP") orders, or
              historical rows that already carry tracking data. */}
          {(order.fulfillPath === "SHIP" ||
            order.shippingCarrier ||
            order.shippingTrackingNumber) && (
            <ShipmentCard
              carrier={order.shippingCarrier}
              trackingNumber={order.shippingTrackingNumber}
              shippedAt={order.shippedAt}
              isSaving={updateShipment.isPending}
              onSave={(values) => updateShipment.mutateAsync({ id: order.id, ...values })}
              openSignal={shipmentOpenSignal}
            />
          )}

          {/* Invoice card — show for any non-draft, non-cancelled order so the operator
              can split into multiple invoices any time after the order is confirmed. */}
          {localStatus !== "DRAFT" && localStatus !== "CANCELLED" && (
            <Card title={`Invoice${((order as any).invoices?.length ?? 0) > 1 ? "s" : ""}`}>
              {(order as any).invoices?.length > 0 && (
                <div className="space-y-3">
                  {(() => {
                    // Warn when this fully-invoiced order's total no longer matches
                    // the sum of its non-void invoices (mirrors the popup note). "Fully
                    // invoiced" = no line has qty left to bill, so a partial split
                    // (which legitimately bills less) never trips the warning.
                    const nonVoid = ((order as any).invoices as any[]).filter(
                      (i) => i.status !== "VOID",
                    );
                    const invoicedTotal = nonVoid.reduce((s, i) => s + Number(i.total), 0);
                    const noRemaining = !((order.lineItems ?? []) as any[]).some(
                      (li) =>
                        li.status !== "CANCELLED" &&
                        Number(li.qty) - Number(li.invoicedQty ?? 0) > 0.001,
                    );
                    const fullyInvoiced = nonVoid.length > 0 && noRemaining;
                    return fullyInvoiced ? (
                      <DivergenceNote
                        orderTotal={Number(order.total)}
                        invoicedTotal={invoicedTotal}
                      />
                    ) : null;
                  })()}
                  {(order as any).invoices.map((inv: any) => (
                    <div key={inv.id} className="space-y-1">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-brand-500" />
                        <span className="mono text-sm font-medium text-navy">
                          {inv.invoiceNumber}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge status={inv.status as BadgeStatus} />
                        {inv.dueDate && (
                          <span className="text-xs text-navy/70">
                            Due {fmtCalendarDate(inv.dueDate)}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => setPreviewInvoiceId(inv.id)}
                          className="text-xs font-medium text-brand-500 hover:underline"
                        >
                          Preview
                        </button>
                        <Link
                          href={`/invoices/${inv.id}`}
                          className="text-xs text-navy/60 hover:underline"
                        >
                          Open →
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {(() => {
                const items = (order.lineItems ?? []) as any[];
                const hasRemaining = items.some(
                  (li) => Number(li.qty) - Number((li as any).invoicedQty ?? 0) > 0.001,
                );
                const hasNoInvoiceYet = !((order as any).invoices?.length > 0);
                if (!hasRemaining && !hasNoInvoiceYet) return null;
                return (
                  <div className="mt-3 space-y-2 border-t border-surface-border pt-3">
                    {hasNoInvoiceYet && (
                      <>
                        <p className="text-xs text-navy/70">
                          No invoice has been generated for this order.
                        </p>
                        <Button
                          size="sm"
                          className="w-full justify-center"
                          leftIcon={<FileText className="h-4 w-4" />}
                          loading={createInvoiceFromOrder.isPending}
                          onClick={() => {
                            // The invoice-time backstop can 409 on an expired/newly-added
                            // regulated line — route it into the license guard + retry.
                            const invoiceNow = () =>
                              createInvoiceFromOrder.mutate(order.id, {
                                onError: guardError(() => invoiceNow()),
                              });
                            invoiceNow();
                          }}
                        >
                          Generate Invoice (full order)
                        </Button>
                      </>
                    )}
                    {hasRemaining && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setSplitInvoiceOpen(true)}
                      >
                        Split into invoice…
                      </Button>
                    )}
                  </div>
                );
              })()}
            </Card>
          )}
        </div>
      </div>

      {/* Split-invoice modal: operator picks per-item qty + due date, and we POST to
          /invoices/from-order/:orderId/partial. Each call increments invoicedQty. */}
      <SplitInvoiceModal
        isOpen={splitInvoiceOpen}
        onClose={() => setSplitInvoiceOpen(false)}
        orderId={order.id}
        orderNumber={order.orderNumber ?? null}
        items={(order.lineItems ?? []).map((li: any) => ({
          id: li.id,
          productName: li.product?.name ?? li.name ?? "Custom item",
          qty: Number(li.qty),
          invoicedQty: Number((li as any).invoicedQty ?? 0),
          unitPrice: Number(li.unitPrice),
          // Stored line subtotal so the preview prorates it the same way the server
          // bills the split — never a raw qty × unitPrice (over-charges boxed lines).
          subtotal: li.subtotal != null ? Number(li.subtotal) : undefined,
          unit: li.product?.unit,
        }))}
      />

      <InvoicePreviewModal
        open={previewInvoiceId != null}
        onClose={() => setPreviewInvoiceId(null)}
        invoiceId={previewInvoiceId ?? ""}
        orderTotal={Number(order.total)}
      />

      {/* Cancel confirmation */}
      <ConfirmDialog
        open={showCancelConfirm}
        onClose={() => setShowCancelConfirm(false)}
        onConfirm={confirmCancel}
        title={cancelCopy.title}
        description={
          cancelImpact.isLoading
            ? "Checking this order's invoices and credits…"
            : (cancelCopy.blockedReason ??
              [`Order ${order.orderNumber} will be marked as cancelled.`, ...cancelCopy.lines].join(
                " ",
              ))
        }
        confirmLabel={cancelCopy.confirmLabel ? "Yes, cancel order" : "Close"}
        variant="danger"
        loading={updateStatus.isPending || cancelImpact.isLoading}
      />

      {/* Demote reason modal */}
      <DemoteReasonModal
        open={!!demoteTarget}
        onClose={() => setDemoteTarget(null)}
        onConfirm={handleDemote}
        loading={updateStatus.isPending}
        targetStatus={demoteTarget ?? ""}
      />

      {/* Send invoice modal — shown after marking order as delivered */}
      {invoiceModal && (
        <SendInvoiceModal data={invoiceModal} onClose={() => setInvoiceModal(null)} />
      )}

      {/* Commission rate override — staff + sales_agents addon only */}
      {hasSalesAgents && isStaff && (
        <CommissionEditModal
          open={commissionEditOpen}
          onClose={() => setCommissionEditOpen(false)}
          orderId={order.id}
          currentValue={order.commissionRatePct == null ? null : Number(order.commissionRatePct)}
        />
      )}

      {/* License guard (W6b): an edit/promote hit a 409 REGULATED_AUTH_REQUIRED.
          Lines are removed via the edit UI here, so the remove exit is omitted. */}
      {licenseBlock && order && (
        <LicenseGuardModal
          open
          customerId={order.customerId}
          orderId={order.id}
          blocked={licenseBlock}
          onResolved={() => {
            const retry = licenseRetryRef.current;
            setLicenseBlock(null);
            retry?.();
          }}
          onClose={() => setLicenseBlock(null)}
        />
      )}
    </div>
  );
}
