"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, Eye, Calendar, X, Loader2, Search, ShieldCheck } from "lucide-react";
import { PageHeader, Button, cn, Modal, useToast, EmptyState, Badge } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import {
  useCreditNotes,
  useCreateCreditNote,
  openCreditBalance,
  type CreditNote,
} from "@/lib/api/credit-notes";
import { useCustomers } from "@/lib/api/customers";
import { useInvoices, useInvoice } from "@/lib/api/invoices";
import { fmt } from "@/lib/formatting";
import { roundMoney } from "@/lib/pricing";
import { useUrlSearch } from "@/lib/hooks/useUrlSearch";
import { useUrlPage, useClampPage } from "@/lib/hooks/useUrlPage";

// P5-13: canonical open-credit predicate — not VOID, has a positive remaining
// balance (amount - amountUsed), and is not expired. Mirrors the API's
// `Σ roundMoney(amount − amountUsed)` — a partially-applied note must never be
// counted at its full original amount.
function isOpenCredit(cn: CreditNote): boolean {
  if (cn.status === "VOID") return false;
  const remaining = roundMoney(Number(cn.amount) - Number(cn.amountUsed ?? 0));
  if (!(remaining > 0.001)) return false;
  if (cn.expiresAt && new Date(cn.expiresAt).getTime() <= Date.now()) return false;
  return true;
}

// ─── Status filter chips (real statuses) ──────────────────────────────────────

const STATUS_CHIPS: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "DRAFT", label: "Draft" },
  { value: "ISSUED", label: "Issued" },
  { value: "APPLIED", label: "Applied" },
  { value: "VOID", label: "Void" },
];

// ─── Create Credit Note modal ─────────────────────────────────────────────────

interface CreateFormState {
  customerId: string;
  invoiceId: string;
  amount: string;
  reason: string;
  /** P5-13: optional — after this date the credit is excluded from the wallet
   *  and can never be applied. */
  expiresAt: string;
}

const EMPTY_FORM: CreateFormState = {
  customerId: "",
  invoiceId: "",
  amount: "",
  reason: "",
  expiresAt: "",
};

/** Selected-customer chip for the debounced search combobox below — mirrors the
 *  pattern in orders/_components/CreateOrderModal.tsx (only the fields this form needs). */
interface SelectedCustomer {
  id: string;
  businessName: string;
  contactName?: string;
}

/** Hidden from the invoice picker. Everything else — including a fully-PAID invoice —
 *  stays selectable; the service's cumulative per-invoice credit cap (enforced on
 *  apply, not here) is what prevents over-crediting. */
const HIDDEN_INVOICE_STATUSES = new Set(["VOID", "WRITTEN_OFF"]);

function CreateCreditNoteModal({
  isOpen,
  onClose,
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (id: string) => void;
}) {
  const { toast } = useToast();
  const createCreditNote = useCreateCreditNote();
  const [form, setForm] = React.useState<CreateFormState>(EMPTY_FORM);
  const [errors, setErrors] = React.useState<Partial<Record<keyof CreateFormState, string>>>({});
  const [customerSearch, setCustomerSearch] = React.useState("");
  const [debouncedCustomerSearch, setDebouncedCustomerSearch] = React.useState("");
  const [selectedCustomer, setSelectedCustomer] = React.useState<SelectedCustomer | null>(null);
  // Line linkage: which invoice lines this credit applies to (drives the regulated
  // ledger reversal). Keyed by invoiceItemId. Empty selection => lump-sum credit.
  const [lineSel, setLineSel] = React.useState<Record<string, boolean>>({});
  const [lineAmt, setLineAmt] = React.useState<Record<string, string>>({});

  // Debounce customer search (300ms) — same pattern as CreateOrderModal's combobox.
  // Without this, every keystroke minted a fresh query key, `data` went undefined
  // mid-flight, and the dropdown collapsed to just its placeholder while typing.
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedCustomerSearch(customerSearch), 300);
    return () => clearTimeout(t);
  }, [customerSearch]);

  // Explicit limit: with none, the API's default limit=20 silently capped this
  // dropdown to the 20 most-recently-created customers regardless of what matched.
  const { data: customersData } = useCustomers({
    search: debouncedCustomerSearch || undefined,
    limit: 50,
  });
  const filteredCustomers = React.useMemo(() => {
    if (!debouncedCustomerSearch) return [];
    return (customersData?.data ?? []).slice(0, 8);
  }, [customersData, debouncedCustomerSearch]);

  // Server-side customerId filter (ListInvoicesDto supports it) instead of fetching
  // the newest 100 invoices tenant-wide and filtering client-side — that could leave
  // a customer's own invoices entirely off the list. No status restriction beyond
  // VOID/WRITTEN_OFF: a fully-paid invoice must stay selectable.
  const { data: invoicesData } = useInvoices(
    form.customerId ? { customerId: form.customerId, limit: 100 } : undefined,
  );
  const invoices = React.useMemo(() => {
    if (!form.customerId) return [];
    return (invoicesData?.data ?? []).filter((inv) => !HIDDEN_INVOICE_STATUSES.has(inv.status));
  }, [invoicesData, form.customerId]);

  // The selected invoice's lines (for the line picker).
  const { data: invoiceDetail } = useInvoice(form.invoiceId);
  const invoiceItems = React.useMemo(
    () => (form.invoiceId ? (invoiceDetail?.items ?? []) : []),
    [invoiceDetail, form.invoiceId],
  );
  const selectedLines = invoiceItems.filter((it) => lineSel[it.id]);
  const hasLineSelection = selectedLines.length > 0;
  const linesTotal = React.useMemo(
    () => selectedLines.reduce((s, it) => s + (parseFloat(lineAmt[it.id] ?? "") || 0), 0),
    [selectedLines, lineAmt],
  );

  React.useEffect(() => {
    if (isOpen) {
      setForm(EMPTY_FORM);
      setErrors({});
      setCustomerSearch("");
      setDebouncedCustomerSearch("");
      setSelectedCustomer(null);
      setLineSel({});
      setLineAmt({});
    }
  }, [isOpen]);

  // Reset line selection whenever the chosen invoice changes; prefill each line's
  // credit amount with its full subtotal.
  React.useEffect(() => {
    setLineSel({});
    setLineAmt(
      Object.fromEntries(invoiceItems.map((it) => [it.id, String(Number(it.subtotal ?? 0))])),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.invoiceId, invoiceItems.length]);

  function validate() {
    const e: Partial<Record<keyof CreateFormState, string>> = {};
    if (!form.customerId) e.customerId = "Customer is required.";
    if (hasLineSelection) {
      for (const it of selectedLines) {
        const a = parseFloat(lineAmt[it.id] ?? "");
        if (isNaN(a) || a <= 0) {
          e.amount = "Each selected line needs an amount greater than 0.";
          break;
        }
        if (a > Number(it.subtotal ?? 0) + 0.001) {
          e.amount = "A line credit can't exceed its line total.";
          break;
        }
      }
    } else {
      const amt = parseFloat(form.amount);
      if (!form.amount || isNaN(amt) || amt <= 0) e.amount = "Enter an amount greater than 0.";
    }
    if (!form.reason.trim()) e.reason = "Reason is required.";
    if (form.expiresAt) {
      const d = new Date(form.expiresAt);
      if (isNaN(d.getTime()) || d.getTime() <= Date.now()) {
        e.expiresAt = "Expiry date must be in the future.";
      }
    }
    return e;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    setErrors({});

    const amount = hasLineSelection ? Number(linesTotal.toFixed(2)) : parseFloat(form.amount);
    createCreditNote.mutate(
      {
        customerId: form.customerId,
        invoiceId: form.invoiceId || undefined,
        amount,
        items: hasLineSelection
          ? selectedLines.map((it) => ({
              invoiceItemId: it.id,
              amount: Number((parseFloat(lineAmt[it.id] ?? "0") || 0).toFixed(2)),
            }))
          : undefined,
        reason: form.reason.trim(),
        // issueDate/notes are deliberately NOT sent: they have no CreditNote columns and
        // the server only tolerates them so in-flight old bundles don't 400. Sending them
        // from new code would keep that deprecation alive forever.
        expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : undefined,
      },
      {
        onSuccess: (cn) => {
          toast({
            title: "Credit note created",
            description: cn.creditNoteNumber,
            variant: "success",
          });
          onClose();
          onSuccess(cn.id);
        },
        onError: () => {
          toast({
            title: "Failed to create credit note",
            description: "Please try again.",
            variant: "error",
          });
        },
      },
    );
  }

  const inputCls = (err?: string) =>
    cn(
      "h-10 w-full rounded-lg border bg-white px-3 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
      err ? "border-danger" : "border-surface-border",
    );

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="New Credit Note"
      description="Issue a credit note against an invoice or directly to a customer."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={createCreditNote.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="create-cn-form" loading={createCreditNote.isPending}>
            Create Credit Note
          </Button>
        </>
      }
    >
      <form id="create-cn-form" onSubmit={handleSubmit} noValidate className="space-y-4">
        {/* Customer — debounced search combobox (CreateOrderModal pattern). Typing
            300ms-debounces into an explicit-limit useCustomers query instead of racing
            an unbounded default (which silently capped results to the 20 most-recently-
            created customers) with no debounce (which raced every keystroke). */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Customer</label>
          {selectedCustomer ? (
            <div className="flex items-center justify-between rounded-lg border border-brand-300 bg-brand-50 px-3 py-2.5">
              <div>
                <span className="text-sm font-medium text-navy">
                  {selectedCustomer.businessName}
                </span>
                {selectedCustomer.contactName && (
                  <span className="ml-2 text-xs text-navy/70">{selectedCustomer.contactName}</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelectedCustomer(null);
                  setForm((f) => ({ ...f, customerId: "", invoiceId: "" }));
                }}
                className="rounded p-1 text-navy/70 hover:text-danger transition-colors"
                title="Change customer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-navy/30" />
              <input
                type="search"
                placeholder="Search by business name…"
                value={customerSearch}
                onChange={(e) => {
                  setCustomerSearch(e.target.value);
                  setErrors((er) => ({ ...er, customerId: undefined }));
                }}
                onKeyDown={(e) => {
                  // This input lives inside the form — Enter must search, not submit.
                  if (e.key === "Enter") e.preventDefault();
                }}
                className={cn(
                  "h-10 w-full rounded-lg border bg-white pl-9 pr-3 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
                  errors.customerId ? "border-danger" : "border-surface-border",
                )}
              />
              {customerSearch &&
                (filteredCustomers.length > 0 || debouncedCustomerSearch.length > 0) && (
                  <ul className="absolute left-0 right-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-lg border border-surface-border bg-white shadow-dropdown">
                    {filteredCustomers.length === 0 && debouncedCustomerSearch.length > 0 && (
                      <li className="px-3 py-2 text-sm text-navy/70">No customers found.</li>
                    )}
                    {filteredCustomers.map(
                      (c: { id: string; businessName: string; contactName?: string }) => (
                        <li key={c.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedCustomer(c);
                              setForm((f) => ({ ...f, customerId: c.id, invoiceId: "" }));
                              setCustomerSearch("");
                              setDebouncedCustomerSearch("");
                            }}
                            className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-navy hover:bg-surface-raised"
                          >
                            <span className="font-medium">{c.businessName}</span>
                            {c.contactName && (
                              <span className="text-xs text-navy/70">{c.contactName}</span>
                            )}
                          </button>
                        </li>
                      ),
                    )}
                  </ul>
                )}
            </div>
          )}
          {errors.customerId && <p className="mt-1 text-xs text-danger">{errors.customerId}</p>}
        </div>

        {/* Invoice (optional) — server-filtered by customerId, any non-VOID/WRITTEN_OFF
            status selectable (including PAID); the per-invoice credit cap is enforced
            server-side when the credit is applied, not gated here. */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">
            Invoice # <span className="text-navy/70">(optional)</span>
          </label>
          <select
            value={form.invoiceId}
            onChange={(e) => setForm((f) => ({ ...f, invoiceId: e.target.value }))}
            disabled={!form.customerId}
            className={cn(inputCls(), "disabled:opacity-50")}
          >
            <option value="">None</option>
            {invoices.map((inv) => (
              <option key={inv.id} value={inv.id}>
                {inv.invoiceNumber} · {inv.status}
              </option>
            ))}
          </select>
        </div>

        {/* Line picker — attribute the credit to specific invoice lines. Selecting a
            regulated line reverses its category tax in the regulated ledger. */}
        {form.invoiceId && invoiceItems.length > 0 && (
          <div className="rounded-lg border border-surface-border bg-surface-raised/40 p-3">
            <div className="mb-2 flex items-center justify-between">
              <label className="text-sm font-medium text-navy/80">Credit specific lines</label>
              <span className="text-xs text-navy/60">
                {hasLineSelection ? `${selectedLines.length} selected` : "optional"}
              </span>
            </div>
            <div className="space-y-1.5">
              {invoiceItems.map((it) => {
                const checked = !!lineSel[it.id];
                const regulated = !!it.trackedCategoryId;
                return (
                  <div
                    key={it.id}
                    className={cn(
                      "flex items-center gap-2 rounded-md border px-2.5 py-2",
                      checked ? "border-brand-500 bg-white" : "border-surface-border bg-white/60",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => setLineSel((s) => ({ ...s, [it.id]: e.target.checked }))}
                      className="h-4 w-4 rounded border-surface-border text-brand-500 focus:ring-brand-500"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm text-navy">{it.description}</span>
                        {regulated && (
                          <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-accent-deep/10 px-1.5 py-0.5 text-[10px] font-medium text-accent-deep">
                            <ShieldCheck className="h-3 w-3" /> Regulated
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-navy/50">
                        {Number(it.qty)} × · line {fmt(Number(it.subtotal ?? 0))}
                      </span>
                    </div>
                    <div className="relative w-24 flex-shrink-0">
                      <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-navy/40">
                        $
                      </span>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        disabled={!checked}
                        value={lineAmt[it.id] ?? ""}
                        onChange={(e) => setLineAmt((a) => ({ ...a, [it.id]: e.target.value }))}
                        className="h-8 w-full rounded-md border border-surface-border bg-white pl-5 pr-2 text-right text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            {hasLineSelection && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-navy/60">
                <ShieldCheck className="h-3.5 w-3.5 flex-shrink-0 text-accent-deep" />
                Credits on regulated lines reverse category tax and post to the category ledger.
              </p>
            )}
          </div>
        )}

        {/* Amount — derived from selected lines, or a free lump sum when none are picked. */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Amount ($)</label>
          {hasLineSelection ? (
            <div className="flex h-10 w-full items-center justify-between rounded-lg border border-surface-border bg-surface-raised px-3 text-sm">
              <span className="text-navy/60">
                Sum of {selectedLines.length} selected line{selectedLines.length === 1 ? "" : "s"}
              </span>
              <span className="money font-semibold text-navy">{fmt(linesTotal)}</span>
            </div>
          ) : (
            <input
              type="number"
              step="0.01"
              min="0.01"
              placeholder="0.00"
              value={form.amount}
              onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
              className={inputCls(errors.amount)}
            />
          )}
          {errors.amount && <p className="mt-1 text-xs text-danger">{errors.amount}</p>}
        </div>

        {/* Reason */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Reason</label>
          <textarea
            rows={3}
            placeholder="Reason for credit note…"
            value={form.reason}
            onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
            className={cn(
              "w-full resize-none rounded-lg border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
              errors.reason ? "border-danger" : "border-surface-border",
            )}
          />
          {errors.reason && <p className="mt-1 text-xs text-danger">{errors.reason}</p>}
        </div>

        {/* Expires (optional) */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">
            Expires <span className="text-navy/70">(optional)</span>
          </label>
          <input
            type="date"
            min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)}
            value={form.expiresAt}
            onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))}
            className={inputCls(errors.expiresAt)}
          />
          {errors.expiresAt && <p className="mt-1 text-xs text-danger">{errors.expiresAt}</p>}
          <p className="mt-1 text-xs text-navy/60">
            After this date the credit is excluded from the wallet and can no longer be applied.
          </p>
        </div>
      </form>
    </Modal>
  );
}

// ─── Stat card (Ledger idiom: overline · value · hint) ─────────────────────────

function StatTile({
  label,
  value,
  hint,
  money,
}: {
  label: string;
  value: string;
  hint: string;
  money?: boolean;
}) {
  return (
    <div className="rounded-lg border border-surface-border bg-white p-4 shadow-card">
      <span className="overline block">{label}</span>
      <span
        className={cn(
          "mt-1.5 block text-2xl text-navy",
          money ? "money" : "font-semibold tracking-[-0.02em]",
        )}
      >
        {value}
      </span>
      <span className="mt-1 block text-xs text-navy/70">{hint}</span>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CreditNotesPage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  React.useEffect(() => {
    setTitle("Credit Notes");
  }, [setTitle]);

  const [statusFilter, setStatusFilter] = React.useState("");
  const [search, setSearch, debouncedSearch] = useUrlSearch();
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [page, setPage] = useUrlPage();
  const [limit, setLimit] = React.useState(20);
  const [isCreateOpen, setIsCreateOpen] = React.useState(false);

  const { data, isLoading, isError } = useCreditNotes({
    status: statusFilter || undefined,
    search: debouncedSearch || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    page,
    limit,
  });

  const creditNotes = data?.data ?? [];
  const meta = data?.meta;
  useClampPage(setPage, page, meta?.totalPages);

  const { data: allData } = useCreditNotes({ limit: 999 });
  const all = allData?.data ?? [];

  const kpiCounts = React.useMemo(() => {
    const counts = { total: all.length, draft: 0, issued: 0, applied: 0, void: 0 };
    for (const cn of all) {
      if (cn.status === "DRAFT") counts.draft++;
      if (cn.status === "ISSUED") counts.issued++;
      if (cn.status === "APPLIED") counts.applied++;
      if (cn.status === "VOID") counts.void++;
    }
    return counts;
  }, [all]);

  // Stat tiles — derived from real data only (no fabricated revenue %).
  const stats = React.useMemo(() => {
    // Open credit: canonical predicate (not VOID, remaining > 0, not expired) —
    // summed by REMAINING balance so a partially-applied note is never double-counted.
    const openNotes = all.filter(isOpenCredit);
    const openCredit = openNotes.reduce(
      (s, cn) => roundMoney(s + roundMoney(Number(cn.amount) - Number(cn.amountUsed ?? 0))),
      0,
    );

    // Issued in the last 30 days (by issue date).
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const issued30 = all.filter((cn) => {
      if (cn.status === "VOID") return false;
      const d = new Date((cn as any).issueDate ?? cn.createdAt);
      return !isNaN(d.getTime()) && d >= cutoff;
    });
    const issued30Value = issued30.reduce((s, cn) => s + Number(cn.amount), 0);

    // Top reason by credited value (non-void).
    const byReason = new Map<string, number>();
    let creditedTotal = 0;
    for (const cn of all) {
      if (cn.status === "VOID") continue;
      const reason = (cn.reason || "—").trim() || "—";
      const amt = Number(cn.amount);
      byReason.set(reason, (byReason.get(reason) ?? 0) + amt);
      creditedTotal += amt;
    }
    let topReason = "—";
    let topReasonValue = 0;
    byReason.forEach((amt, reason) => {
      if (amt > topReasonValue) {
        topReason = reason;
        topReasonValue = amt;
      }
    });
    const topReasonPct = creditedTotal > 0 ? Math.round((topReasonValue / creditedTotal) * 100) : 0;

    return {
      openCredit,
      openCount: openNotes.length,
      issued30Value,
      issued30Count: issued30.length,
      topReason,
      topReasonPct,
    };
  }, [all]);

  const totalPages = meta?.totalPages ?? 1;
  const hasActiveFilters = !!(search || statusFilter || dateFrom || dateTo);

  function clearFilters() {
    setSearch("");
    setStatusFilter("");
    setDateFrom("");
    setDateTo("");
    setPage(1);
  }

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Credit Notes"
        subtitle="Issued from returns, disputes and manual adjustments, applied against invoices automatically."
        action={
          <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => setIsCreateOpen(true)}>
            New Credit Note
          </Button>
        }
      />

      {/* Stat tiles */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile
          label="Open Credit"
          value={fmt(stats.openCredit)}
          hint={`${stats.openCount} ${stats.openCount === 1 ? "note" : "notes"} with remaining balance`}
          money
        />
        <StatTile
          label="Issued, 30d"
          value={fmt(stats.issued30Value)}
          hint={`${stats.issued30Count} ${stats.issued30Count === 1 ? "note" : "notes"} in the last 30 days`}
          money
        />
        <StatTile
          label="Top Reason"
          value={stats.topReason}
          hint={
            stats.topReasonPct > 0
              ? `${stats.topReasonPct}% of credited value`
              : "No credited value yet"
          }
        />
      </div>

      {/* Filter + table card */}
      <div className="rounded-lg border border-surface-border bg-white shadow-card">
        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-2.5 border-b border-surface-border px-4 py-3">
          {STATUS_CHIPS.map((chip) => {
            const count =
              chip.value === ""
                ? kpiCounts.total
                : chip.value === "DRAFT"
                  ? kpiCounts.draft
                  : chip.value === "ISSUED"
                    ? kpiCounts.issued
                    : chip.value === "APPLIED"
                      ? kpiCounts.applied
                      : kpiCounts.void;
            const showCount =
              chip.value === "" || chip.value === "DRAFT" || chip.value === "ISSUED";
            return (
              <button
                key={chip.value || "all"}
                onClick={() => {
                  setStatusFilter(chip.value);
                  setPage(1);
                }}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium whitespace-nowrap transition-colors",
                  statusFilter === chip.value
                    ? "border-navy bg-navy text-white"
                    : "border-surface-border bg-white text-navy hover:bg-surface-raised",
                )}
              >
                {chip.label}
                {showCount && count > 0 && (
                  <span
                    className={cn(
                      "font-mono text-[11px]",
                      statusFilter === chip.value ? "text-white/60" : "text-navy/40",
                    )}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}

          {/* Date range */}
          <div className="ml-auto flex items-center gap-1.5">
            <Calendar className="h-4 w-4 text-navy/70" />
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => {
                setDateFrom(e.target.value);
                setPage(1);
              }}
              className="h-8 rounded-lg border border-surface-border bg-white px-2 text-xs text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              title="Issue date from"
            />
            <span className="text-navy/70">–</span>
            <input
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(e) => {
                setDateTo(e.target.value);
                setPage(1);
              }}
              className="h-8 rounded-lg border border-surface-border bg-white px-2 text-xs text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              title="Issue date to"
            />
            {(dateFrom || dateTo) && (
              <button
                onClick={() => {
                  setDateFrom("");
                  setDateTo("");
                  setPage(1);
                }}
                className="rounded p-1.5 text-navy/70 hover:text-danger transition-colors"
                title="Clear dates"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Search */}
          <div className="relative w-full sm:w-56">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-navy/40" />
            <input
              type="search"
              placeholder="CN #, customer or invoice…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="h-8 w-full rounded-lg border border-surface-border bg-white pl-8 pr-3 text-xs text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-surface-border bg-surface-raised">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">
                  Credit Note
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Customer</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Source</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-navy/70">Amount</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Applied To</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Status</th>
                <th className="w-10 px-3 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border bg-white">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-navy/70" />
                  </td>
                </tr>
              ) : isError ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-sm text-danger">
                    Failed to load credit notes. Please try again.
                  </td>
                </tr>
              ) : creditNotes.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-0">
                    {hasActiveFilters ? (
                      <EmptyState
                        variant="invoices"
                        title="No matching credit notes"
                        description="No credit notes match your current search and filters."
                        action={
                          <Button variant="secondary" size="sm" onClick={clearFilters}>
                            Clear filters
                          </Button>
                        }
                      />
                    ) : (
                      <EmptyState
                        variant="invoices"
                        title="No credit notes yet"
                        description="Issue a credit note to refund or adjust a customer's balance."
                        action={
                          <Button size="sm" onClick={() => setIsCreateOpen(true)}>
                            New credit note
                          </Button>
                        }
                      />
                    )}
                  </td>
                </tr>
              ) : (
                creditNotes.map((cn: CreditNote) => (
                  <tr
                    key={cn.id}
                    onClick={() => router.push(`/credit-notes/${cn.id}`)}
                    className="cursor-pointer transition-colors hover:bg-surface-raised"
                  >
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-navy">
                      {cn.creditNoteNumber}
                    </td>
                    <td className="px-4 py-3 font-medium text-navy">
                      {cn.customer?.businessName ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-navy/70">
                      <span className="line-clamp-1">{cn.reason || "—"}</span>
                    </td>
                    <td className="px-4 py-3 text-right money text-navy">
                      {fmt(Number(cn.amount))}
                      {/* A partially-applied note stays ISSUED — the face
                          amount alone reads as "untouched". */}
                      {Number(cn.amountUsed ?? 0) > 0 && openCreditBalance(cn) > 0 ? (
                        <span className="block text-xs font-semibold text-brand-600">
                          {fmt(openCreditBalance(cn))} left
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      {cn.invoiceId ? (
                        <span className="font-mono text-xs text-brand-600">{cn.invoiceId}</span>
                      ) : (
                        <span className="text-xs text-navy/40">next invoice (auto)</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge status={cn.status} />
                    </td>
                    <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      <button
                        title="View credit note"
                        onClick={() => router.push(`/credit-notes/${cn.id}`)}
                        className="rounded p-1.5 text-navy/70 hover:bg-surface-raised hover:text-navy transition-colors"
                      >
                        <Eye className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Compliance note + count */}
        <div className="flex items-center gap-2.5 border-t border-surface-border px-4 py-3">
          <ShieldCheck className="h-3.5 w-3.5 flex-shrink-0 text-accent-deep" />
          <span className="text-xs text-navy/70">
            Credits on regulated lines reverse category tax and post to the category ledger.
          </span>
          {meta && (
            <span className="ml-auto text-xs text-navy/70">
              {meta.total > 0
                ? `Showing ${(page - 1) * limit + 1}–${Math.min(page * limit, meta.total)} of ${meta.total}`
                : "Showing 0 of 0"}
            </span>
          )}
        </div>
      </div>

      {/* Pagination */}
      {meta && (
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <p className="text-sm text-navy/70">
              {meta.total > 0
                ? `Showing ${(page - 1) * limit + 1}–${Math.min(page * limit, meta.total)} of ${meta.total} credit notes`
                : "No credit notes found"}
            </p>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-navy/70">Per page:</span>
              <select
                value={limit}
                onChange={(e) => {
                  setLimit(Number(e.target.value));
                  setPage(1);
                }}
                className="h-8 rounded-lg border border-surface-border bg-white px-2 text-xs text-navy focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                {[10, 20, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {meta.totalPages > 1 && (
            <div className="flex items-center gap-1">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="rounded border border-surface-border bg-white px-3 py-1.5 text-sm font-medium text-navy hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Previous
              </button>
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                const p = totalPages <= 7 ? i + 1 : page <= 4 ? i + 1 : page + i - 3;
                if (p < 1 || p > totalPages) return null;
                return (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    className={cn(
                      "rounded border px-3 py-1.5 text-sm font-medium transition-colors",
                      p === page
                        ? "border-brand-500 bg-brand-500 text-white"
                        : "border-surface-border bg-white text-navy hover:bg-surface-raised",
                    )}
                  >
                    {p}
                  </button>
                );
              })}
              <button
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="rounded border border-surface-border bg-white px-3 py-1.5 text-sm font-medium text-navy hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}

      {/* Create modal */}
      <CreateCreditNoteModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onSuccess={(id) => router.push(`/credit-notes/${id}`)}
      />
    </div>
  );
}
