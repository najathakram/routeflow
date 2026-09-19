"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { X, AlertTriangle, ChevronRight, Plus, Minus } from "lucide-react";
import { Modal, Textarea, Button, cn, useToast } from "@routeflow/ui/web";
import { useQuery } from "@tanstack/react-query";
import { useCustomers, useCustomerPrices, useCustomer } from "@/lib/api/customers";
import { useProducts } from "@/lib/api/products";
import {
  useCreateOrder,
  useActiveOrderForCustomer,
  useCustomerPriceHistory,
  type ActiveOrderSummary,
} from "@/lib/api/orders";
import { useCreateDraft, useUpdateDraft, useDeleteDraft, useDraft } from "@/lib/api/drafts";
import { draftDeviceLabel, type OrderDraftPayload } from "@/lib/drafts";
import { apiClient } from "@/lib/api-client";
import { getTierPrice, computeLineSubtotal, normalizeBoxesPieces } from "@routeflow/pricing";
import { useMarginConfig, floorForCategory } from "@/lib/api/margin";
import { MoneyInput, DecimalInput } from "@/components/MoneyInput";
import { displayProductName } from "@/lib/product-display";
import { InlineCreateProductModal } from "@/components/InlineCreateProductModal";
import { BarcodeScannerButton } from "@/components/BarcodeScannerButton";
import { LineItemRow } from "@/components/LineItemRow";
import { resolveProductByCode } from "@/lib/barcode-resolve";
import { LicenseGuardModal } from "./LicenseGuardModal";
import { parseRegulatedAuthError, type BlockedCategory } from "@/lib/api/authorizations";
import { useTrackedCategories } from "@/lib/api/tracked-categories";
import { CreditNotePicker, type CreditSelection } from "./CreditNotePicker";
import { useAuth } from "@/lib/auth-context";
import { useHasAddon } from "@/lib/api/tobacco";
import { SALES_AGENTS_ADDON } from "@/lib/api/addons";

// ─── Schema ───────────────────────────────────────────────────────────────────

const schema = z.object({
  notes: z.string().optional(),
  urgent: z.boolean().optional(),
  /** ROUTE (dispatched on a delivery route) vs SHIP (supplier/carrier-shipped,
   *  excluded from trip/route dispatch) — seeded from the selected customer's
   *  own default, editable per order via the segmented control below. Plain
   *  `.optional()` (not `.default()`) matches `urgent` above — every call site
   *  already supplies an explicit "ROUTE"/"SHIP" value, and `.default()` here
   *  makes the zodResolver's inferred type disagree with useForm<FormValues>. */
  fulfillPath: z.enum(["ROUTE", "SHIP"]).optional(),
});

type FormValues = z.infer<typeof schema>;

/**
 * `OrderDraftPayload` (lib/drafts.ts) predates fulfillPath. Extended locally
 * rather than widening the shared type — fully optional so drafts parked
 * before this feature (missing the key) still hydrate fine.
 */
type DraftPayloadWithFulfillPath = OrderDraftPayload & { fulfillPath?: "ROUTE" | "SHIP" };

// ─── Types ────────────────────────────────────────────────────────────────────

interface SelectedCustomer {
  id: string;
  businessName: string;
  contactName?: string;
  pricingTier?: number;
  /** Per-customer fulfillment default — seeds the order's fulfillPath on select. */
  fulfillPath?: "ROUTE" | "SHIP";
}

interface LineItem {
  tempId: string;
  /** Empty string for unlisted (ad-hoc) lines — `isUnlisted` is the real flag. */
  productId: string;
  productName: string;
  unit: string;
  listPrice: number; // standard pricePerUnit from product catalog
  specialPrice?: number; // permanent customer-specific price (from CustomerPrice)
  discountedPrice?: number; // one-time ad-hoc override (below list = discount, above = upsell)
  unitPrice: number; // effective price used for display totals
  priceType: "STANDARD" | "SPECIAL" | "DISCOUNTED" | "MANUAL";
  qty: number; // total pieces (authoritative)
  unitsPerBox?: number; // set when product has box packaging
  boxes?: number; // whole boxes (only when unitsPerBox is set)
  pieces?: number; // extra loose pieces (only when unitsPerBox is set)
  unitCost?: number; // Product.averageCost (per piece) — for the live margin hint
  category?: string; // for the per-category margin floor
  /** Regulated tracked-category id (null for standard products) — maps a blocked
   *  category from the 409 license guard back to the cart line. */
  trackedCategoryId?: string | null;
  /** True for a free-text, non-catalog line (sent as { name, qty, unitPrice }). */
  isUnlisted?: boolean;
  /** Optional per-line note — carried onto the invoice line (buyer-visible). */
  note?: string;
  /** Note input expanded for this row (icon toggle; note text survives collapse). */
  noteOpen?: boolean;
  /** UI-only qty entry mode for case-packed lines. NEVER submitted — the payload always
   *  carries {qty, boxes, pieces} and the per-case unitPrice. */
  sellBy?: "case" | "unit";
}

// ─── Component ────────────────────────────────────────────────────────────────

export interface CreateOrderModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** When set, resume this parked draft (hydrate the builder from its payload). */
  resumeDraftId?: string | null;
  /** A barcode to add on open (scan-to-draft / scan-to-new, pos-cost-roles §2). */
  initialScanCode?: string | null;
}

export function CreateOrderModal({
  isOpen,
  onClose,
  resumeDraftId,
  initialScanCode,
}: CreateOrderModalProps) {
  const { toast } = useToast();
  const createOrder = useCreateOrder();

  // Minimize & resume drafts (pos-cost-roles-spec §2).
  const createDraft = useCreateDraft();
  const updateDraft = useUpdateDraft();
  const deleteDraft = useDeleteDraft();
  const { data: loadedDraft, isFetching: draftLoading } = useDraft(isOpen ? resumeDraftId : null);
  // The draft this builder session is bound to (set on resume, or after Minimize
  // of a fresh order). While set, edits autosave to it.
  const [activeDraftId, setActiveDraftId] = React.useState<string | null>(null);
  const hydratedRef = React.useRef<string | null>(null);
  const scanConsumedRef = React.useRef(false);
  const lastSavedRef = React.useRef<string>("");

  // Fetch default tax rate from settings
  const { data: settings } = useQuery<{ taxRate?: number }>({
    queryKey: ["settings"],
    queryFn: () => apiClient.get("/settings").then((r) => r.data),
    staleTime: 60_000,
  });
  const taxRate = (settings?.taxRate ?? 0) / 100;

  // Customer search state
  const [customerSearch, setCustomerSearch] = React.useState("");
  const [debouncedCustomerSearch, setDebouncedCustomerSearch] = React.useState("");
  const [selectedCustomer, setSelectedCustomer] = React.useState<SelectedCustomer | null>(null);
  const [customerError, setCustomerError] = React.useState("");

  // Customer per-product tier overrides
  const { data: customerPricesData } = useCustomerPrices(selectedCustomer?.id);
  const cpMap = React.useMemo(() => {
    const map = new Map<string, number | null>();
    (customerPricesData ?? []).forEach((cp: any) => map.set(cp.productId, cp.pricingTier ?? null));
    return map;
  }, [customerPricesData]);

  // Product search state
  const [productSearch, setProductSearch] = React.useState("");
  const [debouncedProductSearch, setDebouncedProductSearch] = React.useState("");
  const [lineItems, setLineItems] = React.useState<LineItem[]>([]);
  const [lineItemsError, setLineItemsError] = React.useState("");
  const [expandedParentId, setExpandedParentId] = React.useState<string | null>(null);

  // ── Custom (unlisted) item inline form ──
  const [customFormOpen, setCustomFormOpen] = React.useState(false);
  const [customName, setCustomName] = React.useState("");
  const [customPrice, setCustomPrice] = React.useState("");
  const [customQty, setCustomQty] = React.useState("1");
  const [customError, setCustomError] = React.useState("");
  const productSearchRef = React.useRef<HTMLInputElement>(null);
  // Scroll the just-scanned line into view so rapid scanning stays visible.
  const rowRefs = React.useRef<Map<string, HTMLLIElement>>(new Map());
  const [scrollToId, setScrollToId] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!scrollToId) return;
    rowRefs.current.get(scrollToId)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setScrollToId(null);
  }, [scrollToId, lineItems]);

  // Create-product modal state
  const [createProductOpen, setCreateProductOpen] = React.useState(false);
  const [createProductInitialName, setCreateProductInitialName] = React.useState("");
  const [createProductInitialSku, setCreateProductInitialSku] = React.useState("");

  // Merge-vs-separate prompt state. Set when the operator submits and the API
  // (or our pre-check) reports an existing active order for the same customer.
  const [mergePrompt, setMergePrompt] = React.useState<ActiveOrderSummary | null>(null);
  // The license guard (W6b): categories blocked by a 409 REGULATED_AUTH_REQUIRED.
  const [licenseBlock, setLicenseBlock] = React.useState<BlockedCategory[] | null>(null);
  // Pre-check: as soon as a customer is selected, look up their active order so we can
  // surface the prompt the moment "Create Order" is clicked.
  const { data: activeOrderForCustomer } = useActiveOrderForCustomer(selectedCustomer?.id);

  // Per-product last-given price for this customer — fetched once on customer select so
  // scanning is instant (no per-item round trip). Used to pre-fill the discount field.
  const { data: priceHistory } = useCustomerPriceHistory(selectedCustomer?.id);

  // Regulated tracked-categories (for the per-line "· regulated" tag + the live
  // invoice-split preview). Only staff build orders here; fetch while open.
  const { data: trackedCategories } = useTrackedCategories({ active: true }, { enabled: isOpen });
  const categoryById = React.useMemo(
    () => new Map((trackedCategories ?? []).map((c) => [c.id, c])),
    [trackedCategories],
  );
  const lineCategory = React.useCallback(
    (li: LineItem) => (li.trackedCategoryId ? categoryById.get(li.trackedCategoryId) : undefined),
    [categoryById],
  );

  // Live cost/margin: the "negotiation floor" (pos-cost-roles-spec §1).
  const { data: marginConfig } = useMarginConfig();
  // Lines where the operator chose "Sell anyway" below the floor — dismisses the warning.
  const [floorAcked, setFloorAcked] = React.useState<Set<string>>(new Set());
  const ackFloor = React.useCallback(
    (tempId: string) => setFloorAcked((prev) => new Set(prev).add(tempId)),
    [],
  );
  // Cost eye: lines whose cost/margin the operator revealed. OFF by default on
  // every line and NEVER serialized into parked drafts — privacy at the counter.
  const [costRevealed, setCostRevealed] = React.useState<Set<string>>(new Set());
  const toggleCostRevealed = React.useCallback(
    (tempId: string) =>
      setCostRevealed((prev) => {
        const next = new Set(prev);
        if (next.has(tempId)) next.delete(tempId);
        else next.add(tempId);
        return next;
      }),
    [],
  );

  // Debounce customer search
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedCustomerSearch(customerSearch), 300);
    return () => clearTimeout(t);
  }, [customerSearch]);

  // Debounce product search
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedProductSearch(productSearch), 300);
    return () => clearTimeout(t);
  }, [productSearch]);

  const { data: customersData } = useCustomers({
    search: debouncedCustomerSearch || undefined,
  });
  // A term that looks like a scanned code goes through the candidate-aware
  // `scanCode` search instead of raw `search` — a suffix-less wedge scanner
  // (no Enter) only ever populates this dropdown, and the raw decode
  // contains-misses whenever the camera/wedge decode differs from the stored
  // shape (iOS 13-digit vs 12-digit codes kept in numeric product names).
  const productTermIsScanCode = /^\d{8,14}$/.test(debouncedProductSearch.trim());
  const { data: productsData } = useProducts({
    search: productTermIsScanCode ? undefined : debouncedProductSearch || undefined,
    scanCode: productTermIsScanCode ? debouncedProductSearch.trim() : undefined,
    isActive: true,
    includeVariants: true,
  });

  const filteredCustomers = React.useMemo(() => {
    if (!debouncedCustomerSearch) return [];
    return (customersData?.data ?? []).slice(0, 8);
  }, [customersData, debouncedCustomerSearch]);

  const filteredProducts = React.useMemo(() => {
    if (!debouncedProductSearch) return [];
    // Only return top-level products (parents + standalones); variants are nested inside parents
    return (productsData?.data ?? [])
      .filter((p: any) => !p.parentProductId) // exclude variant rows from top-level
      .slice(0, 10);
  }, [productsData, debouncedProductSearch]);

  // Barcode scan handler — kept in a ref so the keydown listener never goes stale.
  // Uses the shared lib ladder (barcode endpoint → candidate-aware scanCode
  // search) instead of the old inline copy, which swallowed 5xx/network errors
  // as "not found" and skipped unitSku on the exact-match check. This surface
  // keeps its historical multi-match behaviour: first row wins (the modal's
  // scan flow has always auto-added; the edit page offers a picker instead).
  const barcodeScanHandlerRef = React.useRef<(code: string) => void>(() => {});
  barcodeScanHandlerRef.current = async (code: string) => {
    try {
      const result = await resolveProductByCode(code);
      if (result.archived) {
        // F30 / R5: the product exists but is retired — never put it on an
        // order silently, and never fall through to "create a new product"
        // for something the catalog already has.
        toast({
          variant: "error",
          title: `${result.product?.name || "Item"} is archived — reactivate to sell`,
        });
        return;
      }
      if (!result.notFound && result.product) {
        addLineItem(result.product); // addLineItem clears search + refocuses
        return;
      }
    } catch (err: any) {
      // Network / 5xx — a transient failure is NOT "product doesn't exist";
      // don't open the create-product modal over it.
      toast({
        variant: "error",
        title: "Couldn't look up the code",
        description:
          err?.response?.data?.message ?? err?.message ?? "Check the connection and rescan.",
      });
      return;
    }
    // Nothing found — open create-product modal with scanned barcode as SKU
    setCreateProductInitialName("");
    setCreateProductInitialSku(code);
    setCreateProductOpen(true);
  };

  // handleProductSearchEnter — called when Enter is pressed in the product search input.
  // Works for keyboard-emulation scanners AND paste-mode scanners (where no individual
  // keydown events fire for each character, so sequence-accumulation approaches fail).
  const handleProductSearchEnter = () => {
    const code = productSearch.trim();
    if (!code) return;
    setProductSearch("");
    setDebouncedProductSearch("");
    barcodeScanHandlerRef.current(code);
  };

  const { register, handleSubmit, reset, watch, setValue } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { urgent: false, fulfillPath: "ROUTE" },
  });

  const isUrgent = watch("urgent");
  const notesValue = watch("notes");
  const fulfillPath = watch("fulfillPath");

  // Reset the builder each time it opens (a fresh session). For a resume, the
  // hydration effect below re-fills the state from the draft payload right after.
  React.useEffect(() => {
    if (!isOpen) return;
    reset({ urgent: false, fulfillPath: "ROUTE" });
    setCustomerSearch("");
    setDebouncedCustomerSearch("");
    setSelectedCustomer(null);
    setCustomerError("");
    setProductSearch("");
    setDebouncedProductSearch("");
    setLineItems([]);
    setLineItemsError("");
    setCustomFormOpen(false);
    setCustomName("");
    setCustomPrice("");
    setCustomQty("1");
    setCustomError("");
    setRequestedDeliveryDate("");
    setOrderDate("");
    setCommissionRatePct(null);
    setOrderDiscount("");
    setShippingFeeInput("");
    setAppliedCredits([]);
    setFloorAcked(new Set());
    setCreateProductOpen(false);
    setCreateProductInitialName("");
    setCreateProductInitialSku("");
    createOrder.reset();
    // Draft-session bookkeeping: allow (re)hydration + one scan-add per open.
    setActiveDraftId(null);
    hydratedRef.current = null;
    scanConsumedRef.current = false;
    lastSavedRef.current = "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, resumeDraftId]);

  const [orderDiscount, setOrderDiscount] = React.useState("");
  const [shippingFeeInput, setShippingFeeInput] = React.useState("");
  // Customer credit notes selected to apply to this order's invoice(s). Not
  // draft-persisted (see drafts.ts) — a resumed draft starts with none selected.
  const [appliedCredits, setAppliedCredits] = React.useState<CreditSelection[]>([]);
  // Credit selections are per-customer — reset whenever the operator swaps customers.
  React.useEffect(() => {
    setAppliedCredits([]);
  }, [selectedCustomer?.id]);

  // ── Derived totals ────────────────────────────────────────────────────────

  // Use the shared helper so the live "Line total" matches what the server
  // will compute. For boxed products (unitsPerBox > 1), unitPrice is the BOX
  // price; loose pieces are prorated.
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
  const tax = subtotal * taxRate;
  const discountAmt = parseFloat(orderDiscount) || 0;
  const shippingAmt = Math.max(0, parseFloat(shippingFeeInput) || 0);
  const total = subtotal + tax - discountAmt + shippingAmt;

  // Live preview of the eventual invoice split (mirrors the API's
  // groupOrderLinesForInvoicing): each SEPARATE_INVOICE regulated category becomes
  // its own invoice; all other lines (standard + non-SEPARATE_INVOICE regulated)
  // fold into one standard invoice. Only shown once a split would actually happen.
  const invoiceSplit = React.useMemo(() => {
    const lineTotal = (li: LineItem) =>
      computeLineSubtotal({
        unitPrice: li.unitPrice,
        qty: li.qty,
        boxes: li.boxes ?? null,
        pieces: li.pieces ?? null,
        unitsPerBox: li.unitsPerBox ?? null,
      });
    const standard = { count: 0, subtotal: 0 };
    const separate = new Map<string, { name: string; count: number; subtotal: number }>();
    for (const li of lineItems) {
      const cat = li.trackedCategoryId ? categoryById.get(li.trackedCategoryId) : undefined;
      if (cat && cat.invoiceTreatment === "SEPARATE_INVOICE") {
        const g = separate.get(cat.id) ?? { name: cat.name, count: 0, subtotal: 0 };
        g.count += 1;
        g.subtotal += lineTotal(li);
        separate.set(cat.id, g);
      } else {
        standard.count += 1;
        standard.subtotal += lineTotal(li);
      }
    }
    const groups: { label: string; count: number; subtotal: number }[] = [];
    if (standard.count > 0) groups.push({ label: "Standard", ...standard });
    for (const g of Array.from(separate.values()).sort((a, b) => a.name.localeCompare(b.name)))
      groups.push({ label: g.name, count: g.count, subtotal: g.subtotal });
    return { groups, willSplit: separate.size > 0 };
  }, [lineItems, categoryById]);

  // ── Stop management ───────────────────────────────────────────────────────

  const addLineItem = (product: any) => {
    // If already in the list, increment qty by 1 (supports repeated scans of the same item)
    const existing = lineItems.find((li) => li.productId === product.id);
    if (existing) {
      setLineItems((prev) =>
        prev.map((li) => (li.productId === product.id ? { ...li, qty: li.qty + 1 } : li)),
      );
      setScrollToId(existing.tempId);
      setProductSearch("");
      setDebouncedProductSearch("");
      setTimeout(() => productSearchRef.current?.focus(), 50);
      return;
    }
    const newTempId = product.id + "-" + Date.now();
    const upb: number | undefined = product.unitsPerBox ? Number(product.unitsPerBox) : undefined;
    const listPrice = Number(product.pricePerUnit ?? 0);
    const customerTier = selectedCustomer?.pricingTier ?? 1;
    const tierOverride = cpMap.get(product.id);
    const effectiveTier = tierOverride ?? customerTier;
    const tierPrice = getTierPrice(product, effectiveTier);
    const priceType = effectiveTier !== 1 ? ("SPECIAL" as const) : ("STANDARD" as const);

    // Pre-fill from customer's last-given price for this product (only when below
    // the effective tier price, and only when this isn't already a SPECIAL price
    // — SPECIAL prices are permanent, the discount is already in tierPrice).
    const histEntry = priceHistory?.[product.id as string];
    const hasHistDiscount =
      priceType !== "SPECIAL" && histEntry != null && histEntry.lastPrice < tierPrice;
    // Carry forward a remembered UPSELL too (a saved price ABOVE list). It pre-fills
    // as a MANUAL override, mirroring the operator's last agreed above-list price.
    const hasHistUpsell =
      priceType !== "SPECIAL" && histEntry != null && histEntry.lastPrice > listPrice;
    const hasHistOverride = hasHistDiscount || hasHistUpsell;

    setLineItems((prev) => [
      ...prev,
      {
        tempId: newTempId,
        productId: product.id,
        // Show the full "<Parent> - <Variant>" name on the order line so the
        // customer knows which flavor / variety they ordered. Variants store
        // just the variant name in `product.name` (PR #44).
        productName: displayProductName(product),
        unit: product.unit ?? "each",
        listPrice,
        specialPrice: effectiveTier !== 1 ? tierPrice : undefined,
        discountedPrice: hasHistOverride ? histEntry!.lastPrice : undefined,
        unitPrice: hasHistOverride ? histEntry!.lastPrice : tierPrice,
        priceType: hasHistUpsell
          ? ("MANUAL" as const)
          : hasHistDiscount
            ? ("DISCOUNTED" as const)
            : priceType,
        qty: upb ? upb : 1,
        unitsPerBox: upb,
        boxes: upb ? 1 : undefined,
        pieces: upb ? 0 : undefined,
        unitCost: product.averageCost != null ? Number(product.averageCost) : undefined,
        category: product.category ?? undefined,
        trackedCategoryId: product.trackedCategoryId ?? null,
      },
    ]);
    setScrollToId(newTempId);
    setProductSearch("");
    setDebouncedProductSearch("");
    setLineItemsError("");
    // Re-focus the product search so the scanner is ready for the next item
    setTimeout(() => productSearchRef.current?.focus(), 50);
  };

  const removeLineItem = (tempId: string) => {
    setLineItems((prev) => prev.filter((li) => li.tempId !== tempId));
  };

  // Append a free-text "custom" line (not in the product catalog). Stored locally
  // like a normal line but flagged isUnlisted; submitted as { name, qty, unitPrice }.
  const addUnlistedItem = () => {
    const name = customName.trim();
    const price = parseFloat(customPrice);
    const qty = parseInt(customQty, 10);
    if (!name) {
      setCustomError("Enter an item name");
      return;
    }
    if (isNaN(price) || price < 0) {
      setCustomError("Enter a valid unit price");
      return;
    }
    if (isNaN(qty) || qty < 1) {
      setCustomError("Enter a quantity of at least 1");
      return;
    }
    const newTempId = `custom-${Date.now()}`;
    setLineItems((prev) => [
      ...prev,
      {
        tempId: newTempId,
        productId: "",
        productName: name,
        unit: "each",
        listPrice: price,
        unitPrice: price,
        priceType: "STANDARD" as const,
        qty,
        isUnlisted: true,
      },
    ]);
    setScrollToId(newTempId);
    setLineItemsError("");
    setCustomFormOpen(false);
    setCustomName("");
    setCustomPrice("");
    setCustomQty("1");
    setCustomError("");
  };

  // Inline edit of an unlisted line's name / unit price.
  const setLineNote = (tempId: string, note: string) => {
    setLineItems((prev) => prev.map((li) => (li.tempId === tempId ? { ...li, note } : li)));
  };
  const toggleNoteOpen = (tempId: string) => {
    setLineItems((prev) =>
      prev.map((li) => (li.tempId === tempId ? { ...li, noteOpen: !li.noteOpen } : li)),
    );
  };

  const updateUnlistedName = (tempId: string, name: string) => {
    setLineItems((prev) =>
      prev.map((li) => (li.tempId === tempId ? { ...li, productName: name } : li)),
    );
  };
  const updateUnlistedPrice = (tempId: string, value: number | null) => {
    setLineItems((prev) =>
      prev.map((li) => {
        if (li.tempId !== tempId) return li;
        const price = value == null || value < 0 ? 0 : value;
        return { ...li, unitPrice: price, listPrice: price };
      }),
    );
  };

  const updateQty = (tempId: string, delta: number) => {
    setLineItems((prev) =>
      prev.map((li) => {
        if (li.tempId !== tempId) return li;
        return { ...li, qty: Math.max(1, li.qty + delta) };
      }),
    );
  };

  const setBoxes = (tempId: string, value: number) => {
    setLineItems((prev) =>
      prev.map((li) => {
        if (li.tempId !== tempId) return li;
        const boxes = Math.max(0, isNaN(value) ? 0 : value);
        const pieces = li.pieces ?? 0;
        const qty = boxes * (li.unitsPerBox ?? 1) + pieces;
        return { ...li, boxes, qty: Math.max(qty, boxes > 0 || pieces > 0 ? qty : 0) };
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

  /** Unit mode: the operator types a TOTAL unit count; normalize it back into cases + loose.
   *  7 units of a 6-pack -> {boxes:1, pieces:1, qty:7}. Price is unchanged either way because
   *  computeLineSubtotal's proration is linear. */
  const setUnitQty = (tempId: string, value: number) => {
    setLineItems((prev) =>
      prev.map((li) => {
        if (li.tempId !== tempId) return li;
        const n = normalizeBoxesPieces({ qty: value, unitsPerBox: li.unitsPerBox });
        return { ...li, boxes: n.boxes ?? 0, pieces: n.pieces ?? 0, qty: n.qty };
      }),
    );
  };

  const setSellBy = (tempId: string, sellBy: "case" | "unit") =>
    setLineItems((prev) => prev.map((li) => (li.tempId === tempId ? { ...li, sellBy } : li)));

  const setDiscountedPrice = (tempId: string, value: number | null) => {
    setLineItems((prev) =>
      prev.map((li) => {
        if (li.tempId !== tempId) return li;
        if (value == null) {
          // Clear override — revert to special or list price
          const revertPrice = li.specialPrice ?? li.listPrice;
          return {
            ...li,
            discountedPrice: undefined,
            unitPrice: revertPrice,
            priceType: li.specialPrice != null ? "SPECIAL" : "STANDARD",
          };
        }
        const enteredPrice = Math.max(0, value);
        if (enteredPrice < li.listPrice) {
          return {
            ...li,
            discountedPrice: enteredPrice,
            unitPrice: enteredPrice,
            priceType: "DISCOUNTED",
          };
        }
        if (enteredPrice > li.listPrice) {
          // Upsell: sold ABOVE list. Stored as MANUAL; the base is hidden from the
          // customer server-side and shown green ("Upsell") to the operator.
          return {
            ...li,
            discountedPrice: enteredPrice,
            unitPrice: enteredPrice,
            priceType: "MANUAL",
          };
        }
        // Entered price == list price → no override
        const revertPrice = li.specialPrice ?? li.listPrice;
        return {
          ...li,
          discountedPrice: undefined,
          unitPrice: revertPrice,
          priceType: li.specialPrice != null ? "SPECIAL" : "STANDARD",
        };
      }),
    );
  };

  // ── Submit ────────────────────────────────────────────────────────────────

  const [requestedDeliveryDate, setRequestedDeliveryDate] = React.useState("");
  // Business date of the order (blank = today).
  const [orderDate, setOrderDate] = React.useState("");
  // The server's upper bound is the end of the current UTC day (parseOrderDate).
  const maxOrderDate = new Date().toISOString().slice(0, 10);

  // Staff-only per-order commission override (0 = exempt; null = agent/customer
  // default). Gated on role + the sales_agents addon — server re-checks both.
  const { user } = useAuth();
  const isStaff = user?.role === "OPERATOR" || user?.role === "TENANT_ADMIN";
  const hasSalesAgents = useHasAddon(SALES_AGENTS_ADDON);
  const [commissionRatePct, setCommissionRatePct] = React.useState<number | null>(null);

  // ── Minimize & resume drafts (pos-cost-roles-spec §2) ───────────────────────

  // The full builder state, serialized so a parked draft restores exactly.
  const draftPayload = React.useMemo<DraftPayloadWithFulfillPath>(
    () => ({
      customer: selectedCustomer,
      lineItems,
      orderDiscount,
      shippingFee: shippingFeeInput,
      requestedDeliveryDate,
      orderDate,
      notes: notesValue ?? "",
      urgent: !!isUrgent,
      floorAcked: Array.from(floorAcked),
      commissionRatePct,
      fulfillPath: fulfillPath ?? "ROUTE",
    }),
    [
      selectedCustomer,
      lineItems,
      orderDiscount,
      shippingFeeInput,
      requestedDeliveryDate,
      orderDate,
      notesValue,
      isUrgent,
      floorAcked,
      commissionRatePct,
      fulfillPath,
    ],
  );
  const draftPayloadJson = JSON.stringify(draftPayload);

  const buildDraftDto = React.useCallback(
    (payload: OrderDraftPayload) => ({
      kind: "ORDER" as const,
      customerId: payload.customer?.id ?? null,
      customerName: payload.customer?.businessName ?? null,
      title: payload.customer ? `Order, ${payload.customer.businessName}` : "Order draft",
      payload: payload as unknown as Record<string, unknown>,
      device: draftDeviceLabel(),
    }),
    [],
  );

  // Nothing worth parking until a customer is picked or a line is added.
  const canMinimize = !!selectedCustomer || lineItems.length > 0;
  const savingDraft = createDraft.isPending || updateDraft.isPending;

  // Park the current builder state into the local Draft (the dock). Returns whether
  // the save succeeded. Reuses the bound draft when resuming, else creates a new one.
  const parkDraft = async (): Promise<boolean> => {
    const dto = buildDraftDto(draftPayload);
    try {
      if (activeDraftId) {
        await updateDraft.mutateAsync({ id: activeDraftId, ...dto });
      } else {
        await createDraft.mutateAsync(dto);
      }
      lastSavedRef.current = draftPayloadJson;
      return true;
    } catch {
      return false;
    }
  };

  // Explicit Minimize button: park then close.
  const handleMinimize = async () => {
    if (!canMinimize || savingDraft) return;
    const ok = await parkDraft();
    toast(
      ok
        ? { title: "Draft parked", variant: "success" }
        : { title: "Could not park the draft", variant: "error" },
    );
    if (ok) onClose();
  };

  // The "add an item" sub-flow is active while the product search/scan field has
  // text OR the inline custom-item form is open. Escape while it's active cancels
  // ONLY the sub-flow (never the order); otherwise Escape falls through to dismiss.
  const addItemFlowActive = !!productSearch || customFormOpen;

  // Radix's Escape interception (see Modal.onEscapeKeyDown). While mid-add, swallow
  // the Escape and clear just the sub-flow state, keeping the order builder open.
  const handleEscape = (event: KeyboardEvent) => {
    if (!addItemFlowActive) return; // fall through → Radix dismiss → handleDismiss
    event.preventDefault();
    setProductSearch("");
    setDebouncedProductSearch("");
    if (customFormOpen) {
      setCustomFormOpen(false);
      setCustomName("");
      setCustomPrice("");
      setCustomQty("1");
      setCustomError("");
    }
    setTimeout(() => productSearchRef.current?.focus(), 0);
  };

  // User-initiated dismiss (Cancel button, backdrop, X, or Escape when NOT mid-add):
  // never lose an in-progress order — auto-park it to a draft first. An empty session
  // (nothing worth parking) closes instantly with no spurious network call/toast; a
  // save failure keeps the modal open so the work isn't lost.
  const handleDismiss = async () => {
    if (!canMinimize || savingDraft) {
      onClose();
      return;
    }
    const ok = await parkDraft();
    if (ok) {
      toast({ title: "Order saved as draft", variant: "success" });
      onClose();
    } else {
      toast({
        title: "Couldn't save your progress — the order is still open.",
        variant: "error",
      });
    }
  };

  // Hydrate the builder from a resumed draft (once per open).
  React.useEffect(() => {
    if (!isOpen || !resumeDraftId || !loadedDraft) return;
    if (hydratedRef.current === loadedDraft.id) return;
    hydratedRef.current = loadedDraft.id;
    const p = (loadedDraft.payload ?? {}) as unknown as DraftPayloadWithFulfillPath;
    setSelectedCustomer(p.customer ?? null);
    setLineItems(Array.isArray(p.lineItems) ? p.lineItems : []);
    setOrderDiscount(p.orderDiscount ?? "");
    setShippingFeeInput(p.shippingFee ?? "");
    setRequestedDeliveryDate(p.requestedDeliveryDate ?? "");
    setOrderDate(p.orderDate ?? "");
    setCommissionRatePct(p.commissionRatePct ?? null);
    setFloorAcked(new Set(p.floorAcked ?? []));
    // fulfillPath round-trips from the parked draft itself — NOT re-derived from
    // the customer's own default (that only seeds a FRESH selection; see the
    // picker's onClick). Order matters: this reset() must run after
    // setSelectedCustomer above so a resumed SHIP order stays SHIP.
    reset({ notes: p.notes ?? "", urgent: !!p.urgent, fulfillPath: p.fulfillPath ?? "ROUTE" });
    setActiveDraftId(loadedDraft.id);
    // Seed the autosave baseline so hydration itself never triggers a write. Key
    // order must match `draftPayload` — the comparison is on the JSON string.
    lastSavedRef.current = JSON.stringify({
      customer: p.customer ?? null,
      lineItems: Array.isArray(p.lineItems) ? p.lineItems : [],
      orderDiscount: p.orderDiscount ?? "",
      shippingFee: p.shippingFee ?? "",
      requestedDeliveryDate: p.requestedDeliveryDate ?? "",
      orderDate: p.orderDate ?? "",
      notes: p.notes ?? "",
      urgent: !!p.urgent,
      floorAcked: p.floorAcked ?? [],
      commissionRatePct: p.commissionRatePct ?? null,
      fulfillPath: p.fulfillPath ?? "ROUTE",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, resumeDraftId, loadedDraft]);

  // Autosave per change while bound to a draft (debounced so keystrokes stay cheap
  // and survive navigation / device loss). Skips when nothing changed.
  React.useEffect(() => {
    if (!isOpen || !activeDraftId) return;
    if (draftPayloadJson === lastSavedRef.current) return;
    const t = setTimeout(() => {
      updateDraft.mutate(
        { id: activeDraftId, ...buildDraftDto(draftPayload) },
        {
          onSuccess: () => {
            lastSavedRef.current = draftPayloadJson;
          },
        },
      );
    }, 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, activeDraftId, draftPayloadJson]);

  // Scan-to-draft / scan-to-new: add the incoming barcode once the builder is
  // ready — a fresh open adds immediately; a resumed draft waits until it has
  // hydrated (activeDraftId matches) so the scan appends to the restored lines.
  React.useEffect(() => {
    if (!isOpen || !initialScanCode || scanConsumedRef.current) return;
    if (resumeDraftId && activeDraftId !== resumeDraftId) return;
    scanConsumedRef.current = true;
    barcodeScanHandlerRef.current(initialScanCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialScanCode, resumeDraftId, activeDraftId]);

  // Stash form values + intended status across the merge-prompt round-trip so we can
  // re-submit with the operator's choice. Both "Save as Draft" and "Create Order"
  // funnel through here so the prompt fires for either action.
  const pendingFormValuesRef = React.useRef<FormValues | null>(null);
  const pendingAsDraftRef = React.useRef<boolean>(false);
  // Stashed submit args so the license guard can retry the create after the
  // operator captures a license or accepts responsibility.
  const licenseRetryRef = React.useRef<{
    data: FormValues;
    options: { mergeChoice?: "merge" | "separate"; asDraft?: boolean };
  } | null>(null);

  /**
   * Actually fire the create-order request with the operator's chosen mergeChoice
   * (or no choice, if the customer has no active order).
   */
  const submitOrder = (
    data: FormValues,
    options: { mergeChoice?: "merge" | "separate"; asDraft?: boolean } = {},
  ) => {
    const { mergeChoice, asDraft } = options;
    const itemsForSubmit = (
      asDraft
        ? lineItems.filter(
            (li) => (li.isUnlisted ? li.productName.trim() : li.productId) && li.qty > 0,
          )
        : lineItems
    ).map((li) => {
      // Optional per-line note (trimmed) — carried onto the invoice line.
      const note = li.note?.trim() ? { notes: li.note.trim() } : {};
      return li.isUnlisted
        ? // Unlisted (ad-hoc) line — no productId; unitPrice required.
          { name: li.productName.trim(), qty: li.qty, unitPrice: li.unitPrice, ...note }
        : {
            productId: li.productId,
            qty: li.qty,
            ...(li.unitsPerBox ? { boxes: li.boxes ?? 0, pieces: li.pieces ?? 0 } : {}),
            // Send unitPrice for one-time overrides — discounts (below list) and
            // upsells (MANUAL, above list). Not for permanent SPECIAL tier prices
            // (backend handles those via CustomerPrice).
            ...((li.priceType === "DISCOUNTED" || li.priceType === "MANUAL") &&
            li.discountedPrice != null
              ? { unitPrice: li.discountedPrice }
              : {}),
            ...note,
          };
    });
    createOrder.mutate(
      {
        customerId: selectedCustomer!.id,
        items: itemsForSubmit,
        notes: data.notes,
        urgent: data.urgent,
        fulfillPath: data.fulfillPath || "ROUTE",
        requestedDeliveryDate: requestedDeliveryDate || undefined,
        orderDate: orderDate || undefined,
        ...(discountAmt > 0 ? { discountAmount: discountAmt } : {}),
        ...(shippingAmt > 0 ? { shippingFee: shippingAmt } : {}),
        // 0 MUST be sent (it means exempt) — `!= null` preserves it; only a
        // blank field (null) is omitted so the agent/customer default applies.
        ...(commissionRatePct != null ? { commissionRatePct } : {}),
        ...(asDraft ? { status: "DRAFT" as const } : {}),
        ...(mergeChoice ? { mergeChoice } : {}),
        // Bill-now (createSale) has no path through this modal today — only
        // the create-order payload needs threading here.
        ...(appliedCredits.length ? { appliedCreditNotes: appliedCredits } : {}),
      } as any,
      {
        onSuccess: (created: any) => {
          if (mergeChoice === "merge") {
            toast({
              title: `Merged into order ${created?.orderNumber ?? "#" + created?.id?.slice(0, 6)}`,
              variant: "success",
            });
          } else if (asDraft) {
            toast({ title: "Order saved as draft", variant: "success" });
          } else {
            toast({ title: "Order created", variant: "success" });
          }
          // The parked draft has become a real order — clear it from the dock.
          if (activeDraftId) deleteDraft.mutate(activeDraftId);
          setMergePrompt(null);
          pendingFormValuesRef.current = null;
          pendingAsDraftRef.current = false;
          onClose();
        },
        onError: (err: any) => {
          // Belt-and-braces: if our pre-check missed an active order (race) the API
          // returns 409 with code MERGE_CHOICE_REQUIRED. Surface the modal from that.
          const body = err?.response?.data;
          if (
            err?.response?.status === 409 &&
            body?.code === "MERGE_CHOICE_REQUIRED" &&
            body?.activeOrder
          ) {
            pendingFormValuesRef.current = data;
            pendingAsDraftRef.current = !!asDraft;
            setMergePrompt(body.activeOrder as ActiveOrderSummary);
            return;
          }
          // A regulated line needs a verified license (or a §8 override / removal).
          const blocked = parseRegulatedAuthError(err);
          if (blocked && blocked.length > 0) {
            licenseRetryRef.current = { data, options };
            setLicenseBlock(blocked);
          }
        },
      },
    );
  };

  /**
   * Save-as-Draft entry point — looser validation (items optional), but still
   * goes through the merge-prompt flow when the customer has an active order.
   */
  const onSaveDraft = () => {
    if (!selectedCustomer) {
      setCustomerError("Select a customer");
      return;
    }
    // Read Notes from react-hook-form (the <Textarea> renders id="notes", so the
    // old getElementById("order-notes") always missed and dropped typed notes).
    const data: FormValues = {
      notes: notesValue || undefined,
      urgent: false,
    };
    if (activeOrderForCustomer) {
      pendingFormValuesRef.current = data;
      pendingAsDraftRef.current = true;
      setMergePrompt(activeOrderForCustomer);
      return;
    }
    submitOrder(data, { asDraft: true });
  };

  const onSubmit = (data: FormValues) => {
    let hasErrors = false;
    if (!selectedCustomer) {
      setCustomerError("Please select a customer");
      hasErrors = true;
    }
    if (lineItems.length === 0) {
      setLineItemsError("Add at least one product");
      hasErrors = true;
    }
    if (lineItems.some((li) => li.qty <= 0)) {
      setLineItemsError("All items must have a quantity greater than zero");
      hasErrors = true;
    }
    if (hasErrors) return;

    // If the customer already has an active draft/pending order, ask the operator
    // explicitly — never silently merge or silently duplicate.
    if (activeOrderForCustomer) {
      pendingFormValuesRef.current = data;
      pendingAsDraftRef.current = false;
      setMergePrompt(activeOrderForCustomer);
      return;
    }
    submitOrder(data);
  };

  // Extract the API's error message from Axios error structure
  const apiError: string | null = (() => {
    const err = createOrder.error as {
      response?: { data?: { message?: string } };
      message?: string;
    } | null;
    if (!err) return null;
    return err.response?.data?.message || err.message || "Something went wrong. Please try again.";
  })();

  return (
    <Modal
      open={isOpen}
      onClose={handleDismiss}
      onEscapeKeyDown={handleEscape}
      title={resumeDraftId ? "Resume draft" : "Create Order"}
      description="Create a new order on behalf of a customer."
      className="max-w-2xl"
      footer={
        // B564: the Modal footer is a `justify-end` flex row, so four buttons wider than a
        // 390px sheet overflowed off the LEFT edge and clipped Minimize. Under `sm` the save
        // actions get their own row and Minimize sits below them, full-width; from `sm` up
        // this is the original single row with Minimize pinned left.
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end sm:gap-3">
          {/* Minimize parks the whole builder into the bottom-left draft dock
              (pos-cost-roles-spec §2). Left-aligned, away from the save actions. */}
          <Button
            variant="ghost"
            type="button"
            className="w-full sm:mr-auto sm:w-auto"
            onClick={handleMinimize}
            disabled={!canMinimize || savingDraft}
            loading={savingDraft}
            leftIcon={<Minus className="h-4 w-4" />}
          >
            Minimize
          </Button>
          {/* Three-tier hierarchy: ghost (dismiss) < secondary (alt save) <
              primary (main action). Save-as-Draft was an amber button that
              competed with the primary blue and misused a warning colour. */}
          <div className="flex items-center justify-end gap-2 sm:gap-3">
            <Button variant="ghost" type="button" onClick={handleDismiss}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              type="button"
              loading={createOrder.isPending}
              onClick={onSaveDraft}
            >
              Save as Draft
            </Button>
            <Button type="submit" form="create-order-form" loading={createOrder.isPending}>
              Create Order
            </Button>
          </div>
        </div>
      }
    >
      <form
        id="create-order-form"
        onSubmit={handleSubmit(onSubmit)}
        noValidate
        onKeyDown={(e) => {
          if (e.key === "Enter") e.preventDefault();
        }}
        className="max-h-[65vh] overflow-y-auto pr-1"
      >
        <div className="space-y-5">
          {/* Resume hydration state */}
          {resumeDraftId && draftLoading && !activeDraftId && (
            <div className="rounded-md bg-brand-50 px-3 py-2 text-sm text-brand-700 ring-1 ring-brand-200">
              Loading your parked draft…
            </div>
          )}

          {/* API error */}
          {apiError && (
            <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">
              {apiError}
            </div>
          )}

          {/* ── Customer ── */}
          <section className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">Customer</p>

            {selectedCustomer ? (
              <div className="flex items-center justify-between rounded-lg border border-brand-300 bg-brand-50 px-3 py-2.5">
                <div>
                  <span className="text-sm font-medium text-navy">
                    {selectedCustomer.businessName}
                  </span>
                  {selectedCustomer.contactName && (
                    <span className="ml-2 text-xs text-navy/70">
                      {selectedCustomer.contactName}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedCustomer(null)}
                  className="rounded p-1 text-navy/70 hover:text-danger transition-colors"
                  title="Change customer"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <div className="relative">
                <input
                  type="search"
                  placeholder="Search by business name…"
                  value={customerSearch}
                  onChange={(e) => {
                    setCustomerSearch(e.target.value);
                    setCustomerError("");
                  }}
                  className={cn(
                    "h-10 w-full rounded border bg-white px-3 text-sm text-navy placeholder:text-navy/70 focus:outline-none focus:ring-2 focus:ring-brand-500",
                    customerError
                      ? "border-danger focus:border-transparent"
                      : "border-surface-border focus:border-transparent",
                  )}
                />
                {customerError && <p className="mt-1 text-xs text-danger">{customerError}</p>}
                {customerSearch &&
                  (filteredCustomers.length > 0 || debouncedCustomerSearch.length > 0) && (
                    <ul className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-surface-border bg-white shadow-dropdown">
                      {filteredCustomers.length === 0 && debouncedCustomerSearch.length > 0 && (
                        <li className="px-3 py-2 text-sm text-navy/70">No customers found.</li>
                      )}
                      {filteredCustomers.map((c: any) => (
                        <li key={c.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedCustomer(c);
                              // Seed the order's fulfillment from this customer's own
                              // default — done here (not a selectedCustomer-keyed
                              // effect) so hydrating a parked draft's own
                              // fulfillPath — via the same setSelectedCustomer call
                              // below — is never clobbered by this default.
                              setValue("fulfillPath", c.fulfillPath ?? "ROUTE");
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
                      ))}
                    </ul>
                  )}
              </div>
            )}
          </section>

          {/* ── Products / Line Items ── */}
          <section className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">Products</p>

            {/* Product search */}
            <div className="relative flex items-center gap-1.5">
              <input
                ref={productSearchRef}
                type="search"
                placeholder="Search by name, SKU or scan barcode…"
                value={productSearch}
                onChange={(e) => {
                  setProductSearch(e.target.value);
                  setLineItemsError("");
                  setExpandedParentId(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    handleProductSearchEnter();
                  }
                }}
                className={cn(
                  "h-10 min-w-0 flex-1 rounded border bg-white px-3 text-sm text-navy placeholder:text-navy/70 focus:outline-none focus:ring-2 focus:ring-brand-500",
                  lineItemsError && lineItems.length === 0
                    ? "border-danger focus:border-transparent"
                    : "border-surface-border focus:border-transparent",
                )}
              />
              <BarcodeScannerButton
                inputRef={productSearchRef}
                onScan={(code) => barcodeScanHandlerRef.current(code)}
                onError={(message) => toast({ variant: "error", title: message })}
                className="h-10 min-h-[44px] w-10 min-w-[44px] shrink-0"
                title="Scan barcode"
              />
              {productSearch &&
                (filteredProducts.length > 0 || debouncedProductSearch.length > 0) && (
                  <ul className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-surface-border bg-white shadow-dropdown">
                    {filteredProducts.length === 0 && debouncedProductSearch.length > 0 && (
                      <li className="px-3 py-2 text-sm text-navy/70">No products found.</li>
                    )}
                    {filteredProducts.map((p: any) => {
                      const hasVariants = p.variants?.length > 0;
                      const isExpanded = expandedParentId === p.id;
                      const alreadyAdded = lineItems.some((li) => li.productId === p.id);
                      return (
                        <React.Fragment key={p.id}>
                          <li>
                            <button
                              type="button"
                              onClick={() => {
                                if (hasVariants) {
                                  setExpandedParentId(isExpanded ? null : p.id);
                                } else {
                                  // Already-added rows increment qty (addLineItem's
                                  // repeat path) — the old no-op left the search
                                  // text + open dropdown for the operator to
                                  // clean up by hand, reading as "choosing does
                                  // nothing". Scan of the same code has always
                                  // incremented; clicking now matches it.
                                  addLineItem(p);
                                }
                              }}
                              className={cn(
                                "flex w-full items-center justify-between px-3 py-2.5 text-left text-sm text-navy hover:bg-surface-raised",
                                alreadyAdded && !hasVariants && "opacity-40",
                              )}
                            >
                              <div className="flex items-center gap-1.5 min-w-0">
                                {hasVariants && (
                                  <ChevronRight
                                    className={cn(
                                      "h-3.5 w-3.5 shrink-0 text-navy/70 transition-transform",
                                      isExpanded && "rotate-90",
                                    )}
                                  />
                                )}
                                <span className="font-medium truncate">{p.name}</span>
                                {p.sku && (
                                  <span className="text-xs text-navy/70 shrink-0">{p.sku}</span>
                                )}
                                {hasVariants && (
                                  <span className="ml-1 text-[10px] text-navy/70 shrink-0">
                                    {p.variants.length} variants
                                  </span>
                                )}
                                {!hasVariants && (
                                  <span className="ml-1 text-xs text-navy/70 shrink-0">
                                    {p.unit}
                                  </span>
                                )}
                              </div>
                              {!hasVariants && (
                                <span className="text-xs font-medium text-navy/70 shrink-0 ml-2">
                                  ${Number(p.pricePerUnit ?? 0).toFixed(2)}
                                </span>
                              )}
                            </button>
                          </li>
                          {/* Expanded variants */}
                          {hasVariants &&
                            isExpanded &&
                            p.variants.map((v: any) => {
                              const variantAdded = lineItems.some((li) => li.productId === v.id);
                              return (
                                <li key={v.id} className="bg-surface-raised/50">
                                  <button
                                    type="button"
                                    onClick={() => addLineItem(v)}
                                    className={cn(
                                      "flex w-full items-center justify-between pl-8 pr-3 py-2 text-left text-sm text-navy hover:bg-surface-raised",
                                      variantAdded && "opacity-40",
                                    )}
                                  >
                                    <div className="flex items-center gap-1.5 min-w-0">
                                      <span className="font-medium truncate">
                                        {v.variantName ?? v.name}
                                      </span>
                                      {v.sku && (
                                        <span className="text-xs text-navy/70 shrink-0">
                                          {v.sku}
                                        </span>
                                      )}
                                      <span className="text-xs text-navy/70 shrink-0">
                                        {v.unit}
                                      </span>
                                    </div>
                                    <span className="text-xs font-medium text-navy/70 shrink-0 ml-2">
                                      ${Number(v.pricePerUnit ?? 0).toFixed(2)}
                                    </span>
                                  </button>
                                </li>
                              );
                            })}
                        </React.Fragment>
                      );
                    })}
                    <li className="border-t border-surface-border">
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-brand-500 hover:bg-surface-raised font-medium"
                        onClick={() => {
                          const looksLikeSku = /^\d{6,}$/.test(debouncedProductSearch.trim());
                          setCreateProductInitialName(looksLikeSku ? "" : debouncedProductSearch);
                          setCreateProductInitialSku(
                            looksLikeSku ? debouncedProductSearch.trim() : "",
                          );
                          setCreateProductOpen(true);
                          setProductSearch("");
                          setDebouncedProductSearch("");
                        }}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Create new product
                        {debouncedProductSearch ? `: "${debouncedProductSearch}"` : ""}
                      </button>
                    </li>
                  </ul>
                )}
            </div>

            {lineItemsError && lineItems.length === 0 && (
              <p className="text-xs text-danger">{lineItemsError}</p>
            )}

            {/* ── Add custom (unlisted) item ── */}
            {customFormOpen ? (
              <div className="space-y-2 rounded-lg border border-dashed border-brand-300 bg-brand-50 px-3 py-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-navy">Custom item</span>
                  <button
                    type="button"
                    onClick={() => {
                      setCustomFormOpen(false);
                      setCustomError("");
                    }}
                    className="rounded p-1 text-navy/40 hover:text-danger transition-colors"
                    title="Cancel"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-[140px] flex-1 space-y-1">
                    <label className="block text-[10px] font-medium text-navy/70">Name</label>
                    <input
                      type="text"
                      value={customName}
                      onChange={(e) => setCustomName(e.target.value)}
                      placeholder="e.g. Pallet delivery surcharge"
                      className="h-9 w-full rounded border border-surface-border bg-white px-2 text-sm text-navy placeholder:text-navy/40 focus:outline-none focus:ring-1 focus:ring-brand-500"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addUnlistedItem();
                        }
                      }}
                    />
                  </div>
                  <div className="w-24 space-y-1">
                    <label className="block text-[10px] font-medium text-navy/70">Unit price</label>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={customPrice}
                      onChange={(e) => setCustomPrice(e.target.value)}
                      placeholder="0.00"
                      className="h-9 w-full rounded border border-surface-border bg-white px-2 text-right text-sm text-navy placeholder:text-navy/40 focus:outline-none focus:ring-1 focus:ring-brand-500"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addUnlistedItem();
                        }
                      }}
                    />
                  </div>
                  <div className="w-16 space-y-1">
                    <label className="block text-[10px] font-medium text-navy/70">Qty</label>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={customQty}
                      onChange={(e) => setCustomQty(e.target.value)}
                      className="h-9 w-full rounded border border-surface-border bg-white px-2 text-right text-sm text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addUnlistedItem();
                        }
                      }}
                    />
                  </div>
                  <Button type="button" size="sm" onClick={addUnlistedItem}>
                    Add
                  </Button>
                </div>
                {customError && <p className="text-xs text-danger">{customError}</p>}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setCustomFormOpen(true)}
                className="flex items-center gap-1.5 text-sm font-medium text-brand-500 hover:text-brand-600 transition-colors"
              >
                <Plus className="h-4 w-4" />
                Add custom item
              </button>
            )}

            {/* Line items list */}
            {lineItems.length > 0 ? (
              <ul className="divide-y divide-surface-border overflow-hidden rounded-lg border border-surface-border">
                {lineItems.map((li) => (
                  <LineItemRow
                    key={li.tempId}
                    item={li}
                    category={lineCategory(li) ?? null}
                    marginFloor={floorForCategory(marginConfig, li.category)}
                    floorAcked={floorAcked.has(li.tempId)}
                    costRevealed={costRevealed.has(li.tempId)}
                    priceHistoryEntry={priceHistory?.[li.productId]}
                    rowRef={(el) => {
                      if (el) rowRefs.current.set(li.tempId, el);
                      else rowRefs.current.delete(li.tempId);
                    }}
                    onQtyDelta={(delta) => updateQty(li.tempId, delta)}
                    onSetBoxes={(value) => setBoxes(li.tempId, value)}
                    onSetPieces={(value) => setPieces(li.tempId, value)}
                    onSetUnitQty={(value) => setUnitQty(li.tempId, value)}
                    onSetSellBy={(mode) => setSellBy(li.tempId, mode)}
                    onSetDiscountedPrice={(value) => setDiscountedPrice(li.tempId, value)}
                    onSetToFloor={(floorPrice) => setDiscountedPrice(li.tempId, floorPrice)}
                    onAckFloor={() => ackFloor(li.tempId)}
                    onToggleCostRevealed={() => toggleCostRevealed(li.tempId)}
                    onToggleNoteOpen={() => toggleNoteOpen(li.tempId)}
                    onSetNote={(note) => setLineNote(li.tempId, note)}
                    onUpdateUnlistedName={(name) => updateUnlistedName(li.tempId, name)}
                    onUpdateUnlistedPrice={(value) => updateUnlistedPrice(li.tempId, value)}
                    onRemove={() => removeLineItem(li.tempId)}
                  />
                ))}
              </ul>
            ) : (
              <div className="rounded-lg border border-dashed border-surface-border bg-surface-raised py-6 text-center">
                <p className="text-sm text-navy/70">Search for products above to add line items.</p>
              </div>
            )}
          </section>

          {/* ── Regulated invoice-split preview (regulated-items-spec §4) ── */}
          {invoiceSplit.willSplit && (
            <div className="space-y-1.5 rounded-lg border border-amber-200 bg-amber-50/40 px-4 py-3 text-sm">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-700">
                Splits into {invoiceSplit.groups.length} invoices
              </p>
              {invoiceSplit.groups.map((g, i) => (
                <div key={g.label} className="flex justify-between text-navy/70">
                  <span>
                    Invoice {i + 1} — {g.label}{" "}
                    <span className="text-navy/40">
                      ({g.count} {g.count === 1 ? "item" : "items"})
                    </span>
                  </span>
                  <span>${g.subtotal.toFixed(2)}</span>
                </div>
              ))}
              <p className="pt-0.5 text-[10px] text-navy/50">
                Regulated categories are billed on their own invoice. Amounts shown are pre-tax
                subtotals.
              </p>
            </div>
          )}

          {/* ── Order totals ── */}
          {lineItems.length > 0 && (
            <div className="space-y-1.5 rounded-lg border border-surface-border bg-surface-raised px-4 py-3 text-sm">
              <div className="flex justify-between text-navy/70">
                <span>Subtotal</span>
                <span>${subtotal.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-navy/70">
                <span>Tax ({settings?.taxRate ?? 10}%)</span>
                <span>${tax.toFixed(2)}</span>
              </div>
              {/* Order-level discount */}
              <div className="flex items-center justify-between text-navy/70">
                <label className="flex items-center gap-2 text-sm">
                  Order discount
                  <MoneyInput
                    min={0}
                    placeholder="0.00"
                    value={orderDiscount === "" ? null : parseFloat(orderDiscount)}
                    onChange={(v) => setOrderDiscount(v == null ? "" : String(v))}
                    className="w-20 rounded border border-surface-border bg-white px-2 py-0.5 text-xs text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                </label>
                {discountAmt > 0 && (
                  <span className="text-amber-600">−${discountAmt.toFixed(2)}</span>
                )}
              </div>
              {/* Shipping fee (optional, never taxed) */}
              <div className="flex items-center justify-between text-navy/70">
                <label className="flex items-center gap-2 text-sm">
                  Shipping fee
                  <MoneyInput
                    min={0}
                    placeholder="0.00 (optional)"
                    value={shippingFeeInput === "" ? null : parseFloat(shippingFeeInput)}
                    onChange={(v) => setShippingFeeInput(v == null ? "" : String(v))}
                    className="w-20 rounded border border-surface-border bg-white px-2 py-0.5 text-xs text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                </label>
                {shippingAmt > 0 && <span className="text-navy">+${shippingAmt.toFixed(2)}</span>}
              </div>
              <div className="flex justify-between border-t border-surface-border pt-1.5 font-semibold text-navy">
                <span>Total</span>
                <span>${total.toFixed(2)}</span>
              </div>
            </div>
          )}

          {/* ── Apply customer credit notes (customer-scoped, auto-populated) ── */}
          {selectedCustomer && (
            <CreditNotePicker
              customerId={selectedCustomer.id}
              value={appliedCredits}
              onChange={setAppliedCredits}
              estimatedOrderTotal={total}
            />
          )}

          {/* ── Options ── */}
          <section className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">Options</p>

            {/* Dates */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="block text-xs font-medium text-navy/70" htmlFor="delivery-date">
                  Requested Delivery Date{" "}
                  <span className="font-normal text-navy/70">(optional)</span>
                </label>
                <input
                  id="delivery-date"
                  type="date"
                  value={requestedDeliveryDate}
                  onChange={(e) => setRequestedDeliveryDate(e.target.value)}
                  className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-medium text-navy/70" htmlFor="order-date">
                  Order date <span className="font-normal text-navy/70">(optional)</span>
                </label>
                <input
                  id="order-date"
                  type="date"
                  max={maxOrderDate}
                  value={orderDate}
                  onChange={(e) => setOrderDate(e.target.value)}
                  className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <p className="text-[11px] leading-snug text-navy/70">
                  The day the order actually happened. Leave blank for today.
                </p>
              </div>
            </div>

            {isStaff && hasSalesAgents && (
              <div className="space-y-1">
                <label className="block text-xs font-medium text-navy/70" htmlFor="commission-rate">
                  Commission rate override{" "}
                  <span className="font-normal text-navy/70">(optional)</span>
                </label>
                <DecimalInput
                  id="commission-rate"
                  value={commissionRatePct}
                  onChange={setCommissionRatePct}
                  decimals={2}
                  min={0}
                  max={100}
                  placeholder="Agent / customer default"
                  className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <p className="text-[11px] leading-snug text-navy/70">
                  Percent of the goods subtotal for this order only. 0 = exempt (no commission).
                  Blank = the customer/agent default rate.
                </p>
              </div>
            )}

            <div className="space-y-1">
              <label className="block text-xs font-medium text-navy/70">Fulfillment</label>
              <div className="inline-flex rounded-lg border border-surface-border bg-white p-0.5">
                <button
                  type="button"
                  onClick={() => setValue("fulfillPath", "ROUTE")}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                    fulfillPath === "ROUTE" ? "bg-navy text-white" : "text-navy/70 hover:text-navy",
                  )}
                >
                  Delivery route
                </button>
                <button
                  type="button"
                  onClick={() => setValue("fulfillPath", "SHIP")}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                    fulfillPath === "SHIP" ? "bg-navy text-white" : "text-navy/70 hover:text-navy",
                  )}
                >
                  Ship via carrier
                </button>
              </div>
              {fulfillPath === "SHIP" && (
                <p className="text-[11px] leading-snug text-navy/70">
                  Ships via carrier — won&apos;t appear on delivery routes.
                </p>
              )}
            </div>

            <Textarea
              label="Notes"
              placeholder="Special instructions, delivery notes…"
              register={register("notes")}
            />

            <label
              className={cn(
                "flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 transition-colors",
                isUrgent
                  ? "border-danger/40 bg-danger-bg"
                  : "border-surface-border bg-white hover:bg-surface-raised",
              )}
            >
              <input type="checkbox" {...register("urgent")} className="h-4 w-4 accent-danger" />
              <AlertTriangle className={cn("h-4 w-4", isUrgent ? "text-danger" : "text-navy/30")} />
              <span className={cn("text-sm font-medium", isUrgent ? "text-danger" : "text-navy")}>
                Mark as Urgent
              </span>
            </label>
          </section>
        </div>
      </form>

      <InlineCreateProductModal
        isOpen={createProductOpen}
        onClose={() => setCreateProductOpen(false)}
        onCreated={(product) => {
          addLineItem({
            id: product.id,
            // A just-created variant's `name` is the bare flavor — compose
            // "Parent - Flavor" so the line label matches picked products.
            name: displayProductName(product),
            sku: product.sku,
            unit: product.unit,
            pricePerUnit: product.pricePerUnit,
            // Real box size so boxed products get the Boxes+Pcs editor.
            unitsPerBox: product.unitsPerBox ?? undefined,
          });
          setCreateProductOpen(false);
        }}
        initialName={createProductInitialName}
        initialSku={createProductInitialSku}
      />

      {/* Merge-or-separate prompt: shown when the selected customer already has an
          unconfirmed order. Operator must choose explicitly — no default. */}
      <Modal
        open={!!mergePrompt}
        onClose={() => {
          setMergePrompt(null);
          pendingFormValuesRef.current = null;
          pendingAsDraftRef.current = false;
        }}
        title="Open order exists"
        description={
          mergePrompt
            ? orderDate
              ? `This customer already has an open ${mergePrompt.status.toLowerCase()} order. Merging files these items under that order's date, so a backdated order has to be created separately.`
              : `This customer already has an open ${mergePrompt.status.toLowerCase()} order. Merge these items into it, or create a fully separate order?`
            : undefined
        }
        className="max-w-md"
        footer={
          mergePrompt ? (
            <div className="flex w-full flex-col gap-2">
              {/* Merging routes through the existing order, which keeps its own
                  orderDate — the backdate would be dropped, so it is not offered. */}
              <Button
                type="button"
                variant={orderDate ? "secondary" : "primary"}
                disabled={!!orderDate}
                loading={createOrder.isPending}
                onClick={() => {
                  if (pendingFormValuesRef.current)
                    submitOrder(pendingFormValuesRef.current, {
                      mergeChoice: "merge",
                      asDraft: pendingAsDraftRef.current,
                    });
                }}
              >
                Merge into {mergePrompt.orderNumber ?? "existing order"}
              </Button>
              <Button
                type="button"
                variant={orderDate ? "primary" : "secondary"}
                loading={createOrder.isPending}
                onClick={() => {
                  if (pendingFormValuesRef.current)
                    submitOrder(pendingFormValuesRef.current, {
                      mergeChoice: "separate",
                      asDraft: pendingAsDraftRef.current,
                    });
                }}
              >
                Create as separate {pendingAsDraftRef.current ? "draft" : "order"}
              </Button>
            </div>
          ) : null
        }
      >
        {mergePrompt && (
          <div className="rounded-md border border-surface-border bg-surface-raised px-3 py-2 text-sm">
            <div className="font-medium text-navy">
              {mergePrompt.orderNumber ?? mergePrompt.id.slice(0, 8)}
            </div>
            <div className="text-navy/70">
              {mergePrompt.itemCount} item{mergePrompt.itemCount === 1 ? "" : "s"} · $
              {mergePrompt.total.toFixed(2)}
            </div>
          </div>
        )}
      </Modal>

      {/* License guard (W6b): the sale hit a 409 REGULATED_AUTH_REQUIRED. */}
      {licenseBlock && selectedCustomer && (
        <LicenseGuardModal
          open
          customerId={selectedCustomer.id}
          blocked={licenseBlock}
          onResolved={() => {
            const retry = licenseRetryRef.current;
            setLicenseBlock(null);
            if (retry) submitOrder(retry.data, retry.options);
          }}
          onRemoveLines={(categoryIds) => {
            setLineItems((prev) =>
              prev.filter(
                (li) => !li.trackedCategoryId || !categoryIds.includes(li.trackedCategoryId),
              ),
            );
            toast({ title: "Removed regulated line(s)", variant: "success" });
          }}
          onClose={() => setLicenseBlock(null)}
        />
      )}
    </Modal>
  );
}
