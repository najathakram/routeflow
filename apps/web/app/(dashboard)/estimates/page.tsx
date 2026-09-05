"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, Eye, Calendar, X, Loader2, Trash2, Search } from "lucide-react";
import {
  PageHeader,
  Button,
  Select,
  cn,
  Modal,
  useToast,
  EmptyState,
  Badge,
} from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useUrlSearch } from "@/lib/hooks/useUrlSearch";
import { useUrlPage, useClampPage } from "@/lib/hooks/useUrlPage";
import {
  useEstimates,
  useCreateEstimate,
  type Estimate,
  type CreateEstimateItem,
} from "@/lib/api/estimates";
import { useCustomers, useCustomerPrices } from "@/lib/api/customers";
import { useProducts } from "@/lib/api/products";
import { computeLineSubtotal, getTierPrice } from "@routeflow/pricing";
import { apiClient } from "@/lib/api-client";
import { useTierLabels } from "@/lib/api/tier-labels";
import { tierLabel } from "@/lib/tier-label";
import { fmt, fmtCalendarDate, fmtDate } from "@/lib/formatting";

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
              : "bg-surface-raised text-navy/70",
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

// ─── Estimate Line Item ───────────────────────────────────────────────────────

interface EstimateLineItem {
  tempId: string;
  productId: string;
  productName: string;
  unit: string;
  listPrice: number;
  tierPrice: number;
  discountedPrice?: number;
  unitPrice: number;
  priceType: "STANDARD" | "SPECIAL" | "DISCOUNTED";
  qty: number;
  unitsPerBox?: number;
  boxes?: number;
  pieces?: number;
}

interface SelectedEstimateCustomer {
  id: string;
  businessName: string;
  contactName?: string;
  pricingTier?: number;
}

// ─── Create Estimate modal ────────────────────────────────────────────────────

function defaultExpiryDate() {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().slice(0, 10);
}

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
  const { data: tierLabels } = useTierLabels();

  // Customer search
  const [customerSearch, setCustomerSearch] = React.useState("");
  const [debouncedCustomerSearch, setDebouncedCustomerSearch] = React.useState("");
  const [selectedCustomer, setSelectedCustomer] = React.useState<SelectedEstimateCustomer | null>(
    null,
  );

  // Product search
  const [productSearch, setProductSearch] = React.useState("");
  const [debouncedProductSearch, setDebouncedProductSearch] = React.useState("");
  const productSearchRef = React.useRef<HTMLInputElement>(null);

  // Line items
  const [lineItems, setLineItems] = React.useState<EstimateLineItem[]>([]);

  // Dates & notes
  const [issueDate, setIssueDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [expiryDate, setExpiryDate] = React.useState(defaultExpiryDate());
  const [notes, setNotes] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  // Customer per-product tier overrides
  const { data: customerPricesData } = useCustomerPrices(selectedCustomer?.id);
  const cpMap = React.useMemo(() => {
    const map = new Map<string, number>();
    (customerPricesData ?? []).forEach((cp: any) => map.set(cp.productId, cp.pricingTier));
    return map;
  }, [customerPricesData]);

  // Debounce
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedCustomerSearch(customerSearch), 300);
    return () => clearTimeout(t);
  }, [customerSearch]);
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedProductSearch(productSearch), 300);
    return () => clearTimeout(t);
  }, [productSearch]);

  const { data: customersData } = useCustomers({ search: debouncedCustomerSearch || undefined });
  const { data: productsData } = useProducts({
    search: debouncedProductSearch || undefined,
    isActive: true,
    includeVariants: true,
  });

  const filteredCustomers = React.useMemo(() => {
    if (!debouncedCustomerSearch) return [];
    return (customersData?.data ?? []).slice(0, 8);
  }, [customersData, debouncedCustomerSearch]);

  const filteredProducts = React.useMemo(() => {
    if (!debouncedProductSearch) return [];
    return (productsData?.data ?? []).filter((p: any) => !p.parentProductId).slice(0, 10);
  }, [productsData, debouncedProductSearch]);

  // Reset on open
  React.useEffect(() => {
    if (isOpen) {
      setSelectedCustomer(null);
      setCustomerSearch("");
      setDebouncedCustomerSearch("");
      setProductSearch("");
      setDebouncedProductSearch("");
      setLineItems([]);
      setIssueDate(new Date().toISOString().slice(0, 10));
      setExpiryDate(defaultExpiryDate());
      setNotes("");
      setErrors({});
    }
  }, [isOpen]);

  // Add line item (from search or barcode)
  const addLineItem = (product: any) => {
    if (lineItems.some((li) => li.productId === product.id)) {
      setLineItems((prev) =>
        prev.map((li) => (li.productId === product.id ? { ...li, qty: li.qty + 1 } : li)),
      );
      setProductSearch("");
      setDebouncedProductSearch("");
      setTimeout(() => productSearchRef.current?.focus(), 50);
      return;
    }
    const upb: number | undefined = product.unitsPerBox ? Number(product.unitsPerBox) : undefined;
    const listPrice = Number(product.pricePerUnit ?? 0);
    const customerTier = selectedCustomer?.pricingTier ?? 1;
    const tierOverride = cpMap.get(product.id);
    const effectiveTier = tierOverride ?? customerTier;
    const tierPrice = getTierPrice(product, effectiveTier);
    const priceType = effectiveTier !== 1 ? ("SPECIAL" as const) : ("STANDARD" as const);
    setLineItems((prev) => [
      ...prev,
      {
        tempId: product.id + "-" + Date.now(),
        productId: product.id,
        productName: product.name,
        unit: product.unit ?? "each",
        listPrice,
        tierPrice,
        unitPrice: tierPrice,
        priceType,
        qty: upb ? upb : 1,
        unitsPerBox: upb,
        boxes: upb ? 1 : undefined,
        pieces: upb ? 0 : undefined,
      },
    ]);
    setProductSearch("");
    setDebouncedProductSearch("");
    setErrors((e) => {
      const { items: _, ...rest } = e;
      return rest;
    });
    setTimeout(() => productSearchRef.current?.focus(), 50);
  };

  // Barcode / Enter handler
  const handleProductSearchEnter = async () => {
    const code = productSearch.trim();
    if (!code) return;
    try {
      const product = await apiClient
        .get(`/products/barcode/${encodeURIComponent(code)}`)
        .then((r) => r.data);
      addLineItem(product);
      return;
    } catch {
      /* not found by barcode */
    }
    try {
      const res = await apiClient
        .get("/products", { params: { search: code, limit: 10, isActive: true } })
        .then((r) => r.data);
      const matches: any[] = res?.data ?? [];
      const skuMatch = matches.find((p: any) => (p.sku ?? "").toLowerCase() === code.toLowerCase());
      const toAdd = skuMatch ?? matches[0];
      if (toAdd) {
        addLineItem(toAdd);
        return;
      }
    } catch {
      /* ignore */
    }
    toast({
      title: "Product not found",
      description: `No product matches "${code}"`,
      variant: "error",
    });
    setProductSearch("");
  };

  const removeLineItem = (tempId: string) =>
    setLineItems((prev) => prev.filter((li) => li.tempId !== tempId));

  const setBoxes = (tempId: string, value: number) => {
    setLineItems((prev) =>
      prev.map((li) => {
        if (li.tempId !== tempId) return li;
        const boxes = Math.max(0, isNaN(value) ? 0 : value);
        const pieces = li.pieces ?? 0;
        const qty = boxes * (li.unitsPerBox ?? 1) + pieces;
        return { ...li, boxes, qty };
      }),
    );
  };

  const setPieces = (tempId: string, value: number) => {
    setLineItems((prev) =>
      prev.map((li) => {
        if (li.tempId !== tempId) return li;
        const pieces = Math.max(0, isNaN(value) ? 0 : value);
        const boxes = li.boxes ?? 0;
        const qty = boxes * (li.unitsPerBox ?? 1) + pieces;
        return { ...li, pieces, qty };
      }),
    );
  };

  const setQty = (tempId: string, value: number) => {
    setLineItems((prev) =>
      prev.map((li) => (li.tempId === tempId ? { ...li, qty: Math.max(0, value) } : li)),
    );
  };

  const subtotal = lineItems.reduce(
    (sum, li) =>
      sum +
      computeLineSubtotal({
        unitPrice: li.unitPrice,
        qty: li.qty,
        boxes: li.boxes ?? null,
        pieces: li.pieces ?? null,
        unitsPerBox: li.unitsPerBox ?? null,
      }),
    0,
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!selectedCustomer) errs.customer = "Select a customer.";
    if (!issueDate) errs.issueDate = "Issue date is required.";
    if (!expiryDate) errs.expiryDate = "Expiry date is required.";
    if (lineItems.length === 0) errs.items = "Add at least one product.";
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    setErrors({});

    const dto = {
      customerId: selectedCustomer!.id,
      expiresAt: expiryDate,
      notes: notes.trim() || undefined,
      items: lineItems.map((li) => ({
        productId: li.productId,
        description: li.productName,
        qty: li.qty,
        ...(li.unitsPerBox ? { boxes: li.boxes ?? 0, pieces: li.pieces ?? 0 } : {}),
        ...(li.priceType === "DISCOUNTED" && li.discountedPrice != null
          ? { unitPrice: li.discountedPrice }
          : {}),
      })),
    };

    createEstimate.mutate(dto as any, {
      onSuccess: (est) => {
        toast({ title: "Estimate created", description: est.estimateNumber, variant: "success" });
        onClose();
        onSuccess(est.id);
      },
      onError: () => {
        toast({
          title: "Failed to create estimate",
          description: "Please try again.",
          variant: "error",
        });
      },
    });
  }

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="New Estimate"
      description="Create an estimate for a customer."
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
        {/* Customer search */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Customer</label>
          {selectedCustomer ? (
            <div className="flex items-center justify-between rounded-lg border border-surface-border bg-surface-raised px-3 py-2">
              <div>
                <span className="text-sm font-medium text-navy">
                  {selectedCustomer.businessName}
                </span>
                {selectedCustomer.contactName && (
                  <span className="ml-2 text-xs text-navy/70">{selectedCustomer.contactName}</span>
                )}
                <span className="ml-2 text-xs text-navy/70">
                  {tierLabel(tierLabels, selectedCustomer.pricingTier ?? 1)}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelectedCustomer(null);
                  setLineItems([]);
                }}
                className="text-navy/70 hover:text-navy"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-navy/30" />
              <input
                type="text"
                placeholder="Search customers…"
                value={customerSearch}
                onChange={(e) => setCustomerSearch(e.target.value)}
                className="h-10 w-full rounded-lg border border-surface-border bg-white pl-9 pr-3 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              {filteredCustomers.length > 0 && customerSearch && (
                <ul className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-surface-border bg-white shadow-dropdown">
                  {filteredCustomers.map((c: any) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedCustomer({
                            id: c.id,
                            businessName: c.businessName,
                            contactName: c.contactName,
                            pricingTier: c.pricingTier,
                          });
                          setCustomerSearch("");
                          setDebouncedCustomerSearch("");
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-navy hover:bg-surface-raised"
                      >
                        <span className="font-medium">{c.businessName}</span>
                        {c.contactName && (
                          <span className="text-xs text-navy/70">{c.contactName}</span>
                        )}
                        <span className="ml-auto text-xs text-navy/70">
                          {tierLabel(tierLabels, c.pricingTier ?? 1)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {errors.customer && <p className="mt-1 text-xs text-danger">{errors.customer}</p>}
        </div>

        {/* Dates */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-navy/80">Issue Date</label>
            <input
              type="date"
              value={issueDate}
              onChange={(e) => setIssueDate(e.target.value)}
              className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            {errors.issueDate && <p className="mt-1 text-xs text-danger">{errors.issueDate}</p>}
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-navy/80">Expiry Date</label>
            <input
              type="date"
              value={expiryDate}
              min={issueDate || undefined}
              onChange={(e) => setExpiryDate(e.target.value)}
              className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            {errors.expiryDate && <p className="mt-1 text-xs text-danger">{errors.expiryDate}</p>}
          </div>
        </div>

        {/* Product search + Line items */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-sm font-medium text-navy/80">Products</label>
          </div>

          {/* Product search input */}
          {selectedCustomer && (
            <div className="relative mb-3">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-navy/30" />
              <input
                ref={productSearchRef}
                type="text"
                placeholder="Search by name, SKU, or scan barcode…"
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleProductSearchEnter();
                  }
                }}
                className="h-10 w-full rounded-lg border border-surface-border bg-white pl-9 pr-3 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              {filteredProducts.length > 0 && productSearch && (
                <ul className="absolute left-0 right-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-lg border border-surface-border bg-white shadow-dropdown">
                  {filteredProducts.map((p: any) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => addLineItem(p)}
                        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-surface-raised"
                      >
                        <div>
                          <span className="font-medium text-navy">{p.name}</span>
                          {p.sku && (
                            <span className="ml-2 font-mono text-xs text-navy/70">{p.sku}</span>
                          )}
                        </div>
                        <span className="text-xs text-navy/70">{fmt(Number(p.pricePerUnit))}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {!selectedCustomer && (
            <p className="mb-3 text-xs text-navy/70">Select a customer first to add products.</p>
          )}

          {errors.items && <p className="mb-2 text-xs text-danger">{errors.items}</p>}

          {/* Line items list */}
          {lineItems.length > 0 && (
            <div className="space-y-2 rounded-lg border border-surface-border p-3">
              {lineItems.map((li) => (
                <div
                  key={li.tempId}
                  className="flex items-center gap-2 rounded-lg bg-surface-raised p-2"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-navy truncate">
                        {li.productName}
                      </span>
                      {li.priceType === "SPECIAL" && (
                        <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                          TIER
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-navy/70">
                      <span>
                        {fmt(li.unitPrice)}/{li.unit}
                      </span>
                      {li.priceType === "SPECIAL" && (
                        <span className="line-through">{fmt(li.listPrice)}</span>
                      )}
                    </div>
                  </div>

                  {/* Box/Pieces or Qty */}
                  {li.unitsPerBox ? (
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min="0"
                        value={li.boxes ?? 0}
                        onChange={(e) => setBoxes(li.tempId, Number(e.target.value))}
                        className="h-8 w-14 rounded border border-surface-border bg-white px-1.5 text-center text-xs text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                      />
                      <span className="text-[10px] text-navy/70">box</span>
                      <input
                        type="number"
                        min="0"
                        value={li.pieces ?? 0}
                        onChange={(e) => setPieces(li.tempId, Number(e.target.value))}
                        className="h-8 w-14 rounded border border-surface-border bg-white px-1.5 text-center text-xs text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                      />
                      <span className="text-[10px] text-navy/70">pcs</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setQty(li.tempId, li.qty - 1)}
                        className="h-7 w-7 rounded border border-surface-border bg-white text-navy/70 hover:bg-surface-raised"
                      >
                        -
                      </button>
                      <input
                        type="number"
                        min="0"
                        value={li.qty}
                        onChange={(e) => setQty(li.tempId, Number(e.target.value))}
                        className="h-8 w-14 rounded border border-surface-border bg-white px-1.5 text-center text-xs text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                      />
                      <button
                        type="button"
                        onClick={() => setQty(li.tempId, li.qty + 1)}
                        className="h-7 w-7 rounded border border-surface-border bg-white text-navy/70 hover:bg-surface-raised"
                      >
                        +
                      </button>
                    </div>
                  )}

                  {/* Subtotal */}
                  <span className="w-20 text-right text-sm font-semibold text-navy">
                    {fmt(
                      computeLineSubtotal({
                        unitPrice: li.unitPrice,
                        qty: li.qty,
                        boxes: li.boxes ?? null,
                        pieces: li.pieces ?? null,
                        unitsPerBox: li.unitsPerBox ?? null,
                      }),
                    )}
                  </span>

                  {/* Remove */}
                  <button
                    type="button"
                    onClick={() => removeLineItem(li.tempId)}
                    className="rounded p-1 text-navy/30 hover:text-danger transition-colors"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Subtotal */}
          {lineItems.length > 0 && (
            <div className="mt-2 flex justify-end">
              <p className="text-sm text-navy/70">
                Subtotal: <span className="font-semibold text-navy">{fmt(subtotal)}</span>
              </p>
            </div>
          )}
        </div>

        {/* Notes */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">
            Notes <span className="text-navy/70">(optional)</span>
          </label>
          <textarea
            rows={2}
            placeholder="Additional notes…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
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
  React.useEffect(() => {
    setTitle("Estimates");
  }, [setTitle]);

  const [statusFilter, setStatusFilter] = React.useState("");
  const [search, setSearch, debouncedSearch] = useUrlSearch();
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [page, setPage] = useUrlPage();
  const [isCreateOpen, setIsCreateOpen] = React.useState(false);
  const LIMIT = 20;

  const { data, isLoading, isError } = useEstimates({
    status: statusFilter || undefined,
    search: debouncedSearch || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    page,
    limit: LIMIT,
  });

  const estimates = data?.data ?? [];
  const meta = data?.meta;
  useClampPage(setPage, page, meta?.totalPages);

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
          <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => setIsCreateOpen(true)}>
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
          onClick={() => {
            setStatusFilter("");
            setPage(1);
          }}
        />
        <KpiChip
          label="Draft"
          value={kpiCounts.draft}
          active={statusFilter === "DRAFT"}
          onClick={() => {
            setStatusFilter("DRAFT");
            setPage(1);
          }}
        />
        <KpiChip
          label="Sent"
          value={kpiCounts.sent}
          active={statusFilter === "SENT"}
          onClick={() => {
            setStatusFilter("SENT");
            setPage(1);
          }}
        />
        <KpiChip
          label="Accepted"
          value={kpiCounts.accepted}
          active={statusFilter === "ACCEPTED"}
          onClick={() => {
            setStatusFilter("ACCEPTED");
            setPage(1);
          }}
        />
        <KpiChip
          label="Declined"
          value={kpiCounts.declined}
          danger
          active={statusFilter === "DECLINED"}
          onClick={() => {
            setStatusFilter("DECLINED");
            setPage(1);
          }}
        />
        <KpiChip
          label="Expired"
          value={kpiCounts.expired}
          danger
          active={statusFilter === "EXPIRED"}
          onClick={() => {
            setStatusFilter("EXPIRED");
            setPage(1);
          }}
        />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Search by estimate # or customer…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="h-10 w-64 rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/70 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <div className="w-44">
          <Select
            options={STATUS_OPTIONS}
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
          />
        </div>
        {/* Date range */}
        <div className="flex items-center gap-1.5">
          <Calendar className="h-4 w-4 text-navy/70" />
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => {
              setDateFrom(e.target.value);
              setPage(1);
            }}
            className="h-10 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
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
            className="h-10 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
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
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-surface-border">
        <table className="w-full text-sm">
          <thead className="border-b border-surface-border bg-surface-raised">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Estimate #</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Customer</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Issue Date</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Expiry Date</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-navy/70">Total</th>
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
                  Failed to load estimates. Please try again.
                </td>
              </tr>
            ) : estimates.length === 0 ? (
              <tr>
                <td colSpan={7} className="p-0">
                  {search || statusFilter || dateFrom || dateTo ? (
                    <EmptyState
                      variant="invoices"
                      title="No matching estimates"
                      description="No estimates match your current search and filters."
                      action={
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setSearch("");
                            setStatusFilter("");
                            setDateFrom("");
                            setDateTo("");
                            setPage(1);
                          }}
                        >
                          Clear filters
                        </Button>
                      }
                    />
                  ) : (
                    <EmptyState
                      variant="invoices"
                      title="No estimates yet"
                      description="Create an estimate to quote a customer before converting it to an invoice."
                      action={
                        <Button size="sm" onClick={() => setIsCreateOpen(true)}>
                          New estimate
                        </Button>
                      }
                    />
                  )}
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
                  <td className="px-4 py-3 text-navy">
                    {fmtCalendarDate((est as any).issueDate ?? est.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-navy">
                    {fmtCalendarDate((est as any).expiresAt ?? (est as any).expiryDate)}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-navy">
                    {fmt(Number(est.total))}
                  </td>
                  <td className="px-4 py-3">
                    <Badge status={est.status} />
                  </td>
                  <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                    <button
                      title="View estimate"
                      onClick={() => router.push(`/estimates/${est.id}`)}
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

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-navy/70">
            Showing {(page - 1) * LIMIT + 1}–{Math.min(page * LIMIT, meta.total)} of {meta.total}{" "}
            estimates
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
