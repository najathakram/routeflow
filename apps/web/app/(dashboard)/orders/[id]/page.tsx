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
import { Badge, Button, Card, cn, useToast, type BadgeStatus } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useOrder, useUpdateOrderStatus, useUpdateOrderItems, useReopenOrder, useDeleteOrder, type OrderItem, type ItemUpdate } from "@/lib/api/orders";
import { useCreateInvoiceFromOrder, useSendInvoice, useSendInvoiceEmail } from "@/lib/api/invoices";
import { useProducts } from "@/lib/api/products";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { apiClient } from "@/lib/api-client";

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

function SendInvoiceModal({
  data,
  onClose,
}: {
  data: InvoiceModalData;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const sendInvoice = useSendInvoice();
  const sendInvoiceEmail = useSendInvoiceEmail();
  const [pdfLoading, setPdfLoading] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  const [emailSent, setEmailSent] = React.useState(false);

  const phone = data.customerMobile || data.customerPhone;
  const totalFmt = `$${Number(data.total).toFixed(2)}`;
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
          toast({ title: "Invoice emailed", description: `Sent to ${res.sentTo}`, variant: "success" });
        },
        onError: (e: any) => toast({ title: "Failed to send email", description: e?.response?.data?.message || e.message, variant: "error" }),
      },
    );
  }

  async function handleDownload() {
    setPdfLoading(true);
    try {
      const res = await apiClient.get(`/invoices/${data.invoiceId}/pdf`);
      if (res.data?.url) window.open(res.data.url, "_blank");
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
            <p className="mt-0.5 text-sm text-navy/60">
              {data.invoiceNumber} · {totalFmt} · {data.customerName}
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-navy/40 hover:text-navy transition-colors">
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
                {sendInvoice.isPending ? <Loader2 className="h-4 w-4 animate-spin text-brand-600" /> : <Send className="h-4 w-4 text-brand-600" />}
              </div>
              <div>
                <p className="text-sm font-medium text-navy">Mark as Sent</p>
                <p className="text-xs text-navy/50">Record invoice as sent to customer</p>
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
                <p className="text-xs text-navy/50">{phone}</p>
              </div>
            </a>
          )}

          {/* Email */}
          {data.customerEmail && (
            emailSent ? (
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
                  {sendInvoiceEmail.isPending ? <Loader2 className="h-4 w-4 animate-spin text-navy/60" /> : <Mail className="h-4 w-4 text-navy/60" />}
                </div>
                <div>
                  <p className="text-sm font-medium text-navy">Send via Email</p>
                  <p className="text-xs text-navy/50">{data.customerEmail}</p>
                </div>
              </button>
            )
          )}

          {/* SMS */}
          {phone && (
            <a
              href={`sms:${phone}?body=${invoiceMsg}`}
              className="flex w-full items-center gap-3 rounded-xl border border-surface-border bg-white px-4 py-3 text-left transition-colors hover:bg-surface-raised"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-raised">
                <Phone className="h-4 w-4 text-navy/60" />
              </div>
              <div>
                <p className="text-sm font-medium text-navy">Send via Text</p>
                <p className="text-xs text-navy/50">{phone}</p>
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
              {pdfLoading ? <Loader2 className="h-4 w-4 animate-spin text-navy/60" /> : <Download className="h-4 w-4 text-navy/60" />}
            </div>
            <div>
              <p className="text-sm font-medium text-navy">Download PDF</p>
              <p className="text-xs text-navy/50">Save a copy to your device</p>
            </div>
          </button>
        </div>

        {/* Footer */}
        <div className="border-t border-surface-border px-5 py-3">
          <button
            onClick={onClose}
            className="w-full rounded-lg px-4 py-2 text-sm text-navy/50 hover:text-navy hover:bg-surface-raised transition-colors"
          >
            Skip — I&apos;ll send it later
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

type ApiOrderStatus = "DRAFT" | "PENDING" | "CONFIRMED" | "OUT_FOR_DELIVERY" | "DELIVERED" | "CANCELLED";

interface EditItemState {
  id: string;          // real DB id for existing items; temp "new-{uuid}" for new items
  isNew?: boolean;
  originalProductId: string;
  originalProductName: string;
  originalQty: number;
  productId: string;
  productName: string;
  qty: number;
  unitPrice: number;
  cancelled: boolean;
  substituteProductId?: string;
  notes?: string;
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
          <h2 className="text-base font-semibold text-navy">{label[targetStatus] ?? "Change Status"}</h2>
          <p className="mt-1 text-sm text-navy/60">{description[targetStatus] ?? "Reason for this status change."}</p>
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

// ─── Substitute product picker ────────────────────────────────────────────────

function SubstitutePicker({
  onSelect,
  onClose,
}: {
  onSelect: (product: { id: string; name: string; sku?: string; pricePerUnit: number }) => void;
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
          <p className="px-3 py-2 text-sm text-navy/50">No products found.</p>
        )}
        {data?.data?.map((p: { id: string; name: string; sku?: string; pricePerUnit: number }) => (
          <button
            key={p.id}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-surface-raised"
            onClick={() => { onSelect(p); onClose(); }}
          >
            <div>
              <span className="font-medium text-navy">{p.name}</span>
              {p.sku && <span className="ml-2 text-xs text-navy/70">{p.sku}</span>}
            </div>
            <span className="text-xs text-navy">${Number(p.pricePerUnit).toFixed(2)}</span>
          </button>
        ))}
      </div>
      <div className="border-t border-surface-border px-3 py-2">
        <button
          className="text-xs text-navy/50 hover:text-navy"
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Edit mode line items ──────────────────────────────────────────────────────

function EditableLineItems({
  items,
  onChange,
  onAdd,
}: {
  items: EditItemState[];
  onChange: (items: EditItemState[]) => void;
  onAdd: (item: EditItemState) => void;
}) {
  const [substituteOpenId, setSubstituteOpenId] = React.useState<string | null>(null);
  const [addSearch, setAddSearch] = React.useState("");
  const [addOpen, setAddOpen] = React.useState(false);
  const [addLoading, setAddLoading] = React.useState(false);
  const addRef = React.useRef<HTMLDivElement>(null);
  const addInputRef = React.useRef<HTMLInputElement>(null);
  const { data: productsData } = useProducts({ search: addSearch || undefined, limit: 20, isActive: true });
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
      onChange(items.map((it) => it.id === existing.id ? { ...it, qty: it.qty + 1 } : it));
    } else {
      onAdd({
        id: `new-${Date.now()}-${Math.random()}`,
        isNew: true,
        originalProductId: p.id,
        originalProductName: p.name,
        originalQty: 1,
        productId: p.id,
        productName: p.name,
        qty: 1,
        unitPrice: Number(p.pricePerUnit ?? 0),
        cancelled: false,
      });
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
      // 1. Barcode endpoint
      try {
        const res = await apiClient.get(`/products/barcode/${encodeURIComponent(code)}`);
        if (res.data?.id) { addProduct(res.data); return; }
      } catch { /* not found */ }
      // 2. Exact SKU match in current results
      const skuMatch = products.find((p) => p.sku === code);
      if (skuMatch) { addProduct(skuMatch); return; }
      // 3. Only one search result — add it directly
      if (products.length === 1) { addProduct(products[0]); return; }
      // 4. Not found — open dropdown for manual selection
      setAddOpen(true);
    } finally {
      setAddLoading(false);
    }
  }

  function update(id: string, patch: Partial<EditItemState>) {
    onChange(items.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div key={item.id}>
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
                  <span className="line-through text-xs text-navy/40 mr-1">{item.originalProductName}</span>
                  <span className="text-sm font-medium text-navy">→ {item.productName}</span>
                </div>
              ) : (
                <span
                  className={cn(
                    "text-sm font-medium text-navy",
                    item.cancelled && "line-through",
                  )}
                >
                  {item.productName}
                </span>
              )}
              {item.cancelled && (
                <span className="text-xs text-danger ml-1.5">Not available</span>
              )}
            </div>

            {/* Qty input */}
            {!item.cancelled && (
              <input
                type="number"
                min={1}
                step={1}
                className="w-20 rounded border border-surface-border bg-surface-raised px-2 py-1 text-right text-sm text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                value={item.qty}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v) && v > 0) update(item.id, { qty: v });
                }}
              />
            )}

            {/* Action buttons */}
            <div className="flex items-center gap-1.5">
              {item.cancelled ? (
                <button
                  className="flex items-center gap-1 rounded px-2 py-1 text-xs text-brand-600 hover:bg-brand-50"
                  onClick={() =>
                    update(item.id, {
                      cancelled: false,
                      productId: item.originalProductId,
                      productName: item.originalProductName,
                      qty: item.originalQty,
                      substituteProductId: undefined,
                    })
                  }
                >
                  <RotateCcw className="h-3 w-3" />
                  Undo
                </button>
              ) : (
                <>
                  {!item.substituteProductId && (
                    <button
                      className="rounded px-2 py-1 text-xs text-navy/50 hover:bg-surface-raised hover:text-navy"
                      onClick={() =>
                        setSubstituteOpenId((p) => (p === item.id ? null : item.id))
                      }
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
                </>
              )}
            </div>
          </div>

          {/* Substitute picker */}
          {substituteOpenId === item.id && (
            <SubstitutePicker
              onSelect={(p) => {
                update(item.id, {
                  substituteProductId: p.id,
                  productId: p.id,
                  productName: p.name,
                  unitPrice: p.pricePerUnit,
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
          {addLoading
            ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-brand-400" />
            : <Search className="h-4 w-4 shrink-0 text-brand-400" />}
          <input
            ref={addInputRef}
            type="text"
            placeholder="Scan barcode or type name…"
            value={addSearch}
            onChange={(e) => { setAddSearch(e.target.value); if (e.target.value) setAddOpen(true); else setAddOpen(false); }}
            onFocus={() => { if (addSearch) setAddOpen(true); }}
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
            className="flex-1 bg-transparent text-sm text-navy placeholder:text-navy/40 outline-none"
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
                    <span className="text-xs text-navy/40">{p.unit}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OrderDetailPage({ params }: { params: { id: string } }) {
  const { setTitle } = usePageTitle();
  const { data: order, isLoading, isError } = useOrder(params.id);
  const router = useRouter();
  const updateStatus = useUpdateOrderStatus();
  const updateItems = useUpdateOrderItems();
  const reopenOrder = useReopenOrder();
  const deleteOrder = useDeleteOrder();
  const createInvoiceFromOrder = useCreateInvoiceFromOrder();

  // Status tracking — use actual API status directly
  const [localStatus, setLocalStatus] = React.useState<ApiOrderStatus>("PENDING");

  // Item editing
  const [isEditing, setIsEditing] = React.useState(false);
  const [editItems, setEditItems] = React.useState<EditItemState[]>([]);
  const [draftAutoEntered, setDraftAutoEntered] = React.useState(false);

  // Demotion modal
  const [demoteTarget, setDemoteTarget] = React.useState<ApiOrderStatus | null>(null);

  // Cancel confirmation
  const [showCancelConfirm, setShowCancelConfirm] = React.useState(false);

  // Delete confirmation
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);

  // Invoice send modal (shown after marking delivered)
  const [invoiceModal, setInvoiceModal] = React.useState<InvoiceModalData | null>(null);

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
            .map((li) => ({
              id: li.id,
              originalProductId: li.productId,
              originalProductName: li.product?.name ?? li.productId,
              originalQty: Math.round(Number(li.qty)),
              productId: li.productId,
              productName: li.product?.name ?? li.productId,
              qty: Math.round(Number(li.qty)),
              unitPrice: Number(li.unitPrice),
              cancelled: false,
              notes: li.notes,
            })),
        );
        setIsEditing(true);
      }
    }
  }, [order, setTitle, draftAutoEntered]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-navy/40" />
      </div>
    );
  }

  if (isError || !order) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Order not found.</p>
        <Button variant="secondary" href="/orders">Back to Orders</Button>
      </div>
    );
  }

  const total = Number(order.total);
  const canEdit = localStatus === "DRAFT" || localStatus === "PENDING" || localStatus === "CONFIRMED";

  // ── Edit mode ──────────────────────────────────────────────────────────────

  function enterEditMode() {
    setEditItems(
      order!.lineItems
        .filter((li) => li.status !== "CANCELLED")
        .map((li) => ({
          id: li.id,
          originalProductId: li.productId,
          originalProductName: li.product?.name ?? li.productId,
          originalQty: Math.round(Number(li.qty)),
          productId: li.productId,
          productName: li.product?.name ?? li.productId,
          qty: Math.round(Number(li.qty)),
          unitPrice: Number(li.unitPrice),
          cancelled: false,
          notes: li.notes,
        })),
    );
    setIsEditing(true);
  }

  function cancelEditMode() {
    setIsEditing(false);
    setEditItems([]);
  }

  function handleSaveItems() {
    const original = order!.lineItems;
    const updates: ItemUpdate[] = [];

    for (const edited of editItems) {
      if (edited.isNew) {
        // New item: no id — API will create it
        updates.push({ productId: edited.productId, qty: edited.qty } as any);
        continue;
      }
      const orig = original.find((li) => li.id === edited.id);
      if (!orig) continue;

      if (edited.cancelled) {
        updates.push({ id: edited.id, action: "CANCEL" });
      } else if (edited.substituteProductId) {
        updates.push({
          id: edited.id,
          substituteProductId: edited.substituteProductId,
          qty: edited.qty,
        });
      } else if (Math.abs(edited.qty - Number(orig.qty)) > 0.0001) {
        updates.push({ id: edited.id, action: "UPDATE", qty: edited.qty });
      }
    }

    if (updates.length === 0) {
      setIsEditing(false);
      return;
    }

    updateItems.mutate(
      { id: order!.id, items: updates },
      {
        onSuccess: () => {
          setIsEditing(false);
          setEditItems([]);
        },
      },
    );
  }

  // ── Status handlers ────────────────────────────────────────────────────────

  const handleConfirm = () => {
    updateStatus.mutate(
      { id: order.id, status: "CONFIRMED" },
      { onSuccess: () => setLocalStatus("CONFIRMED") },
    );
  };

  const handleLock = () => {
    updateStatus.mutate(
      { id: order.id, status: "OUT_FOR_DELIVERY" },
      { onSuccess: () => setLocalStatus("OUT_FOR_DELIVERY") },
    );
  };

  const handleCancel = () => setShowCancelConfirm(true);

  const confirmCancel = () => {
    updateStatus.mutate(
      { id: order.id, status: "CANCELLED" },
      {
        onSuccess: () => {
          setLocalStatus("CANCELLED");
          setShowCancelConfirm(false);
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
          // then show the send-invoice prompt
          createInvoiceFromOrder.mutate(order.id, {
            onSuccess: (invoice: any) => {
              setInvoiceModal({
                invoiceId: invoice.id,
                invoiceNumber: invoice.invoiceNumber,
                total: Number(invoice.total),
                customerName: order.customer?.businessName ?? "Customer",
                customerPhone: order.customer?.phone,
                customerMobile: order.customer?.mobile,
                customerEmail: order.customer?.email,
              });
            },
            onError: () => {
              // Non-critical — invoice can be created manually
              toast({ title: "Order delivered. Create the invoice manually from the Invoices page.", variant: "warning" });
            },
          });
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

  // ── Estimated totals in edit mode ──────────────────────────────────────────

  const editSubtotal = isEditing
    ? editItems
        .filter((it) => !it.cancelled)
        .reduce((s, it) => s + it.qty * it.unitPrice, 0)
    : Number(order.subtotal);

  const taxRate = order.subtotal > 0 ? Number(order.tax) / Number(order.subtotal) : 0;
  const editTax = isEditing ? editSubtotal * taxRate : Number(order.tax);
  const editTotal = editSubtotal + editTax;

  return (
    <div className="space-y-5 p-6">
      {/* Back */}
      <Link
        href="/orders"
        className="flex items-center gap-1.5 text-sm text-navy/60 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Orders
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          {order.urgent && (
            <div className="mt-1 flex items-center gap-1.5 rounded-full bg-danger-bg px-2.5 py-1 text-xs font-semibold text-danger">
              <AlertTriangle className="h-3.5 w-3.5" />
              URGENT
            </div>
          )}
          <div>
            <h1 className="text-2xl font-bold text-navy">{order.orderNumber}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-navy/60">
              <span>
                Created{" "}
                {new Date(order.createdAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
              {order.requestedDeliveryDate && (
                <span className="flex items-center gap-1.5 rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700">
                  <Calendar className="h-3.5 w-3.5" />
                  Delivery:{" "}
                  {(() => { const [y,m,d] = order.requestedDeliveryDate!.split('T')[0].split('-').map(Number); return new Date(y, m-1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); })()}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Action bar */}
        <div className="flex flex-wrap items-center gap-2">
          <Badge status={localStatus as BadgeStatus} />

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

          {/* DRAFT actions */}
          {localStatus === "DRAFT" && !isEditing && (
            <>
              <Button
                size="sm"
                leftIcon={<CheckCircle2 className="h-4 w-4" />}
                onClick={() => {
                  updateStatus.mutate(
                    { id: order.id, status: "PENDING" as any },
                    { onSuccess: () => setLocalStatus("PENDING") },
                  );
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
                        onSuccess: () => { toast({ title: "Draft deleted", variant: "success" }); router.push("/orders"); },
                        onError: (e) => { toast({ title: e.message, variant: "error" }); setShowDeleteConfirm(false); },
                      });
                    }}
                  >
                    Confirm Delete
                  </Button>
                  <button onClick={() => setShowDeleteConfirm(false)} className="text-sm text-navy/50 hover:text-navy transition-colors">No</button>
                </div>
              ) : (
                <Button size="sm" variant="ghost" leftIcon={<Trash2 className="h-4 w-4" />} onClick={() => setShowDeleteConfirm(true)}>
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
                        onSuccess: () => { toast({ title: "Order deleted", variant: "success" }); router.push("/orders"); },
                        onError: (e) => { toast({ title: e.message, variant: "error" }); setShowDeleteConfirm(false); },
                      });
                    }}
                  >
                    Confirm Delete
                  </Button>
                  <button onClick={() => setShowDeleteConfirm(false)} className="text-sm text-navy/50 hover:text-navy transition-colors">No</button>
                </div>
              ) : (
                <Button size="sm" variant="ghost" leftIcon={<Trash2 className="h-4 w-4" />} onClick={() => setShowDeleteConfirm(true)}>
                  Delete
                </Button>
              )}
            </>
          )}

          {/* CONFIRMED actions */}
          {localStatus === "CONFIRMED" && !isEditing && (
            <>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Truck className="h-4 w-4" />}
                onClick={handleLock}
                loading={updateStatus.isPending}
              >
                Out for Delivery
              </Button>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<RotateCcw className="h-4 w-4" />}
                onClick={() => {
                  if (confirm("Unconfirm this order? It will return to Pending status.")) {
                    updateStatus.mutate(
                      { id: order.id, status: "PENDING" },
                      { onSuccess: () => setLocalStatus("PENDING") },
                    );
                  }
                }}
                loading={updateStatus.isPending}
              >
                Unconfirm
              </Button>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<RefreshCcw className="h-4 w-4" />}
                onClick={() => setDemoteTarget("PENDING")}
              >
                Return to Pending
              </Button>
              <Button
                size="sm"
                variant="danger"
                leftIcon={<XCircle className="h-4 w-4" />}
                onClick={handleCancel}
              >
                Cancel Order
              </Button>
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
                Mark as Delivered
              </Button>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<RefreshCcw className="h-4 w-4" />}
                onClick={() => setDemoteTarget("CONFIRMED")}
              >
                Return to Confirmed
              </Button>
              <Button
                size="sm"
                variant="danger"
                leftIcon={<XCircle className="h-4 w-4" />}
                onClick={handleCancel}
              >
                Cancel Order
              </Button>
            </>
          )}

          {/* DELIVERED actions */}
          {localStatus === "DELIVERED" && (
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<RefreshCcw className="h-4 w-4" />}
              onClick={() => setDemoteTarget("CONFIRMED")}
            >
              Reopen Order
            </Button>
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
                        onSuccess: () => { toast({ title: "Order deleted", variant: "success" }); router.push("/orders"); },
                        onError: (e) => { toast({ title: e.message, variant: "error" }); setShowDeleteConfirm(false); },
                      });
                    }}
                  >
                    Confirm Delete
                  </Button>
                  <button onClick={() => setShowDeleteConfirm(false)} className="text-sm text-navy/50 hover:text-navy transition-colors">No</button>
                </div>
              ) : (
                <Button size="sm" variant="ghost" leftIcon={<Trash2 className="h-4 w-4" />} onClick={() => setShowDeleteConfirm(true)}>
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
          <Card title={isEditing ? "Edit Line Items" : "Line Items"}>
            {isEditing ? (
              <div className="space-y-4">
                <p className="text-sm text-navy/60">
                  Add new items, adjust quantities, substitute or mark as unavailable.
                  Changes are applied when you save.
                </p>
                <EditableLineItems
                  items={editItems}
                  onChange={setEditItems}
                  onAdd={(item) => setEditItems((prev) => [...prev, item])}
                />

                {/* Live total preview */}
                <div className="rounded-lg border border-surface-border bg-surface-raised px-4 py-3">
                  <div className="flex justify-between text-sm text-navy/70">
                    <span>Subtotal</span>
                    <span>${editSubtotal.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-navy/70 mt-1">
                    <span>Tax ({(taxRate * 100).toFixed(0)}%)</span>
                    <span>${editTax.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-base font-bold text-navy border-t border-surface-border mt-2 pt-2">
                    <span>New total</span>
                    <span>${editTotal.toFixed(2)}</span>
                  </div>
                </div>

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
                          // Save items first, then publish
                          const original = order!.lineItems;
                          const updates: any[] = [];
                          for (const edited of editItems) {
                            if (edited.isNew) { updates.push({ productId: edited.productId, qty: edited.qty }); continue; }
                            const orig = original.find((li) => li.id === edited.id);
                            if (!orig) continue;
                            if (edited.cancelled) { updates.push({ id: edited.id, action: "CANCEL" }); }
                            else if (edited.substituteProductId) { updates.push({ id: edited.id, substituteProductId: edited.substituteProductId, qty: edited.qty }); }
                            else if (Math.abs(edited.qty - Number(orig.qty)) > 0.0001) { updates.push({ id: edited.id, action: "UPDATE", qty: edited.qty }); }
                          }
                          const doPublish = () => updateStatus.mutate(
                            { id: order!.id, status: "PENDING" as any },
                            { onSuccess: () => { setLocalStatus("PENDING"); setIsEditing(false); setEditItems([]); } },
                          );
                          if (updates.length > 0) {
                            updateItems.mutate({ id: order!.id, items: updates }, { onSuccess: doPublish });
                          } else {
                            doPublish();
                          }
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
                      <Button
                        size="sm"
                        onClick={handleSaveItems}
                        loading={updateItems.isPending}
                      >
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
              <div className="-mx-6 -mb-6 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="border-b border-surface-border bg-surface-raised">
                    <tr>
                      <th className="px-6 py-2.5 text-left text-xs font-medium text-navy/70">Product</th>
                      <th className="px-4 py-2.5 text-right text-xs font-medium text-navy/70">Qty</th>
                      <th className="px-4 py-2.5 text-right text-xs font-medium text-navy/70">Unit Price</th>
                      <th className="px-4 py-2.5 text-right text-xs font-medium text-navy/70">Total</th>
                      <th className="px-6 py-2.5 text-left text-xs font-medium text-navy/70">Status</th>
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
                            <span
                              className={cn(
                                "font-medium text-navy",
                                li.status === "CANCELLED" && "line-through",
                              )}
                            >
                              {li.product?.name ?? li.productId}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right text-navy/70">
                          {li.boxes != null
                            ? <span title={`${Number(li.qty)} ${li.product?.unit ?? "pcs"} total`}>{li.boxes} box{li.boxes !== 1 ? "es" : ""}{li.pieces ? ` + ${li.pieces} pcs` : ""}</span>
                            : Number(li.qty)
                          }
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex flex-col items-end gap-0.5">
                            {li.priceType === 'SPECIAL' ? (
                              <>
                                <span className="text-xs text-navy/40 line-through">${Number(li.originalPrice).toFixed(2)}</span>
                                <span className="font-medium text-emerald-600">${Number(li.unitPrice).toFixed(2)}</span>
                                <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-200">Special</span>
                              </>
                            ) : li.priceType === 'DISCOUNTED' ? (
                              <>
                                <span className="text-xs text-navy/40 line-through">${Number(li.originalPrice).toFixed(2)}</span>
                                <span className="font-medium text-amber-600">${Number(li.unitPrice).toFixed(2)}</span>
                                <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200">Discounted</span>
                              </>
                            ) : (
                              <span className="text-navy/70">${Number(li.unitPrice).toFixed(2)}</span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right font-medium text-navy">
                          {li.status === "CANCELLED"
                            ? "—"
                            : `$${(Number(li.qty) * Number(li.unitPrice)).toFixed(2)}`}
                        </td>
                        <td className="px-6 py-3">
                          <Badge status={li.status as BadgeStatus} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t-2 border-surface-border">
                    <tr>
                      <td colSpan={3} className="px-6 py-3 text-right text-sm font-semibold text-navy">
                        Order Total
                      </td>
                      <td className="px-4 py-3 text-right text-base font-bold text-navy">
                        ${total.toFixed(2)}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Card>

          {/* Notes */}
          {order.notes && !isEditing && (
            <Card title="Order Notes">
              <div className="flex items-start gap-3">
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-navy/40" />
                <p className="text-sm text-navy/80 whitespace-pre-line">{order.notes}</p>
              </div>
            </Card>
          )}
        </div>

        {/* ── Sidebar ── */}
        <div className="space-y-4">

          {/* Customer info */}
          <Card title="Customer">
            <div className="space-y-3">
              <div className="flex items-start gap-2">
                <User className="mt-0.5 h-4 w-4 shrink-0 text-navy/40" />
                <div>
                  <p className="text-sm font-semibold text-navy">{order.customer?.businessName ?? "—"}</p>
                  {order.customer?.contactName && (
                    <p className="text-xs text-navy/50">{order.customer.contactName}</p>
                  )}
                </div>
              </div>
              <Link
                href={`/customers/${order.customerId}`}
                className="mt-1 block text-xs text-brand-500 hover:underline"
              >
                View customer profile →
              </Link>
            </div>
          </Card>

          {/* Order summary */}
          <Card title="Summary">
            <dl className="space-y-2 text-sm">
              {order.requestedDeliveryDate && (
                <div className="flex justify-between">
                  <dt className="text-navy/60">Delivery Date</dt>
                  <dd className="font-medium text-navy">
                    {(() => { const [y,m,d] = order.requestedDeliveryDate!.split('T')[0].split('-').map(Number); return new Date(y, m-1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); })()}
                  </dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-navy/60">Line items</dt>
                <dd className="font-medium text-navy">{order.lineItems.filter((li) => li.status !== "CANCELLED").length}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-navy/60">Total qty</dt>
                <dd className="font-medium text-navy">
                  {order.lineItems
                    .filter((li) => li.status !== "CANCELLED")
                    .reduce((s, li) => s + Number(li.qty), 0)
                    .toFixed(1)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-navy/60">Subtotal</dt>
                <dd className="font-medium text-navy">${Number(order.subtotal).toFixed(2)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-navy/60">Tax</dt>
                <dd className="font-medium text-navy">${Number(order.tax).toFixed(2)}</dd>
              </div>
              <div className="flex justify-between border-t border-surface-border pt-2">
                <dt className="font-semibold text-navy">Order total</dt>
                <dd className="font-bold text-navy">${total.toFixed(2)}</dd>
              </div>
            </dl>
          </Card>

          {/* Invoice link(s) */}
          {(localStatus === "DELIVERED" || (localStatus as string) === "PARTIALLY_DELIVERED") && (
            <Card title={`Invoice${((order as any).invoices?.length ?? 0) > 1 ? "s" : ""}`}>
              {(order as any).invoices?.length > 0 ? (
                <div className="space-y-3">
                  {(order as any).invoices.map((inv: any) => (
                    <div key={inv.id} className="space-y-1">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-brand-500" />
                        <span className="text-sm font-medium text-navy">
                          {inv.invoiceNumber}
                        </span>
                      </div>
                      <Badge status={inv.status as BadgeStatus} />
                      <Link
                        href={`/invoices/${inv.id}`}
                        className="block text-xs text-brand-500 hover:underline"
                      >
                        View invoice →
                      </Link>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-navy/50">No invoice generated yet.</p>
                  <Button
                    size="sm"
                    leftIcon={<FileText className="h-4 w-4" />}
                    loading={createInvoiceFromOrder.isPending}
                    onClick={() => createInvoiceFromOrder.mutate(order.id)}
                  >
                    Generate Invoice
                  </Button>
                </div>
              )}
            </Card>
          )}
        </div>
      </div>

      {/* Cancel confirmation */}
      <ConfirmDialog
        open={showCancelConfirm}
        onClose={() => setShowCancelConfirm(false)}
        onConfirm={confirmCancel}
        title="Cancel this order?"
        description={`Order ${order.orderNumber} will be marked as cancelled. This cannot be undone.`}
        confirmLabel="Yes, cancel order"
        variant="danger"
        loading={updateStatus.isPending}
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
        <SendInvoiceModal
          data={invoiceModal}
          onClose={() => setInvoiceModal(null)}
        />
      )}
    </div>
  );
}
