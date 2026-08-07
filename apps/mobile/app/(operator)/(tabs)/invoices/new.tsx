import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { FilterChipRow, NavBackButton, NavBar, SearchBar } from "@routeflow/ui/mobile/ios";
import { useAdminCustomers } from "../../../../lib/api/admin";
import { useProducts } from "../../../../lib/api/products";
import { useCreateInvoice, type CreateInvoiceItem } from "../../../../lib/api/invoices";
import { showToast } from "../../../../lib/toast";
import {
  decrementLine,
  incrementLine,
  setLineBoxes,
  setLinePieces,
  setLineQty,
  setLineUnits,
} from "../../../../lib/sale-line";
import { resolveProductByCode } from "../../../../lib/barcode-resolve";
// Compose "<Parent> - <Variant>" so variants don't show as "Strawberry" alone.
import { displayProductName as displayName } from "../../../../lib/product-display";
import {
  computeLineSubtotal,
  effectiveQty,
  normalizeBoxesPieces,
  roundMoney,
} from "../../../../lib/pricing";
import { MoneyTextInput } from "../../../../components/MoneyTextInput";
import { alertInfo, chooseAction } from "../../../../lib/confirm";
import { QtyStepper } from "../../../../components/QtyStepper";
import { InlineCreateProductSheet } from "../../../../components/InlineCreateProductSheet";
import { InlineToast, useInlineToast } from "../../../../components/InlineToast";
import { ProductRow } from "../../../../components/ProductRow";
import { ScanOrderSheet } from "../../../../components/ScanOrderSheet";
import type { CreatedProduct } from "../../../../lib/api/products";
import { ScanOutcome } from "../../../../lib/scan-loop";
import { bumpScanOrder, nextFlash, trayRowsFrom, type ScanFlash } from "../../../../lib/scan-tray";
import {
  NO_PENDING_SCROLL,
  requestScroll,
  stepPendingScroll,
  type PendingScrollState,
} from "../../../../lib/pending-scroll";
import { withCartRows } from "../../../../lib/visible-cart";
import { unlistedAffordancePlacement } from "../../../../lib/unlisted-affordance";
import { sanitizeIntInput } from "../../../../lib/qty";

/**
 * Standalone invoice composer for the mobile operator UI.
 *
 * Shares the new-order flow's parts (customer picker → catalog list with
 * inline steppers → review sheet → save) so the two builders stay identical:
 * ProductRow rows in a FlatList, ScanOrderSheet as the only scan entry point,
 * pending-scroll for scroll-to-added.
 *
 * Posts to POST /invoices (not from-order/partial) — for splitting an existing
 * order into invoices, use the order detail's "Split into invoice" entry.
 */

const TERM_DAYS: Record<string, number> = {
  "Due on Receipt": 0,
  "Net 15": 15,
  "Net 30": 30,
  "Net 45": 45,
  "Net 60": 60,
};

const TERM_OPTIONS = Object.keys(TERM_DAYS);
const TERM_CHIPS = TERM_OPTIONS.map((label) => ({ label }));
const DEFAULT_TERMS = "Net 30";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function todayPlusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Due date = issue date (today when blank) + the term's day count, as web does. */
function dueDateFor(issueDate: string, terms: string): string {
  const days = TERM_DAYS[terms] ?? 30;
  if (!ISO_DATE.test(issueDate)) return todayPlusDays(days);
  const d = new Date(`${issueDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function toNumber(v: number | string | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

type Product = {
  id: string;
  name: string;
  sku?: string | null;
  barcode?: string | null;
  unit?: string;
  pricePerUnit: number | string;
  category?: string | null;
  unitsPerBox?: number | null;
  parentProductId?: string | null;
  parent?: { id: string; name: string } | null;
};

// `unitPrice` is an optional one-time price override (the "discounted price").
// When unset, the catalog price is used. For boxed products it is the BOX price,
// matching the catalog price unit; computeLineSubtotal prorates pieces.
type LineState = { qty: number; boxes?: number; pieces?: number; unitPrice?: number };

/**
 * An ad-hoc, non-catalog ("unlisted") invoice line: free-text description +
 * required price; never boxed. Serialised as `{ description, qty, unitPrice }`
 * (no productId). Keyed locally by a synthetic id.
 */
type UnlistedLine = { id: string; name: string; unitPrice: number; qty: number };

function newLocalId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The effective per-unit price for a line: the override, else the catalog price. */
function effectiveUnitPrice(line: LineState | undefined, p: Product): number {
  return line?.unitPrice != null ? line.unitPrice : toNumber(p.pricePerUnit);
}

const productKey = (p: Product) => p.id;

function RowSpacer() {
  return <View style={styles.rowSpacer} />;
}

/** One-line "2 cases + 1 loose · $54.00" for an added case-packed catalog row. */
function boxedLineSummary(line: LineState, product: Product, unitPrice: number): string {
  const split = normalizeBoxesPieces({
    boxes: line.boxes,
    pieces: line.pieces,
    qty: line.qty,
    unitsPerBox: product.unitsPerBox,
  });
  const boxes = split.boxes ?? 0;
  const pieces = split.pieces ?? 0;
  const parts: string[] = [];
  if (boxes > 0) parts.push(`${boxes} case${boxes === 1 ? "" : "s"}`);
  if (pieces > 0) parts.push(`${pieces} loose`);
  // Raw line fields, exactly as the footer memo passes them — the two totals
  // must be byte-identical.
  const subtotal = computeLineSubtotal({
    unitPrice,
    qty: split.qty,
    boxes: line.boxes ?? null,
    pieces: line.pieces ?? null,
    unitsPerBox: product.unitsPerBox ?? null,
  });
  return `${parts.join(" + ") || "0"} · $${subtotal.toFixed(2)}`;
}

export default function NewInvoiceScreen() {
  const router = useRouter();
  const [pickedCustomerId, setPickedCustomerId] = useState<string | null>(null);
  const [pickedCustomerName, setPickedCustomerName] = useState<string | null>(null);

  // `router.back()` is a silent no-op on web when this URL was opened
  // directly (empty history stack). Always have a fallback destination.
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/(operator)/(tabs)/invoices" as any);
  };

  if (!pickedCustomerId) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <CustomerPicker
          onBack={goBack}
          onPick={(id, name) => {
            setPickedCustomerId(id);
            setPickedCustomerName(name);
          }}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <InvoiceComposer
        customerId={pickedCustomerId}
        customerName={pickedCustomerName}
        onBack={goBack}
        onChangeCustomer={() => {
          setPickedCustomerId(null);
          setPickedCustomerName(null);
        }}
        onSaved={(invoiceId, invoiceNumber) => {
          showToast(`Invoice ${invoiceNumber} created`);
          router.replace(`/(operator)/invoices/${invoiceId}` as any);
        }}
      />
    </SafeAreaView>
  );
}

// ─── Customer picker ─────────────────────────────────────────────────────────

function CustomerPicker({
  onBack,
  onPick,
}: {
  onBack: () => void;
  onPick: (id: string, name: string) => void;
}) {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useAdminCustomers({
    search: search.trim() || undefined,
    limit: 100,
  });
  const customers = data?.data ?? [];

  return (
    <>
      <NavBar inlineTitle="New invoice" leading={<NavBackButton label="Back" onPress={onBack} />} />
      <SearchBar placeholder="Search customers…" value={search} onChangeText={setSearch} />
      <ScrollView showsVerticalScrollIndicator={false}>
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : customers.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyText}>
              {search ? "No customers match." : "No customers yet."}
            </Text>
          </View>
        ) : (
          <View style={styles.customerList}>
            {customers.map((c, i) => (
              <Pressable
                key={c.id}
                style={[
                  styles.customerRow,
                  i > 0 && {
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: ios.separator,
                  },
                ]}
                onPress={() => onPick(c.id, c.businessName)}
              >
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>
                    {c.businessName
                      .split(/\s+/)
                      .filter(Boolean)
                      .slice(0, 2)
                      .map((w) => w[0]?.toUpperCase() ?? "")
                      .join("") || "?"}
                  </Text>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.customerName} numberOfLines={1}>
                    {c.businessName}
                  </Text>
                  {c.contactName ? (
                    <Text style={styles.customerSub} numberOfLines={1}>
                      {c.contactName}
                    </Text>
                  ) : null}
                </View>
                <Ionicons name="chevron-forward" size={16} color={ios.gray[3]} />
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </>
  );
}

// ─── Composer ────────────────────────────────────────────────────────────────

function InvoiceComposer({
  customerId,
  customerName,
  onBack,
  onChangeCustomer,
  onSaved,
}: {
  customerId: string;
  customerName: string | null;
  onBack: () => void;
  onChangeCustomer: () => void;
  onSaved: (invoiceId: string, invoiceNumber: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [items, setItems] = useState<Record<string, LineState>>({});
  // Ad-hoc lines not in the catalog (no productId on submit).
  const [unlisted, setUnlisted] = useState<UnlistedLine[]>([]);
  const [unlistedModalOpen, setUnlistedModalOpen] = useState(false);
  // Name to prefill the unlisted-item composer with (from an empty search).
  const [unlistedPrefill, setUnlistedPrefill] = useState("");
  const [scannedById, setScannedById] = useState<Record<string, Product>>({});
  const [scanOpen, setScanOpen] = useState(false);
  // Newest-first ids for the scan tray + which row is flashing. Both are scan-UI
  // only: the invoice payload never reads them.
  const [scanOrder, setScanOrder] = useState<string[]>([]);
  const [scanFlash, setScanFlash] = useState<ScanFlash | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  // Scanned/typed code with no product match → prefills the inline create sheet.
  const [createCode, setCreateCode] = useState<string | null>(null);
  // Scroll the just-added row into view. The target is kept as an ID and
  // re-resolved against whatever the list renders each pass — a cached row
  // offset goes stale the moment clearing the search swaps the rendered list.
  const listRef = useRef<FlatList<Product>>(null);
  const [pendingScroll, setPendingScroll] = useState<PendingScrollState>(NO_PENDING_SCROLL);
  const { toast, show: showInline, dismiss: dismissInline } = useInlineToast();
  const [terms, setTerms] = useState(DEFAULT_TERMS);
  // Business date of the invoice (YYYY-MM-DD); blank = today, stamped server-side.
  const [issueDate, setIssueDate] = useState("");
  const [dueDate, setDueDate] = useState(() => dueDateFor("", DEFAULT_TERMS));
  const [send, setSend] = useState(false);

  const { data: productsData, isLoading: productsLoading } = useProducts({
    search: search.trim() || undefined,
    limit: 0,
  });
  const products: Product[] = productsData?.data ?? [];

  const productById = useMemo(() => {
    const m = new Map<string, Product>();
    for (const p of products) m.set(p.id, p);
    for (const id of Object.keys(scannedById)) {
      if (!m.has(id)) m.set(id, scannedById[id]);
    }
    return m;
  }, [products, scannedById]);

  const addOne = (id: string, snapshot?: Product) => {
    const p = snapshot ?? productById.get(id);
    const upb = Number(p?.unitsPerBox ?? 0);
    const isBoxed = upb > 1;
    setItems((m) => {
      const prev: LineState = m[id] ?? { qty: 0 };
      // ...prev preserved so a repeat scan / +1 keeps unitPrice.
      return { ...m, [id]: incrementLine(prev, isBoxed, upb) };
    });
    // Always retain the snapshot (see NewOrderScreen): the empty-search query
    // can be GC'd while a search is held, so setSearch("") after a local scan
    // may briefly refetch cold — the snapshot keeps this row resolvable.
    if (snapshot) {
      setScannedById((m) => (id in m ? m : { ...m, [id]: snapshot }));
    }
  };

  const removeOne = (id: string) => {
    const p = productById.get(id);
    const upb = Number(p?.unitsPerBox ?? 0);
    const isBoxed = upb > 1;
    setItems((m) => {
      const prev = m[id];
      if (!prev) return m;
      const next = { ...m };
      const line = decrementLine(prev, isBoxed, upb);
      if (!line) delete next[id];
      else next[id] = line;
      return next;
    });
  };

  const setBoxes = (id: string, boxes: number) =>
    setItems((m) => {
      const upb = Number(productById.get(id)?.unitsPerBox ?? 0);
      const line = setLineBoxes(m[id] ?? { qty: 0 }, boxes, upb);
      const next = { ...m };
      if (!line) delete next[id];
      else next[id] = line;
      return next;
    });

  const setPieces = (id: string, pieces: number) =>
    setItems((m) => {
      const upb = Number(productById.get(id)?.unitsPerBox ?? 0);
      const line = setLinePieces(m[id] ?? { qty: 0 }, pieces, upb);
      const next = { ...m };
      if (!line) delete next[id];
      else next[id] = line;
      return next;
    });

  /** Total unit count for a case-packed line, re-split into cases + loose. */
  const setUnits = (id: string, units: number) =>
    setItems((m) => {
      const upb = Number(productById.get(id)?.unitsPerBox ?? 0);
      const line = setLineUnits(m[id] ?? { qty: 0 }, units, upb);
      const next = { ...m };
      if (!line) delete next[id];
      else next[id] = line;
      return next;
    });

  const setQty = (id: string, qty: number) =>
    setItems((m) => {
      const line = setLineQty(m[id] ?? { qty: 0 }, qty);
      const next = { ...m };
      if (!line) delete next[id];
      else next[id] = line;
      return next;
    });

  const removeLine = (id: string) =>
    setItems((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });

  // Set (or clear) a one-time price override for a line. Empty/invalid clears it.
  const setLinePrice = (id: string, value: number | null) =>
    setItems((m) => {
      const prev = m[id];
      if (!prev) return m;
      if (value == null || value < 0) {
        const { unitPrice: _drop, ...rest } = prev;
        return { ...m, [id]: rest };
      }
      return { ...m, [id]: { ...prev, unitPrice: value } };
    });

  // ── Unlisted (ad-hoc, non-catalog) line helpers ──────────────────────────
  const addUnlisted = (name: string, unitPrice: number, qty: number) =>
    setUnlisted((u) => [...u, { id: newLocalId(), name: name.trim(), unitPrice, qty }]);
  const updateUnlistedQty = (id: string, qty: number) =>
    setUnlisted((u) =>
      qty <= 0 ? u.filter((x) => x.id !== id) : u.map((x) => (x.id === id ? { ...x, qty } : x)),
    );
  const updateUnlistedPrice = (id: string, value: number | null) =>
    setUnlisted((u) => {
      const price = value == null || value < 0 ? 0 : value;
      return u.map((x) => (x.id === id ? { ...x, unitPrice: price } : x));
    });
  const removeUnlisted = (id: string) => setUnlisted((u) => u.filter((x) => x.id !== id));

  /** Newest scanned line to the top of the tray, and flash it. */
  const bumpScanned = (id: string) => {
    setScanOrder((order) => bumpScanOrder(order, id));
    setScanFlash((prev) => nextFlash(prev, id));
  };

  /**
   * Land a resolved product on the invoice. In scan mode the tray row IS the
   * confirmation, so no banner and no search reset (which would swap the list
   * out from under the operator mid-scan); ScanOrderSheet owns the haptic.
   */
  const acceptScannedProduct = (product: Product): ScanOutcome => {
    addOne(product.id, product);
    if (scanOpen) {
      bumpScanned(product.id);
      return;
    }
    setSearch(""); // an active search would hide the added row (web clears too)
    setPendingScroll((s) => requestScroll(s, product.id));
    return { feedback: { kind: "added", text: `Added ${displayName(product)}` } };
  };

  // Continuous-scan handler: the scan sheet stays open between items; only the
  // create-product hand-off (and Done) closes it.
  const handleBarcodeScanned = async (code: string): Promise<ScanOutcome> => {
    const trimmed = code.trim();
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    const local = products.find(
      (p) =>
        (p.barcode ?? "").toLowerCase() === lower ||
        (p.sku ?? "").toLowerCase() === lower ||
        (p.id ?? "").toLowerCase() === lower,
    );
    if (local) return acceptScannedProduct(local);
    try {
      const result = await resolveProductByCode<Product>(trimmed);
      if (!result.notFound && result.product?.id) {
        return acceptScannedProduct(result.product);
      }
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? err?.message ?? "Couldn't look up barcode.";
      return { feedback: { kind: "error", text: msg } };
    }
    chooseAction(
      `No product for "${trimmed}"`,
      "Add it as a new product or a variant of an existing one? Your invoice stays as it is.",
      [
        { label: "Cancel", style: "cancel" },
        { label: "Create", onPress: () => setCreateCode(trimmed) },
      ],
    );
    return { close: true };
  };

  // Create-on-miss: overlays the invoice builder (never navigates away) so the
  // in-progress invoice is preserved; the new product lands in the cart.
  const handleInlineCreated = (product: CreatedProduct) => {
    const snapshot: Product = {
      id: product.id,
      name: product.name,
      sku: product.sku ?? null,
      barcode: product.barcode ?? null,
      unit: product.unit,
      pricePerUnit: product.pricePerUnit,
      category: product.category ?? null,
      unitsPerBox: product.unitsPerBox ?? null,
      parentProductId: product.parentProductId ?? null,
      parent: null,
    };
    addOne(product.id, snapshot);
    bumpScanned(product.id);
    setPendingScroll((s) => requestScroll(s, product.id));
    setCreateCode(null);
    showInline(`Added ${displayName(snapshot, products)}`);
  };

  const categoryChips = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) if (p.category) set.add(p.category);
    return [{ label: "All" }, ...Array.from(set).map((label) => ({ label }))];
  }, [products]);

  const filtered = useMemo(() => {
    const term = search.trim();
    // The chip row is hidden while a search is active, so the category must not
    // keep narrowing results behind a control the operator can no longer see.
    const base =
      term || category === "All" ? products : products.filter((p) => p.category === category);
    // While browsing (no active search), pin cart lines the filter would hide
    // so every scanned item keeps a visible row.
    if (term) return base;
    return withCartRows(base, Object.keys(items), (id) => productById.get(id));
  }, [products, category, search, items, productById]);

  // Resolve a queued scroll against the ids the list renders THIS pass. A
  // just-scanned product is often absent for a render or two while it refetches.
  useEffect(() => {
    if (!pendingScroll.targetId) return;
    const { state, scrollIndex } = stepPendingScroll(
      pendingScroll,
      filtered.map((p) => p.id),
    );
    if (scrollIndex == null) return;
    setPendingScroll(state);
    listRef.current?.scrollToIndex({ index: scrollIndex, viewPosition: 0.12, animated: true });
  }, [pendingScroll, filtered]);

  const { total, totalItems } = useMemo(() => {
    let total = 0;
    let totalItems = 0;
    for (const [id, line] of Object.entries(items)) {
      const p = productById.get(id);
      if (!p) continue;
      const qty = effectiveQty(line, p.unitsPerBox);
      if (qty <= 0) continue;
      totalItems += qty;
      total += computeLineSubtotal({
        unitPrice: effectiveUnitPrice(line, p),
        qty,
        boxes: line.boxes ?? null,
        pieces: line.pieces ?? null,
        unitsPerBox: p.unitsPerBox ?? null,
      });
    }
    // Unlisted lines: never boxed, simple unitPrice × qty.
    for (const u of unlisted) {
      if (u.qty <= 0) continue;
      totalItems += u.qty;
      total += computeLineSubtotal({ unitPrice: u.unitPrice, qty: u.qty });
    }
    return { total: roundMoney(total), totalItems };
  }, [items, productById, unlisted]);

  // Newest-first "invoice so far" for the scan tray. Same inputs as the total
  // memo, so the tray and the footer cannot disagree.
  const trayRows = useMemo(
    () =>
      trayRowsFrom({
        items,
        unlisted,
        scanOrder,
        lookup: (id) => productById.get(id),
        priceFor: (p) => toNumber(productById.get(p.id)?.pricePerUnit),
      }),
    [items, unlisted, scanOrder, productById],
  );

  /**
   * Catalog rows and tray rows are memoized, so their callbacks must keep a
   * stable identity or every row re-renders on each scan. This ref always holds
   * the current render's closures behind that stable identity.
   */
  const rowActions = {
    add: addOne,
    remove: removeOne,
    setQty,
    setBoxes,
    setUnits,
    removeLine,
    isUnlisted: (id: string) => unlisted.some((u) => u.id === id),
    unlistedQty: (id: string) => unlisted.find((u) => u.id === id)?.qty ?? 0,
    updateUnlistedQty,
    removeUnlisted,
    unitsPerBox: (id: string) => Number(productById.get(id)?.unitsPerBox ?? 0),
  };
  const actionsRef = useRef(rowActions);
  actionsRef.current = rowActions;

  const onRowAdd = useCallback((id: string) => actionsRef.current.add(id), []);
  const onRowIncrement = useCallback((id: string) => actionsRef.current.add(id), []);
  const onRowDecrement = useCallback((id: string) => actionsRef.current.remove(id), []);
  const onRowChangeQty = useCallback(
    (id: string, n: number) => actionsRef.current.setQty(id, n),
    [],
  );
  const onRowChangeBoxes = useCallback(
    (id: string, n: number) => actionsRef.current.setBoxes(id, n),
    [],
  );
  const openReview = useCallback(() => setReviewOpen(true), []);
  const openUnlistedModal = useCallback((prefill: string) => {
    setUnlistedPrefill(prefill);
    setUnlistedModalOpen(true);
  }, []);

  // Tray steppers hand back a TOTAL unit count; a case-packed line has to go
  // through setLineUnits so the cases/loose split is re-derived from it.
  const onTrayChangeQty = useCallback((id: string, qty: number) => {
    const a = actionsRef.current;
    if (a.isUnlisted(id)) a.updateUnlistedQty(id, qty);
    else if (a.unitsPerBox(id) > 1) a.setUnits(id, qty);
    else a.setQty(id, qty);
  }, []);
  const onTrayIncrement = useCallback((id: string) => {
    const a = actionsRef.current;
    if (a.isUnlisted(id)) a.updateUnlistedQty(id, a.unlistedQty(id) + 1);
    else a.add(id);
  }, []);
  const onTrayDecrement = useCallback((id: string) => {
    const a = actionsRef.current;
    if (a.isUnlisted(id)) a.updateUnlistedQty(id, a.unlistedQty(id) - 1);
    else a.remove(id);
  }, []);
  const onTrayRemove = useCallback((id: string) => {
    const a = actionsRef.current;
    if (a.isUnlisted(id)) a.removeUnlisted(id);
    else a.removeLine(id);
  }, []);

  // Boxed rows have variable height, so there's no getItemLayout to make
  // scrollToIndex exact — estimate, then retry once the cells have laid out.
  const scrollRetryRef = useRef(false);
  const onScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      listRef.current?.scrollToOffset({
        offset: Math.max(0, info.averageItemLength * info.index),
        animated: true,
      });
      if (scrollRetryRef.current) return;
      scrollRetryRef.current = true;
      requestAnimationFrame(() => {
        scrollRetryRef.current = false;
        listRef.current?.scrollToIndex({ index: info.index, viewPosition: 0.12, animated: true });
      });
    },
    [],
  );

  /**
   * An added case-packed row keeps exactly three controls: a case stepper, the
   * resulting split + line total, and a way into the review sheet, which owns
   * the full per-line editor (price override, loose units).
   */
  const renderProduct = useCallback(
    ({ item: p }: { item: Product }) => {
      const line = items[p.id];
      const qty = line ? effectiveQty(line, p.unitsPerBox) : 0;
      const price = toNumber(p.pricePerUnit);
      const band =
        line && qty > 0 && Number(p.unitsPerBox ?? 0) > 1 ? (
          <>
            <View style={styles.boxedControl}>
              <Text style={styles.boxedQtyLabel}>Cases</Text>
              <QtyStepper
                size="mini"
                value={line.boxes ?? 0}
                onChangeQty={(n) => onRowChangeBoxes(p.id, n)}
              />
            </View>
            <Text style={styles.boxedSummary} numberOfLines={1}>
              {boxedLineSummary(line, p, effectiveUnitPrice(line, p))}
            </Text>
            <Pressable
              onPress={openReview}
              hitSlop={8}
              style={styles.boxedEditBtn}
              accessibilityRole="button"
              accessibilityLabel={`Edit ${displayName(p)}`}
            >
              <Text style={styles.boxedEditText}>Edit</Text>
            </Pressable>
          </>
        ) : null;

      return (
        <ProductRow
          id={p.id}
          name={displayName(p)}
          sku={p.sku}
          unit={p.unit}
          unitsPerBox={p.unitsPerBox}
          price={price}
          listPrice={price}
          qty={qty}
          onAdd={onRowAdd}
          onChangeQty={onRowChangeQty}
          onIncrement={onRowIncrement}
          onDecrement={onRowDecrement}
        >
          {band}
        </ProductRow>
      );
    },
    [items, onRowAdd, onRowChangeQty, onRowIncrement, onRowDecrement, onRowChangeBoxes, openReview],
  );

  const createMut = useCreateInvoice();
  const canSave = totalItems > 0 && !createMut.isPending;

  const onTermsChange = (t: string) => {
    setTerms(t);
    setDueDate(dueDateFor(issueDate, t));
  };

  const onIssueDateChange = (v: string) => {
    setIssueDate(v);
    if (ISO_DATE.test(v)) setDueDate(dueDateFor(v, terms));
  };

  const onSave = () => {
    if (!canSave) {
      alertInfo("Add at least one item", "Tap + on any product to start the invoice.");
      return;
    }
    if (!ISO_DATE.test(dueDate)) {
      alertInfo("Bad due date", "Use the format YYYY-MM-DD.");
      return;
    }
    const issueTrim = issueDate.trim();
    if (issueTrim && !ISO_DATE.test(issueTrim)) {
      alertInfo("Bad issue date", "Use the format YYYY-MM-DD, or leave it blank for today.");
      return;
    }
    const payload: CreateInvoiceItem[] = [];
    for (const [productId, line] of Object.entries(items)) {
      const p = productById.get(productId);
      if (!p) continue;
      const qty = effectiveQty(line, p.unitsPerBox);
      if (qty <= 0) continue;
      payload.push({
        description: displayName(p),
        productId,
        qty,
        unitPrice: effectiveUnitPrice(line, p),
        ...(line.boxes != null ? { boxes: line.boxes } : {}),
        ...(line.pieces != null ? { pieces: line.pieces } : {}),
      });
    }
    // Unlisted lines → `{ description, qty, unitPrice }` (no productId).
    for (const u of unlisted) {
      if (u.qty <= 0 || u.name.trim() === "" || u.unitPrice <= 0) continue;
      payload.push({ description: u.name.trim(), qty: u.qty, unitPrice: u.unitPrice });
    }
    createMut.mutate(
      {
        customerId,
        items: payload,
        dueDate,
        terms,
        send,
        ...(issueTrim ? { issueDate: issueTrim } : {}),
      },
      {
        onSuccess: (inv) => {
          onSaved(inv.id, inv.invoiceNumber);
        },
        onError: (err: any) => {
          alertInfo(
            "Couldn't create invoice",
            err?.response?.data?.message ?? err?.message ?? "Try again.",
          );
        },
      },
    );
  };

  const searchTerm = search.trim();
  // The review sheet's copy of this opener is unreachable until the invoice has
  // a line, so the catalog list owns the only zero-item path to an ad-hoc item.
  const unlistedPlacement = unlistedAffordancePlacement({
    rowCount: filtered.length,
    loading: productsLoading,
  });
  const unlistedLabel = searchTerm
    ? `Add "${searchTerm}" as an unlisted item`
    : "Add an unlisted item";

  return (
    <>
      {/* One save trigger only — the footer Create. */}
      <NavBar inlineTitle="New invoice" leading={<NavBackButton label="Back" onPress={onBack} />} />

      <View style={styles.customerChipWrap}>
        <Pressable style={styles.customerChip} onPress={onChangeCustomer}>
          <Ionicons name="person-outline" size={14} color={ios.brand} />
          <Text style={styles.customerChipText} numberOfLines={1}>
            {customerName ?? "Customer"}
          </Text>
          <Text style={styles.customerChipChange}>Change</Text>
        </Pressable>
      </View>

      {/* Find: search + categories, pinned so they never scroll away. */}
      <SearchBar
        placeholder="Search items…"
        value={search}
        onChangeText={setSearch}
        trailing={
          <Pressable
            onPress={() => setScanOpen(true)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Scan items"
          >
            <Ionicons name="barcode-outline" size={20} color={ios.brand} />
          </Pressable>
        }
      />

      {searchTerm === "" && categoryChips.length > 1 ? (
        <FilterChipRow chips={categoryChips} value={category} onChange={setCategory} />
      ) : null}

      <FlatList
        ref={listRef}
        style={styles.catalogList}
        data={filtered}
        keyExtractor={productKey}
        renderItem={renderProduct}
        extraData={items}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={7}
        removeClippedSubviews
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        onScrollToIndexFailed={onScrollToIndexFailed}
        contentContainerStyle={styles.listContent}
        ItemSeparatorComponent={RowSpacer}
        ListEmptyComponent={
          unlistedPlacement === "empty-state" ? (
            <View style={styles.center}>
              <Text style={styles.emptyText}>
                No products{searchTerm ? " match your search" : " yet"}.
              </Text>
              <Pressable
                style={styles.emptyUnlistedBtn}
                onPress={() => openUnlistedModal(searchTerm)}
                accessibilityRole="button"
              >
                <Ionicons name="add-circle-outline" size={16} color={ios.brand} />
                <Text style={styles.emptyUnlistedText} numberOfLines={2}>
                  {unlistedLabel}
                </Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.center}>
              <ActivityIndicator color={ios.brand} />
            </View>
          )
        }
        ListFooterComponent={
          unlistedPlacement === "list-footer" ? (
            <Pressable
              style={styles.listUnlistedBtn}
              onPress={() => openUnlistedModal(searchTerm)}
              accessibilityRole="button"
              accessibilityLabel={unlistedLabel}
              hitSlop={4}
            >
              <Ionicons name="add-circle-outline" size={16} color={ios.brand} />
              <Text style={styles.listUnlistedText} numberOfLines={1}>
                {unlistedLabel}
              </Text>
            </Pressable>
          ) : null
        }
      />

      <View style={styles.footer}>
        <Pressable
          style={styles.footerTotalTap}
          onPress={totalItems > 0 ? openReview : undefined}
          disabled={totalItems === 0}
          hitSlop={6}
        >
          <Text style={styles.footerEyebrow}>
            {totalItems} ITEM{totalItems === 1 ? "" : "S"}
          </Text>
          <Text style={styles.footerTotal}>${total.toFixed(2)}</Text>
        </Pressable>
        <View style={styles.footerActions}>
          {totalItems > 0 ? (
            <Pressable
              style={styles.viewBtn}
              onPress={openReview}
              accessibilityRole="button"
              accessibilityLabel="View and edit invoice"
              hitSlop={4}
            >
              <Ionicons name="list-outline" size={14} color={ios.brand} />
              <Text style={styles.viewBtnText}>View / edit</Text>
            </Pressable>
          ) : null}
          <Pressable
            style={[styles.confirmBtn, !canSave && styles.confirmBtnDisabled]}
            disabled={!canSave}
            onPress={onSave}
            accessibilityState={{ disabled: !canSave }}
          >
            <Text style={styles.confirmBtnText}>{createMut.isPending ? "Saving…" : "Create"}</Text>
            <Ionicons name="arrow-forward" size={14} color="#fff" />
          </Pressable>
        </View>
      </View>

      <InlineToast toast={toast} onDismiss={dismissInline} bottom={96} />

      {/* Scan mode: camera over the live invoice. The sheet owns the scan
          haptics and the tray scroll; this screen only mutates the lines. */}
      <ScanOrderSheet
        visible={scanOpen}
        rows={trayRows}
        flash={scanFlash}
        totalItems={totalItems}
        total={total}
        onScanned={handleBarcodeScanned}
        onChangeQty={onTrayChangeQty}
        onIncrement={onTrayIncrement}
        onDecrement={onTrayDecrement}
        onRemove={onTrayRemove}
        onReview={() => {
          setScanOpen(false);
          setReviewOpen(true);
        }}
        onDone={() => setScanOpen(false)}
      />

      <ReviewSheet
        open={reviewOpen}
        items={items}
        productById={productById}
        unlisted={unlisted}
        total={total}
        totalItems={totalItems}
        saving={createMut.isPending}
        onClose={() => setReviewOpen(false)}
        onIncrement={addOne}
        onDecrement={removeOne}
        onChangeQty={setQty}
        onChangeBoxes={setBoxes}
        onChangePieces={setPieces}
        onChangePrice={setLinePrice}
        onRemove={removeLine}
        onChangeUnlistedQty={updateUnlistedQty}
        onChangeUnlistedPrice={updateUnlistedPrice}
        onRemoveUnlisted={removeUnlisted}
        onAddUnlisted={() => openUnlistedModal("")}
        details={{
          terms,
          onChangeTerms: onTermsChange,
          issueDate,
          onChangeIssueDate: onIssueDateChange,
          dueDate,
          onChangeDueDate: setDueDate,
          send,
          onToggleSend: () => setSend((s) => !s),
        }}
        onSave={() => {
          setReviewOpen(false);
          onSave();
        }}
      />

      <UnlistedItemModal
        open={unlistedModalOpen}
        initialName={unlistedPrefill}
        onClose={() => setUnlistedModalOpen(false)}
        onAdd={(name, unitPrice, qty) => {
          addUnlisted(name, unitPrice, qty);
          setUnlistedModalOpen(false);
          showInline(`Added ${name}`);
        }}
      />

      <InlineCreateProductSheet
        visible={createCode != null}
        initialCode={createCode ?? undefined}
        onClose={() => setCreateCode(null)}
        onCreated={handleInlineCreated}
      />
    </>
  );
}

// ─── Review sheet ────────────────────────────────────────────────────────────

/** Invoice-level fields, owned by the composer and edited inside the sheet. */
interface InvoiceDetails {
  terms: string;
  onChangeTerms: (v: string) => void;
  /** Business date (YYYY-MM-DD); blank = today. */
  issueDate: string;
  onChangeIssueDate: (v: string) => void;
  dueDate: string;
  onChangeDueDate: (v: string) => void;
  send: boolean;
  onToggleSend: () => void;
}

function ReviewSheet({
  open,
  items,
  productById,
  unlisted,
  total,
  totalItems,
  saving,
  onClose,
  onIncrement,
  onDecrement,
  onChangeQty,
  onChangeBoxes,
  onChangePieces,
  onChangePrice,
  onRemove,
  onChangeUnlistedQty,
  onChangeUnlistedPrice,
  onRemoveUnlisted,
  onAddUnlisted,
  details,
  onSave,
}: {
  open: boolean;
  items: Record<string, LineState>;
  productById: Map<string, Product>;
  unlisted: UnlistedLine[];
  total: number;
  totalItems: number;
  saving: boolean;
  onClose: () => void;
  onIncrement: (id: string) => void;
  onDecrement: (id: string) => void;
  onChangeQty: (id: string, n: number) => void;
  onChangeBoxes: (id: string, n: number) => void;
  onChangePieces: (id: string, n: number) => void;
  onChangePrice: (id: string, value: number | null) => void;
  onRemove: (id: string) => void;
  onChangeUnlistedQty: (id: string, n: number) => void;
  onChangeUnlistedPrice: (id: string, value: number | null) => void;
  onRemoveUnlisted: (id: string) => void;
  onAddUnlisted: () => void;
  details: InvoiceDetails;
  onSave: () => void;
}) {
  // Insertion order = scan order (a repeat scan updates the key in place), which
  // is the order the operator added the lines in and the order they land on the
  // invoice — an alphabetical re-sort made scanned lines hard to verify.
  const rows = useMemo(() => {
    const list: { id: string; product: Product; line: LineState }[] = [];
    for (const [id, line] of Object.entries(items)) {
      const product = productById.get(id);
      if (!product) continue;
      list.push({ id, product, line });
    }
    return list;
  }, [items, productById]);

  return (
    <Modal visible={open} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Pressable onPress={onClose} hitSlop={8} style={styles.sheetHeaderBtn}>
              <Ionicons name="chevron-down" size={22} color={ios.label2} />
            </Pressable>
            <Text style={styles.sheetTitle}>Review invoice</Text>
            <Text style={styles.sheetCount}>
              {totalItems} item{totalItems === 1 ? "" : "s"}
            </Text>
          </View>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16, gap: 10 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {rows.length === 0 && unlisted.length === 0 ? (
              <View style={[styles.center, { paddingVertical: 40 }]}>
                <Text style={styles.emptyText}>No items.</Text>
              </View>
            ) : (
              <>
                {rows.map(({ id, product, line }) => (
                  <ReviewRow
                    key={id}
                    product={product}
                    line={line}
                    onIncrement={() => onIncrement(id)}
                    onDecrement={() => onDecrement(id)}
                    onChangeQty={(n) => onChangeQty(id, n)}
                    onChangeBoxes={(n) => onChangeBoxes(id, n)}
                    onChangePieces={(n) => onChangePieces(id, n)}
                    onChangePrice={(v) => onChangePrice(id, v)}
                    onRemove={() => onRemove(id)}
                  />
                ))}
                {unlisted.map((u) => (
                  <UnlistedReviewRow
                    key={u.id}
                    line={u}
                    onChangeQty={(n) => onChangeUnlistedQty(u.id, n)}
                    onChangePrice={(v) => onChangeUnlistedPrice(u.id, v)}
                    onRemove={() => onRemoveUnlisted(u.id)}
                  />
                ))}
              </>
            )}

            <Pressable style={styles.cartAddUnlisted} onPress={onAddUnlisted} hitSlop={4}>
              <Ionicons name="add-circle-outline" size={16} color={ios.brand} />
              <Text style={styles.cartAddUnlistedText}>Add unlisted item</Text>
            </Pressable>

            <InvoiceDetailsCard details={details} />
          </ScrollView>

          <View style={styles.cartFooter}>
            <View style={styles.cartFooterRow}>
              <View>
                <Text style={styles.footerEyebrow}>INVOICE TOTAL</Text>
                <Text style={styles.footerTotal}>${total.toFixed(2)}</Text>
              </View>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Pressable style={styles.cartContinueBtn} onPress={onClose} hitSlop={6}>
                  <Text style={styles.cartContinueText}>Keep adding</Text>
                </Pressable>
                <Pressable
                  style={[
                    styles.confirmBtn,
                    (totalItems === 0 || saving) && styles.confirmBtnDisabled,
                  ]}
                  disabled={totalItems === 0 || saving}
                  onPress={onSave}
                  accessibilityState={{ disabled: totalItems === 0 || saving }}
                >
                  <Text style={styles.confirmBtnText}>{saving ? "Saving…" : "Create invoice"}</Text>
                  <Ionicons name="checkmark" size={14} color="#fff" />
                </Pressable>
              </View>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function ReviewRow({
  product,
  line,
  onIncrement,
  onDecrement,
  onChangeQty,
  onChangeBoxes,
  onChangePieces,
  onChangePrice,
  onRemove,
}: {
  product: Product;
  line: LineState;
  onIncrement: () => void;
  onDecrement: () => void;
  onChangeQty: (n: number) => void;
  onChangeBoxes: (n: number) => void;
  onChangePieces: (n: number) => void;
  onChangePrice: (value: number | null) => void;
  onRemove: () => void;
}) {
  const upb = Number(product.unitsPerBox ?? 0);
  const isBoxed = upb > 1;
  const catalogPrice = toNumber(product.pricePerUnit);
  const effUnit = effectiveUnitPrice(line, product);
  const isOverridden = line.unitPrice != null && line.unitPrice !== catalogPrice;
  const qty = effectiveQty(line, product.unitsPerBox);
  const lineTotal = computeLineSubtotal({
    unitPrice: effUnit,
    qty,
    boxes: line.boxes ?? null,
    pieces: line.pieces ?? null,
    unitsPerBox: product.unitsPerBox ?? null,
  });

  return (
    <View style={styles.cartRow}>
      <View style={styles.cartRowHeader}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.cartRowName} numberOfLines={2}>
            {displayName(product)}
          </Text>
          <Text style={styles.cartRowMeta}>
            {isBoxed ? `case of ${upb}` : product.unit ? `per ${product.unit}` : ""}
            {product.sku ? `${isBoxed || product.unit ? " · " : ""}${product.sku}` : ""}
          </Text>
        </View>
        <Pressable onPress={onRemove} hitSlop={8} style={styles.cartRowRemove}>
          <Ionicons name="trash-outline" size={18} color={ios.system.redInk} />
        </Pressable>
      </View>

      {/* Editable price — the "discounted price". Defaults to the catalog price;
          typing another value records a one-time override for this line. */}
      <View style={styles.cartPriceRow}>
        <Text style={styles.cartPriceLabel}>Price{isBoxed ? " / case" : ""}</Text>
        <View style={styles.cartPriceInputWrap}>
          <Text style={styles.cartPriceCurrency}>$</Text>
          <MoneyTextInput
            style={[styles.cartPriceInput, isOverridden && styles.cartPriceInputActive]}
            value={line.unitPrice ?? null}
            onChangeValue={onChangePrice}
            placeholder={catalogPrice.toFixed(2)}
            returnKeyType="done"
          />
          {isOverridden ? (
            <Text style={styles.cartPriceWas}>${catalogPrice.toFixed(2)}</Text>
          ) : null}
        </View>
      </View>

      {isBoxed ? (
        <>
          <StepperRow label="Cases" value={line.boxes ?? 0} onChange={onChangeBoxes} />
          <StepperRow
            label={`Loose ${product.unit ?? "units"}`}
            value={line.pieces ?? 0}
            onChange={onChangePieces}
            max={upb - 1}
            hint={`${upb} per case`}
          />
        </>
      ) : (
        <StepperRow
          label={`Qty${product.unit ? ` (${product.unit})` : ""}`}
          value={line.qty ?? 0}
          onChange={onChangeQty}
          onIncrement={onIncrement}
          onDecrement={onDecrement}
        />
      )}

      <View style={styles.cartRowFooter}>
        <Text style={styles.cartRowFooterLabel}>Line total</Text>
        <Text style={styles.cartRowFooterValue}>${lineTotal.toFixed(2)}</Text>
      </View>
    </View>
  );
}

/** Review row for an ad-hoc (unlisted) line: editable price + qty, "Custom" tag. */
function UnlistedReviewRow({
  line,
  onChangeQty,
  onChangePrice,
  onRemove,
}: {
  line: UnlistedLine;
  onChangeQty: (n: number) => void;
  onChangePrice: (value: number | null) => void;
  onRemove: () => void;
}) {
  const lineTotal = computeLineSubtotal({ unitPrice: line.unitPrice, qty: line.qty });
  return (
    <View style={styles.cartRow}>
      <View style={styles.cartRowHeader}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.unlistedTagRow}>
            <Text style={styles.cartRowName} numberOfLines={2}>
              {line.name || "Unlisted item"}
            </Text>
            <View style={styles.customTag}>
              <Text style={styles.customTagText}>Custom</Text>
            </View>
          </View>
        </View>
        <Pressable onPress={onRemove} hitSlop={8} style={styles.cartRowRemove}>
          <Ionicons name="trash-outline" size={18} color={ios.system.redInk} />
        </Pressable>
      </View>

      <View style={styles.cartPriceRow}>
        <Text style={styles.cartPriceLabel}>Price</Text>
        <View style={styles.cartPriceInputWrap}>
          <Text style={styles.cartPriceCurrency}>$</Text>
          <MoneyTextInput
            style={[styles.cartPriceInput, styles.cartPriceInputActive]}
            value={line.unitPrice || null}
            onChangeValue={onChangePrice}
            placeholder="0.00"
            returnKeyType="done"
          />
        </View>
      </View>

      <StepperRow
        label="Qty"
        value={line.qty}
        onChange={onChangeQty}
        onIncrement={() => onChangeQty(line.qty + 1)}
        onDecrement={() => onChangeQty(Math.max(0, line.qty - 1))}
      />

      <View style={styles.cartRowFooter}>
        <Text style={styles.cartRowFooterLabel}>Line total</Text>
        <Text style={styles.cartRowFooterValue}>${lineTotal.toFixed(2)}</Text>
      </View>
    </View>
  );
}

/** Labelled row wrapping the shared stepper. */
function StepperRow({
  label,
  value,
  onChange,
  onIncrement,
  onDecrement,
  max,
  hint,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  onIncrement?: () => void;
  onDecrement?: () => void;
  max?: number;
  hint?: string;
}) {
  return (
    <View style={styles.stepperRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.stepperLabel}>{label}</Text>
        {hint ? <Text style={styles.stepperHint}>{hint}</Text> : null}
      </View>
      <QtyStepper
        value={value}
        onChangeQty={onChange}
        onIncrement={onIncrement}
        onDecrement={onDecrement}
        max={max}
      />
    </View>
  );
}

/** Terms, dates and delivery — everything that isn't a line, in one card. */
function InvoiceDetailsCard({ details: d }: { details: InvoiceDetails }) {
  return (
    <View style={styles.detailsCard}>
      <Text style={styles.detailsTitle}>Invoice details</Text>

      <View style={styles.detailField}>
        <Text style={styles.detailLabel}>Payment terms</Text>
        <FilterChipRow
          chips={TERM_CHIPS}
          value={d.terms}
          onChange={d.onChangeTerms}
          paddingHorizontal={0}
        />
      </View>

      <View style={styles.detailField}>
        <Text style={styles.detailLabel}>Issue date (backdate)</Text>
        <TextInput
          value={d.issueDate}
          onChangeText={d.onChangeIssueDate}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={ios.label3}
          keyboardType="numbers-and-punctuation"
          style={styles.detailInput}
        />
        <Text style={styles.detailHelp}>
          The day the invoice was actually issued. Leave blank for today.
        </Text>
      </View>

      <View style={styles.detailField}>
        <Text style={styles.detailLabel}>Due date</Text>
        <TextInput
          value={d.dueDate}
          onChangeText={d.onChangeDueDate}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={ios.label3}
          keyboardType="numbers-and-punctuation"
          style={styles.detailInput}
        />
      </View>

      <Pressable style={styles.sendRow} onPress={d.onToggleSend}>
        <View style={[styles.checkbox, d.send && styles.checkboxOn]}>
          {d.send ? <Text style={styles.checkboxTick}>✓</Text> : null}
        </View>
        <Text style={styles.sendLabel}>Send immediately on create</Text>
      </Pressable>
    </View>
  );
}

// ─── Unlisted item modal ─────────────────────────────────────────────────────

function UnlistedItemModal({
  open,
  initialName,
  onClose,
  onAdd,
}: {
  open: boolean;
  /** Prefills the description — the search term that matched no catalog product. */
  initialName?: string;
  onClose: () => void;
  onAdd: (name: string, unitPrice: number, qty: number) => void;
}) {
  const [name, setName] = useState("");
  const [priceText, setPriceText] = useState("");
  const [qtyText, setQtyText] = useState("1");

  useEffect(() => {
    if (open) {
      setName(initialName ?? "");
      setPriceText("");
      setQtyText("1");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const price = parseFloat(priceText);
  const qty = parseInt(qtyText || "0", 10);
  const valid = name.trim() !== "" && Number.isFinite(price) && price > 0 && qty > 0;

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.unlistedOverlay} onPress={onClose}>
        <Pressable style={styles.unlistedCard} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.unlistedTitle}>Add unlisted item</Text>
          <Text style={styles.unlistedSub}>A one-off line that isn't in your catalog.</Text>

          <Text style={styles.unlistedFieldLabel}>Item description</Text>
          <TextInput
            style={styles.unlistedInput}
            value={name}
            onChangeText={setName}
            placeholder="e.g. Delivery surcharge"
            placeholderTextColor={ios.label3}
            autoFocus
            returnKeyType="next"
          />

          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.unlistedFieldLabel}>Unit price</Text>
              <TextInput
                style={styles.unlistedInput}
                value={priceText}
                onChangeText={setPriceText}
                placeholder="0.00"
                placeholderTextColor={ios.label3}
                keyboardType="decimal-pad"
                selectTextOnFocus
              />
            </View>
            <View style={{ width: 96 }}>
              <Text style={styles.unlistedFieldLabel}>Qty</Text>
              <TextInput
                style={styles.unlistedInput}
                value={qtyText}
                onChangeText={(t) => setQtyText(sanitizeIntInput(t))}
                placeholder="1"
                placeholderTextColor={ios.label3}
                keyboardType="number-pad"
                maxLength={5}
                selectTextOnFocus
              />
            </View>
          </View>

          <View style={styles.modalBtns}>
            <Pressable style={styles.modalBtnGhost} onPress={onClose}>
              <Text style={styles.modalBtnGhostText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.modalBtnFill, !valid && styles.modalBtnDisabled]}
              onPress={() => valid && onAdd(name.trim(), price, qty)}
              disabled={!valid}
            >
              <Text style={styles.modalBtnFillText}>Add to invoice</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bgElev },
  center: { padding: 40, alignItems: "center" },
  emptyText: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },

  customerList: {
    marginHorizontal: 16,
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
  },
  customerRow: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 999,
    backgroundColor: ios.brandWash,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: ios.brand, fontSize: 13, fontFamily: "Inter_700Bold" },
  customerName: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  customerSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 1,
  },

  customerChipWrap: { paddingHorizontal: 16, paddingTop: 10 },
  customerChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: ios.brandWash,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignSelf: "flex-start",
    maxWidth: "100%",
  },
  customerChipText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.brand,
    flexShrink: 1,
  },
  customerChipChange: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: ios.brand,
    opacity: 0.65,
    marginLeft: 6,
  },

  catalogList: { flex: 1 },
  listContent: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 16, flexGrow: 1 },
  rowSpacer: { height: 10 },
  emptyUnlistedBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 14,
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: ios.brandWash,
  },
  emptyUnlistedText: {
    flexShrink: 1,
    color: ios.brand,
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  // Tail of the catalog: the same escape hatch, quiet enough not to read as a
  // second primary action next to the rows' Add buttons.
  listUnlistedBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: 44,
    marginTop: 12,
    paddingHorizontal: 14,
  },
  listUnlistedText: {
    flexShrink: 1,
    color: ios.brand,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },

  // ── Added case-packed catalog row: cases stepper + split + way into review ──
  boxedControl: { alignItems: "center", gap: 4 },
  boxedQtyLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.3,
  },
  boxedSummary: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
    fontVariant: ["tabular-nums"],
  },
  boxedEditBtn: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: ios.brandWash,
  },
  boxedEditText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.brand },

  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 16,
    backgroundColor: ios.bgElev,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  footerTotalTap: { paddingVertical: 4, paddingRight: 8 },
  footerEyebrow: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    color: ios.label2,
    letterSpacing: 0.4,
  },
  footerTotal: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  footerActions: { flexDirection: "row", gap: 8, alignItems: "center" },
  viewBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: ios.brandWash,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 14,
  },
  viewBtnText: { color: ios.brand, fontSize: 14, fontFamily: "Inter_600SemiBold" },
  confirmBtn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  confirmBtnDisabled: { opacity: 0.4 },
  confirmBtnText: { color: "#fff", fontSize: 14, fontFamily: "Inter_600SemiBold" },

  // ── Review sheet ──────────────────────────────────────────────────────────
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: ios.bg,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    maxHeight: "92%",
    minHeight: "55%",
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  sheetHeaderBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  sheetTitle: {
    flex: 1,
    textAlign: "center",
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: ios.label,
  },
  sheetCount: {
    width: 64,
    textAlign: "right",
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
    marginRight: 6,
  },
  cartRow: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 12,
    gap: 10,
  },
  cartRowHeader: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  cartRowName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  cartRowMeta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 2,
    fontVariant: ["tabular-nums"],
  },
  cartRowRemove: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: ios.fill3,
    alignItems: "center",
    justifyContent: "center",
  },
  cartPriceRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  cartPriceLabel: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  cartPriceInputWrap: { flexDirection: "row", alignItems: "center", gap: 6 },
  cartPriceCurrency: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },
  cartPriceInput: {
    minWidth: 70,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
    borderRadius: 8,
    textAlign: "right",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  cartPriceInputActive: { borderColor: ios.brand, color: ios.brand },
  cartPriceWas: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textDecorationLine: "line-through",
  },
  stepperRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  stepperLabel: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  stepperHint: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: ios.label3,
    marginTop: 1,
  },
  cartRowFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  cartRowFooterLabel: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.label2 },
  cartRowFooterValue: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  cartAddUnlisted: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: ios.brandWash,
    borderRadius: 12,
    paddingVertical: 12,
    marginTop: 4,
  },
  cartAddUnlistedText: { color: ios.brand, fontSize: 14, fontFamily: "Inter_600SemiBold" },
  cartFooter: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 20,
    backgroundColor: ios.bgElev,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  cartFooterRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cartContinueBtn: {
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: ios.fill3,
  },
  cartContinueText: { color: ios.label, fontSize: 14, fontFamily: "Inter_600SemiBold" },

  // ── Invoice details card ──────────────────────────────────────────────────
  detailsCard: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 12,
    gap: 12,
    marginTop: 4,
  },
  detailsTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  detailField: { gap: 6 },
  detailLabel: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },
  detailInput: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label,
  },
  detailHelp: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label3 },
  sendRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: ios.separator,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: { backgroundColor: ios.brand, borderColor: ios.brand },
  checkboxTick: { color: "#fff", fontFamily: "Inter_700Bold" },
  sendLabel: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },

  // ── Unlisted tag + modal ──────────────────────────────────────────────────
  unlistedTagRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  customTag: {
    backgroundColor: ios.system.orangeWash,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  customTagText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.system.orangeInk,
    letterSpacing: 0.2,
  },
  unlistedOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  unlistedCard: {
    backgroundColor: ios.bgElev,
    borderRadius: 20,
    padding: 20,
    width: "100%",
    maxWidth: 380,
  },
  unlistedTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.3,
    marginBottom: 2,
  },
  unlistedSub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginBottom: 12,
  },
  unlistedFieldLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.3,
    marginBottom: 6,
  },
  unlistedInput: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    fontFamily: "Inter_500Medium",
    color: ios.label,
    marginBottom: 12,
  },
  modalBtns: { flexDirection: "row", gap: 10, marginTop: 4 },
  modalBtnGhost: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: ios.fill3,
  },
  modalBtnGhostText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  modalBtnFill: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: ios.brand,
  },
  modalBtnDisabled: { opacity: 0.4 },
  modalBtnFillText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#fff" },
});
