"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Plus, Trash2, Search, Loader2 } from "lucide-react";
import { Button, Card, useToast, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useInvoice, useUpdateInvoice, type CreateInvoiceItem } from "@/lib/api/invoices";
import { useCustomers } from "@/lib/api/customers";
import { useProducts } from "@/lib/api/products";
import { apiClient } from "@/lib/api-client";
import { InlineCreateProductModal } from "@/components/InlineCreateProductModal";
import { BarcodeScannerButton } from "@/components/BarcodeScannerButton";
import { displayProductName } from "@/lib/product-display";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

// ─── Product search dropdown (inline) ────────────────────────────────────────

function ProductSearchInput({
  value,
  onChange,
  onCreateProduct,
  onBarcodeNotFound,
}: {
  value: string;
  onChange: (description: string, productId?: string, unitPrice?: number) => void;
  onCreateProduct?: (searchTerm: string) => void;
  onBarcodeNotFound?: (barcode: string) => void;
}) {
  const [query, setQuery] = React.useState(value);
  const [debouncedQuery, setDebouncedQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

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
    <div ref={ref} className="relative flex items-center gap-1">
      <input
        ref={inputRef}
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
      <BarcodeScannerButton
        inputRef={inputRef}
        onScan={async (code) => {
          try {
            const product = await apiClient.get(`/products/barcode/${encodeURIComponent(code)}`).then((r) => r.data);
            if (product) {
              setQuery(product.name);
              onChange(product.name, product.id, product.pricePerUnit);
              setOpen(false);
              return;
            }
          } catch {
            // product not found by barcode
          }
          if (onBarcodeNotFound) onBarcodeNotFound(code);
        }}
      />
      {open && debouncedQuery.length > 0 && (products.length > 0 || onCreateProduct) && (
        <div className="absolute z-10 mt-1 w-full rounded-lg border border-surface-border bg-white shadow-lg">
          <ul className="max-h-36 overflow-y-auto">
            {products.length === 0 && (
              <li className="px-3 py-2 text-sm text-navy/50">No products found.</li>
            )}
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
            {onCreateProduct && (
              <li className="border-t border-surface-border">
                <button
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-brand-500 hover:bg-surface-raised font-medium"
                  onClick={() => {
                    onCreateProduct(debouncedQuery);
                    setOpen(false);
                  }}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Create new product{debouncedQuery ? `: "${debouncedQuery}"` : ""}
                </button>
              </li>
            )}
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function EditInvoicePage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();

  const { data: invoice, isLoading, isError } = useInvoice(params.id);
  const updateInvoice = useUpdateInvoice();

  const [initialized, setInitialized] = React.useState(false);
  const [issueDate, setIssueDate] = React.useState("");
  const [dueDate, setDueDate] = React.useState("");
  const [discount, setDiscount] = React.useState("0");
  const [shippingFee, setShippingFee] = React.useState("0");
  const [notes, setNotes] = React.useState("");
  const [terms, setTerms] = React.useState("");
  const [referenceNumber, setReferenceNumber] = React.useState("");
  const [subject, setSubject] = React.useState("");
  const [items, setItems] = React.useState<LineItemState[]>([createEmptyItem()]);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  // Create-product modal state
  const [createProductOpen, setCreateProductOpen] = React.useState(false);
  const [createProductInitialName, setCreateProductInitialName] = React.useState("");
  const [createProductInitialSku, setCreateProductInitialSku] = React.useState("");
  const [createProductTargetIdx, setCreateProductTargetIdx] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (invoice && !initialized) {
      setTitle(`Edit ${invoice.invoiceNumber}`);
      setIssueDate(invoice.issueDate ? invoice.issueDate.slice(0, 10) : new Date().toISOString().slice(0, 10));
      setDueDate(invoice.dueDate ? invoice.dueDate.slice(0, 10) : "");
      setDiscount(String(Number(invoice.discount ?? 0)));
      setShippingFee(String(Number(invoice.shippingFee ?? 0)));
      setNotes(invoice.notes ?? "");
      setTerms(invoice.terms ?? "");
      setReferenceNumber(invoice.referenceNumber ?? "");
      setSubject(invoice.subject ?? "");
      setItems(
        (invoice.items ?? []).length > 0
          ? (invoice.items ?? []).map((it) => ({
              key: it.id,
              productId: it.productId,
              description: it.description,
              qty: Number(it.qty),
              unitPrice: Number(it.unitPrice),
              taxRate: Number(it.taxRate ?? 0),
              discount: Number(it.discount ?? 0),
            }))
          : [createEmptyItem()],
      );
      setInitialized(true);
    }
  }, [invoice, initialized, setTitle]);

  // ── Calculations ─────────────────────────────────────────────────────────────

  const subtotal = items.reduce((s, it) => s + Number(it.qty) * Number(it.unitPrice) - Number(it.discount), 0);
  const taxTotal = items.reduce((s, it) => {
    const lineSub = Number(it.qty) * Number(it.unitPrice) - Number(it.discount);
    return s + lineSub * Number(it.taxRate);
  }, 0);
  const invDiscount = parseFloat(discount) || 0;
  const shipping = parseFloat(shippingFee) || 0;
  const total = subtotal - invDiscount + shipping + taxTotal;

  // ── Item helpers ──────────────────────────────────────────────────────────────

  function updateItem(key: string, patch: Partial<LineItemState>) {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  }

  function removeItem(key: string) {
    setItems((prev) => prev.filter((it) => it.key !== key));
  }

  function addItem() {
    setItems((prev) => [...prev, createEmptyItem()]);
  }

  // ── Validation ────────────────────────────────────────────────────────────────

  function validate() {
    const errs: Record<string, string> = {};
    if (!issueDate) errs.issueDate = "Issue date is required.";
    if (items.length === 0) errs.items = "Add at least one line item.";
    for (const it of items) {
      if (!it.description.trim()) { errs.items = "All line items must have a description."; break; }
      if (Number(it.qty) <= 0) { errs.items = "All quantities must be greater than 0."; break; }
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  // ── Submit ────────────────────────────────────────────────────────────────────

  function handleSubmit() {
    if (!validate()) return;

    const dto = {
      id: params.id,
      issueDate: issueDate || undefined,
      dueDate: dueDate || undefined,
      discount: invDiscount,
      shippingFee: shipping,
      notes: notes.trim() || undefined,
      terms: terms.trim() || undefined,
      referenceNumber: referenceNumber.trim() || undefined,
      subject: subject.trim() || undefined,
      items: items.map((it): CreateInvoiceItem => ({
        productId: it.productId,
        description: it.description,
        qty: Number(it.qty),
        unitPrice: Number(it.unitPrice),
        taxRate: it.taxRate != null ? Number(it.taxRate) : undefined,
        discount: it.discount != null && Number(it.discount) !== 0 ? Number(it.discount) : undefined,
      })),
    };

    updateInvoice.mutate(dto, {
      onSuccess: () => {
        toast({ title: "Invoice updated", description: "Draft invoice has been saved.", variant: "success" });
        router.push(`/invoices/${params.id}`);
      },
      onError: (err: any) => {
        toast({ title: "Failed to update invoice", description: err?.response?.data?.message ?? "Please try again.", variant: "error" });
      },
    });
  }

  // ── Guards ────────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-navy/40" />
      </div>
    );
  }

  if (isError || !invoice) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Invoice not found.</p>
        <Button variant="secondary" href="/invoices">Back to Invoices</Button>
      </div>
    );
  }

  if (invoice.status !== "DRAFT") {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Only DRAFT invoices can be edited.</p>
        <Button variant="secondary" href={`/invoices/${params.id}`}>Back to Invoice</Button>
      </div>
    );
  }

  return (
    <div className="space-y-5 p-6">
      <Link href={`/invoices/${params.id}`} className="flex items-center gap-1.5 text-sm text-navy/60 hover:text-navy transition-colors">
        <ArrowLeft className="h-4 w-4" />
        {invoice.invoiceNumber}
      </Link>

      <h1 className="text-2xl font-bold text-navy">Edit Invoice</h1>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
        {/* ── Left column (3/5) ── */}
        <div className="space-y-5 lg:col-span-3">

          {/* Dates */}
          <Card title="Invoice Dates">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-navy/80">Issue Date</label>
                <input
                  type="date"
                  value={issueDate}
                  onChange={(e) => setIssueDate(e.target.value)}
                  className={cn(
                    "h-10 w-full rounded-lg border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
                    errors.issueDate ? "border-danger" : "border-surface-border",
                  )}
                />
                {errors.issueDate && <p className="mt-1 text-xs text-danger">{errors.issueDate}</p>}
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-navy/80">Due Date</label>
                <input
                  type="date"
                  value={dueDate}
                  min={issueDate || undefined}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
            </div>
          </Card>

          {/* Line items */}
          <Card title="Line Items">
            <div className="space-y-2">
              {errors.items && <p className="text-xs text-danger">{errors.items}</p>}
              {/* Table header */}
              <div className="grid grid-cols-[1fr_70px_90px_70px_70px_32px] gap-2 px-1">
                <span className="text-xs font-medium text-navy/50">Description</span>
                <span className="text-xs font-medium text-navy/50 text-right">Qty</span>
                <span className="text-xs font-medium text-navy/50 text-right">Unit Price</span>
                <span className="text-xs font-medium text-navy/50 text-right">Disc. $</span>
                <span className="text-xs font-medium text-navy/50 text-right">Tax %</span>
                <span />
              </div>

              {items.map((item) => (
                <div key={item.key} className="grid grid-cols-[1fr_70px_90px_70px_70px_32px] items-center gap-2">
                  <ProductSearchInput
                    value={item.description}
                    onCreateProduct={(searchTerm) => {
                      const idx = items.findIndex((it) => it.key === item.key);
                      const looksLikeSku = /^\d{6,}$/.test(searchTerm.trim());
                      setCreateProductInitialName(looksLikeSku ? "" : searchTerm);
                      setCreateProductInitialSku(looksLikeSku ? searchTerm.trim() : "");
                      setCreateProductTargetIdx(idx);
                      setCreateProductOpen(true);
                    }}
                    onBarcodeNotFound={(barcode) => {
                      const idx = items.findIndex((it) => it.key === item.key);
                      setCreateProductInitialName("");
                      setCreateProductInitialSku(barcode);
                      setCreateProductTargetIdx(idx);
                      setCreateProductOpen(true);
                    }}
                    onChange={(description, productId, unitPrice) => {
                      updateItem(item.key, {
                        description,
                        productId,
                        unitPrice: unitPrice !== undefined ? unitPrice : item.unitPrice,
                      });
                    }}
                  />
                  <input
                    type="number" min={0.01} step={0.01} value={item.qty}
                    onChange={(e) => updateItem(item.key, { qty: parseFloat(e.target.value) || 0 })}
                    className="h-9 rounded border border-surface-border bg-white px-2 text-right text-sm text-navy focus:border-transparent focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                  <input
                    type="number" min={0} step={0.01} value={item.unitPrice}
                    onChange={(e) => updateItem(item.key, { unitPrice: parseFloat(e.target.value) || 0 })}
                    className="h-9 rounded border border-surface-border bg-white px-2 text-right text-sm text-navy focus:border-transparent focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                  <input
                    type="number" min={0} step={0.01} value={item.discount}
                    onChange={(e) => updateItem(item.key, { discount: parseFloat(e.target.value) || 0 })}
                    className="h-9 rounded border border-surface-border bg-white px-2 text-right text-sm text-navy focus:border-transparent focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                  <input
                    type="number" min={0} max={1} step={0.01} value={item.taxRate}
                    placeholder="0.10"
                    onChange={(e) => updateItem(item.key, { taxRate: parseFloat(e.target.value) || 0 })}
                    className="h-9 rounded border border-surface-border bg-white px-2 text-right text-sm text-navy focus:border-transparent focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                  <button
                    onClick={() => removeItem(item.key)}
                    disabled={items.length === 1}
                    className="flex items-center justify-center rounded p-1 text-navy/30 hover:text-danger transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
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

          {/* Notes & Terms */}
          <Card title="Notes & Terms">
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-navy/80">
                    Reference / PO Number <span className="text-navy/40 font-normal">(optional)</span>
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. PO-1234"
                    value={referenceNumber}
                    onChange={(e) => setReferenceNumber(e.target.value)}
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
              <div>
                <label className="mb-1.5 block text-sm font-medium text-navy/80">Notes</label>
                <textarea
                  rows={3}
                  placeholder="Add any notes for the customer…"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full resize-none rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-navy/80">Payment Terms</label>
                <textarea
                  rows={2}
                  placeholder="e.g. Net 30, payment due within 30 days…"
                  value={terms}
                  onChange={(e) => setTerms(e.target.value)}
                  className="w-full resize-none rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
            </div>
          </Card>
        </div>

        {/* ── Right column (2/5) ── */}
        <div className="space-y-4 lg:col-span-2">
          {/* Adjustments */}
          <Card title="Adjustments">
            <div className="space-y-3">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-navy/80">Invoice Discount ($)</label>
                <input
                  type="number" min={0} step={0.01} value={discount}
                  onChange={(e) => setDiscount(e.target.value)}
                  className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-navy/80">Shipping Fee ($)</label>
                <input
                  type="number" min={0} step={0.01} value={shippingFee}
                  onChange={(e) => setShippingFee(e.target.value)}
                  className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
            </div>
          </Card>

          {/* Summary */}
          <Card title="Invoice Summary">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-navy/60">Subtotal</dt>
                <dd className="font-medium text-navy">{fmt.format(subtotal)}</dd>
              </div>
              {invDiscount > 0 && (
                <div className="flex justify-between text-success">
                  <dt>Discount</dt>
                  <dd>-{fmt.format(invDiscount)}</dd>
                </div>
              )}
              {taxTotal > 0 && (
                <div className="flex justify-between text-navy/60">
                  <dt>Tax</dt>
                  <dd className="font-medium text-navy">{fmt.format(taxTotal)}</dd>
                </div>
              )}
              {shipping > 0 && (
                <div className="flex justify-between text-navy/60">
                  <dt>Shipping</dt>
                  <dd className="font-medium text-navy">{fmt.format(shipping)}</dd>
                </div>
              )}
              <div className="flex justify-between border-t border-surface-border pt-2">
                <dt className="font-semibold text-navy">Total</dt>
                <dd className="text-base font-bold text-navy">{fmt.format(total)}</dd>
              </div>
            </dl>

            <div className="mt-5 space-y-2">
              <Button
                className="w-full"
                onClick={handleSubmit}
                loading={updateInvoice.isPending}
                disabled={updateInvoice.isPending}
              >
                Save Changes
              </Button>
              <Button
                className="w-full"
                variant="secondary"
                href={`/invoices/${params.id}`}
                disabled={updateInvoice.isPending}
              >
                Cancel
              </Button>
            </div>
          </Card>
        </div>
      </div>

      <InlineCreateProductModal
        isOpen={createProductOpen}
        onClose={() => { setCreateProductOpen(false); setCreateProductTargetIdx(null); }}
        onCreated={(product) => {
          if (createProductTargetIdx !== null) {
            setItems((prev) =>
              prev.map((item, i) =>
                i === createProductTargetIdx
                  ? {
                      ...item,
                      description: displayProductName(product),
                      productId: product.id,
                      unitPrice: parseFloat(product.pricePerUnit) || 0,
                    }
                  : item
              )
            );
          }
          setCreateProductOpen(false);
          setCreateProductTargetIdx(null);
        }}
        initialName={createProductInitialName}
        initialSku={createProductInitialSku}
      />
    </div>
  );
}
