"use client";

import * as React from "react";
import { Plus, Trash2, Search } from "lucide-react";
import { Button, Card, cn } from "@routeflow/ui/web";
import {
  type CreateRecurringInvoiceDto,
  type RecurringInvoice,
  type RecurringInvoiceItem,
} from "@/lib/api/invoices";
import { useCustomers, type Customer } from "@/lib/api/customers";
import { useProducts } from "@/lib/api/products";
import { DecimalInput, MoneyInput } from "@/components/MoneyInput";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

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

  React.useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
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
          {value.contactName && <p className="text-xs text-navy/70">{value.contactName}</p>}
        </div>
        <button
          onClick={() => onSelect(null)}
          className="rounded p-1 text-navy/70 hover:text-danger transition-colors"
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
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          className={cn(
            "h-10 w-full rounded-lg border bg-white pl-9 pr-3 text-sm text-navy placeholder:text-navy/70 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
            error ? "border-danger" : "border-surface-border",
          )}
        />
      </div>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      {open && (
        <div className="absolute z-10 mt-1 w-full rounded-lg border border-surface-border bg-white shadow-lg">
          {customers.length === 0 ? (
            <p className="px-3 py-2 text-sm text-navy/70">No customers found.</p>
          ) : (
            <ul className="max-h-48 overflow-y-auto">
              {customers.map((c) => (
                <li key={c.id}>
                  <button
                    className="flex w-full flex-col px-3 py-2 text-left hover:bg-surface-raised"
                    onClick={() => {
                      onSelect(c);
                      setOpen(false);
                      setQuery("");
                    }}
                  >
                    <span className="text-sm font-medium text-navy">{c.businessName}</span>
                    {c.contactName && <span className="text-xs text-navy/70">{c.contactName}</span>}
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

// ─── Product search input ─────────────────────────────────────────────────────

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
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
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
                  <span className="text-sm font-medium text-navy">{p.name}</span>
                  <span className="text-xs text-navy/70">{fmt.format(Number(p.pricePerUnit))}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Line item state ──────────────────────────────────────────────────────────

interface LineItemState {
  key: string;
  productId?: string;
  description: string;
  qty: number;
  unitPrice: number;
  taxRate: number;
  discount: number;
}

function createEmptyItem(): LineItemState {
  return {
    key: Math.random().toString(36).slice(2),
    description: "",
    qty: 1,
    unitPrice: 0,
    taxRate: 0,
    discount: 0,
  };
}

function itemsFromInitial(initial?: RecurringInvoice): LineItemState[] {
  if (!initial || initial.items.length === 0) return [createEmptyItem()];
  return initial.items.map((it, i) => ({
    key: String(i),
    productId: it.productId,
    description: it.description,
    qty: Number(it.qty),
    unitPrice: Number(it.unitPrice),
    taxRate: Number(it.taxRate ?? 0),
    discount: Number(it.discount ?? 0),
  }));
}

// ─── Form ─────────────────────────────────────────────────────────────────────

export interface RecurringInvoiceFormProps {
  mode: "create" | "edit";
  /** edit: the loaded template; seeds every field once (keyed on initial?.id). */
  initial?: RecurringInvoice;
  onSubmit: (dto: CreateRecurringInvoiceDto) => void;
  isPending: boolean;
  submitLabel: string;
}

export function RecurringInvoiceForm({
  mode,
  initial,
  onSubmit,
  isPending,
  submitLabel,
}: RecurringInvoiceFormProps) {
  // Unused in edit mode: the Customer card renders `initial.customer` read-only
  // instead of <CustomerSearch>, and the submitted dto uses `initial.customerId`.
  const [customer, setCustomer] = React.useState<Customer | null>(null);
  const [frequency, setFrequency] = React.useState<"WEEKLY" | "BIWEEKLY" | "MONTHLY">(
    initial?.frequency ?? "MONTHLY",
  );
  const [dayOfWeek, setDayOfWeek] = React.useState(initial?.dayOfWeek ?? 1); // Monday
  const [dayOfMonth, setDayOfMonth] = React.useState(initial?.dayOfMonth ?? 1);
  const [autoSend, setAutoSend] = React.useState(initial?.autoSend ?? false);
  const [nextRunAt, setNextRunAt] = React.useState(() => {
    if (initial) return initial.nextRunAt.slice(0, 10);
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  });
  const [notes, setNotes] = React.useState(initial?.notes ?? "");
  const [terms, setTerms] = React.useState(initial?.terms ?? "");
  const [discount, setDiscount] = React.useState(String(initial?.discount ?? 0));
  const [shippingFee, setShippingFee] = React.useState(String(initial?.shippingFee ?? 0));
  const [items, setItems] = React.useState<LineItemState[]>(() => itemsFromInitial(initial));
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  function updateItem(key: string, patch: Partial<LineItemState>) {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  }

  function validate() {
    const errs: Record<string, string> = {};
    if (mode === "create" && !customer) errs.customer = "Please select a customer.";
    if (!nextRunAt) errs.nextRunAt = "First run date is required.";
    if (items.length === 0) errs.items = "Add at least one line item.";
    for (const it of items) {
      if (!it.description.trim()) {
        errs.items = "All items need a description.";
        break;
      }
      if (Number(it.qty) <= 0) {
        errs.items = "All quantities must be > 0.";
        break;
      }
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function handleSubmit() {
    if (!validate()) return;

    // In edit mode an emptied field is an instruction to CLEAR the value, so it must be
    // sent explicitly: `"" || undefined` and `0 || undefined` both collapse to undefined,
    // JSON.stringify drops undefined keys, and the PATCH only writes fields that arrive
    // `!== undefined` — a cleared discount/shipping fee/note would silently keep its old
    // value behind a success toast. Create keeps the omit-when-blank shape (the API
    // defaults notes/terms to NULL and the money fields to 0).
    const isEdit = mode === "edit";
    const parsedDiscount = parseFloat(discount);
    const parsedShippingFee = parseFloat(shippingFee);

    const dto: CreateRecurringInvoiceDto = {
      customerId: mode === "edit" ? initial!.customerId : customer!.id,
      frequency,
      dayOfWeek: frequency !== "MONTHLY" ? dayOfWeek : undefined,
      dayOfMonth: frequency === "MONTHLY" ? dayOfMonth : undefined,
      autoSend,
      nextRunAt: new Date(nextRunAt).toISOString(),
      notes: isEdit ? notes.trim() : notes.trim() || undefined,
      terms: isEdit ? terms.trim() : terms.trim() || undefined,
      discount: Number.isFinite(parsedDiscount) ? parsedDiscount : isEdit ? 0 : undefined,
      shippingFee: Number.isFinite(parsedShippingFee) ? parsedShippingFee : isEdit ? 0 : undefined,
      items: items.map((it): RecurringInvoiceItem => ({
        productId: it.productId,
        description: it.description,
        qty: Number(it.qty),
        unitPrice: Number(it.unitPrice),
        taxRate: Number(it.taxRate) || undefined,
        discount: Number(it.discount) || undefined,
      })),
    };

    onSubmit(dto);
  }

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
      {/* ── Left (3/5) ── */}
      <div className="space-y-5 lg:col-span-3">
        {/* Customer */}
        <Card title="Customer">
          {mode === "edit" ? (
            <div className="rounded-lg border border-surface-border px-3 py-2.5">
              <p className="text-sm font-semibold text-navy">
                {initial?.customer?.businessName ?? initial?.customerId}
              </p>
              <p className="text-xs text-navy/70">
                Customer can&apos;t be changed on an existing template.
              </p>
            </div>
          ) : (
            <CustomerSearch value={customer} onSelect={setCustomer} error={errors.customer} />
          )}
        </Card>

        {/* Schedule */}
        <Card title="Schedule">
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-navy/80">Frequency</label>
              <select
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as typeof frequency)}
                className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="WEEKLY">Weekly</option>
                <option value="BIWEEKLY">Every 2 weeks</option>
                <option value="MONTHLY">Monthly</option>
              </select>
            </div>

            {frequency !== "MONTHLY" ? (
              <div>
                <label className="mb-1.5 block text-sm font-medium text-navy/80">Day of Week</label>
                <select
                  value={dayOfWeek}
                  onChange={(e) => setDayOfWeek(Number(e.target.value))}
                  className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  <option value={0}>Sunday</option>
                  <option value={1}>Monday</option>
                  <option value={2}>Tuesday</option>
                  <option value={3}>Wednesday</option>
                  <option value={4}>Thursday</option>
                  <option value={5}>Friday</option>
                  <option value={6}>Saturday</option>
                </select>
              </div>
            ) : (
              <div>
                <label className="mb-1.5 block text-sm font-medium text-navy/80">
                  Day of Month
                </label>
                <input
                  type="number"
                  min={1}
                  max={28}
                  value={dayOfMonth}
                  onChange={(e) => setDayOfMonth(Number(e.target.value))}
                  className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <p className="mt-1 text-xs text-navy/70">Use 1–28 to avoid month-end issues.</p>
              </div>
            )}

            <div>
              <label className="mb-1.5 block text-sm font-medium text-navy/80">
                {mode === "edit" ? "Next Run Date" : "First Run Date"}
              </label>
              <input
                type="date"
                value={nextRunAt}
                onChange={(e) => setNextRunAt(e.target.value)}
                className={cn(
                  "h-10 w-full rounded-lg border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
                  errors.nextRunAt ? "border-danger" : "border-surface-border",
                )}
              />
              {errors.nextRunAt && <p className="mt-1 text-xs text-danger">{errors.nextRunAt}</p>}
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autoSend}
                onChange={(e) => setAutoSend(e.target.checked)}
                className="h-4 w-4 rounded border-surface-border text-brand-500 focus:ring-brand-500"
              />
              <span className="text-sm text-navy">Auto-send generated invoices to customer</span>
            </label>
          </div>
        </Card>

        {/* Line items */}
        <Card title="Line Items">
          <div className="space-y-2">
            {errors.items && <p className="text-xs text-danger">{errors.items}</p>}
            <div className="grid grid-cols-[1fr_70px_90px_32px] gap-2 px-1">
              <span className="text-xs font-medium text-navy/70">Description</span>
              <span className="text-xs font-medium text-navy/70 text-right">Qty</span>
              <span className="text-xs font-medium text-navy/70 text-right">Unit Price</span>
              <span />
            </div>
            {items.map((item) => (
              <div
                key={item.key}
                className="grid grid-cols-[1fr_70px_90px_32px] items-center gap-2"
              >
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
                <DecimalInput
                  decimals={3}
                  min={0}
                  value={item.qty}
                  onChange={(v) => updateItem(item.key, { qty: v ?? 0 })}
                  className="h-9 rounded border border-surface-border bg-white px-2 text-right text-sm text-navy focus:border-transparent focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
                <MoneyInput
                  min={0}
                  value={item.unitPrice}
                  onChange={(v) => updateItem(item.key, { unitPrice: v ?? 0 })}
                  className="h-9 rounded border border-surface-border bg-white px-2 text-right text-sm text-navy focus:border-transparent focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
                <button
                  onClick={() => setItems((prev) => prev.filter((it) => it.key !== item.key))}
                  disabled={items.length === 1}
                  className="flex items-center justify-center rounded p-1 text-navy/30 hover:text-danger transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <button
              onClick={() => setItems((prev) => [...prev, createEmptyItem()])}
              className="mt-2 flex items-center gap-1.5 text-sm font-medium text-brand-500 hover:text-brand-600 transition-colors"
            >
              <Plus className="h-4 w-4" />
              Add Line Item
            </button>
          </div>
        </Card>

        {/* Notes */}
        <Card title="Notes & Terms">
          <div className="space-y-3">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-navy/80">Notes</label>
              <textarea
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full resize-none rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-navy/80">Payment Terms</label>
              <textarea
                rows={2}
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
                className="w-full resize-none rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          </div>
        </Card>
      </div>

      {/* ── Right (2/5) ── */}
      <div className="space-y-4 lg:col-span-2">
        <Card title="Adjustments">
          <div className="space-y-3">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-navy/80">
                Invoice Discount ($)
              </label>
              <input
                type="number"
                min={0}
                step={0.01}
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
                className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-navy/80">
                Shipping Fee ($)
              </label>
              <input
                type="number"
                min={0}
                step={0.01}
                value={shippingFee}
                onChange={(e) => setShippingFee(e.target.value)}
                className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          </div>
        </Card>

        <Card>
          <Button className="w-full" onClick={handleSubmit} loading={isPending}>
            {submitLabel}
          </Button>
          <Button
            className="mt-2 w-full"
            variant="secondary"
            href="/invoices/recurring"
            disabled={isPending}
          >
            Cancel
          </Button>
        </Card>
      </div>
    </div>
  );
}
