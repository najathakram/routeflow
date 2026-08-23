"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Plus, Trash2, Search, Loader2 } from "lucide-react";
import { Button, Card, useToast, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useInvoice, useUpdateInvoice, type CreateInvoiceItem } from "@/lib/api/invoices";
import {
  useCustomers,
  useCustomer,
  useCustomerPrices,
  type CustomerPrice,
} from "@/lib/api/customers";
import { useProducts } from "@/lib/api/products";
import { apiClient } from "@/lib/api-client";
import { InlineCreateProductModal } from "@/components/InlineCreateProductModal";
import { BarcodeScannerButton } from "@/components/BarcodeScannerButton";
import { DecimalInput, MoneyInput } from "@/components/MoneyInput";
import { displayProductName } from "@/lib/product-display";
import { computeLineSubtotal, normalizeBoxesPieces, roundMoney, getTierPrice } from "@/lib/pricing";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Shape needed to resolve this customer's tier price for a product — mirrors
 *  invoices/new's `getTierPrice` callers. */
interface TierPriceableProduct {
  id: string;
  pricePerUnit: number | string;
  priceTier2?: number | string | null;
  priceTier3?: number | string | null;
  priceTier4?: number | string | null;
  priceTier5?: number | string | null;
}

// ─── Product search dropdown (inline) ────────────────────────────────────────

function ProductSearchInput({
  value,
  onChange,
  onCreateProduct,
  onBarcodeNotFound,
  tierPriceFor,
  pricingPending,
}: {
  value: string;
  onChange: (
    description: string,
    productId?: string,
    unitPrice?: number,
    unitsPerBox?: number,
  ) => void;
  onCreateProduct?: (searchTerm: string) => void;
  onBarcodeNotFound?: (barcode: string) => void;
  /** This customer's price for a product (per-product tier override, else the
   *  customer's tier ladder) — used instead of catalog list price whenever a
   *  product is selected here (scan or dropdown pick). */
  tierPriceFor: (product: TierPriceableProduct) => number;
  /** True until the customer + customer-prices queries settle. `tierPriceFor`
   *  would resolve to LIST until then, so no product may be picked yet. */
  pricingPending: boolean;
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
        disabled={pricingPending}
        placeholder={pricingPending ? "Loading customer pricing…" : "Description / product…"}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          onChange(e.target.value, undefined, undefined);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        className="h-9 w-full rounded border border-surface-border bg-white px-2.5 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:cursor-not-allowed disabled:bg-surface-raised"
      />
      {/* Hold every product-selection path until the tier data lands: picking or
          scanning earlier resolves `tierPriceFor` to the catalog LIST price, so a
          tiered customer is silently over-charged and nothing re-resolves the line
          afterwards. Disabling the input also silences the USB-scanner keydown
          listener that BarcodeScannerButton attaches to it. */}
      {pricingPending ? (
        <span
          title="Loading customer pricing…"
          className="inline-flex items-center justify-center rounded border border-surface-border bg-white p-1.5 text-navy/30"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
        </span>
      ) : (
        <BarcodeScannerButton
          inputRef={inputRef}
          onScan={async (code) => {
            try {
              const product = await apiClient
                .get(`/products/barcode/${encodeURIComponent(code)}`)
                .then((r) => r.data);
              if (product) {
                setQuery(product.name);
                onChange(product.name, product.id, tierPriceFor(product), product.unitsPerBox);
                setOpen(false);
                return;
              }
            } catch {
              // product not found by barcode
            }
            if (onBarcodeNotFound) onBarcodeNotFound(code);
          }}
        />
      )}
      {!pricingPending &&
        open &&
        debouncedQuery.length > 0 &&
        (products.length > 0 || onCreateProduct) && (
          <div className="absolute z-10 mt-1 w-full rounded-lg border border-surface-border bg-white shadow-lg">
            <ul className="max-h-36 overflow-y-auto">
              {products.length === 0 && (
                <li className="px-3 py-2 text-sm text-navy/70">No products found.</li>
              )}
              {products.map(
                (p: {
                  id: string;
                  name: string;
                  pricePerUnit: number;
                  sku?: string;
                  unitsPerBox?: number | null;
                  priceTier2?: number | string | null;
                  priceTier3?: number | string | null;
                  priceTier4?: number | string | null;
                  priceTier5?: number | string | null;
                }) => (
                  <li key={p.id}>
                    <button
                      className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-surface-raised"
                      onClick={() => {
                        setQuery(p.name);
                        onChange(p.name, p.id, tierPriceFor(p), p.unitsPerBox ?? undefined);
                        setOpen(false);
                      }}
                    >
                      <div>
                        <span className="text-sm font-medium text-navy">{p.name}</span>
                        {p.sku && <span className="ml-2 text-xs text-navy/70">{p.sku}</span>}
                      </div>
                      <span className="text-xs text-navy/70">
                        {fmt.format(Number(p.pricePerUnit))}
                      </span>
                    </button>
                  </li>
                ),
              )}
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
  /** Set when the product has box packaging (unitsPerBox > 1). `qty` stays in
   *  total pieces; boxes/pieces are derived from it so boxed lines prorate. */
  unitsPerBox?: number;
  /** Per-line note (buyer-visible) — MUST round-trip: the update endpoint
   *  delete-and-recreates items, so dropping this wipes order-carried notes. */
  notes?: string;
  /** BUY_N_GET_M snapshot carried from the order line: whole free selling units.
   *  MUST round-trip for the same reason as `notes` — but this one is MONEY: drop
   *  it and an agreed 12-boxes-2-free line re-prices from $350 to $420 on save. */
  promoFreeUnits?: number;
  /** Whole selling units the snapshot above was earned at, so a qty edit rescales
   *  it instead of handing over free units the new quantity never earned. */
  promoBaseUnits?: number;
}

/**
 * Boxed split for a line, derived from its `qty` (total pieces) + `unitsPerBox`.
 * Returns nulls for non-boxed lines so callers pass through to `unitPrice * qty`.
 * Mirrors the invoice CREATE page + the server, which prorate a boxed line as
 * `unitPrice * (boxes + pieces / unitsPerBox)` (unitPrice is the BOX price).
 */
function lineSplit(it: { qty: number; unitsPerBox?: number }): {
  boxes: number | null;
  pieces: number | null;
} {
  const upb = Number(it.unitsPerBox ?? 0);
  if (upb > 1) {
    const s = normalizeBoxesPieces({ qty: it.qty, unitsPerBox: upb });
    return { boxes: s.boxes, pieces: s.pieces };
  }
  return { boxes: null, pieces: null };
}

/**
 * BUY_N_GET_M free units for this line, rescaled when the operator edits the qty.
 * The snapshot was earned at `promoBaseUnits` whole selling units, so a shrunk line
 * earns proportionally fewer and a grown one never earns MORE than was agreed
 * (mirrors the order engine's `rescaleBogoFreeUnits` fallback). Capped at
 * units − 1: the buyer always pays the N in every (N + M), so no line is all free.
 */
function lineFreeUnits(it: LineItemState): number {
  const stored = Math.max(0, Math.trunc(it.promoFreeUnits ?? 0));
  if (stored <= 0) return 0;
  const { boxes } = lineSplit(it);
  const units = Math.trunc(Number(boxes != null ? boxes : it.qty) || 0);
  if (units <= 0) return 0;
  const base = Math.max(0, Math.trunc(it.promoBaseUnits ?? units));
  const earned = base > 0 ? Math.floor((stored * units) / base) : stored;
  return Math.min(stored, earned, units - 1);
}

/** Post-discount line total, boxed-aware, rounded — same basis the server stores. */
function lineTotal(it: LineItemState): number {
  const { boxes, pieces } = lineSplit(it);
  const beforeDiscount = computeLineSubtotal({
    unitPrice: Number(it.unitPrice),
    qty: Number(it.qty),
    boxes,
    pieces,
    unitsPerBox: it.unitsPerBox ?? null,
    // BUY_N_GET_M: free whole units come off before pricing, exactly like the server.
    freeUnits: lineFreeUnits(it),
  });
  return roundMoney(beforeDiscount - Number(it.discount));
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

  // Customer tier pricing (mirrors invoices/new): every product-selection path
  // below should price at this customer's tier, not the raw catalog price.
  const customerQuery = useCustomer(invoice?.customerId ?? "");
  const customerPricesQuery = useCustomerPrices(invoice?.customerId);
  const { data: customer } = customerQuery;
  const { data: customerPricesData } = customerPricesQuery;
  // Unlike invoices/new, this page auto-loads with the line rows already usable,
  // so both requests are still in flight when the operator can first scan/pick —
  // and `tierPriceFor` would answer LIST. Block selection until they settle.
  // (v5 `isLoading` is false while a query is disabled or after it errors, so an
  // invoice with no customer, or a failed fetch, never leaves the rows stuck.)
  const tierPricingPending = customerQuery.isLoading || customerPricesQuery.isLoading;
  // Per-product PRICE resolved from the CustomerPrice TIER override through the
  // product's tier ladder. An msrp-only override row has pricingTier null —
  // price at the customer's default tier (Post-MSRP hazard).
  const priceMap = React.useMemo(() => {
    const map: Record<string, number> = {};
    for (const cp of (customerPricesData ?? []) as CustomerPrice[]) {
      if (!cp.product) continue;
      const price = getTierPrice(cp.product, cp.pricingTier ?? customer?.pricingTier ?? 1);
      if (Number.isFinite(price)) map[cp.productId] = price;
    }
    return map;
  }, [customerPricesData, customer]);
  /** This customer's price for `product` — the per-product CustomerPrice
   *  override first, else this customer's own tier ladder; falls back to list
   *  for Tier 1 / no override (mirrors invoices/new's addProductFromCatalog). */
  const tierPriceFor = React.useCallback(
    (product: TierPriceableProduct) => {
      const listPrice = parseFloat(String(product.pricePerUnit ?? 0)) || 0;
      const customerTier = customer?.pricingTier ?? 1;
      const tierLadderPrice = customerTier !== 1 ? getTierPrice(product, customerTier) : undefined;
      const specialPrice = priceMap[product.id] ?? tierLadderPrice;
      return specialPrice != null && Number.isFinite(specialPrice) ? specialPrice : listPrice;
    },
    [customer, priceMap],
  );

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
      setIssueDate(
        invoice.issueDate ? invoice.issueDate.slice(0, 10) : new Date().toISOString().slice(0, 10),
      );
      setDueDate(invoice.dueDate ? invoice.dueDate.slice(0, 10) : "");
      setDiscount(String(Number(invoice.discount ?? 0)));
      setShippingFee(String(Number(invoice.shippingFee ?? 0)));
      setNotes(invoice.notes ?? "");
      setTerms(invoice.terms ?? "");
      setReferenceNumber(invoice.referenceNumber ?? "");
      setSubject(invoice.subject ?? "");
      setItems(
        (invoice.items ?? []).length > 0
          ? (invoice.items ?? []).map((it) => {
              // Treat a line as box-split ONLY if it was STORED with a split, and
              // use the sale-time snapshot upb — never the live product (which, if
              // the product's packaging changed since, would re-price the line and
              // show the per-box price as the whole line total). Selling-unit lines
              // (boxes == null) stay non-boxed so qty × unitPrice is preserved.
              const isBoxSplit = it.boxes != null;
              const upb = Number(it.unitsPerBox ?? it.product?.unitsPerBox ?? 0);
              return {
                key: it.id,
                productId: it.productId,
                description: it.description,
                qty: Number(it.qty),
                unitPrice: Number(it.unitPrice),
                taxRate: Number(it.taxRate ?? 0),
                discount: Number(it.discount ?? 0),
                unitsPerBox: isBoxSplit && upb > 1 ? upb : undefined,
                notes: it.notes ?? undefined,
                // BUY_N_GET_M snapshot + the whole-unit count it was earned at.
                promoFreeUnits: it.promoFreeUnits ?? undefined,
                promoBaseUnits: it.promoFreeUnits
                  ? Math.trunc(Number(isBoxSplit ? (it.boxes ?? 0) : it.qty) || 0)
                  : undefined,
              };
            })
          : [createEmptyItem()],
      );
      setInitialized(true);
    }
  }, [invoice, initialized, setTitle]);

  // ── Calculations ─────────────────────────────────────────────────────────────

  // Boxed lines prorate via computeLineSubtotal (unitPrice is the BOX price); a
  // plain qty*unitPrice would over-charge by unitsPerBox. Matches server pricing.
  const subtotal = items.reduce((s, it) => s + lineTotal(it), 0);
  const taxTotal = items.reduce((s, it) => s + lineTotal(it) * Number(it.taxRate), 0);
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
      items: items.map((it): CreateInvoiceItem => {
        // Send the boxed split so the server prorates (unitPrice is the BOX price).
        // Without boxes/pieces the server falls back to unitPrice*qty and over-charges.
        const { boxes, pieces } = lineSplit(it);
        const freeUnits = lineFreeUnits(it);
        return {
          productId: it.productId,
          description: it.description,
          qty: Number(it.qty),
          unitPrice: Number(it.unitPrice),
          taxRate: it.taxRate != null ? Number(it.taxRate) : undefined,
          discount:
            it.discount != null && Number(it.discount) !== 0 ? Number(it.discount) : undefined,
          ...(it.unitsPerBox && it.productId ? { boxes: boxes ?? 0, pieces: pieces ?? 0 } : {}),
          // Round-trip the BUY_N_GET_M snapshot — the server replaces every line.
          ...(freeUnits > 0 ? { promoFreeUnits: freeUnits } : {}),
          // Round-trip the per-line note — the server recreates all items on update.
          ...(it.notes?.trim() ? { notes: it.notes.trim() } : {}),
        };
      }),
    };

    updateInvoice.mutate(dto, {
      onSuccess: () => {
        toast({
          title: "Invoice updated",
          description: "Draft invoice has been saved.",
          variant: "success",
        });
        router.push(`/invoices/${params.id}`);
      },
      onError: (err: any) => {
        toast({
          title: "Failed to update invoice",
          description: err?.response?.data?.message ?? "Please try again.",
          variant: "error",
        });
      },
    });
  }

  // ── Guards ────────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-navy/70" />
      </div>
    );
  }

  if (isError || !invoice) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Invoice not found.</p>
        <Button variant="secondary" href="/invoices">
          Back to Invoices
        </Button>
      </div>
    );
  }

  if (invoice.status !== "DRAFT") {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Only DRAFT invoices can be edited.</p>
        <Button variant="secondary" href={`/invoices/${params.id}`}>
          Back to Invoice
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5 p-6">
      <Link
        href={`/invoices/${params.id}`}
        className="flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
      >
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
                <span className="text-xs font-medium text-navy/70">Description</span>
                <span className="text-xs font-medium text-navy/70 text-right">Qty</span>
                <span className="text-xs font-medium text-navy/70 text-right">Unit Price</span>
                <span className="text-xs font-medium text-navy/70 text-right">Disc. $</span>
                <span className="text-xs font-medium text-navy/70 text-right">Tax %</span>
                <span />
              </div>

              {items.map((item) => (
                <div
                  key={item.key}
                  className="grid grid-cols-[1fr_70px_90px_70px_70px_32px] items-center gap-2"
                >
                  <ProductSearchInput
                    value={item.description}
                    tierPriceFor={tierPriceFor}
                    pricingPending={tierPricingPending}
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
                    onChange={(description, productId, unitPrice, unitsPerBox) => {
                      updateItem(item.key, {
                        description,
                        productId,
                        unitPrice: unitPrice !== undefined ? unitPrice : item.unitPrice,
                        unitsPerBox: unitsPerBox && unitsPerBox > 1 ? unitsPerBox : undefined,
                      });
                    }}
                  />
                  {/* Editable while typing — commit numbers live, format on blur only
                      (the old parseFloat(...) || 0 bindings collapsed "2." and turned
                      a cleared field into 0). */}
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
                  <MoneyInput
                    min={0}
                    value={item.discount}
                    onChange={(v) => updateItem(item.key, { discount: v ?? 0 })}
                    className="h-9 rounded border border-surface-border bg-white px-2 text-right text-sm text-navy focus:border-transparent focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                  <DecimalInput
                    decimals={4}
                    min={0}
                    max={1}
                    value={item.taxRate}
                    placeholder="0.10"
                    onChange={(v) => updateItem(item.key, { taxRate: v ?? 0 })}
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
                    Reference / PO Number{" "}
                    <span className="text-navy/70 font-normal">(optional)</span>
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
                    Subject <span className="text-navy/70 font-normal">(optional)</span>
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
                <label className="mb-1.5 block text-sm font-medium text-navy/80">
                  Payment Terms
                </label>
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

          {/* Summary */}
          <Card title="Invoice Summary">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-navy/70">Subtotal</dt>
                <dd className="font-medium text-navy">{fmt.format(subtotal)}</dd>
              </div>
              {invDiscount > 0 && (
                <div className="flex justify-between text-success">
                  <dt>Discount</dt>
                  <dd>-{fmt.format(invDiscount)}</dd>
                </div>
              )}
              {taxTotal > 0 && (
                <div className="flex justify-between text-navy/70">
                  <dt>Tax</dt>
                  <dd className="font-medium text-navy">{fmt.format(taxTotal)}</dd>
                </div>
              )}
              {shipping > 0 && (
                <div className="flex justify-between text-navy/70">
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
        onClose={() => {
          setCreateProductOpen(false);
          setCreateProductTargetIdx(null);
        }}
        onCreated={(product) => {
          if (createProductTargetIdx !== null) {
            setItems((prev) =>
              prev.map((item, i) =>
                i === createProductTargetIdx
                  ? {
                      ...item,
                      description: displayProductName(product),
                      productId: product.id,
                      unitPrice: tierPriceFor(product),
                    }
                  : item,
              ),
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
