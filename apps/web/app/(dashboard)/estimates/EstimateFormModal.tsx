"use client";

import * as React from "react";
import { X, Trash2, Search, ChevronRight } from "lucide-react";
import { Button, Modal, useToast } from "@routeflow/ui/web";
import { countNoun } from "@/lib/plural";
import { scheduleScannerRefocus } from "@/lib/refocus-scanner";
import { useCreateEstimate } from "@/lib/api/estimates";
import { useCustomers, useCustomerPrices } from "@/lib/api/customers";
import { useProducts } from "@/lib/api/products";
import { displayProductName } from "@/lib/product-display";
import {
  attachParent,
  groupOffered,
  groupEnterAction,
  groupSearchRows,
  isFamilyProduct,
  isGroupExpanded,
  pickerProductName,
} from "@/lib/product-search-groups";
import {
  isAboveListLine,
  isSpecialTier,
  computeInvoiceLineTotal,
  computeInvoiceTotals,
  customerLinePrice,
  customerTierFor,
  type InvoiceTotalsLine,
} from "@routeflow/pricing";
import { newDocumentDiscountBase } from "@/lib/discount-tax-base";
import { useCustomerPriceLayer } from "@/lib/api/useCustomerPriceLayer";
import { PriceLayerNotice } from "@/components/PriceLayerNotice";
import { customerPricingGate, gateNoticeLayer } from "@/lib/customer-pricing-gate";
import { apiClient } from "@/lib/api-client";
import { useTierLabels } from "@/lib/api/tier-labels";
import { tierLabel } from "@/lib/tier-label";
import { fmt } from "@/lib/formatting";
import { defaultExpiryDate, defaultIssueDate } from "./estimate-date-defaults";

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
  priceType: "STANDARD" | "SPECIAL" | "DISCOUNTED" | "MANUAL";
  qty: number;
  unitsPerBox?: number;
  boxes?: number;
  pieces?: number;
}

/** The pricing-helper view of a line: a boxed line prorates by its box split (BOX price). */
function toTotalsLine(li: EstimateLineItem): InvoiceTotalsLine {
  return {
    unitPrice: li.unitPrice,
    qty: li.qty,
    boxes: li.boxes ?? null,
    pieces: li.pieces ?? null,
    unitsPerBox: li.unitsPerBox ?? null,
  };
}

interface SelectedEstimateCustomer {
  id: string;
  businessName: string;
  contactName?: string;
  pricingTier?: number;
}

// ─── Create Estimate modal ────────────────────────────────────────────────────

export function CreateEstimateModal({
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
  // The group last toggled in the dropdown ("" = closed it); null = not toggled yet.
  const [expandedParentId, setExpandedParentId] = React.useState<string | null>(null);
  // Row 503: the highlighted visible variant of an OPEN family in the first row (Enter adds it; arrows move it).
  const [variantHighlight, setVariantHighlight] = React.useState(0);
  React.useEffect(() => setVariantHighlight(0), [productSearch, expandedParentId]);

  // Line items
  const [lineItems, setLineItems] = React.useState<EstimateLineItem[]>([]);

  // Dates & notes
  const [issueDate, setIssueDate] = React.useState(defaultIssueDate());
  const [expiryDate, setExpiryDate] = React.useState(() => defaultExpiryDate(issueDate));
  const [notes, setNotes] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  // Customer per-product tier overrides
  const customerPricesQuery = useCustomerPrices(selectedCustomer?.id);
  const { data: customerPricesData } = customerPricesQuery;
  const cpMap = React.useMemo(() => {
    const map = new Map<string, number>();
    (customerPricesData ?? []).forEach((cp: any) => map.set(cp.productId, cp.pricingTier));
    return map;
  }, [customerPricesData]);

  // S19b (SA-811a/813): flag-on, billing's own customer layer. Flag off = no request and master's chain.
  const priceLayer = useCustomerPriceLayer(selectedCustomer?.id);
  // W-745 (SA-868/884): the one shared gate. The customer is the picked row (its tier is read); a customer-price read that
  // failed with no data blocks the pick (it would drop every per-product override); a PLAN_GATE 403 is an empty read.
  const pricingGate = customerPricingGate({
    customerQuery: selectedCustomer ? { data: selectedCustomer } : {},
    customerPricesQuery: selectedCustomer ? customerPricesQuery : {},
    priceLayer,
    productIds: lineItems.map((li) => li.productId),
    openSuggestions: lineItems.some(
      (li) => li.priceType === "STANDARD" || li.priceType === "SPECIAL",
    ),
  });

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

  // Parents + standalones with variants nested, so an estimate can quote a variant. A variant that
  // matched on its own gets its parent re-attached and opened (B1215 C6); a FAMILY is never a line (C7).
  const productGroups = React.useMemo(
    () => groupSearchRows<any>(productsData?.data ?? []),
    [productsData],
  );
  const filteredProducts = React.useMemo(() => {
    if (!debouncedProductSearch) return [];
    return productGroups.rows.slice(0, 10);
  }, [productGroups, debouncedProductSearch]);

  // Reset on open
  React.useEffect(() => {
    if (isOpen) {
      setSelectedCustomer(null);
      setCustomerSearch("");
      setDebouncedCustomerSearch("");
      setProductSearch("");
      setDebouncedProductSearch("");
      setLineItems([]);
      const today = defaultIssueDate();
      setIssueDate(today);
      setExpiryDate(defaultExpiryDate(today));
      setNotes("");
      setErrors({});
    }
  }, [isOpen]);

  // Add line item (from search or barcode)
  const addLineItem = (product: any) => {
    if (isFamilyProduct(product)) return; // a FAMILY is a container, never a line (B1215 C7)
    if (lineItems.some((li) => li.productId === product.id)) {
      setLineItems((prev) =>
        prev.map((li) => (li.productId === product.id ? { ...li, qty: li.qty + 1 } : li)),
      );
      setProductSearch("");
      setDebouncedProductSearch("");
      scheduleScannerRefocus(productSearchRef, 50);
      return;
    }
    // The customer's prices or (flag on) the layer not read yet, or failed: a pick would mis-price, so wait (the notice says why).
    if (pricingGate.blockPick) return;
    const upb: number | undefined = product.unitsPerBox ? Number(product.unitsPerBox) : undefined;
    const listPrice = Number(product.pricePerUnit ?? 0);
    const effectiveTier = customerTierFor(cpMap.get(product.id), selectedCustomer?.pricingTier);
    let tierPrice = customerLinePrice({ product, tier: effectiveTier }).price;
    let priceType: EstimateLineItem["priceType"] = isSpecialTier(effectiveTier)
      ? "SPECIAL"
      : "STANDARD";
    const layer = priceLayer.layerOf(product.id);
    if (layer) {
      const r = customerLinePrice({ product, tier: effectiveTier, layer, unitLabel: null });
      if (r.layered) {
        // The layer's price is the line's price; an above-list one is MANUAL (badged MANUAL, no tier badge or strikethrough).
        tierPrice = r.price;
        priceType = r.priceType;
      }
    }
    setLineItems((prev) => [
      ...prev,
      {
        tempId: product.id + "-" + Date.now(),
        productId: product.id,
        productName: displayProductName(product),
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
    scheduleScannerRefocus(productSearchRef, 50);
  };

  // Barcode / Enter handler
  const handleProductSearchEnter = async (
    /** Row 503: the grouped rows on screen, when they were built from this exact text. */
    shownRows?: any[],
  ) => {
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
      // Row 503: the rows the dropdown shows (or, before it caught up, the search grouped the same way).
      const grouped = shownRows
        ? { rows: shownRows, expandedIds: productGroups.expandedIds }
        : groupSearchRows<any>(
            (
              await apiClient
                .get("/products", {
                  params: { search: code, limit: 10, isActive: true, includeVariants: true },
                })
                .then((r) => r.data)
            )?.data ?? [],
          );
      const rows: any[] = grouped.rows;
      const offered = groupOffered<any>(rows);
      const skuMatch = offered.find((p: any) => (p.sku ?? "").toLowerCase() === code.toLowerCase());
      if (skuMatch) {
        addLineItem(skuMatch);
        return;
      }
      // Enter does what a click on the first shown row does: a FAMILY opens (SA must, row 503).
      const first = rows[0];
      const action = groupEnterAction<any>(
        first,
        !!first && isGroupExpanded(expandedParentId, grouped.expandedIds, first.id),
        variantHighlight,
      );
      if (action.kind === "add") {
        addLineItem(action.product);
        return;
      }
      if (action.kind === "expand") {
        setExpandedParentId(action.id);
        return;
      }
    } catch {
      /* ignore */
    }
    toast({
      title: "Product not found",
      description: `No product matches "${code}".`,
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

  // Footer subtotal: boxed-aware per-line totals, summed and rounded once in pricing.
  const { subtotal } = computeInvoiceTotals(lineItems.map(toTotalsLine), {
    discountBase: newDocumentDiscountBase(),
  });

  const priceBlocked = pricingGate.blockSave;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (priceBlocked) return;
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
      issueDate,
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

    createEstimate.mutate(dto, {
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
      title="New estimate"
      description="Create an estimate for a customer."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={createEstimate.isPending}>
            Cancel
          </Button>
          <PriceLayerNotice
            layer={gateNoticeLayer(
              pricingGate,
              priceLayer,
              () => void customerPricesQuery.refetch(),
            )}
            unconfirmed={priceBlocked || pricingGate.blockPick}
            className="mr-auto self-center text-xs text-amber-700"
          />
          <Button
            type="submit"
            form="create-estimate-form"
            loading={createEstimate.isPending}
            disabled={priceBlocked}
          >
            Create estimate
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
            <label className="mb-1.5 block text-sm font-medium text-navy/80">Issue date</label>
            <input
              type="date"
              value={issueDate}
              onChange={(e) => setIssueDate(e.target.value)}
              className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            {errors.issueDate && <p className="mt-1 text-xs text-danger">{errors.issueDate}</p>}
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-navy/80">Expiry date</label>
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
                onChange={(e) => {
                  setProductSearch(e.target.value);
                  setExpandedParentId(null);
                }}
                onKeyDown={(e) => {
                  // Row 503: arrows move over the visible variants of an open family in the first row.
                  const head = filteredProducts[0];
                  const navigable =
                    head &&
                    isFamilyProduct(head) &&
                    (head.variants?.length ?? 0) > 1 &&
                    isGroupExpanded(expandedParentId, productGroups.expandedIds, head.id);
                  if (navigable && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                    e.preventDefault();
                    const last = head.variants.length - 1;
                    setVariantHighlight((h) =>
                      e.key === "ArrowDown" ? Math.min(h + 1, last) : Math.max(h - 1, 0),
                    );
                    return;
                  }
                  if (e.key === "Enter") {
                    e.preventDefault();
                    // Trust the shown rows only once they were built from this exact text (row 503).
                    const settled =
                      filteredProducts.length > 0 && debouncedProductSearch === productSearch;
                    void handleProductSearchEnter(settled ? filteredProducts : undefined);
                  }
                }}
                className="h-10 w-full rounded-lg border border-surface-border bg-white pl-9 pr-3 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              {filteredProducts.length > 0 && productSearch && (
                <ul className="absolute left-0 right-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-lg border border-surface-border bg-white shadow-dropdown">
                  {filteredProducts.map((p: any) => {
                    const hasVariants = p.variants?.length > 0;
                    const isExpanded = isGroupExpanded(
                      expandedParentId,
                      productGroups.expandedIds,
                      p.id,
                    );
                    return (
                      <React.Fragment key={p.id}>
                        <li>
                          <button
                            type="button"
                            onClick={() => {
                              if (hasVariants) setExpandedParentId(isExpanded ? "" : p.id);
                              else addLineItem(p);
                            }}
                            className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-surface-raised"
                          >
                            <div className="flex min-w-0 items-center gap-1.5">
                              {hasVariants && (
                                <ChevronRight
                                  className={`h-3.5 w-3.5 shrink-0 text-navy/70 transition-transform ${
                                    isExpanded ? "rotate-90" : ""
                                  }`}
                                />
                              )}
                              <span className="font-medium text-navy">{p.name}</span>
                              {p.sku && (
                                <span className="ml-2 font-mono text-xs text-navy/70">{p.sku}</span>
                              )}
                              {hasVariants && (
                                <span className="shrink-0 text-[10px] text-navy/70">
                                  {countNoun(p.variants.length, "variant")}
                                </span>
                              )}
                            </div>
                            {!hasVariants && (
                              <span className="text-xs text-navy/70">
                                {fmt(Number(p.pricePerUnit))}
                              </span>
                            )}
                          </button>
                        </li>
                        {hasVariants && isExpanded && !isFamilyProduct(p) && (
                          // A non-family parent is itself a sellable product: it stays quotable (#3323).
                          <li className="bg-surface-raised/50">
                            <button
                              type="button"
                              onClick={() => addLineItem(p)}
                              className="flex w-full items-center justify-between py-2 pl-8 pr-3 text-left text-sm hover:bg-surface-raised"
                            >
                              <span className="font-medium text-navy">Quote {p.name} itself</span>
                              <span className="text-xs text-navy/70">
                                {fmt(Number(p.pricePerUnit))}
                              </span>
                            </button>
                          </li>
                        )}
                        {hasVariants &&
                          isExpanded &&
                          p.variants.map((v: any, vi: number) => (
                            <li key={v.id} className="bg-surface-raised/50">
                              <button
                                type="button"
                                onClick={() => addLineItem(attachParent(v, p))}
                                aria-selected={
                                  p.id === filteredProducts[0]?.id && isFamilyProduct(p)
                                    ? vi === variantHighlight
                                    : undefined
                                }
                                className={`flex w-full items-center justify-between py-2 pl-8 pr-3 text-left text-sm hover:bg-surface-raised${
                                  p.id === filteredProducts[0]?.id &&
                                  isFamilyProduct(p) &&
                                  vi === variantHighlight
                                    ? " bg-surface-raised"
                                    : ""
                                }`}
                              >
                                <div className="flex min-w-0 items-center gap-1.5">
                                  <span className="font-medium text-navy">
                                    {pickerProductName(v, p)}
                                  </span>
                                  {v.sku && (
                                    <span className="ml-2 font-mono text-xs text-navy/70">
                                      {v.sku}
                                    </span>
                                  )}
                                  {v.unit && (
                                    <span className="shrink-0 text-xs text-navy/70">{v.unit}</span>
                                  )}
                                </div>
                                <span className="text-xs text-navy/70">
                                  {fmt(Number(v.pricePerUnit))}
                                </span>
                              </button>
                            </li>
                          ))}
                      </React.Fragment>
                    );
                  })}
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
                      {li.priceType === "MANUAL" && (
                        <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                          MANUAL
                        </span>
                      )}
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
                      {li.priceType === "SPECIAL" &&
                        !isAboveListLine({
                          unitPrice: li.unitPrice,
                          originalPrice: li.listPrice,
                        }) && <span className="line-through">{fmt(li.listPrice)}</span>}
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
                    {fmt(computeInvoiceLineTotal(toTotalsLine(li)))}
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
