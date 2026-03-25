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
} from "lucide-react";
import { Button, Card, Input, useToast, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useCreateInvoice, type CreateInvoiceItem } from "@/lib/api/invoices";
import { useCustomers, type Customer } from "@/lib/api/customers";
import { useProducts } from "@/lib/api/products";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

const TAX_RATE = 0.1; // 10% – adjust as needed

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
  onChange: (description: string, productId?: string, unitPrice?: number) => void;
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
    <div ref={ref} className="relative">
      <input
        type="text"
        placeholder="Description / product…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          onChange(e.target.value, undefined, undefined);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        className="h-9 w-full rounded border border-surface-border bg-white px-2.5 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-1 focus:ring-brand-500"
      />
      {open && debouncedQuery.length > 0 && products.length > 0 && (
        <div className="absolute z-10 mt-1 w-full rounded-lg border border-surface-border bg-white shadow-lg">
          <ul className="max-h-36 overflow-y-auto">
            {products.map((p: { id: string; name: string; pricePerUnit: number; sku?: string }) => (
              <li key={p.id}>
                <button
                  className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-surface-raised"
                  onClick={() => {
                    setQuery(p.name);
                    onChange(p.name, p.id, p.pricePerUnit);
                    setOpen(false);
                  }}
                >
                  <div>
                    <span className="text-sm font-medium text-navy">{p.name}</span>
                    {p.sku && <span className="ml-2 text-xs text-navy/40">{p.sku}</span>}
                  </div>
                  <span className="text-xs text-navy/60">{fmt.format(Number(p.pricePerUnit))}</span>
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
  taxable: boolean;
}

function createEmptyItem(): LineItemState {
  return {
    key: Math.random().toString(36).slice(2),
    productId: undefined,
    description: "",
    qty: 1,
    unitPrice: 0,
    taxable: false,
  };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function NewInvoicePage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();
  const createInvoice = useCreateInvoice();

  React.useEffect(() => { setTitle("New Invoice"); }, [setTitle]);

  const [customer, setCustomer] = React.useState<Customer | null>(null);
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
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  // ── Calculations ────────────────────────────────────────────────────────────

  const subtotal = items.reduce((s, it) => s + Number(it.qty) * Number(it.unitPrice), 0);
  const tax = items
    .filter((it) => it.taxable)
    .reduce((s, it) => s + Number(it.qty) * Number(it.unitPrice) * TAX_RATE, 0);
  const total = subtotal + tax;

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
      items: items.map((it): CreateInvoiceItem => ({
        productId: it.productId,
        description: it.description,
        qty: Number(it.qty),
        unitPrice: Number(it.unitPrice),
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
          <Card title="Customer">
            <CustomerSearch
              value={customer}
              onSelect={setCustomer}
              error={errors.customer}
            />
          </Card>

          {/* Dates */}
          <Card title="Invoice Dates">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-navy/80">
                  Issue Date
                </label>
                <input
                  type="date"
                  value={issueDate}
                  onChange={(e) => setIssueDate(e.target.value)}
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
                  Due Date
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
          </Card>

          {/* Line items */}
          <Card title="Line Items">
            <div className="space-y-2">
              {errors.items && (
                <p className="text-xs text-danger">{errors.items}</p>
              )}
              {/* Table header */}
              <div className="grid grid-cols-[1fr_80px_100px_44px_32px] gap-2 px-1">
                <span className="text-xs font-medium text-navy/50">Description</span>
                <span className="text-xs font-medium text-navy/50 text-right">Qty</span>
                <span className="text-xs font-medium text-navy/50 text-right">Unit Price</span>
                <span className="text-xs font-medium text-navy/50 text-center">Tax</span>
                <span />
              </div>

              {items.map((item) => (
                <div
                  key={item.key}
                  className="grid grid-cols-[1fr_80px_100px_44px_32px] items-center gap-2"
                >
                  {/* Description / product search */}
                  <ProductSearchInput
                    value={item.description}
                    onChange={(description, productId, unitPrice) => {
                      updateItem(item.key, {
                        description,
                        productId,
                        unitPrice: unitPrice !== undefined ? unitPrice : item.unitPrice,
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
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    value={item.unitPrice}
                    onChange={(e) => updateItem(item.key, { unitPrice: parseFloat(e.target.value) || 0 })}
                    className="h-9 rounded border border-surface-border bg-white px-2 text-right text-sm text-navy focus:border-transparent focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />

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
                  className="flex justify-end px-1 text-xs text-navy/50"
                >
                  <span className="w-[100px] text-right">
                    = {fmt.format(Number(item.qty) * Number(item.unitPrice))}
                  </span>
                  <span className="w-[44px]" />
                  <span className="w-[32px]" />
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
          </Card>

          {/* Notes */}
          <Card title="Notes">
            <textarea
              rows={3}
              placeholder="Add any notes or payment terms…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
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
                <dd className="font-medium text-navy">{fmt.format(subtotal)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-navy/60">Tax ({(TAX_RATE * 100).toFixed(0)}%)</dt>
                <dd className="font-medium text-navy">{fmt.format(tax)}</dd>
              </div>
              <div className="flex justify-between border-t border-surface-border pt-2">
                <dt className="font-semibold text-navy">Total</dt>
                <dd className="text-base font-bold text-navy">{fmt.format(total)}</dd>
              </div>
            </dl>

            <div className="mt-5 space-y-2">
              <Button
                className="w-full"
                variant="secondary"
                onClick={() => handleSubmit(false)}
                loading={createInvoice.isPending}
                disabled={createInvoice.isPending}
              >
                Save as Draft
              </Button>
              <Button
                className="w-full"
                onClick={() => handleSubmit(true)}
                loading={createInvoice.isPending}
                disabled={createInvoice.isPending}
              >
                Send Invoice
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
