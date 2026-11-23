"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { Paperclip, ArrowUp, ArrowDown } from "lucide-react";
import { RecordCard, RecordCardList } from "@/components/RecordCard";
import { FiltersDisclosure, activeFilterCount } from "@/components/FiltersDisclosure";
import { usePageTitle } from "@/lib/page-title-context";
import { useUrlSearch } from "@/lib/hooks/useUrlSearch";
import { useUrlPage, useResetPageOnChange, useClampPage } from "@/lib/hooks/useUrlPage";
import {
  useInvoicePayments,
  useVoidPayment,
  useExportPayments,
  useRecordPaymentStandalone,
  useUploadPaymentImage,
  type PaymentListParams,
  type StandalonePaymentDto,
} from "@/lib/api/invoices";
import { useInvoices } from "@/lib/api/invoices";
import { isOpenInvoiceStatus } from "@/lib/open-invoice-status";
import { waterfallAllocations, allocationTotals } from "@/lib/api/supplier-payments";
import { clampAllocationInput } from "@/lib/payment-allocation";
import { genericToastCopy } from "@/lib/generic-toast-copy";
import { useAuth } from "@/lib/auth-context";
import { toastDuplicatePaymentRef } from "@/lib/duplicate-payment-ref";
import { dayClosedCopy } from "@/lib/day-closed-copy";
import { useCustomers } from "@/lib/api/customers";
import { useToast, EmptyState, Button, Badge, Select, cn } from "@routeflow/ui/web";
import Link from "next/link";
import { fmt, fmtDate } from "@/lib/formatting";
import { tenantTodayIso, useResyncOnZone, useTenantTimeZone } from "@/lib/tenant-timezone";
import {
  SELECTABLE_PAYMENT_METHODS,
  ALL_PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS as METHOD_LABELS,
  PAYMENT_METHOD_COLORS as METHOD_COLORS,
  type SelectablePaymentMethod,
} from "@/lib/payment-methods";
import { ReadOnlyHint, WriteButton } from "@/lib/read-only-gate";
import {
  PAYMENT_PHOTO_LATER_COPY,
  finishFoundPayment,
  forgetPaymentProof,
  paymentKeyScope,
  rememberPaymentProof,
  usePaymentSubmitKey,
} from "@/lib/payment-submit-key";
import { usePaymentStatusCheck } from "@/lib/use-payment-status-check";
import { PaymentStatusCheck } from "@/components/PaymentStatusCheck";
import { CREDIT_WORDS, type PaymentStatus } from "@routeflow/types";
import { PAYMENT_STATUS_COPY } from "@routeflow/types/payment-submit-key";

// ─── Constants ─────────────────────────────────────────────────────────────────

const fieldCls =
  "w-full rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500";

const BANK_DATE_LABEL = "Money received in bank";
const BANK_DATE_HELP =
  "When the funds actually landed in your account — e.g. a post-dated check's clearing date. Leave blank if unknown.";

// A payment can land on the open statuses (isOpenInvoiceStatus). Filtered CLIENT-side: ListInvoicesDto
// validates `status` as a single enum value, so a comma-list 400s server-side (mirrors mobile payments/record).

// ─── Sort helper ───────────────────────────────────────────────────────────────

function SortIcon({ col, sortBy, sortDir }: { col: string; sortBy: string; sortDir: string }) {
  if (sortBy !== col) return <span className="ml-1 text-navy/30">⇅</span>;
  return <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>;
}

// ─── Record Payment Modal ──────────────────────────────────────────────────────

interface Allocation {
  invoiceId: string;
  amount: string;
  invoiceNumber: string;
  amountDue: number;
}

function RecordPaymentModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const record = useRecordPaymentStandalone();
  const [customerId, setCustomerId] = React.useState("");
  // SA-824: the holder scope is the writer + target (`standalone:<customerId>`), shared with
  // CustomerRecordPaymentModal, resolved when the customer is chosen: no key exists before that. One key per
  // open, kept across a Cancel -> reopen while the outcome is unknown.
  const keyScope = customerId ? paymentKeyScope.standalone(customerId) : null;
  const paymentKey = usePaymentSubmitKey(true, keyScope);
  const uploadPaymentImage = useUploadPaymentImage();
  // SA-824: an unknown outcome offers "Check payment status"; found closes like a 2xx, and attaches the
  // selected proof photo to the found payment (the same upload the 2xx path runs).
  const statusCheck = usePaymentStatusCheck(paymentKey, async (payment) => {
    // No scope (no customer chosen) means no key and no remembered proof: skip the lookup.
    const photo = keyScope
      ? await finishFoundPayment<File>(keyScope, payment, (paymentId, f) =>
          uploadPaymentImage.mutateAsync({ paymentId, file: f }),
        )
      : "none";
    toast(
      photo === "later"
        ? { title: PAYMENT_PHOTO_LATER_COPY, variant: "info" }
        : { title: PAYMENT_STATUS_COPY.recorded, variant: "success" },
    );
    if (photo === "failed") {
      toast({
        title: "Payment saved, image upload failed",
        description: "You can attach it later from the payment detail page.",
        variant: "error",
      });
    }
    onClose();
  });
  const { data: customersData } = useCustomers({ limit: 200 });
  // An attempt for this customer is unknown or in flight: never re-scope it to another customer.
  const customerLocked = paymentKey.hasUnknown();
  const [totalAmount, setTotalAmount] = React.useState("");
  const [bankCharges, setBankCharges] = React.useState("");
  const zone = useTenantTimeZone(); // SA-943: the business's today, not the UTC day
  const [paidAt, setPaidAt] = React.useState(() => tenantTodayIso(zone));
  useResyncOnZone(zone, tenantTodayIso, paidAt, setPaidAt);
  const [settledAt, setSettledAt] = React.useState("");
  const [method, setMethod] = React.useState<SelectablePaymentMethod>("CASH");
  const [reference, setReference] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [allocations, setAllocations] = React.useState<Allocation[]>([]);
  const [file, setFile] = React.useState<File | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const { data: invoicesData } = useInvoices(
    { customerId: customerId || undefined, page: 1, limit: 50 },
    { enabled: !!customerId },
  );

  // Open invoices, oldest first — the array order IS the pre-fill allocation order.
  const customerInvoices = React.useMemo(() => {
    if (!customerId || !invoicesData?.data) return [];
    return invoicesData.data
      .filter((inv) => isOpenInvoiceStatus(inv.status) && (inv.balanceDue ?? 0) > 0.001)
      .sort((a, b) =>
        (a.issueDate ?? a.createdAt ?? "").localeCompare(b.issueDate ?? b.createdAt ?? ""),
      );
  }, [customerId, invoicesData]);

  // When customer changes, reset allocations and pre-fill greedily. The
  // waterfall/clamp/remainder arithmetic lives in ONE place
  // (`@/lib/api/supplier-payments`) shared with CustomerRecordPaymentModal and
  // RecordSupplierPaymentModal — don't re-derive it here.
  React.useEffect(() => {
    if (!customerId || !customerInvoices.length) {
      setAllocations([]);
      return;
    }
    const { allocations: prefill } = waterfallAllocations(
      parseFloat(totalAmount) || 0,
      customerInvoices.map((inv) => ({ id: inv.id, amountDue: inv.balanceDue ?? 0 })),
    );
    const byId = new Map(prefill.map((a) => [a.id, a.amount]));
    setAllocations(
      customerInvoices.map((inv) => ({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        amountDue: inv.balanceDue ?? 0,
        amount: byId.has(inv.id) ? byId.get(inv.id)!.toFixed(2) : "",
      })),
    );
  }, [customerId, customerInvoices.length, totalAmount]);

  const total = parseFloat(totalAmount) || 0;
  const {
    allocated: allocatedTotal,
    excess,
    overAllocated,
  } = allocationTotals(
    total,
    // `|| null` also swallows a NaN from a half-typed value, as the old
    // `parseFloat(a.amount) || 0` did.
    allocations.map((a) => ({ amount: parseFloat(a.amount) || null })),
  );

  // REG-B1002 / B313: cap each row at its invoice's balance, same helper as
  // CustomerRecordPaymentModal.
  const updateAlloc = (idx: number, val: string) =>
    setAllocations((prev) =>
      prev.map((a, i) =>
        i === idx ? { ...a, amount: clampAllocationInput(val, a.amountDue) } : a,
      ),
    );

  const customers = customersData?.data ?? [];

  const handleSave = async (status: "DRAFT" | "PAID", recordAnyway = false) => {
    if (paymentKey.hasUnknown()) return; // SA-824: the status check comes before any new attempt
    if (!customerId || !keyScope) {
      toast({ title: "Select a customer", variant: "error" });
      return;
    }
    if (!total || total <= 0) {
      toast({ title: "Enter a valid amount", variant: "error" });
      return;
    }
    if (overAllocated) {
      toast({ title: "Allocated more than the amount received", variant: "error" });
      return;
    }
    const validAllocs = allocations.filter((a) => a.amount && parseFloat(a.amount) > 0);
    // X1: bind TMethod to web's enterable subset at the use site — `method`
    // is now typed `SelectablePaymentMethod` above, so this compiles without
    // the `as any` the loosened (generic, `TMethod = string`) shared DTO used
    // to force here.
    const dto: StandalonePaymentDto<SelectablePaymentMethod> = {
      customerId,
      totalAmount: total,
      method,
      paidAt,
      settledAt: settledAt || undefined,
      bankCharges: bankCharges ? parseFloat(bankCharges) : undefined,
      reference: reference || undefined,
      notes: notes || undefined,
      status,
      ...(recordAnyway ? { recordAnyway: true } : {}),
      allocations: validAllocs.map((a) => ({
        invoiceId: a.invoiceId,
        amount: parseFloat(a.amount),
      })),
    };
    rememberPaymentProof(keyScope, file); // so a status check that finds the payment can attach it
    try {
      const res = await record.mutateAsync({ ...dto, submitKey: paymentKey });
      forgetPaymentProof(keyScope);
      toast({
        title: `Payment ${status === "DRAFT" ? "saved as draft" : "recorded"}`,
        variant: "success",
      });
      // Best-effort: the payment already succeeded — an image-upload failure
      // must never look like the payment itself failed. The server anchors the
      // image on the group id, so uploading against the first allocation row
      // makes it visible from every row in the group.
      const createdPaymentId = res.payments[0]?.id;
      if (file && createdPaymentId) {
        try {
          await uploadPaymentImage.mutateAsync({ paymentId: createdPaymentId, file });
        } catch {
          toast({
            title: "Payment saved, image upload failed",
            description: "You can attach it later from the payment detail page.",
            variant: "error",
          });
        }
      }
      onClose();
    } catch (err: unknown) {
      // Row 498: a duplicate reference names the existing payment; staff may "Record anyway".
      if (toastDuplicatePaymentRef(err, toast, user?.role, () => void handleSave(status, true)))
        return;
      toast({
        title: "Failed to record payment",
        description: genericToastCopy(err),
        variant: "error",
      });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-2xl bg-white shadow-modal flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <h2 className="text-lg font-semibold text-navy">Record payment</h2>
          <button onClick={onClose} className="text-navy/70 hover:text-navy text-xl">
            ×
          </button>
        </div>
        <div className="overflow-y-auto px-6 py-4 space-y-4">
          {/* Customer */}
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="mb-1.5 block text-sm font-medium text-navy">Customer *</label>
              <select
                value={customerId}
                onChange={(e) => {
                  if (paymentKey.hasUnknown()) return; // SA-824: never re-scope an unknown attempt
                  setCustomerId(e.target.value);
                }}
                disabled={customerLocked}
                className={fieldCls}
              >
                <option value="">Select customer…</option>
                {customers.map((c: { id: string; businessName: string }) => (
                  <option key={c.id} value={c.id}>
                    {c.businessName}
                  </option>
                ))}
              </select>
              {customerLocked && (
                <p className="mt-1 text-xs text-navy/70">{PAYMENT_STATUS_COPY.customerLocked}</p>
              )}
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-navy">
                Amount received *
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={totalAmount}
                onChange={(e) => setTotalAmount(e.target.value)}
                placeholder="0.00"
                className={fieldCls}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-navy">Bank charges</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={bankCharges}
                onChange={(e) => setBankCharges(e.target.value)}
                placeholder="0.00"
                className={fieldCls}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-navy">Payment date *</label>
              <input
                type="date"
                value={paidAt}
                onChange={(e) => setPaidAt(e.target.value)}
                className={fieldCls}
              />
              <label className="mb-1.5 mt-3 block text-sm font-medium text-navy/60">
                {BANK_DATE_LABEL}
              </label>
              <input
                type="date"
                value={settledAt}
                onChange={(e) => setSettledAt(e.target.value)}
                className={fieldCls}
              />
              <p className="mt-1 text-xs text-navy/50">{BANK_DATE_HELP}</p>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-navy">Payment method *</label>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value as SelectablePaymentMethod)}
                className={fieldCls}
              >
                {SELECTABLE_PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {METHOD_LABELS[m]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-navy">Reference #</label>
              <input
                type="text"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Check #, transaction ID…"
                className={fieldCls}
              />
            </div>
            <div className="col-span-2">
              <label className="mb-1.5 block text-sm font-medium text-navy">Notes (internal)</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className={`${fieldCls} resize-none`}
                placeholder="Internal notes…"
              />
            </div>
            <div className="col-span-2">
              <label className="mb-1.5 block text-sm font-medium text-navy">
                Attach image (optional)
              </label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              {file ? (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-surface-border bg-surface-raised px-3 py-2 text-sm text-navy">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Paperclip className="h-3.5 w-3.5 shrink-0 text-navy/70" />
                    <span className="truncate">{file.name}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setFile(null)}
                    className="shrink-0 text-navy/50 transition-colors hover:text-danger"
                    title="Remove attachment"
                  >
                    ×
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-surface-border bg-white px-3 py-2 text-sm text-navy/70 transition-colors hover:bg-surface-raised"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                  Attach receipt / check photo
                </button>
              )}
            </div>
          </div>

          {/* Invoice allocation */}
          {customerId && (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-navy">Apply to invoices</h3>
                <button
                  type="button"
                  onClick={() => setAllocations((prev) => prev.map((a) => ({ ...a, amount: "" })))}
                  className="text-xs text-brand-500 hover:underline"
                >
                  Clear
                </button>
              </div>
              {customerInvoices.length === 0 ? (
                <p className="text-sm text-navy/70 italic">No unpaid invoices for this customer.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-surface-border">
                  <table className="w-full text-sm">
                    <thead className="bg-surface-raised text-xs font-medium text-navy/70">
                      <tr>
                        <th className="px-3 py-2 text-left">Invoice #</th>
                        <th className="px-3 py-2 text-right">Amount Due</th>
                        <th className="px-3 py-2 text-right">Apply ($)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-surface-border">
                      {allocations.map((a, idx) => (
                        <tr key={a.invoiceId}>
                          <td className="px-3 py-2 font-medium text-brand-600">
                            {a.invoiceNumber}
                          </td>
                          <td className="px-3 py-2 text-right text-navy">{fmt(a.amountDue)}</td>
                          <td className="px-3 py-2 text-right">
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              max={a.amountDue}
                              value={a.amount}
                              onChange={(e) => updateAlloc(idx, e.target.value)}
                              className="w-28 rounded border border-surface-border px-2 py-1 text-right text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="mt-3 space-y-1 text-sm text-right">
                <div className="flex justify-between text-navy/70">
                  <span>Allocated:</span>
                  <span>{fmt(allocatedTotal)}</span>
                </div>
                <div className="flex justify-between text-navy/70">
                  <span>Total received:</span>
                  <span>{fmt(total)}</span>
                </div>
                {overAllocated ? (
                  <div className="flex justify-between font-medium text-danger">
                    <span>⚠ Allocated more than received:</span>
                    <span>{fmt(allocatedTotal - total)}</span>
                  </div>
                ) : (
                  excess > 0.001 && (
                    <div className="flex justify-between font-medium text-amber-600">
                      <span>⚠ {CREDIT_WORDS.kept}:</span>
                      <span>{fmt(excess)}</span>
                    </div>
                  )
                )}
              </div>
            </div>
          )}
        </div>

        <div className="px-6 pb-2">
          <PaymentStatusCheck status={statusCheck} />
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-surface-border px-6 py-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-surface-border px-4 py-2 text-sm text-navy/70 hover:bg-surface-raised"
          >
            Cancel
          </button>
          <button
            onClick={() => handleSave("DRAFT")}
            disabled={record.isPending || overAllocated || statusCheck.unknown}
            className="rounded-lg border border-surface-border px-4 py-2 text-sm text-navy hover:bg-surface-raised disabled:opacity-50"
          >
            Save as draft
          </button>
          <button
            onClick={() => handleSave("PAID")}
            disabled={record.isPending || overAllocated || statusCheck.unknown}
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {record.isPending ? "Saving…" : "Save as paid"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function FinancePaymentsPage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => {
    setTitle("Payments received");
  }, [setTitle]);
  const router = useRouter();
  const { toast } = useToast();

  // Filters + sort state
  const [search, setSearch, debouncedSearch] = useUrlSearch();
  const [method, setMethod] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [customerId, setCustomerId] = React.useState("");
  const [sortBy, setSortBy] = React.useState("paidAt");
  const [sortDir, setSortDir] = React.useState("desc");
  const [page, setPage] = useUrlPage();
  const [showModal, setShowModal] = React.useState(false);
  const [voidConfirm, setVoidConfirm] = React.useState<{
    invoiceId: string;
    paymentId: string;
  } | null>(null);

  const params: PaymentListParams = {
    page,
    limit: 25,
    search: debouncedSearch || undefined,
    method: method || undefined,
    status: status || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    customerId: customerId || undefined,
    sortBy,
    sortDir,
  };

  const { data, isLoading, isError, isFetching, error, refetch } = useInvoicePayments(params);
  const { data: customersData } = useCustomers({ limit: 200 });
  const voidPayment = useVoidPayment();
  const exportPayments = useExportPayments();

  const payments = data?.data ?? [];
  const meta = data?.meta;
  useClampPage(setPage, page, meta?.totalPages);
  const summary = data?.summary;
  const customers = customersData?.data ?? [];

  const toggleSort = (col: string) => {
    if (sortBy === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortBy(col);
      setSortDir("desc");
    }
    setPage(1);
  };

  const handleVoid = async () => {
    if (!voidConfirm) return;
    try {
      await voidPayment.mutateAsync(voidConfirm);
      toast({ title: "Payment voided", variant: "success" });
      setVoidConfirm(null);
    } catch (err: unknown) {
      // The global toast is quiet for a closed-day refusal (the hook's meta): this one says why, once.
      toast({
        title: "Failed to void payment",
        description: dayClosedCopy(err) ?? undefined,
        variant: "error",
      });
    }
  };

  const handleExport = async () => {
    try {
      await exportPayments.mutateAsync(params);
    } catch {
      toast({ title: "Export failed", variant: "error" });
    }
  };

  // Reset page when filters change — but not on mount: page now lives in the
  // URL (useUrlPage), so a mount-time reset would clobber the ?page= just
  // restored when the operator presses Back from a payment.
  // `search` is deliberately NOT in this list: it is the raw per-keystroke value
  // here (this page never destructures useUrlSearch's debounced third element),
  // and useUrlSearch's own write already drops the page param — including it
  // would fire a history write on every keystroke to no effect.
  useResetPageOnChange(setPage, [method, status, dateFrom, dateTo, customerId]);

  // Keyboard shortcut: / to focus search
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.key === "/" &&
        !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        document.getElementById("payments-search")?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const clearFilters = () => {
    setSearch("");
    setMethod("");
    setStatus("");
    setDateFrom("");
    setDateTo("");
    setCustomerId("");
  };
  // `debouncedSearch` too: the query still carries the old text for 300 ms after the box is cleared.
  const filtered = Boolean(
    search || debouncedSearch || method || status || dateFrom || dateTo || customerId,
  );
  // No payments at all (not "no results for this filter"): one message and one action, nothing to filter.
  // Only a loaded answer of "zero in total" counts: a failed load, a page past the end and a filter are not empty.
  const trulyEmpty = !isLoading && !isError && meta?.total === 0 && !filtered;

  const emptyState = filtered ? (
    <EmptyState
      variant="invoices"
      title="No matching payments"
      description="No payments match your current search and filters."
      action={
        <Button variant="secondary" size="sm" onClick={clearFilters}>
          Clear filters
        </Button>
      }
    />
  ) : (
    <EmptyState
      variant="invoices"
      title="No payments yet"
      description="Record a payment to mark invoices as paid."
      action={
        <div className="flex flex-col items-center">
          <WriteButton size="sm" onClick={() => setShowModal(true)}>
            Record payment
          </WriteButton>
          <ReadOnlyHint />
        </div>
      }
    />
  );

  return (
    <div className="space-y-6 p-6">
      {showModal && <RecordPaymentModal onClose={() => setShowModal(false)} />}

      {/* Void confirm */}
      {voidConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-modal space-y-4">
            <h3 className="text-lg font-semibold text-navy">Void payment?</h3>
            <p className="text-sm text-navy/70">
              This will mark the payment as void and reverse its effect on the invoice. This cannot
              be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setVoidConfirm(null)}
                className="rounded-lg border border-surface-border px-4 py-2 text-sm text-navy/70 hover:bg-surface-raised"
              >
                Cancel
              </button>
              <button
                onClick={handleVoid}
                disabled={voidPayment.isPending}
                className="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white hover:bg-danger/90 disabled:opacity-50"
              >
                {voidPayment.isPending ? "Voiding…" : "Void payment"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-navy">Payments received</h2>
          <p className="hidden text-sm text-navy/70 md:block">
            All payments recorded against invoices
          </p>
        </div>
        {!trulyEmpty && (
          <div className="flex flex-col items-end">
            <WriteButton className="min-h-[44px] md:min-h-0" onClick={() => setShowModal(true)}>
              Record payment
            </WriteButton>
            <ReadOnlyHint />
          </div>
        )}
      </div>

      {/* Summary cards */}
      {summary && !(trulyEmpty && summary.advanceBalance <= 0) && (
        <div
          data-kpi-row
          className={cn(
            "flex snap-x gap-3 overflow-x-auto py-1 scrollbar-hide md:grid md:gap-4 md:overflow-visible md:py-0",
            trulyEmpty ? "md:max-w-xs md:grid-cols-1" : "md:grid-cols-3",
          )}
        >
          {!trulyEmpty && (
            <div
              data-kpi-cell
              className="w-[46%] shrink-0 snap-start rounded-xl border border-surface-border bg-white p-3 md:w-auto md:shrink md:p-4"
            >
              <p className="text-xs font-medium uppercase tracking-wide text-navy/70">
                Total received
              </p>
              <p className="mt-1 text-2xl font-bold text-success">{fmt(summary.totalReceived)}</p>
              <p className="text-xs text-navy/70 mt-0.5">
                {summary.count} {summary.count === 1 ? "payment" : "payments"}
              </p>
            </div>
          )}
          {!trulyEmpty && (
            <div
              data-kpi-cell
              className="w-[46%] shrink-0 snap-start rounded-xl border border-surface-border bg-white p-3 md:w-auto md:shrink md:p-4"
            >
              <p className="text-xs font-medium uppercase tracking-wide text-navy/70">
                Filtered Count
              </p>
              <p className="mt-1 text-2xl font-bold text-navy">{meta?.total ?? 0}</p>
              <p className="text-xs text-navy/70 mt-0.5">matching current filters</p>
            </div>
          )}
          <div
            data-kpi-cell
            className="w-[46%] shrink-0 snap-start rounded-xl border border-surface-border bg-white p-3 md:w-auto md:shrink md:p-4"
          >
            <p className="text-xs font-medium uppercase tracking-wide text-navy/70">
              Advance Balance
            </p>
            <p
              className={`mt-1 text-2xl font-bold ${summary.advanceBalance > 0 ? "text-warning" : "text-navy"}`}
            >
              {fmt(summary.advanceBalance)}
            </p>
            <p className="text-xs text-navy/70 mt-0.5">unallocated advance funds</p>
          </div>
        </div>
      )}

      {!trulyEmpty && (
        <>
          {/* Filter bar: search is always visible. Below md the other filters open from a "Filters (n)"
          button that shares a row with the sort control, one labelled full-width field per row;
          from md up it is the same inline bar (the field groups use md:contents). */}
          <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:gap-3 md:rounded-xl md:border md:border-surface-border md:bg-white md:p-4">
            <input
              id="payments-search"
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search payment #, reference, customer... (/)"
              aria-label="Search payments"
              className="h-11 w-full rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 md:h-auto md:w-64"
            />
            <FiltersDisclosure
              layout="contents"
              count={activeFilterCount({ dateFrom, dateTo, method, status, customerId })}
              toolbar={
                !isLoading && payments.length > 0 ? (
                  <div className="flex min-w-0 flex-1 items-center gap-1.5 md:hidden">
                    <div className="min-w-0 flex-1">
                      <Select
                        aria-label="Sort payments by"
                        options={[
                          { value: "paidAt", label: "Date" },
                          { value: "settledAt", label: "Bank date" },
                          { value: "paymentNumber", label: "Payment #" },
                          { value: "amount", label: "Amount" },
                        ]}
                        value={sortBy}
                        onChange={(e) => {
                          if (e.target.value !== sortBy) toggleSort(e.target.value);
                        }}
                        className="h-11"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleSort(sortBy)}
                      aria-label={sortDir === "asc" ? "Sort descending" : "Sort ascending"}
                      className="grid h-11 w-11 shrink-0 place-items-center rounded-ctl border border-surface-border bg-white text-navy hover:bg-surface-raised"
                    >
                      {sortDir === "asc" ? (
                        <ArrowUp className="h-4 w-4" />
                      ) : (
                        <ArrowDown className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                ) : undefined
              }
            >
              <div className="flex flex-col gap-2 md:contents">
                <div className="flex flex-col gap-2 md:contents">
                  <div className="flex flex-col gap-1 md:contents">
                    <label
                      htmlFor="payments-date-from"
                      className="text-xs font-medium text-navy/70 md:sr-only"
                    >
                      From
                    </label>
                    <input
                      id="payments-date-from"
                      type="date"
                      value={dateFrom}
                      onChange={(e) => setDateFrom(e.target.value)}
                      className="h-11 w-full rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 md:h-9 md:w-32"
                      title="From date"
                    />
                  </div>
                  <span className="hidden text-sm text-navy/70 md:inline">–</span>
                  <div className="flex flex-col gap-1 md:contents">
                    <label
                      htmlFor="payments-date-to"
                      className="text-xs font-medium text-navy/70 md:sr-only"
                    >
                      To
                    </label>
                    <input
                      id="payments-date-to"
                      type="date"
                      value={dateTo}
                      onChange={(e) => setDateTo(e.target.value)}
                      className="h-11 w-full rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 md:h-9 md:w-32"
                      title="To date"
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-1 md:contents">
                  <label
                    htmlFor="payments-method"
                    className="text-xs font-medium text-navy/70 md:sr-only"
                  >
                    Method
                  </label>
                  <select
                    id="payments-method"
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                    className="min-h-[44px] w-full rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 md:min-h-0 md:w-auto"
                  >
                    <option value="">All methods</option>
                    {ALL_PAYMENT_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {METHOD_LABELS[m]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1 md:contents">
                  <label
                    htmlFor="payments-status"
                    className="text-xs font-medium text-navy/70 md:sr-only"
                  >
                    Status
                  </label>
                  <select
                    id="payments-status"
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                    className="min-h-[44px] w-full rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 md:min-h-0 md:w-auto"
                  >
                    <option value="">All statuses</option>
                    <option value="PAID">Paid</option>
                    <option value="DRAFT">Draft</option>
                    <option value="VOID">Void</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1 md:contents">
                  <label
                    htmlFor="payments-customer"
                    className="text-xs font-medium text-navy/70 md:sr-only"
                  >
                    Customer
                  </label>
                  <select
                    id="payments-customer"
                    value={customerId}
                    onChange={(e) => setCustomerId(e.target.value)}
                    className="min-h-[44px] w-full rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 md:min-h-0 md:w-auto"
                  >
                    <option value="">All customers</option>
                    {customers.map((c: { id: string; businessName: string }) => (
                      <option key={c.id} value={c.id}>
                        {c.businessName}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  onClick={() => {
                    setSearch("");
                    setMethod("");
                    setStatus("");
                    setDateFrom("");
                    setDateTo("");
                    setCustomerId("");
                  }}
                  className="min-h-[44px] self-start text-sm text-navy/70 underline hover:text-navy md:min-h-0 md:self-auto"
                >
                  Clear
                </button>
                <button
                  onClick={handleExport}
                  disabled={exportPayments.isPending}
                  className="min-h-[44px] rounded-lg border border-surface-border px-3 py-2 text-sm text-navy/70 transition-colors hover:bg-surface-raised disabled:opacity-50 md:ml-auto md:min-h-0"
                >
                  {exportPayments.isPending ? "Exporting…" : "Export CSV"}
                </button>
              </div>
            </FiltersDisclosure>
          </div>
        </>
      )}

      {/* Phone cards below md; the table takes over from md up. Loading and empty keep the table
          wrapper's own states at every width. */}
      {!isLoading && payments.length > 0 && (
        <RecordCardList>
          {payments.map((p) => (
            <RecordCard
              key={p.id}
              href={`/finance/payments/${p.id}`}
              title={p.paymentNumber ?? p.reference ?? "—"}
              dimmed={p.status === "VOID"}
              amount={fmt(p.amount)}
              subtitle={p.invoice.customer?.businessName ?? "—"}
              badges={
                <>
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${METHOD_COLORS[p.method] ?? "bg-surface-raised text-navy/70"}`}
                  >
                    {METHOD_LABELS[p.method] ?? p.method}
                  </span>
                  <Badge status={(p.status ?? "PAID") as PaymentStatus} />
                </>
              }
              meta={
                <span className="flex flex-wrap gap-x-2 gap-y-0.5">
                  <span>{fmtDate(p.paidAt ?? p.createdAt)}</span>
                  {((p.reference && p.paymentNumber) || p.imageKey) && (
                    <span className="inline-flex items-center gap-1">
                      {p.imageKey && (
                        <span title="Has receipt image" className="inline-flex shrink-0">
                          <Paperclip className="h-3 w-3 text-navy/50" />
                        </span>
                      )}
                      {p.paymentNumber && p.reference}
                    </span>
                  )}
                </span>
              }
              actions={
                <>
                  <Link
                    href={`/invoices/${p.invoice.id}`}
                    aria-label={`View invoice ${p.invoice.invoiceNumber}`}
                    className="grid min-h-[44px] min-w-[44px] place-items-center rounded px-1 text-sm font-medium text-brand-600 hover:underline"
                  >
                    {p.invoice.invoiceNumber}
                  </Link>
                  {p.status !== "VOID" && (
                    <button
                      type="button"
                      aria-label={`Void payment ${p.paymentNumber ?? p.id}`}
                      onClick={() => setVoidConfirm({ invoiceId: p.invoice.id, paymentId: p.id })}
                      className="ml-2 grid min-h-[44px] min-w-[44px] place-items-center rounded px-1 text-sm font-medium text-danger hover:bg-danger-bg"
                    >
                      Void
                    </button>
                  )}
                </>
              }
            />
          ))}
        </RecordCardList>
      )}

      {/* Table */}
      <div
        className={cn(
          "overflow-hidden rounded-xl border border-surface-border bg-white",
          !isLoading && payments.length > 0 && "hidden md:block",
        )}
      >
        {isLoading || (payments.length === 0 && !isError && !trulyEmpty && !filtered) ? (
          // Loading, or a page past the end for a moment before the page number is clamped.
          <div className="flex h-64 items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-500 border-t-transparent" />
          </div>
        ) : payments.length === 0 && isError ? (
          <div role="alert" className="flex flex-col items-center gap-3 px-4 py-12 text-center">
            <p className="text-sm text-danger">Couldn&apos;t load payments.</p>
            {/* A 403 is a decision, not a hiccup (the app's retry treats it as final): no Try again. */}
            {(error as { response?: { status?: number } } | null)?.response?.status !== 403 && (
              <Button variant="secondary" size="sm" disabled={isFetching} onClick={() => refetch()}>
                {isFetching ? "Trying again…" : "Try again"}
              </Button>
            )}
          </div>
        ) : payments.length === 0 ? (
          emptyState
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-border bg-surface-raised">
                  <th
                    onClick={() => toggleSort("paidAt")}
                    className="px-4 py-3 text-left text-xs font-medium text-navy/70 cursor-pointer select-none hover:text-navy"
                  >
                    Date <SortIcon col="paidAt" sortBy={sortBy} sortDir={sortDir} />
                  </th>
                  <th
                    onClick={() => toggleSort("settledAt")}
                    title={BANK_DATE_HELP}
                    className="px-4 py-3 text-left text-xs font-medium text-navy/70 cursor-pointer select-none hover:text-navy"
                  >
                    Bank date <SortIcon col="settledAt" sortBy={sortBy} sortDir={sortDir} />
                  </th>
                  <th
                    onClick={() => toggleSort("paymentNumber")}
                    className="px-4 py-3 text-left text-xs font-medium text-navy/70 cursor-pointer select-none hover:text-navy"
                  >
                    Payment # <SortIcon col="paymentNumber" sortBy={sortBy} sortDir={sortDir} />
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">
                    Invoice(s)
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Customer</th>
                  <th
                    onClick={() => toggleSort("method")}
                    className="px-4 py-3 text-left text-xs font-medium text-navy/70 cursor-pointer select-none hover:text-navy"
                  >
                    Method <SortIcon col="method" sortBy={sortBy} sortDir={sortDir} />
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">
                    Reference
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Status</th>
                  <th
                    onClick={() => toggleSort("amount")}
                    className="px-4 py-3 text-right text-xs font-medium text-navy/70 cursor-pointer select-none hover:text-navy"
                  >
                    Amount <SortIcon col="amount" sortBy={sortBy} sortDir={sortDir} />
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-navy/70">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {payments.map((p) => (
                  <tr
                    key={p.id}
                    onClick={() => router.push(`/finance/payments/${p.id}`)}
                    className={`cursor-pointer hover:bg-surface-raised/50 transition-colors ${p.status === "VOID" ? "opacity-50" : ""}`}
                  >
                    <td className="px-4 py-3 text-navy">{fmtDate(p.paidAt ?? p.createdAt)}</td>
                    <td className="px-4 py-3 text-navy/70">
                      {p.settledAt ? fmtDate(p.settledAt) : "—"}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-navy">
                      {p.paymentNumber ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/invoices/${p.invoice.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="font-medium text-brand-600 hover:underline"
                      >
                        {p.invoice.invoiceNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-navy">
                      {p.invoice.customer?.businessName ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${METHOD_COLORS[p.method] ?? "bg-surface-raised text-navy/70"}`}
                      >
                        {METHOD_LABELS[p.method] ?? p.method}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-navy/70">
                      <div className="flex items-center gap-1.5">
                        {p.imageKey && (
                          <span title="Has receipt image" className="inline-flex shrink-0">
                            <Paperclip className="h-3.5 w-3.5 text-navy/50" />
                          </span>
                        )}
                        <span>{p.reference ?? "—"}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge status={(p.status ?? "PAID") as PaymentStatus} />
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-success">
                      {fmt(p.amount)}
                    </td>
                    <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="relative group inline-block">
                        <button className="rounded-lg border border-surface-border px-2 py-1 text-xs text-navy/70 hover:bg-surface-raised">
                          ⋮
                        </button>
                        <div className="absolute right-0 top-7 z-10 hidden group-focus-within:block bg-white border border-surface-border rounded-lg shadow-dropdown min-w-[140px] py-1">
                          <button
                            onClick={() => router.push(`/finance/payments/${p.id}`)}
                            className="block w-full px-3 py-1.5 text-left text-sm hover:bg-surface-raised"
                          >
                            View receipt
                          </button>
                          <Link
                            href={`/invoices/${p.invoice.id}`}
                            className="block px-3 py-1.5 text-sm hover:bg-surface-raised"
                          >
                            View invoice
                          </Link>
                          {p.status !== "VOID" && (
                            <button
                              onClick={() =>
                                setVoidConfirm({ invoiceId: p.invoice.id, paymentId: p.id })
                              }
                              className="block w-full px-3 py-1.5 text-left text-sm text-danger hover:bg-danger-bg"
                            >
                              Void
                            </button>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-navy/70">
            Page {meta.page} of {meta.totalPages} · {meta.total}{" "}
            {meta.total === 1 ? "payment" : "payments"}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="rounded-lg border border-surface-border px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-surface-raised"
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
              disabled={page === meta.totalPages}
              className="rounded-lg border border-surface-border px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-surface-raised"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
