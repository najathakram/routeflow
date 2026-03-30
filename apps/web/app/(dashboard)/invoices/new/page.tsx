"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Plus,
  Trash2,
  Search,
  Loader2,
  Eye,
} from "lucide-react";
import { Button, Card, Input, useToast, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useCreateInvoice, type CreateInvoiceItem } from "@/lib/api/invoices";
import { useCustomers, useCustomerPrices, type Customer } from "@/lib/api/customers";
import { useProducts } from "@/lib/api/products";
import { apiClient } from "@/lib/api-client";
import { BarcodeScannerButton } from "@/components/BarcodeScannerButton";
import { fmt } from "@/lib/formatting";

const TAX_RATE = 0.1; // 10% – adjust as needed

// ─── Terms options ─────────────────────────────────────────────────────────────

const TERMS_OPTIONS = [
  { value: "", label: "Select terms…" },
  { value: "Due on Receipt", label: "Due on Receipt" },
  { value: "Net 15", label: "Net 15" },
  { value: "Net 30", label: "Net 30" },
  { value: "Net 45", label: "Net 45" },
  { value: "Net 60", label: "Net 60" },
];

function getDaysForTerms(terms: string): number | null {
  switch (terms) {
    case "Due on Receipt": return 0;
    case "Net 15": return 15;
    case "Net 30": return 30;
    case "Net 45": return 45;
    case "Net 60": return 60;
    default: return null;
  }
}

// ─── Customer search dropdown ─────────────────────────────────────────────────

function CustomerSearch({
  value,
  onSelect,
  error,
}: {
  value: Customer | null;
  onSelect: (c: Customer | null) => void;
  error?: string;
}) {
  const [query, setQuery] = React.useState("");
  const [debouncedQuery, setDebouncedQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  const { data } = useCustomers({ search: debouncedQuery || undefined });
  const customers: Customer[] = data?.data ?? [];

  // Close on outside click
  React.useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  if (value) {
    return (
      <div
        className={cn(
          "flex items-center justify-between rounded-lg border px-3 py-2.5",
          error ? "border-danger" : "border-surface-border",
        )}
      >
        <div>
          <p className="text-sm font-semibold text-navy">{value.businessName}</p>
          {value.contactName && (
            <p className="text-xs text-navy/50">{value.contactName}</p>
          )}
        </div>
        <button
          onClick={() => onSelect(null)}
          className="rounded p-1 text-navy/40 hover:text-danger transition-colors"
          title="Remove customer"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div ref={ref} className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-navy/30" />
        <input
          type="text"
          placeholder="Search customers…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          className={cn(
            "h-10 w-full rounded-lg border bg-white pl-9 pr-3 text-sm text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
            error ? "border-danger" : "border-surface-border",
          )}
        />
      </div>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      {open && (
        <div className="absolute z-10 mt-1 w-full rounded-lg border border-surface-border bg-white shadow-lg">
          {customers.length === 0 ? (
            <p className="px-3 py-2 text-sm text-navy/50">No customers found.</p>
          ) : (
            <ul className="max-h-48 overflow-y-auto">
              {customers.map((c) => (
                <li key={c.id}>
                  <button
                    className="flex w-full flex-col px-3 py-2 text-left hover:bg-surface-raised"
                    onClick={() => { onSelect(c); setOpen(false); setQuery(""); }}
                  >
                    <span className="text-sm font-medium text-navy">{c.businessName}</span>
                    {c.contactName && (
                      <span className="text-xs text-navy/50">{c.contactName}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Product search dropdown (inline) ────────────────────────────────────────

function ProductSearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (description: string, productId: string, unitPrice: string, avgCost?: number) => void;
}) {
  const [query, setQuery] = React.useState(value);
  const [debouncedQuery, setDebouncedQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  const { data } = useProducts({ search: debouncedQuery || undefined, isActive: true });
  const products = data?.data ?? [];

  React.useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  return (
    <div ref={ref} className="relative flex items-center gap-1">
      <input
        type="text"
        placeholder="Description / product…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          onChange(e.target.value, "", "0", undefined);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        className="h-9 w-full rounded border border-surface-border bg-white px-2.5 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-1 focus:ring-brand-500"
      />
      <BarcodeScannerButton
        onScan={async (code) => {
          try {
            const product = await apiClient.get(`/products/barcode/${code}`).then(r => r.data);
            if (product) {
              onChange(product.name, product.id, String(product.pricePerUnit), product.averageCost ? parseFloat(String(product.averageCost)) : undefined);
              setQuery(product.name);
              setOpen(false);
            }
          } catch {
            // product not found, ignore
          }
        }}
      />
      {open && debouncedQuery.length > 0 && products.length > 0 && (
        <div className="absolute left-0 top-full z-10 mt-1 w-full rounded-lg border border-surface-border bg-white shadow-lg">
          <ul className="max-h-36 overflow-y-auto">
            {products.map((p: { id: string; name: string; pricePerUnit: number; sku?: string; averageCost?: number }) => (
              <li key={p.id}>
                <button
                  className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-surface-raised"
                  onClick={() => {
                    setQuery(p.name);
                    onChange(p.name, p.id, String(p.pricePerUnit), p.averageCost ? parseFloat(String(p.averageCost)) : undefined);
                    setOpen(false);
                  }}
                >
                  <div>
                    <span className="text-sm font-medium text-navy">{p.name}</span>
                    {p.sku && <span className="ml-2 text-xs text-navy/40">{p.sku}</span>}
                  </div>
                  <span className="text-xs text-navy/60">{fmt(Number(p.pricePerUnit))}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Line item row ────────────────────────────────────────────────────────────

interface LineItemState {
  key: string;
  productId?: string;
  description: string;
  qty: number;
  unitPrice: number;
  discount: number;
  taxable: boolean;
  regularPrice?: number;      // original product price before special pricing
  isSpecialPrice?: boolean;   // true if a customer-specific price was applied
  avgCost?: number;           // average cost of the product (display only, never submitted)
}

function createEmptyItem(): LineItemState {
  return {
    key: Math.random().toString(36).slice(2),
    productId: undefined,
    description: "",
    qty: 1,
    unitPrice: 0,
    discount: 0,
    taxable: false,
  };
}

function lineTotal(item: LineItemState): number {
  return Math.max(0, Number(item.qty) * Number(item.unitPrice) - Number(item.discount));
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function NewInvoicePage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();
  const createInvoice = useCreateInvoice();

  React.useEffect(() => { setTitle("New Invoice"); }, [setTitle]);

  const [customer, setCustomer] = React.useState<Customer | null>(null);
  const [orderNumber, setOrderNumber] = React.useState("");
  const [subject, setSubject] = React.useState("");
  const [terms, setTerms] = React.useState("");
  const [issueDate, setIssueDate] = React.useState(
    () => new Date().toISOString().slice(0, 10),
  );
  const [dueDate, setDueDate] = React.useState(
    () => {
      const d = new Date();
      d.setDate(d.getDate() + 30);
      return d.toISOString().slice(0, 10);
    },
  );
  const [items, setItems] = React.useState<LineItemState[]>([createEmptyItem()]);
  const [notes, setNotes] = React.useState("");
  const [termsText, setTermsText] = React.useState("");
  const [adjustment, setAdjustment] = React.useState(0);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [showAvgCost, setShowAvgCost] = React.useState(false);

  const { data: customerPricesData } = useCustomerPrices(customer?.id);
  const priceMap = React.useMemo(() => {
    const map: Record<string, number> = {};
    if (customerPricesData) {
      for (const cp of customerPricesData) {
        map[cp.productId] = parseFloat(String(cp.specialPrice));
      }
    }
    return map;
  }, [customerPricesData]);

  // ── Auto-update due date when terms change ────────────────────────────────

  function handleTermsChange(t: string) {
    setTerms(t);
    const days = getDaysForTerms(t);
    if (days !== null && issueDate) {
      const d = new Date(issueDate);
      d.setDate(d.getDate() + days);
      setDueDate(d.toISOString().slice(0, 10));
    }
  }

  function handleIssueDateChange(d: string) {
    setIssueDate(d);
    if (terms) {
      const days = getDaysForTerms(terms);
      if (days !== null && d) {
        const due = new Date(d);
        due.setDate(due.getDate() + days);
        setDueDate(due.toISOString().slice(0, 10));
      }
    }
  }

  // ── Calculations ────────────────────────────────────────────────────────────

  const subtotal = items.reduce((s, it) => s + lineTotal(it), 0);
  const tax = items
    .filter((it) => it.taxable)
    .reduce((s, it) => s + lineTotal(it) * TAX_RATE, 0);
  const total = subtotal + tax + adjustment;
  const totalQty = items.reduce((s, it) => s + Number(it.qty), 0);

  // ── Item helpers ────────────────────────────────────────────────────────────

  function updateItem(key: string, patch: Partial<LineItemState>) {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  }

  function removeItem(key: string) {
    setItems((prev) => prev.filter((it) => it.key !== key));
  }

  function addItem() {
    setItems((prev) => [...prev, createEmptyItem()]);
  }

  // ── Validation ──────────────────────────────────────────────────────────────

  function validate() {
    const errs: Record<string, string> = {};
    if (!customer) errs.customer = "Please select a customer.";
    if (!issueDate) errs.issueDate = "Issue date is required.";
    if (!dueDate) errs.dueDate = "Due date is required.";
    if (items.length === 0) errs.items = "Add at least one line item.";
    for (const it of items) {
      if (!it.description.trim()) {
        errs.items = "All line items must have a description.";
        break;
      }
      if (Number(it.qty) <= 0) {
        errs.items = "All quantities must be greater than 0.";
        break;
      }
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  // ── Submit ──────────────────────────────────────────────────────────────────

  function handleSubmit(sendNow: boolean) {
    if (!validate()) return;

    const dto = {
      customerId: customer!.id,
      dueDate: dueDate || undefined,
      issueDate: issueDate || undefined,
      terms: terms || undefined,
      items: items.map((it): CreateInvoiceItem => ({
        productId: it.productId,
        description: it.description,
        qty: Number(it.qty),
        unitPrice: Number(it.unitPrice),
        discount: Number(it.discount) || undefined,
      })),
      notes: notes.trim() || undefined,
      ...(sendNow ? { send: true } : {}),
    };

    createInvoice.mutate(dto as Parameters<typeof createInvoice.mutate>[0], {
      onSuccess: (invoice) => {
        toast({
          title: sendNow ? "Invoice sent" : "Draft saved",
          description: sendNow
            ? `Invoice ${invoice.invoiceNumber} has been sent.`
            : `Invoice ${invoice.invoiceNumber} saved as draft.`,
          variant: "success",
        });
        router.push(`/invoices/${invoice.id}`);
      },
      onError: () => {
        toast({
          title: "Failed to create invoice",
          description: "Please check your inputs and try again.",
          variant: "error",
        });
      },
    });
  }

  return (
    <div className="pb-24">
      <div className="space-y-5 p-6">
        {/* Back */}
        <Link
          href="/invoices"
          className="flex items-center gap-1.5 text-sm text-navy/60 hover:text-navy transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Invoices
        </Link>

        <h1 className="text-2xl font-bold text-navy">New Invoice</h1>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
          {/* ── Left column (3/5) ── */}
          <div className="space-y-5 lg:col-span-3">

            {/* Customer */}
            <Card title="Customer *">
              <CustomerSearch
                value={customer}
                onSelect={setCustomer}
                error={errors.customer}
              />
            </Card>

            {/* Invoice details */}
            <Card title="Invoice Details">
              <div className="space-y-4">
                {/* Order Number + Subject */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-navy/80">
                      Order Number <span className="text-navy/40 font-normal">(optional)</span>
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. PO-1234"
                      value={orderNumber}
                      onChange={(e) => setOrderNumber(e.target.value)}
                      className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-navy/80">
                      Subject <span className="text-navy/40 font-normal">(optional)</span>
                    </label>
                    <input
                      type="text"
                      placeholder="What is this invoice for?"
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                  </div>
                </div>

                {/* Dates + Terms */}
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-navy/80">
                      Issue Date *
                    </label>
                    <input
                      type="date"
                      value={issueDate}
                      onChange={(e) => handleIssueDateChange(e.target.value)}
                      className={cn(
                        "h-10 w-full rounded-lg border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
                        errors.issueDate ? "border-danger" : "border-surface-border",
                      )}
                    />
                    {errors.issueDate && (
                      <p className="mt-1 text-xs text-danger">{errors.issueDate}</p>
                    )}
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-navy/80">
                      Terms
                    </label>
                    <select
                      value={terms}
                      onChange={(e) => handleTermsChange(e.target.value)}
                      className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                    >
                      {TERMS_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-navy/80">
                      Due Date *
                    </label>
                    <input
                      type="date"
                      value={dueDate}
                      min={issueDate || undefined}
                      onChange={(e) => setDueDate(e.target.value)}
                      className={cn(
                        "h-10 w-full rounded-lg border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
                        errors.dueDate ? "border-danger" : "border-surface-border",
                      )}
                    />
                    {errors.dueDate && (
                      <p className="mt-1 text-xs text-danger">{errors.dueDate}</p>
                    )}
                  </div>
                </div>
              </div>
            </Card>

            {/* Line items */}
            <Card title="Item Table">
              <div className="space-y-2">
                {errors.items && (
                  <p className="text-xs text-danger">{errors.items}</p>
                )}
                {/* Avg cost toggle */}
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-navy/60">Line Items</span>
                  <button
                    type="button"
                    onClick={() => setShowAvgCost(v => !v)}
                    className={cn(
                      "flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
                      showAvgCost ? "bg-brand-500/10 text-brand-500" : "text-navy/40 hover:text-navy"
                    )}
                    title="Toggle average cost column (not included in invoice)"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    {showAvgCost ? 'Hide avg. cost' : 'Show avg. cost'}
                  </button>
                </div>
                {/* Table header */}
                <div className={cn(
                  "gap-2 rounded-t bg-gray-50 px-1 py-2 text-xs font-semibold uppercase tracking-wider text-gray-500",
                  showAvgCost ? "grid grid-cols-[1fr_70px_100px_90px_72px_44px_32px]" : "grid grid-cols-[1fr_70px_100px_90px_44px_32px]"
                )}>
                  <span>Item Details</span>
                  <span className="text-right">Qty</span>
                  <span className="text-right">Rate</span>
                  <span className="text-right">Discount</span>
                  {showAvgCost && <span className="text-right text-navy/40">Avg. Cost</span>}
                  <span className="text-center">Tax</span>
                  <span />
                </div>

                {items.map((item) => (
                  <div
                    key={item.key}
                    className={cn(
                      "items-center gap-2 border-b border-surface-border pb-2",
                      showAvgCost ? "grid grid-cols-[1fr_70px_100px_90px_72px_44px_32px]" : "grid grid-cols-[1fr_70px_100px_90px_44px_32px]"
                    )}
                  >
                    {/* Description / product search */}
                    <ProductSearchInput
                      value={item.description}
                      onChange={(desc, pid, price, avgCost) => {
                        const specialPrice = pid ? priceMap[pid] : undefined;
                        updateItem(item.key, {
                          description: desc,
                          productId: pid || undefined,
                          unitPrice: specialPrice ?? (price ? parseFloat(price) : item.unitPrice),
                          regularPrice: specialPrice !== undefined ? parseFloat(price) : undefined,
                          isSpecialPrice: specialPrice !== undefined,
                          avgCost,
                        });
                      }}
                    />

                    {/* Qty */}
                    <input
                      type="number"
                      min={0.01}
                      step={0.01}
                      value={item.qty}
                      onChange={(e) => updateItem(item.key, { qty: parseFloat(e.target.value) || 0 })}
                      className="h-9 rounded border border-surface-border bg-white px-2 text-right text-sm text-navy focus:border-transparent focus:outline-none focus:ring-1 focus:ring-brand-500"
                    />

                    {/* Unit price */}
                    <div>
                      {item.isSpecialPrice && item.regularPrice !== undefined && (
                        <p className="text-xs line-through text-navy/40 mb-0.5 text-right">
                          ${item.regularPrice.toFixed(2)}
                        </p>
                      )}
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        value={item.unitPrice}
                        onChange={(e) => updateItem(item.key, { unitPrice: parseFloat(e.target.value) || 0 })}
                        className="h-9 w-full rounded border border-surface-border bg-white px-2 text-right text-sm text-navy focus:border-transparent focus:outline-none focus:ring-1 focus:ring-brand-500"
                      />
                    </div>

                    {/* Discount */}
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      placeholder="0.00"
                      value={item.discount || ""}
                      onChange={(e) => updateItem(item.key, { discount: parseFloat(e.target.value) || 0 })}
                      className="h-9 rounded border border-surface-border bg-white px-2 text-right text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-1 focus:ring-brand-500"
                    />

                    {/* Avg cost (optional column) */}
                    {showAvgCost && (
                      <span className="text-right text-xs text-navy/50">
                        {item.avgCost ? '$' + item.avgCost.toFixed(2) : '—'}
                      </span>
                    )}

                    {/* Taxable checkbox */}
                    <label className="flex cursor-pointer items-center justify-center">
                      <input
                        type="checkbox"
                        checked={item.taxable}
                        onChange={(e) => updateItem(item.key, { taxable: e.target.checked })}
                        className="h-4 w-4 rounded border-surface-border text-brand-500 focus:ring-brand-500"
                      />
                    </label>

                    {/* Remove */}
                    <button
                      onClick={() => removeItem(item.key)}
                      disabled={items.length === 1}
                      className="flex items-center justify-center rounded p-1 text-navy/30 hover:text-danger transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      title="Remove item"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}

                {/* Row totals strip */}
                {items.map((item) => (
                  <div
                    key={item.key + "-total"}
                    className={cn(
                      "gap-2 px-1",
                      showAvgCost ? "grid grid-cols-[1fr_70px_100px_90px_72px_44px_32px]" : "grid grid-cols-[1fr_70px_100px_90px_44px_32px]"
                    )}
                  >
                    <span />
                    <span />
                    <span />
                    <span className="col-span-1 text-right text-xs font-medium text-navy/60">
                      = {fmt(lineTotal(item))}
                    </span>
                    {showAvgCost && <span />}
                    <span />
                    <span />
                  </div>
                ))}

                <button
                  onClick={addItem}
                  className="mt-2 flex items-center gap-1.5 text-sm font-medium text-brand-500 hover:text-brand-600 transition-colors"
                >
                  <Plus className="h-4 w-4" />
                  Add Line Item
                </button>
              </div>

              {/* Totals section */}
              <div className="mt-4 border-t border-surface-border pt-4">
                <div className="ml-auto w-64 space-y-2 text-sm">
                  <div className="flex justify-between text-navy/70">
                    <span>Subtotal</span>
                    <span>{fmt(subtotal)}</span>
                  </div>
                  {tax > 0 && (
                    <div className="flex justify-between text-navy/70">
                      <span>Tax ({(TAX_RATE * 100).toFixed(0)}%)</span>
                      <span>{fmt(tax)}</span>
                    </div>
                  )}
                  {/* Adjustment row */}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-navy/70">Adjustment</span>
                    <input
                      type="number"
                      step={0.01}
                      placeholder="0.00"
                      value={adjustment || ""}
                      onChange={(e) => setAdjustment(parseFloat(e.target.value) || 0)}
                      className="w-28 rounded border border-surface-border bg-white px-2 py-1 text-right text-sm text-navy focus:border-transparent focus:outline-none focus:ring-1 focus:ring-brand-500"
                    />
                  </div>
                  <div className="flex justify-between border-t border-surface-border pt-2 text-base font-bold text-navy">
                    <span>Total</span>
                    <span>{fmt(total)}</span>
                  </div>
                </div>
              </div>
            </Card>

            {/* Notes */}
            <Card title="Customer Notes">
              <textarea
                rows={3}
                placeholder="Add any notes visible to the customer…"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full resize-none rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </Card>

            {/* Terms & Conditions */}
            <Card title="Terms & Conditions">
              <textarea
                rows={3}
                placeholder="Terms and conditions for this invoice…"
                value={termsText}
                onChange={(e) => setTermsText(e.target.value)}
                className="w-full resize-none rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </Card>
          </div>

          {/* ── Right column (2/5) ── */}
          <div className="space-y-4 lg:col-span-2">
            <Card title="Invoice Summary">
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-navy/60">Subtotal</dt>
                  <dd className="font-medium text-navy">{fmt(subtotal)}</dd>
                </div>
                {tax > 0 && (
                  <div className="flex justify-between">
                    <dt className="text-navy/60">Tax ({(TAX_RATE * 100).toFixed(0)}%)</dt>
                    <dd className="font-medium text-navy">{fmt(tax)}</dd>
                  </div>
                )}
                {adjustment !== 0 && (
                  <div className="flex justify-between">
                    <dt className="text-navy/60">Adjustment</dt>
                    <dd className={cn("font-medium", adjustment < 0 ? "text-success" : "text-navy")}>
                      {adjustment < 0 ? "-" : "+"}{fmt(Math.abs(adjustment))}
                    </dd>
                  </div>
                )}
                <div className="flex justify-between border-t border-surface-border pt-2">
                  <dt className="font-semibold text-navy">Total</dt>
                  <dd className="text-base font-bold text-navy">{fmt(total)}</dd>
                </div>
                <div className="flex justify-between pt-1 text-xs text-navy/50">
                  <dt>Total Quantity</dt>
                  <dd>{totalQty}</dd>
                </div>
              </dl>
            </Card>
          </div>
        </div>
      </div>

      {/* Sticky bottom bar (Zoho-style) */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-surface-border bg-white px-6 py-3 shadow-[0_-2px_8px_0_rgb(0,0,0,0.06)]">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => handleSubmit(false)}
              loading={createInvoice.isPending}
              disabled={createInvoice.isPending}
            >
              Save as Draft
            </Button>
            <Button
              onClick={() => handleSubmit(true)}
              loading={createInvoice.isPending}
              disabled={createInvoice.isPending}
            >
              Save and Send
            </Button>
            <button
              onClick={() => router.push("/invoices")}
              className="px-3 py-1.5 text-sm text-navy/60 hover:text-navy transition-colors"
            >
              Cancel
            </button>
          </div>
          <div className="text-right">
            <p className="text-xs text-navy/50">Total Amount</p>
            <p className="text-lg font-bold text-navy">{fmt(total)}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
