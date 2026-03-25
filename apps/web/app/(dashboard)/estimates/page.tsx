"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  Eye,
  Calendar,
  X,
  Loader2,
  FileText,
  Trash2,
  Search,
} from "lucide-react";
import { PageHeader, Button, Select, cn, Modal, useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import {
  useEstimates,
  useCreateEstimate,
  type Estimate,
  type EstimateStatus,
  type CreateEstimateItem,
} from "@/lib/api/estimates";
import { useCustomers } from "@/lib/api/customers";
import { useProducts } from "@/lib/api/products";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function fmtDate(d?: string | null) {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<EstimateStatus, string> = {
  DRAFT: "bg-gray-100 text-gray-600",
  SENT: "bg-blue-100 text-blue-700",
  ACCEPTED: "bg-green-100 text-green-700",
  DECLINED: "bg-red-100 text-red-600",
  EXPIRED: "bg-orange-100 text-orange-700",
};

function EstimateStatusBadge({ status }: { status: EstimateStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
        STATUS_COLORS[status],
      )}
    >
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}

// ─── KPI chip ─────────────────────────────────────────────────────────────────

function KpiChip({
  label,
  value,
  danger,
  onClick,
  active,
}: {
  label: string;
  value: number;
  danger?: boolean;
  onClick: () => void;
  active: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-medium transition-colors",
        active
          ? "border-brand-500 bg-brand-500 text-white"
          : danger && value > 0
          ? "border-red-200 bg-red-50 text-red-700 hover:border-red-300"
          : "border-surface-border bg-white text-navy hover:bg-surface-raised",
      )}
    >
      <span>{label}</span>
      <span
        className={cn(
          "flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1 text-xs font-bold",
          active
            ? "bg-white/20 text-white"
            : danger && value > 0
            ? "bg-red-200 text-red-700"
            : "bg-surface-raised text-navy/60",
        )}
      >
        {value}
      </span>
    </button>
  );
}

// ─── Status filter options ────────────────────────────────────────────────────

const STATUS_OPTIONS = [
  { value: "", label: "All Statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "SENT", label: "Sent" },
  { value: "ACCEPTED", label: "Accepted" },
  { value: "DECLINED", label: "Declined" },
  { value: "EXPIRED", label: "Expired" },
];

// ─── Line item row ────────────────────────────────────────────────────────────

interface LineItem {
  key: string;
  productId: string;
  description: string;
  qty: string;
  unitPrice: string;
}

function newLineItem(): LineItem {
  return {
    key: Math.random().toString(36).slice(2),
    productId: "",
    description: "",
    qty: "1",
    unitPrice: "",
  };
}

// ─── Create Estimate modal ────────────────────────────────────────────────────

interface CreateFormState {
  customerId: string;
  issueDate: string;
  expiryDate: string;
  notes: string;
}

function defaultExpiryDate() {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().slice(0, 10);
}

const EMPTY_FORM: CreateFormState = {
  customerId: "",
  issueDate: new Date().toISOString().slice(0, 10),
  expiryDate: defaultExpiryDate(),
  notes: "",
};

function CreateEstimateModal({
  isOpen,
  onClose,
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (id: string) => void;
}) {
  const { toast } = useToast();
  const createEstimate = useCreateEstimate();
  const [form, setForm] = React.useState<CreateFormState>(EMPTY_FORM);
  const [items, setItems] = React.useState<LineItem[]>([newLineItem()]);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [customerSearch, setCustomerSearch] = React.useState("");
  const [productSearch, setProductSearch] = React.useState("");

  const { data: customersData } = useCustomers({ search: customerSearch || undefined });
  const customers = customersData?.data ?? (Array.isArray(customersData) ? customersData : []);

  const { data: productsData } = useProducts({ search: productSearch || undefined });
  const products = productsData?.data ?? (Array.isArray(productsData) ? productsData : []);

  React.useEffect(() => {
    if (isOpen) {
      setForm({ ...EMPTY_FORM, expiryDate: defaultExpiryDate() });
      setItems([newLineItem()]);
      setErrors({});
      setCustomerSearch("");
      setProductSearch("");
    }
  }, [isOpen]);

  function handleProductSelect(itemKey: string, productId: string) {
    const product = products.find((p: { id: string; name: string; price?: number }) => p.id === productId);
    setItems((prev) =>
      prev.map((it) =>
        it.key === itemKey
          ? {
              ...it,
              productId,
              description: product?.name ?? it.description,
              unitPrice: product?.price != null ? String(product.price) : it.unitPrice,
            }
          : it,
      ),
    );
  }

  function updateItem(key: string, field: keyof LineItem, value: string) {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, [field]: value } : it)));
  }

  function addItem() {
    setItems((prev) => [...prev, newLineItem()]);
  }

  function removeItem(key: string) {
    setItems((prev) => prev.filter((it) => it.key !== key));
  }

  const subtotal = items.reduce((sum, it) => {
    const qty = parseFloat(it.qty) || 0;
    const up = parseFloat(it.unitPrice) || 0;
    return sum + qty * up;
  }, 0);

  function validate() {
    const e: Record<string, string> = {};
    if (!form.customerId) e.customerId = "Customer is required.";
    if (!form.issueDate) e.issueDate = "Issue date is required.";
    if (!form.expiryDate) e.expiryDate = "Expiry date is required.";
    if (items.length === 0) e.items = "Add at least one line item.";
    items.forEach((it, idx) => {
      if (!it.description.trim()) e[`item_${idx}_desc`] = "Description required.";
      const qty = parseFloat(it.qty);
      if (isNaN(qty) || qty <= 0) e[`item_${idx}_qty`] = "Invalid qty.";
      const up = parseFloat(it.unitPrice);
      if (isNaN(up) || up < 0) e[`item_${idx}_up`] = "Invalid price.";
    });
    return e;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }
    setErrors({});

    const dto = {
      customerId: form.customerId,
      issueDate: form.issueDate,
      expiryDate: form.expiryDate,
      notes: form.notes.trim() || undefined,
      items: items.map(
        (it): CreateEstimateItem => ({
          productId: it.productId || undefined,
          description: it.description.trim(),
          qty: parseFloat(it.qty),
          unitPrice: parseFloat(it.unitPrice),
        }),
      ),
    };

    createEstimate.mutate(dto, {
      onSuccess: (est) => {
        toast({ title: "Estimate created", description: est.estimateNumber, variant: "success" });
        onClose();
        onSuccess(est.id);
      },
      onError: () => {
        toast({ title: "Failed to create estimate", description: "Please try again.", variant: "error" });
      },
    });
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
      title="New Estimate"
      description="Create an estimate for a customer with line items."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={createEstimate.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="create-estimate-form" loading={createEstimate.isPending}>
            Create Estimate
          </Button>
        </>
      }
    >
      <form id="create-estimate-form" onSubmit={handleSubmit} noValidate className="space-y-5">
        {/* Customer */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Customer</label>
          <div className="relative mb-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-navy/30" />
            <input
              type="search"
              placeholder="Search customers…"
              value={customerSearch}
              onChange={(e) => setCustomerSearch(e.target.value)}
              className="h-10 w-full rounded-lg border border-surface-border bg-white pl-9 pr-3 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <select
            value={form.customerId}
            onChange={(e) => setForm((f) => ({ ...f, customerId: e.target.value }))}
            className={inputCls(errors.customerId)}
          >
            <option value="">Select customer…</option>
            {customers.map((c: { id: string; businessName: string }) => (
              <option key={c.id} value={c.id}>{c.businessName}</option>
            ))}
          </select>
          {errors.customerId && <p className="mt-1 text-xs text-danger">{errors.customerId}</p>}
        </div>

        {/* Dates */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-navy/80">Issue Date</label>
            <input
              type="date"
              value={form.issueDate}
              onChange={(e) => setForm((f) => ({ ...f, issueDate: e.target.value }))}
              className={inputCls(errors.issueDate)}
            />
            {errors.issueDate && <p className="mt-1 text-xs text-danger">{errors.issueDate}</p>}
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-navy/80">Expiry Date</label>
            <input
              type="date"
              value={form.expiryDate}
              min={form.issueDate || undefined}
              onChange={(e) => setForm((f) => ({ ...f, expiryDate: e.target.value }))}
              className={inputCls(errors.expiryDate)}
            />
            {errors.expiryDate && <p className="mt-1 text-xs text-danger">{errors.expiryDate}</p>}
          </div>
        </div>

        {/* Line items */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-sm font-medium text-navy/80">Line Items</label>
            <div className="relative w-40">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-navy/30" />
              <input
                type="search"
                placeholder="Search products…"
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                className="h-8 w-full rounded border border-surface-border bg-white pl-7 pr-2 text-xs text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          </div>

          {errors.items && <p className="mb-2 text-xs text-danger">{errors.items}</p>}

          <div className="space-y-3 rounded-lg border border-surface-border p-3">
            {items.map((item, idx) => (
              <div key={item.key} className="grid grid-cols-12 gap-2">
                {/* Product selector */}
                <div className="col-span-4">
                  <select
                    value={item.productId}
                    onChange={(e) => handleProductSelect(item.key, e.target.value)}
                    className="h-9 w-full rounded border border-surface-border bg-white px-2 text-xs text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    <option value="">No product</option>
                    {products.map((p: { id: string; name: string }) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                {/* Description */}
                <div className="col-span-3">
                  <input
                    type="text"
                    placeholder="Description"
                    value={item.description}
                    onChange={(e) => updateItem(item.key, "description", e.target.value)}
                    className={cn(
                      "h-9 w-full rounded border bg-white px-2 text-xs text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
                      errors[`item_${idx}_desc`] ? "border-danger" : "border-surface-border",
                    )}
                  />
                </div>
                {/* Qty */}
                <div className="col-span-2">
                  <input
                    type="number"
                    placeholder="Qty"
                    min="0.001"
                    step="any"
                    value={item.qty}
                    onChange={(e) => updateItem(item.key, "qty", e.target.value)}
                    className={cn(
                      "h-9 w-full rounded border bg-white px-2 text-xs text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
                      errors[`item_${idx}_qty`] ? "border-danger" : "border-surface-border",
                    )}
                  />
                </div>
                {/* Unit price */}
                <div className="col-span-2">
                  <input
                    type="number"
                    placeholder="Price"
                    min="0"
                    step="0.01"
                    value={item.unitPrice}
                    onChange={(e) => updateItem(item.key, "unitPrice", e.target.value)}
                    className={cn(
                      "h-9 w-full rounded border bg-white px-2 text-xs text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
                      errors[`item_${idx}_up`] ? "border-danger" : "border-surface-border",
                    )}
                  />
                </div>
                {/* Remove */}
                <div className="col-span-1 flex items-center justify-center">
                  <button
                    type="button"
                    onClick={() => removeItem(item.key)}
                    disabled={items.length === 1}
                    className="rounded p-1 text-navy/30 hover:text-danger disabled:opacity-30 transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}

            <button
              type="button"
              onClick={addItem}
              className="mt-1 flex items-center gap-1 text-xs text-brand-500 hover:text-brand-600 transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Line Item
            </button>
          </div>

          {/* Subtotal */}
          <div className="mt-2 flex justify-end">
            <p className="text-sm text-navy/60">
              Subtotal: <span className="font-semibold text-navy">{fmt.format(subtotal)}</span>
            </p>
          </div>
        </div>

        {/* Notes */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">
            Notes <span className="text-navy/40">(optional)</span>
          </label>
          <textarea
            rows={2}
            placeholder="Additional notes…"
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            className="w-full resize-none rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
      </form>
    </Modal>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function EstimatesPage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  React.useEffect(() => { setTitle("Estimates"); }, [setTitle]);

  const [statusFilter, setStatusFilter] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [isCreateOpen, setIsCreateOpen] = React.useState(false);
  const LIMIT = 20;

  const { data, isLoading, isError } = useEstimates({
    status: statusFilter || undefined,
    search: search || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    page,
    limit: LIMIT,
  });

  const estimates = data?.data ?? [];
  const meta = data?.meta;

  const { data: allData } = useEstimates({ limit: 999 });
  const all = allData?.data ?? [];

  const kpiCounts = React.useMemo(() => {
    const counts = { total: all.length, draft: 0, sent: 0, accepted: 0, declined: 0, expired: 0 };
    for (const est of all) {
      if (est.status === "DRAFT") counts.draft++;
      if (est.status === "SENT") counts.sent++;
      if (est.status === "ACCEPTED") counts.accepted++;
      if (est.status === "DECLINED") counts.declined++;
      if (est.status === "EXPIRED") counts.expired++;
    }
    return counts;
  }, [all]);

  const totalPages = meta?.totalPages ?? 1;

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Estimates"
        action={
          <Button
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={() => setIsCreateOpen(true)}
          >
            New Estimate
          </Button>
        }
      />

      {/* KPI chips */}
      <div className="flex flex-wrap items-center gap-2">
        <KpiChip
          label="All"
          value={kpiCounts.total}
          active={statusFilter === ""}
          onClick={() => { setStatusFilter(""); setPage(1); }}
        />
        <KpiChip
          label="Draft"
          value={kpiCounts.draft}
          active={statusFilter === "DRAFT"}
          onClick={() => { setStatusFilter("DRAFT"); setPage(1); }}
        />
        <KpiChip
          label="Sent"
          value={kpiCounts.sent}
          active={statusFilter === "SENT"}
          onClick={() => { setStatusFilter("SENT"); setPage(1); }}
        />
        <KpiChip
          label="Accepted"
          value={kpiCounts.accepted}
          active={statusFilter === "ACCEPTED"}
          onClick={() => { setStatusFilter("ACCEPTED"); setPage(1); }}
        />
        <KpiChip
          label="Declined"
          value={kpiCounts.declined}
          danger
          active={statusFilter === "DECLINED"}
          onClick={() => { setStatusFilter("DECLINED"); setPage(1); }}
        />
        <KpiChip
          label="Expired"
          value={kpiCounts.expired}
          danger
          active={statusFilter === "EXPIRED"}
          onClick={() => { setStatusFilter("EXPIRED"); setPage(1); }}
        />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Search by estimate # or customer…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="h-10 w-64 rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <div className="w-44">
          <Select
            options={STATUS_OPTIONS}
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          />
        </div>
        {/* Date range */}
        <div className="flex items-center gap-1.5">
          <Calendar className="h-4 w-4 text-navy/40" />
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
            className="h-10 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            title="Issue date from"
          />
          <span className="text-navy/40">–</span>
          <input
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
            className="h-10 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            title="Issue date to"
          />
          {(dateFrom || dateTo) && (
            <button
              onClick={() => { setDateFrom(""); setDateTo(""); setPage(1); }}
              className="rounded p-1.5 text-navy/40 hover:text-danger transition-colors"
              title="Clear dates"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-surface-border">
        <table className="w-full text-sm">
          <thead className="border-b border-surface-border bg-surface-raised">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Estimate #</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Customer</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Issue Date</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Expiry Date</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-navy/60">Total</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Status</th>
              <th className="w-10 px-3 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border bg-white">
            {isLoading ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center">
                  <Loader2 className="mx-auto h-6 w-6 animate-spin text-navy/40" />
                </td>
              </tr>
            ) : isError ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-sm text-danger">
                  Failed to load estimates. Please try again.
                </td>
              </tr>
            ) : estimates.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <FileText className="h-8 w-8 text-navy/20" />
                    <p className="text-sm text-navy/40">No estimates match your filters.</p>
                    <button
                      className="text-sm text-brand-500 hover:underline"
                      onClick={() => {
                        setSearch("");
                        setStatusFilter("");
                        setDateFrom("");
                        setDateTo("");
                        setPage(1);
                      }}
                    >
                      Clear filters
                    </button>
                  </div>
                </td>
              </tr>
            ) : (
              estimates.map((est: Estimate) => (
                <tr
                  key={est.id}
                  onClick={() => router.push(`/estimates/${est.id}`)}
                  className="cursor-pointer transition-colors hover:bg-surface-raised"
                >
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-navy">
                    {est.estimateNumber}
                  </td>
                  <td className="px-4 py-3 font-medium text-navy">
                    {est.customer?.businessName ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-navy/60">
                    {fmtDate((est as any).issueDate ?? est.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-navy/60">
                    {fmtDate((est as any).expiresAt ?? (est as any).expiryDate)}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-navy">
                    {fmt.format(Number(est.total))}
                  </td>
                  <td className="px-4 py-3">
                    <EstimateStatusBadge status={est.status} />
                  </td>
                  <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                    <button
                      title="View estimate"
                      onClick={() => router.push(`/estimates/${est.id}`)}
                      className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors"
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

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-navy/50">
            Showing {(page - 1) * LIMIT + 1}–{Math.min(page * LIMIT, meta.total)} of {meta.total} estimates
          </p>
          <div className="flex items-center gap-1">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="rounded border border-surface-border bg-white px-3 py-1.5 text-sm font-medium text-navy hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Previous
            </button>
            {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
              const p = i + 1;
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
        </div>
      )}

      {/* Create modal */}
      <CreateEstimateModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onSuccess={(id) => router.push(`/estimates/${id}`)}
      />
    </div>
  );
}
