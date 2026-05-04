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
  ChevronRight,
} from "lucide-react";
import { Button, Card, Input, useToast, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useQuery } from "@tanstack/react-query";
import {
  useCreateInvoice,
  useUpdateInvoice,
  type CreateInvoiceItem,
} from "@/lib/api/invoices";
import { useCustomers, useCustomerPrices, type Customer } from "@/lib/api/customers";
import { useProducts } from "@/lib/api/products";
import { apiClient } from "@/lib/api-client";
import { fetchPdfBlob } from "@/lib/fetch-pdf-blob";
import { BarcodeScannerButton } from "@/components/BarcodeScannerButton";
import { InlineCreateProductModal } from "@/components/InlineCreateProductModal";
import { fmt } from "@/lib/formatting";

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
  onCreateProduct,
  onBarcodeNotFound,
}: {
  value: string;
  onChange: (description: string, productId: string, unitPrice: string, avgCost?: number, unitsPerBox?: number) => void;
  onCreateProduct?: (searchTerm: string) => void;
  onBarcodeNotFound?: (barcode: string) => void;
}) {
  const [query, setQuery] = React.useState(value);
  const [debouncedQuery, setDebouncedQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [expandedParentId, setExpandedParentId] = React.useState<string | null>(null);
  const ref = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  const { data } = useProducts({ search: debouncedQuery || undefined, isActive: true, limit: 20, includeVariants: true });
  // Only top-level products (parents + standalones) shown at root; variants appear as children
  const products = (data?.data ?? []).filter((p: any) => !p.parentProductId);

  React.useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  function selectProduct(p: any) {
    onChange(
      p.name,
      p.id,
      String(p.pricePerUnit),
      p.averageCost ? parseFloat(String(p.averageCost)) : undefined,
      p.unitsPerBox ? Number(p.unitsPerBox) : undefined,
    );
    setQuery(p.name);
    setOpen(false);
    setExpandedParentId(null);
  }

  return (
    <div ref={ref} className="relative flex items-center gap-1">
      <input
        ref={inputRef}
        type="text"
        placeholder="Description / product…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          onChange(e.target.value, "", "0", undefined, undefined);
          setOpen(true);
          setExpandedParentId(null);
        }}
        onFocus={() => setOpen(true)}
        className="h-9 w-full rounded border border-surface-border bg-white px-2.5 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-1 focus:ring-brand-500"
      />
      <BarcodeScannerButton
        inputRef={inputRef}
        onScan={async (code) => {
          try {
            const product = await apiClient.get(`/products/barcode/${encodeURIComponent(code)}`).then(r => r.data);
            if (product) { selectProduct(product); return; }
          } catch {
            // product not found by barcode
          }
          // Not found — open create-product modal with scanned code as SKU
          if (onBarcodeNotFound) {
            onBarcodeNotFound(code);
          }
        }}
      />
      {open && debouncedQuery.length > 0 && (products.length > 0 || onCreateProduct) && (
        <div className="absolute left-0 top-full z-10 mt-1 w-full rounded-lg border border-surface-border bg-white shadow-lg">
          <ul className="max-h-48 overflow-y-auto">
            {products.length === 0 && (
              <li className="px-3 py-2 text-sm text-navy/50">No products found.</li>
            )}
            {products.map((p: any) => {
              const hasVariants = p.variants?.length > 0;
              const isExpanded = expandedParentId === p.id;
              return (
                <React.Fragment key={p.id}>
                  <li>
                    <button
                      className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-surface-raised"
                      onClick={() => {
                        if (hasVariants) {
                          setExpandedParentId(isExpanded ? null : p.id);
                        } else {
                          selectProduct(p);
                        }
                      }}
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        {hasVariants && (
                          <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-navy/40 transition-transform", isExpanded && "rotate-90")} />
                        )}
                        <span className="text-sm font-medium text-navy truncate">{p.name}</span>
                        {p.sku && <span className="ml-1 text-xs text-navy/40 shrink-0">{p.sku}</span>}
                        {hasVariants && <span className="text-[10px] text-navy/40 shrink-0">{p.variants.length} variants</span>}
                      </div>
                      {!hasVariants && <span className="text-xs text-navy/60 shrink-0 ml-2">{fmt(Number(p.pricePerUnit))}</span>}
                    </button>
                  </li>
                  {hasVariants && isExpanded && p.variants.map((v: any) => (
                    <li key={v.id} className="bg-surface-raised/50">
                      <button
                        className="flex w-full items-center justify-between pl-8 pr-3 py-2 text-left hover:bg-surface-raised"
                        onClick={() => selectProduct(v)}
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-sm font-medium text-navy truncate">{v.variantName ?? v.name}</span>
                          {v.sku && <span className="text-xs text-navy/40 shrink-0">{v.sku}</span>}
                        </div>
                        <span className="text-xs text-navy/60 shrink-0 ml-2">{fmt(Number(v.pricePerUnit))}</span>
                      </button>
                    </li>
                  ))}
                </React.Fragment>
              );
            })}
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
  unitsPerBox?: number;       // set when product has box packaging
  boxes?: number;             // whole boxes (only when unitsPerBox is set)
  pieces?: number;            // extra loose pieces (only when unitsPerBox is set)
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
  const updateInvoice = useUpdateInvoice();

  // Track the draft id we've previewed so subsequent "Preview" clicks update
  // the same draft instead of creating a new one each time.
  const [currentDraftId, setCurrentDraftId] = React.useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = React.useState(false);

  React.useEffect(() => { setTitle("New Invoice"); }, [setTitle]);

  const [customer, setCustomer] = React.useState<Customer | null>(null);
  const [reference, setReference] = React.useState("");
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

  // Create-product modal state
  const [createProductOpen, setCreateProductOpen] = React.useState(false);
  const [createProductInitialName, setCreateProductInitialName] = React.useState("");
  const [createProductInitialSku, setCreateProductInitialSku] = React.useState("");
  const [createProductTargetIdx, setCreateProductTargetIdx] = React.useState<number | null>(null);

  const { data: settings } = useQuery<{
    taxRate?: number;
    invoiceNotes?: string;
    invoiceTerms?: string;
  }>({
    queryKey: ["settings"],
    queryFn: () => apiClient.get("/settings").then((r) => r.data),
    staleTime: 60_000,
  });
  const taxRate = (settings?.taxRate ?? 0) / 100;

  // Prefill customer-facing Notes & Terms from the tenant's Invoicing
  // settings the first time they arrive. Don't overwrite any edits the
  // operator has already made — only fill when the field is still empty.
  const didPrefillRef = React.useRef(false);
  React.useEffect(() => {
    if (didPrefillRef.current) return;
    if (!settings) return;
    didPrefillRef.current = true;
    if (settings.invoiceNotes && !notes) setNotes(settings.invoiceNotes);
    if (settings.invoiceTerms && !termsText) setTermsText(settings.invoiceTerms);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

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
    .reduce((s, it) => s + lineTotal(it) * taxRate, 0);
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

  /**
   * Add a product from the catalog as a new line item, mirroring the order
   * modal's flow. If the only existing row is the seeded blank row, replace
   * it instead of appending so the table doesn't grow a stray empty line.
   * If the product is already on the invoice, just bump its qty by one box
   * (or 1 unit) — same ergonomics as the order scan flow.
   */
  function addProductFromCatalog(product: any) {
    const upb = product.unitsPerBox ? Number(product.unitsPerBox) : undefined;
    const specialPrice: number | undefined = priceMap[product.id];
    const listPrice = parseFloat(String(product.pricePerUnit ?? 0));
    const effectivePrice = specialPrice ?? listPrice;

    const lineItem: LineItemState = {
      key: Math.random().toString(36).slice(2),
      productId: product.id,
      description: product.name,
      qty: upb ? upb : 1,
      unitPrice: effectivePrice,
      discount: 0,
      taxable: false,
      regularPrice: specialPrice !== undefined ? listPrice : undefined,
      isSpecialPrice: specialPrice !== undefined,
      avgCost: product.averageCost ? parseFloat(String(product.averageCost)) : undefined,
      unitsPerBox: upb,
      boxes: upb ? 1 : undefined,
      pieces: upb ? 0 : undefined,
    };

    setItems((prev) => {
      // If product is already on the invoice, increment its qty instead of duplicating.
      const existingIdx = prev.findIndex((it) => it.productId === product.id);
      if (existingIdx >= 0) {
        return prev.map((it, idx) => {
          if (idx !== existingIdx) return it;
          if (it.unitsPerBox) {
            const nextBoxes = (it.boxes ?? 0) + 1;
            return {
              ...it,
              boxes: nextBoxes,
              qty: nextBoxes * it.unitsPerBox + (it.pieces ?? 0),
            };
          }
          return { ...it, qty: Number(it.qty) + 1 };
        });
      }
      // Replace the seeded blank row if it's the only one and is empty.
      const onlyBlank =
        prev.length === 1 &&
        !prev[0].productId &&
        !prev[0].description &&
        Number(prev[0].qty) <= 1 &&
        Number(prev[0].unitPrice) === 0;
      return onlyBlank ? [lineItem] : [...prev, lineItem];
    });
    setErrors((e) => ({ ...e, items: "" }));
    // Refocus the scanner input so a sequence of scans is uninterrupted.
    setTimeout(() => scanInputRef.current?.focus(), 30);
  }

  // ── Top-of-table scan/search input ───────────────────────────────────────────

  const scanInputRef = React.useRef<HTMLInputElement>(null);
  const [scanQuery, setScanQuery] = React.useState("");
  const [debouncedScanQuery, setDebouncedScanQuery] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedScanQuery(scanQuery), 200);
    return () => clearTimeout(t);
  }, [scanQuery]);

  const { data: scanProductsData } = useProducts({
    search: debouncedScanQuery || undefined,
    isActive: true,
    limit: 10,
    includeVariants: true,
  });
  const scanSuggestions = React.useMemo(() => {
    if (!debouncedScanQuery.trim()) return [] as any[];
    return ((scanProductsData?.data as any[]) ?? [])
      .filter((p: any) => !p.parentProductId)
      .slice(0, 8);
  }, [scanProductsData, debouncedScanQuery]);

  /**
   * Resolve a scanned/typed code to a product and add it to the invoice.
   * Mirrors the order modal's flow: barcode endpoint → product search by
   * SKU/name → create-product modal as last resort.
   */
  async function handleScanCode(rawCode: string) {
    const code = rawCode.trim();
    if (!code) return;
    setScanQuery("");
    setDebouncedScanQuery("");
    // 1) Dedicated barcode field
    try {
      const product = await apiClient
        .get(`/products/barcode/${encodeURIComponent(code)}`)
        .then((r) => r.data);
      if (product?.id) {
        addProductFromCatalog(product);
        return;
      }
    } catch {
      // not found by barcode — fall through to SKU/name search
    }
    // 2) SKU / name search; prefer exact SKU
    try {
      const res = await apiClient
        .get("/products", {
          params: { search: code, limit: 10, isActive: true, includeVariants: true },
        })
        .then((r) => r.data);
      const matches: any[] = res?.data ?? [];
      const skuExact = matches.find(
        (p) => (p.sku ?? "").toLowerCase() === code.toLowerCase(),
      );
      const toAdd = skuExact ?? matches[0];
      if (toAdd) {
        addProductFromCatalog(toAdd);
        return;
      }
    } catch {
      // fall through to create-product modal
    }
    // 3) Nothing matched — open create-product pre-filled with this code as SKU
    setCreateProductInitialName("");
    setCreateProductInitialSku(code);
    setCreateProductTargetIdx(null);
    setCreateProductOpen(true);
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

  function buildInvoiceDto(sendNow: boolean) {
    return {
      customerId: customer!.id,
      dueDate: dueDate || undefined,
      issueDate: issueDate || undefined,
      // The form has two separate fields:
      //   - `terms` = the Payment Terms dropdown ("Net 30" / "Due on Receipt"
      //      etc.) which is used purely to drive the due-date calculator.
      //   - `termsText` = the Terms & Conditions long-form textarea, which
      //     is what the tenant configures in Settings → Invoicing → "Terms
      //     & Conditions" and what gets pre-filled on this page.
      // The invoice schema has a single `terms` column that we render under
      // the "Terms & Conditions" section of the invoice and PDF — so we
      // need to send the LONG text, not the dropdown selection. Sending the
      // dropdown value here was overwriting tenant defaults with "Net 30",
      // making the configured Terms & Conditions invisible on every new
      // invoice. The dropdown's effect is preserved via dueDate above.
      terms: termsText.trim() || undefined,
      items: items.map((it): CreateInvoiceItem => ({
        productId: it.productId,
        description: it.description,
        qty: Number(it.qty),
        unitPrice: Number(it.unitPrice),
        discount: Number(it.discount) || undefined,
        // Map the taxable checkbox to an actual tax rate sent to the API
        taxRate: it.taxable ? taxRate : 0,
        ...(it.unitsPerBox ? { boxes: it.boxes ?? 0, pieces: it.pieces ?? 0 } : {}),
      })),
      notes: notes.trim() || undefined,
      referenceNumber: reference.trim() || undefined,
      subject: subject.trim() || undefined,
      // Map adjustment to discount (negative = reduce price) or shippingFee (positive = surcharge)
      ...(adjustment < 0 ? { discount: Math.abs(adjustment) } : {}),
      ...(adjustment > 0 ? { shippingFee: adjustment } : {}),
      ...(sendNow ? { send: true } : {}),
    };
  }

  async function handlePreview() {
    if (!validate()) return;
    setPreviewLoading(true);
    try {
      const dto = buildInvoiceDto(false);
      let invoiceId = currentDraftId;
      if (invoiceId) {
        // Update the existing draft so the preview reflects edits
        await updateInvoice.mutateAsync({ id: invoiceId, ...dto } as any);
      } else {
        const created: any = await createInvoice.mutateAsync(
          dto as Parameters<typeof createInvoice.mutate>[0],
        );
        invoiceId = created.id;
        setCurrentDraftId(invoiceId);
      }
      // Two-step: render PDF on the API, then fetch its bytes through the
      // authenticated apiClient. The raw URL points at the storage uploads
      // endpoint which requires a JWT (RF-075); embedding it directly in an
      // <iframe> fails because the iframe request has no token. A blob URL
      // built from the auth-fetched bytes works in any <iframe>/new tab.
      const meta = await apiClient.get<{ url: string }>(`/invoices/${invoiceId}/pdf`, {
        params: { refresh: 1 },
      });
      if (!meta.data?.url) {
        setPreviewUrl(null);
      } else {
        const blob = await fetchPdfBlob(meta.data.url, apiClient);
        // Replace any previous preview blob URL to avoid memory leaks.
        setPreviewUrl((prev) => {
          if (prev && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
          return URL.createObjectURL(blob);
        });
      }
    } catch (err) {
      toast({
        title: "Couldn't build preview",
        description: "Check your inputs and try again.",
        variant: "error",
      });
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleSendFromPreview() {
    if (!currentDraftId) return;
    try {
      await apiClient.post(`/invoices/${currentDraftId}/send`);
      toast({
        title: "Invoice sent",
        description: "The draft has been sent.",
        variant: "success",
      });
      router.push(`/invoices/${currentDraftId}`);
    } catch {
      toast({
        title: "Send failed",
        description: "Please try again from the invoice detail page.",
        variant: "error",
      });
    }
  }

  function handleSubmit(sendNow: boolean) {
    if (!validate()) return;

    // If we already have a preview draft, just update it and optionally send.
    if (currentDraftId) {
      const dto = buildInvoiceDto(false);
      updateInvoice.mutate(
        { id: currentDraftId, ...dto } as any,
        {
          onSuccess: async () => {
            if (sendNow) {
              try {
                await apiClient.post(`/invoices/${currentDraftId}/send`);
              } catch {
                // fall through to toast below
              }
            }
            toast({
              title: sendNow ? "Invoice sent" : "Draft saved",
              variant: "success",
            });
            router.push(`/invoices/${currentDraftId}`);
          },
          onError: () => {
            toast({
              title: "Failed to save invoice",
              description: "Please check your inputs and try again.",
              variant: "error",
            });
          },
        },
      );
      return;
    }

    const dto = buildInvoiceDto(sendNow);

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
                      Reference / PO Number <span className="text-navy/40 font-normal">(optional)</span>
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. PO-1234, contract ref, etc."
                      value={reference}
                      onChange={(e) => setReference(e.target.value)}
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

                {/* Top-level scan/search — mirrors the order modal's flow.
                    Scan a barcode (or type a name/SKU and press Enter) and the
                    matched product is added as a new line item, then the input
                    re-focuses so the operator can keep scanning. */}
                <div className="relative mb-3">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-navy/40" />
                  <input
                    ref={scanInputRef}
                    type="search"
                    value={scanQuery}
                    onChange={(e) => setScanQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        // If a suggestion is open and user picked one with mouse, that path
                        // already handles add. Otherwise treat the typed text as a scan code.
                        void handleScanCode(scanQuery);
                      }
                    }}
                    placeholder="Scan barcode, or type product name / SKU and press Enter…"
                    className="h-10 w-full rounded-lg border border-surface-border bg-white pl-9 pr-9 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                  {scanQuery && (
                    <button
                      type="button"
                      onClick={() => setScanQuery("")}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-navy/30 transition-colors hover:bg-surface-raised hover:text-navy"
                      aria-label="Clear"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {/* Live suggestion dropdown */}
                  {scanQuery.trim() && scanSuggestions.length > 0 && (
                    <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-lg border border-surface-border bg-white shadow-lg">
                      <p className="border-b border-surface-border px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-navy/40">
                        {scanSuggestions.length} suggestion{scanSuggestions.length === 1 ? "" : "s"}
                        <span className="ml-2 normal-case text-navy/30">
                          (Enter or click to add)
                        </span>
                      </p>
                      <ul role="listbox" className="py-1">
                        {scanSuggestions.map((p: any) => {
                          const alreadyAdded = items.some((it) => it.productId === p.id);
                          return (
                            <li key={p.id}>
                              <button
                                type="button"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  addProductFromCatalog(p);
                                  setScanQuery("");
                                  setDebouncedScanQuery("");
                                }}
                                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-navy transition-colors hover:bg-brand-50"
                              >
                                <div className="min-w-0 flex-1">
                                  <p className="truncate font-medium" title={p.name}>
                                    {p.name}
                                  </p>
                                  <p className="truncate text-[11px] text-navy/40">
                                    {p.sku ? <span className="font-mono">{p.sku}</span> : <span className="italic">no SKU</span>}
                                    {p.unitsPerBox ? <span> · {p.unitsPerBox} per box</span> : null}
                                  </p>
                                </div>
                                <div className="text-right">
                                  <p className="text-xs font-medium text-navy/70 tabular-nums">
                                    ${parseFloat(String(p.pricePerUnit ?? 0)).toFixed(2)}
                                  </p>
                                  <p className={cn("text-[10px]", alreadyAdded ? "text-amber-600" : "text-brand-600")}>
                                    {alreadyAdded ? "Already added · +1" : "Add →"}
                                  </p>
                                </div>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </div>

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
                      onChange={(desc, pid, price, avgCost, unitsPerBox) => {
                        const specialPrice = pid ? priceMap[pid] : undefined;
                        const effectivePrice = specialPrice ?? (price ? parseFloat(price) : item.unitPrice);
                        const upb = unitsPerBox ?? undefined;
                        updateItem(item.key, {
                          description: desc,
                          productId: pid || undefined,
                          unitPrice: effectivePrice,
                          regularPrice: specialPrice !== undefined ? parseFloat(price) : undefined,
                          isSpecialPrice: specialPrice !== undefined,
                          avgCost,
                          unitsPerBox: upb,
                          boxes: upb ? 1 : undefined,
                          pieces: upb ? 0 : undefined,
                          qty: upb ? upb : (item.qty || 1),
                        });
                      }}
                    />

                    {/* Qty — box/piece mode if unitsPerBox set, otherwise plain number */}
                    {item.unitsPerBox ? (
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-0.5">
                          <input
                            type="number"
                            min={0}
                            value={item.boxes ?? 0}
                            onChange={(e) => {
                              const boxes = Math.max(0, parseInt(e.target.value, 10) || 0);
                              const pieces = item.pieces ?? 0;
                              updateItem(item.key, { boxes, qty: boxes * item.unitsPerBox! + pieces });
                            }}
                            onFocus={(e) => e.target.select()}
                            className="w-8 rounded border border-surface-border bg-white px-1 py-1 text-center text-xs font-semibold text-navy focus:border-transparent focus:outline-none focus:ring-1 focus:ring-brand-500"
                            title="Boxes"
                          />
                          <span className="text-[10px] text-navy/40">b+</span>
                          <input
                            type="number"
                            min={0}
                            max={item.unitsPerBox - 1}
                            value={item.pieces ?? 0}
                            onChange={(e) => {
                              const pieces = Math.max(0, parseInt(e.target.value, 10) || 0);
                              const boxes = item.boxes ?? 0;
                              updateItem(item.key, { pieces, qty: boxes * item.unitsPerBox! + pieces });
                            }}
                            onFocus={(e) => e.target.select()}
                            className="w-8 rounded border border-surface-border bg-white px-1 py-1 text-center text-xs font-semibold text-navy focus:border-transparent focus:outline-none focus:ring-1 focus:ring-brand-500"
                            title="Pieces"
                          />
                        </div>
                        <span className="text-[9px] text-navy/30 text-right">{item.qty} pcs</span>
                      </div>
                    ) : (
                      <input
                        type="number"
                        min={0.01}
                        step={0.01}
                        value={item.qty}
                        onChange={(e) => updateItem(item.key, { qty: parseFloat(e.target.value) || 0 })}
                        className="h-9 rounded border border-surface-border bg-white px-2 text-right text-sm text-navy focus:border-transparent focus:outline-none focus:ring-1 focus:ring-brand-500"
                      />
                    )}

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
                      {item.unitsPerBox && item.unitsPerBox > 1 && item.unitPrice > 0 && (
                        <p className="text-[9px] text-navy/40 text-right mt-0.5">
                          ${(item.unitPrice / item.unitsPerBox).toFixed(2)}/pc
                        </p>
                      )}
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
                      <span>Tax ({(taxRate * 100).toFixed(0)}%)</span>
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
                    <dt className="text-navy/60">Tax ({(taxRate * 100).toFixed(0)}%)</dt>
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

      <InlineCreateProductModal
        isOpen={createProductOpen}
        onClose={() => { setCreateProductOpen(false); setCreateProductTargetIdx(null); }}
        onCreated={(product) => {
          if (createProductTargetIdx !== null) {
            setItems((prev) =>
              prev.map((item, i) =>
                i === createProductTargetIdx
                  ? { ...item, description: product.name, productId: product.id, unitPrice: parseFloat(product.pricePerUnit) || 0 }
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

      {/* Sticky bottom bar (Zoho-style) */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-surface-border bg-white px-6 py-3 shadow-[0_-2px_8px_0_rgb(0,0,0,0.06)]">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              leftIcon={<Eye className="h-4 w-4" />}
              onClick={handlePreview}
              loading={previewLoading}
              disabled={previewLoading || createInvoice.isPending}
            >
              Preview
            </Button>
            <Button
              variant="secondary"
              onClick={() => handleSubmit(false)}
              loading={createInvoice.isPending || updateInvoice.isPending}
              disabled={createInvoice.isPending || updateInvoice.isPending}
            >
              Save as Draft
            </Button>
            <Button
              onClick={() => handleSubmit(true)}
              loading={createInvoice.isPending || updateInvoice.isPending}
              disabled={createInvoice.isPending || updateInvoice.isPending}
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

      {/* Print-ready preview modal */}
      {previewUrl ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={() => setPreviewUrl(null)}
        >
          <div
            className="flex h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-surface-border px-5 py-3">
              <h2 className="text-base font-semibold text-navy">Invoice preview</h2>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={() => setPreviewUrl(null)}
                  disabled={previewLoading}
                >
                  Close
                </Button>
                <Button onClick={handleSendFromPreview} disabled={previewLoading}>
                  Send invoice
                </Button>
              </div>
            </div>
            <iframe src={previewUrl} className="h-full w-full flex-1" title="Invoice preview" />
          </div>
        </div>
      ) : null}
    </div>
  );
}
