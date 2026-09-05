import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Platform,
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
import {
  FilterChipRow,
  NavBackButton,
  NavBar,
  SearchBar,
  SegmentedControl,
} from "@routeflow/ui/mobile/ios";
import {
  useAdminCustomer,
  useAdminCustomers,
  useBusinessSettings,
} from "../../../../lib/api/admin";
import { useProductCategories } from "../../../../lib/api/products";
import { useProductSearch } from "../../../../lib/use-product-search";
import { mergeProductIndex } from "../../../../lib/paged-rows";
import { useCreateInvoice, type CreateInvoiceItem } from "../../../../lib/api/invoices";
import { useCreateSale, type CreateSaleItemInput } from "../../../../lib/api/orders";
import { useTrackedCategories } from "../../../../lib/api/tracked-categories";
import { saleModeGate } from "../../../../lib/sale-mode";
import { showToast } from "../../../../lib/toast";
import {
  decrementLine,
  incrementLine,
  incrementLinePiece,
  setLineBoxes,
  setLinePieces,
  setLineQty,
  setLineUnits,
} from "../../../../lib/sale-line";
import { resolveProductByCode } from "../../../../lib/barcode-resolve";
import { makeScanHandler, runWedgeSubmit } from "../../../../lib/scan-ladder";
import { createScanAttempt, createWedgeSubmitHandler } from "../../../../lib/wedge-submit";
import { findExactScanMatch, looksLikeScanCode, scanUnitKind } from "../../../../lib/wedge-scan";
import { useAuthStore } from "../../../../lib/auth-store";
// Compose "<Parent> - <Variant>" so variants don't show as "Strawberry" alone.
import { displayProductName as displayName } from "../../../../lib/product-display";
import { computeLineSubtotal, effectiveQty, getTierPrice } from "@routeflow/pricing";
import { useCustomerPrices } from "../../../../lib/api/customers";
import {
  computeInvoiceTotals,
  invoiceLineDto,
  type InvoiceTotals,
  type InvoiceTotalsLine,
} from "../../../../lib/invoice-totals";
import {
  DEFAULT_TERMS,
  ISO_DATE,
  TERM_CHIPS,
  dueDateFor,
  todayPlusDays,
} from "../../../../lib/invoice-terms";
import { MoneyTextInput } from "../../../../components/MoneyTextInput";
import { alertInfo, chooseAction } from "../../../../lib/confirm";
import { QtyStepper } from "../../../../components/QtyStepper";
import { InlineCreateProductSheet } from "../../../../components/InlineCreateProductSheet";
import { ProductPickerSheet } from "../../../../components/ProductPickerSheet";
import { BoxedQtyBand } from "../../../../components/BoxedQtyBand";
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
import { isCatalogHeader, visibleCatalogRows, type CatalogRow } from "../../../../lib/visible-cart";
import { unlistedAffordancePlacement } from "../../../../lib/unlisted-affordance";
import { sanitizeIntInput } from "../../../../lib/qty";
import { MONEY_INPUT_MAX_WIDTH } from "../../../../lib/row-layout";

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

// Term constants + due-date math live in lib/invoice-terms.ts (shared with
// SplitInvoiceScreen and the invoice edit screen).

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
  /** Retail-unit code — scannable, so the local scan fast path must see it. */
  unitSku?: string | null;
  barcode?: string | null;
  unit?: string;
  pricePerUnit: number | string;
  priceTier2?: number | string | null;
  priceTier3?: number | string | null;
  priceTier4?: number | string | null;
  priceTier5?: number | string | null;
  category?: string | null;
  unitsPerBox?: number | null;
  parentProductId?: string | null;
  parent?: { id: string; name: string } | null;
  /** Regulated category this product belongs to — drives the van-sale gate's
   *  "a regulated item bills on its own invoice" check (WP4). */
  trackedCategoryId?: string | null;
};

// `unitPrice` is an optional one-time price override (the "discounted price").
// When unset, the catalog price is used. For boxed products it is the BOX price,
// matching the catalog price unit; computeLineSubtotal prorates pieces.
// Wave 2 exception fields (all optional, survive the sale-line helpers' ...prev):
// `discount` = flat $ off the line, `taxable` maps to the tenant tax rate at
// submit (web's exact model), `note` prints under the description on the PDF.
type LineState = {
  qty: number;
  boxes?: number;
  pieces?: number;
  unitPrice?: number;
  discount?: number;
  taxable?: boolean;
  note?: string;
  noteOpen?: boolean;
};

/**
 * An ad-hoc, non-catalog ("unlisted") invoice line: free-text description +
 * required price; never boxed. Serialised as `{ description, qty, unitPrice }`
 * (no productId). Keyed locally by a synthetic id.
 */
type UnlistedLine = { id: string; name: string; unitPrice: number; qty: number; taxable?: boolean };

function newLocalId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The effective per-unit price for a line: the override, else the CUSTOMER's
 * catalog price (tier/customer-price resolved by the caller — this screen
 * previously always fell back to the LIST price, overbilling every tiered
 * customer on mobile-built invoices; the server takes unitPrice verbatim).
 */
function effectiveUnitPrice(
  line: LineState | undefined,
  p: Product,
  catalogPrice?: number,
): number {
  return line?.unitPrice != null ? line.unitPrice : (catalogPrice ?? toNumber(p.pricePerUnit));
}

const productKey = (p: CatalogRow<Product>) => (isCatalogHeader(p) ? `hdr-${p.__header}` : p.id);

/** Separator label between the on-this-invoice section and the catalogue. */
function CatalogSectionLabel({ label }: { label: string }) {
  return (
    <View style={sectionStyles.wrap}>
      <Text style={sectionStyles.text}>{label.toUpperCase()}</Text>
      <View style={sectionStyles.rule} />
    </View>
  );
}

const sectionStyles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingTop: 6,
    paddingBottom: 2,
  },
  text: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.6,
  },
  rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: ios.separator },
});

function RowSpacer() {
  return <View style={styles.rowSpacer} />;
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
  /** Scanned code with several substring matches → picker over the camera. */
  const [pickCode, setPickCode] = useState<string | null>(null);
  // POST /products is @Roles(OPERATOR) server-side, so offering "Create" to a
  // driver only earns them a 403. NewOrderScreen has always gated this; this
  // screen did not.
  const userRole = useAuthStore((s) => s.user?.role);
  const canCreateProducts = userRole === "OPERATOR" || userRole === "TENANT_ADMIN";
  // Scroll the just-added row into view. The target is kept as an ID and
  // re-resolved against whatever the list renders each pass — a cached row
  // offset goes stale the moment clearing the search swaps the rendered list.
  const listRef = useRef<FlatList<CatalogRow<Product>>>(null);
  const [pendingScroll, setPendingScroll] = useState<PendingScrollState>(NO_PENDING_SCROLL);
  const { toast, show: showInline, dismiss: dismissInline } = useInlineToast();
  const [terms, setTerms] = useState(DEFAULT_TERMS);
  // Business date of the invoice (YYYY-MM-DD); blank = today, stamped server-side.
  const [issueDate, setIssueDate] = useState("");
  const [dueDate, setDueDate] = useState(() => dueDateFor("", DEFAULT_TERMS));
  const [send, setSend] = useState(false);
  // Invoice-level money + header fields (Wave 2). Null money = unset.
  const [invDiscount, setInvDiscount] = useState<number | null>(null);
  const [shippingFee, setShippingFee] = useState<number | null>(null);
  const [referenceNumber, setReferenceNumber] = useState("");
  const [subject, setSubject] = useState("");

  // ── Van-sale mode (WP4, PR-4) ─────────────────────────────────────────────
  // "Delivered today?" — default YES, the common van-sale case. Whether this
  // actually collapses into POST /orders/sell is decided by saleModeGate below;
  // this is just the operator's stated intent.
  const [deliveredNow, setDeliveredNow] = useState(true);
  // "Touched" flags for the header fields the sale gate disqualifies on — dirty
  // means the operator EDITED the field, not that its current value happens to
  // differ from the default (a from-order invoice has none of these set).
  const [touchedDueDate, setTouchedDueDate] = useState(false);
  const [touchedTerms, setTouchedTerms] = useState(false);
  const [touchedReference, setTouchedReference] = useState(false);
  const [touchedSubject, setTouchedSubject] = useState(false);

  // Tenant tax rate (a PERCENT in settings → fraction on the wire, web's exact
  // mapping) and the customer's exempt flag, which zeroes ALL tax server-side —
  // the preview must match or the operator quotes a total the invoice won't have.
  const { data: settings } = useBusinessSettings();
  const { data: pickedCustomer } = useAdminCustomer(customerId);
  const isTaxExempt = !!pickedCustomer?.isTaxExempt;
  // Customer pricing (parity with NewOrderScreen/web): per-product tier
  // overrides first, then the customer's own tier ladder. Without this the
  // invoice builder billed LIST to everyone.
  const { data: customerPrices } = useCustomerPrices(customerId ?? "");
  const customerTier = Number((pickedCustomer as any)?.pricingTier ?? 1) || 1;
  const cpMap = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const cp of customerPrices ?? []) m.set(cp.productId, cp.pricingTier);
    return m;
  }, [customerPrices]);
  const tierPriceFor = (p: Product) => getTierPrice(p, cpMap.get(p.id) ?? customerTier ?? 1);
  const tenantTaxRate = (Number(settings?.taxRate) || 0) / 100;
  // Rate the row toggles actually offer: hidden entirely for exempt customers.
  const taxRateFraction = isTaxExempt ? 0 : tenantTaxRate;

  // Regulated categories that bill on their OWN invoice — a SEPARATE_INVOICE
  // line can't ride the sale path (POST /orders/sell always creates ONE
  // invoice). Reuses the shipped tracked-categories hook, no new API surface.
  // NO `active` filter: `groupOrderLinesForInvoicing` looks categories up by id
  // with no active filter (invoices.service.ts), so a DEACTIVATED category with
  // products still assigned still splits server-side — the client set has to
  // match what the server actually groups on.
  // `isSuccess` matters: react-query hands back `undefined` both in flight AND
  // after a failure, and an empty id set would silently disarm gate rule 6.
  const { data: saleTrackedCategories, isSuccess: saleCategoriesLoaded } = useTrackedCategories();
  const separateInvoiceCategoryIds = useMemo(() => {
    const s = new Set<string>();
    for (const c of saleTrackedCategories ?? []) {
      if (c.invoiceTreatment === "SEPARATE_INVOICE") s.add(c.id);
    }
    return s;
  }, [saleTrackedCategories]);

  // Debounced, server-filtered, paged — replaces the `limit: 0` fetch-all.
  // See NewOrderScreen and lib/use-product-search.ts.
  const {
    search,
    setSearch,
    searchTerm,
    products,
    isLoading: productsLoading,
    isSearching,
    isPlaceholder,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useProductSearch<Product>({ category });

  const productById = useMemo(
    () => mergeProductIndex<Product>(products, scannedById),
    [products, scannedById],
  );

  const addOne = (id: string, snapshot?: Product, kind: "case" | "piece" = "case") => {
    const p = snapshot ?? productById.get(id);
    const upb = Number(p?.unitsPerBox ?? 0);
    const isBoxed = upb > 1;
    setItems((m) => {
      const prev: LineState = m[id] ?? { qty: 0 };
      // ...prev preserved so a repeat scan / +1 keeps unitPrice. A PIECE-code
      // scan (unitSku) adds one loose piece, rolling into a box at upb.
      return {
        ...m,
        [id]:
          kind === "piece"
            ? incrementLinePiece(prev, isBoxed, upb)
            : incrementLine(prev, isBoxed, upb),
      };
    });
    // Retain a snapshot for EVERY added line, not just scanned ones — see
    // NewOrderScreen.addOne. Gated on `snapshot`, a row added by TAPPING it
    // dropped out of the total as soon as the page changed underneath.
    if (p) {
      setScannedById((m) => (id in m ? m : { ...m, [id]: p }));
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

  // Flat $ off one line (comes off BEFORE tax). Empty/invalid clears it.
  const setLineDiscount = (id: string, value: number | null) =>
    setItems((m) => {
      const prev = m[id];
      if (!prev) return m;
      if (value == null || value <= 0) {
        const { discount: _drop, ...rest } = prev;
        return { ...m, [id]: rest };
      }
      return { ...m, [id]: { ...prev, discount: value } };
    });

  const toggleLineTaxable = (id: string) =>
    setItems((m) => (m[id] ? { ...m, [id]: { ...m[id], taxable: !m[id].taxable } } : m));

  const setLineNote = (id: string, note: string) =>
    setItems((m) => (m[id] ? { ...m, [id]: { ...m[id], note } } : m));

  const toggleLineNote = (id: string) =>
    setItems((m) => (m[id] ? { ...m, [id]: { ...m[id], noteOpen: !m[id].noteOpen } } : m));

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
  const toggleUnlistedTaxable = (id: string) =>
    setUnlisted((u) => u.map((x) => (x.id === id ? { ...x, taxable: !x.taxable } : x)));
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
  const acceptScannedProduct = (
    product: Product,
    unitKind: "case" | "piece" = "case",
  ): ScanOutcome => {
    addOne(product.id, product, unitKind);
    bumpScanned(product.id);
    // Never set the search box to the scanned code — see NewOrderScreen: the
    // barcode endpoint resolves codes the text search cannot match.
    setSearch("");
    const label =
      unitKind === "piece" && Number(product.unitsPerBox ?? 0) > 1
        ? `Added 1 loose · ${displayName(product)}`
        : `Added ${displayName(product)}`;
    if (scanOpen) return; // the tray row is the confirmation
    setPendingScroll((s) => requestScroll(s, product.id));
    return { feedback: { kind: "added", text: label } };
  };

  // Continuous-scan handler: the scan sheet stays open between items; only the
  // create-product hand-off (and Done) closes it. Shared ladder — see
  // lib/scan-ladder for why an ambiguous hit opens a picker instead of taking
  // matches[0], and why a miss must never close the scanner.
  const handleBarcodeScanned = makeScanHandler<Product>({
    products,
    accept: acceptScannedProduct,
    // Forward the ladder's abort signal — without it a lookup that blows the
    // scan deadline keeps running and still adds the line (F30 / R2).
    resolve: (c, signal) => resolveProductByCode<Product>(c, signal),
    onAmbiguous: setPickCode,
    onCreate: canCreateProducts ? setCreateCode : undefined,
  });

  // Wedge-scanner path — mirrors NewOrderScreen exactly (see its comment for
  // the full reasoning): Enter-as-scan for terminator scanners, settled
  // exact-match auto-add for the rest. Both gated on looksLikeScanCode so a
  // typed NAME search never auto-adds.
  // Wedge-submit: the search field is cleared SYNCHRONOUSLY on every SCAN
  // submit (never on a typed name) — mirrors NewOrderScreen exactly (see its
  // comment) — and a burst arriving
  // mid-resolve is buffered, never dropped, never concatenated (REG-B193). The
  // handler's busy/queue state has to survive re-renders, so it's built ONCE
  // via a ref; a "latest deps" ref keeps it pointed at the current
  // searchTerm/handleBarcodeScanned/showInline closures instead of the ones
  // captured on the render that built it.
  const wedgeDepsRef = useRef<{ scan: (code: string) => Promise<void>; clearSearch: () => void }>({
    scan: async () => undefined,
    clearSearch: () => undefined,
  });
  wedgeDepsRef.current = {
    scan: (code) =>
      runWedgeSubmit({
        term: code,
        scan: handleBarcodeScanned,
        clearSearch: () => setSearch(""),
        showInline,
      }),
    clearSearch: () => setSearch(""),
  };
  const wedgeSubmitRef = useRef(
    createWedgeSubmitHandler({
      scan: (code) => wedgeDepsRef.current.scan(code),
      clearSearch: () => wedgeDepsRef.current.clearSearch(),
    }),
  );
  const handleSearchSubmit = () => wedgeSubmitRef.current(searchTerm);

  // Settled exact-match auto-add (no-terminator scanners): a per-scan ATTEMPT
  // — not a time window — decides whether a settle may fire (REG-B201); see
  // NewOrderScreen's comment for why a window can't tell "already added" from
  // "a background refetch re-settled", and why the attempt has to END when the
  // field clears (otherwise a deliberate re-scan of the same item is eaten).
  const autoAddAttemptRef = useRef(createScanAttempt());
  useEffect(() => {
    const code = searchTerm.trim();
    if (!looksLikeScanCode(code)) {
      autoAddAttemptRef.current.end();
      return;
    }
    if (isSearching) return;
    const { match } = findExactScanMatch(code, products);
    if (!match) return;
    if (!autoAddAttemptRef.current.shouldAutoAdd(code)) return;
    const outcome = acceptScannedProduct(match, scanUnitKind(code, match));
    if (outcome?.feedback?.kind === "added") showInline(outcome.feedback.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, products, isSearching]);

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

  // Chips from the tenant's distinct categories — a 50-row page can't enumerate them.
  const { data: tenantCategories } = useProductCategories();
  const categoryChips = useMemo(
    () => [{ label: "All" }, ...(tenantCategories ?? []).map((label) => ({ label }))],
    [tenantCategories],
  );

  // Quiet by default — mirrors NewOrderScreen (see visibleCatalogRows): the
  // list shows what is ON the invoice, with the full catalogue one tap away,
  // because accepting a scan clears the search box and used to snap the list
  // back to hundreds of rows.
  const [browsing, setBrowsing] = useState(false);
  const visible = useMemo(
    () =>
      visibleCatalogRows<Product>({
        base: products,
        cartIds: Object.keys(items),
        lookup: (id) => productById.get(id),
        browsing,
        searchTerm,
      }),
    [products, searchTerm, items, productById, browsing],
  );
  const filtered: CatalogRow<Product>[] = visible.rows;

  // Resolve a queued scroll against the ids the list renders THIS pass. A
  // just-scanned product is often absent for a render or two while it refetches.
  useEffect(() => {
    if (!pendingScroll.targetId) return;
    const { state, scrollIndex } = stepPendingScroll(
      pendingScroll,
      filtered.map((p) => (isCatalogHeader(p) ? `hdr-${p.__header}` : p.id)),
    );
    if (scrollIndex == null) return;
    setPendingScroll(state);
    listRef.current?.scrollToIndex({ index: scrollIndex, viewPosition: 0.12, animated: true });
  }, [pendingScroll, filtered]);

  // The exact line set fed to computeInvoiceTotals below — ALSO fed verbatim to
  // saleModeGate (WP4). The gate's equality assertion is only meaningful when
  // both the preview and the gate see the identical lines; building them twice
  // (even from the same inputs) would risk the two silently drifting apart.
  const { invoiceLines, totalItems, hasSeparateInvoiceCategoryLine } = useMemo(() => {
    const lines: InvoiceTotalsLine[] = [];
    let totalItems = 0;
    let hasSeparateInvoiceCategoryLine = false;
    for (const [id, line] of Object.entries(items)) {
      const p = productById.get(id);
      if (!p) continue;
      const qty = effectiveQty(line, p.unitsPerBox);
      if (qty <= 0) continue;
      totalItems += qty;
      if (p.trackedCategoryId && separateInvoiceCategoryIds.has(p.trackedCategoryId)) {
        hasSeparateInvoiceCategoryLine = true;
      }
      lines.push({
        unitPrice: effectiveUnitPrice(line, p, tierPriceFor(p)),
        qty,
        boxes: line.boxes ?? null,
        pieces: line.pieces ?? null,
        unitsPerBox: p.unitsPerBox ?? null,
        discount: line.discount ?? 0,
        taxRate: line.taxable ? taxRateFraction : 0,
      });
    }
    // Unlisted lines: never boxed, simple unitPrice × qty.
    for (const u of unlisted) {
      if (u.qty <= 0) continue;
      totalItems += u.qty;
      lines.push({
        unitPrice: u.unitPrice,
        qty: u.qty,
        taxRate: u.taxable ? taxRateFraction : 0,
      });
    }
    return { invoiceLines: lines, totalItems, hasSeparateInvoiceCategoryLine };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    items,
    productById,
    unlisted,
    taxRateFraction,
    cpMap,
    customerTier,
    separateInvoiceCategoryIds,
  ]);

  // Full money preview through lib/invoice-totals — the same formula the server
  // runs, so the footer/review totals equal the saved invoice to the cent.
  const totals = useMemo(
    () =>
      computeInvoiceTotals({
        lines: invoiceLines,
        discount: invDiscount ?? 0,
        shippingFee: shippingFee ?? 0,
        isTaxExempt,
      }),
    [invoiceLines, invDiscount, shippingFee, isTaxExempt],
  );
  const total = totals.total;

  // Any unlisted line the operator hasn't finished filling in yet — can't ride
  // the sale path (POST /orders/sell requires a real name + price per item).
  const hasUnlistedInvalid = useMemo(
    () => unlisted.some((u) => u.name.trim() === "" || u.unitPrice <= 0),
    [unlisted],
  );

  // The gate's input — pure, no network. Fed the SAME `invoiceLines` array as
  // `totals` above (see lib/sale-mode.ts for the full rule set and the final
  // total-equality assertion that is the real safety net). Hoisted so the gate
  // can also be re-run at a hypothetical control position below.
  const saleGateInput = useMemo(
    () => ({
      lines: invoiceLines,
      hasUnlistedInvalid,
      invDiscount: invDiscount ?? 0,
      shippingFee: shippingFee ?? 0,
      isTaxExempt,
      taxRateFraction,
      touched: {
        dueDate: touchedDueDate,
        terms: touchedTerms,
        reference: touchedReference,
        subject: touchedSubject,
      },
      sendNowOn: send,
      deliveredNow,
      hasSeparateInvoiceCategoryLine,
    }),
    [
      invoiceLines,
      hasUnlistedInvalid,
      invDiscount,
      shippingFee,
      isTaxExempt,
      taxRateFraction,
      touchedDueDate,
      touchedTerms,
      touchedReference,
      touchedSubject,
      send,
      deliveredNow,
      hasSeparateInvoiceCategoryLine,
    ],
  );

  const saleGate = useMemo(() => saleModeGate(saleGateInput), [saleGateInput]);

  // Ineligibility the gate itself can't see, layered on top of it. Both are
  // independent of the "Delivered today?" / Send controls, so they also decide
  // whether that control stays tappable (see `saleControlEnabled`).
  //  - saleModeGate deliberately leaves `hasUnlistedInvalid` unenforced — its
  //    own doc comment makes this the CALLER's call. It has to be one here: an
  //    unlisted line with a real price but no name still counts toward the
  //    previewed total above, but the submit path below drops it (a nameless
  //    line can't go on the wire), which would silently undercharge an
  //    "eligible" sale.
  //  - Rule 6 needs the tracked categories to have actually loaded. Until then
  //    `separateInvoiceCategoryIds` is empty and the rule can't fire, so an
  //    unresolved/failed fetch has to fail CLOSED — otherwise a
  //    SEPARATE_INVOICE line rides the sale path and the server splits it into
  //    sibling invoices that match neither the preview nor the success handler.
  const saleExtraReasons = useMemo(() => {
    const reasons: string[] = [];
    if (hasUnlistedInvalid) reasons.push("an unlisted item needs a name and price");
    if (!saleCategoriesLoaded) reasons.push("regulated categories haven't loaded yet");
    return reasons;
  }, [hasUnlistedInvalid, saleCategoriesLoaded]);

  const saleMode = useMemo(() => {
    if (saleExtraReasons.length === 0) return saleGate;
    const reasons = saleGate.eligible ? [] : saleGate.reasons;
    return { eligible: false as const, reasons: [...reasons, ...saleExtraReasons] };
  }, [saleGate, saleExtraReasons]);

  // Whether the "Delivered today?" control may be operated. It must NOT disable
  // itself for an ineligibility it produced: rule 5 ("sending now without
  // delivery") is a function of this control's own value, so disabling on it
  // would strand the operator on "No" with no way back to "Yes". Re-run the
  // gate at the control's clean position (delivered + not sending) — only a
  // CART-level problem locks the control.
  const saleControlEnabled = useMemo(
    () =>
      saleExtraReasons.length === 0 &&
      saleModeGate({ ...saleGateInput, deliveredNow: true, sendNowOn: false }).eligible,
    [saleGateInput, saleExtraReasons],
  );

  // Newest-first "invoice so far" for the scan tray. Same inputs as the total
  // memo, so the tray and the footer cannot disagree.
  const trayRows = useMemo(
    () =>
      trayRowsFrom({
        items,
        unlisted,
        scanOrder,
        lookup: (id) => productById.get(id),
        priceFor: (p) => {
          const full = productById.get(p.id);
          return full ? tierPriceFor(full) : 0;
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, unlisted, scanOrder, productById, cpMap, customerTier],
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
    setPieces,
    setUnits,
    removeLine,
    isUnlisted: (id: string) => unlisted.some((u) => u.id === id),
    unlistedQty: (id: string) => unlisted.find((u) => u.id === id)?.qty ?? 0,
    updateUnlistedQty,
    removeUnlisted,
    unitsPerBox: (id: string) => Number(productById.get(id)?.unitsPerBox ?? 0),
    // Owner ask: after CHOOSING the searched item, the field clears. Only on
    // the row's first Add (not stepper increments — the settled list must not
    // swap mid-repeat-tap); the added row survives the swap back to the
    // catalogue because cart lines are pinned (withCartRows), and the pending
    // scroll brings it into view at its new position.
    pickedFromSearch: (id: string) => {
      if (!searchTerm) return;
      setSearch("");
      setPendingScroll((s) => requestScroll(s, id));
    },
  };
  const actionsRef = useRef(rowActions);
  actionsRef.current = rowActions;

  const onRowAdd = useCallback((id: string) => {
    actionsRef.current.add(id);
    actionsRef.current.pickedFromSearch(id);
  }, []);
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
  const onRowChangePieces = useCallback(
    (id: string, n: number) => actionsRef.current.setPieces(id, n),
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
    ({ item: p }: { item: CatalogRow<Product> }) => {
      if (isCatalogHeader(p)) return <CatalogSectionLabel label={p.label} />;
      const line = items[p.id];
      const qty = line ? effectiveQty(line, p.unitsPerBox) : 0;
      const price = tierPriceFor(p);
      const band =
        line && qty > 0 && Number(p.unitsPerBox ?? 0) > 1 ? (
          <BoxedQtyBand
            line={line}
            unitsPerBox={Number(p.unitsPerBox)}
            unit={p.unit}
            unitPrice={effectiveUnitPrice(line, p, tierPriceFor(p))}
            productName={displayName(p)}
            onChangeBoxes={(n) => onRowChangeBoxes(p.id, n)}
            onChangePieces={(n) => onRowChangePieces(p.id, n)}
            onEdit={openReview}
          />
        ) : null;

      return (
        <ProductRow
          id={p.id}
          name={displayName(p)}
          sku={p.sku}
          unit={p.unit}
          unitsPerBox={p.unitsPerBox}
          price={price}
          listPrice={toNumber(p.pricePerUnit)}
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      items,
      cpMap,
      customerTier,
      onRowAdd,
      onRowChangeQty,
      onRowIncrement,
      onRowDecrement,
      onRowChangeBoxes,
      onRowChangePieces,
      openReview,
    ],
  );

  const createMut = useCreateInvoice();
  const createSaleMut = useCreateSale();
  const saving = createMut.isPending || createSaleMut.isPending;
  // A recorded sale already moved stock and issued an invoice. If we ever fail
  // to navigate away from it (see the sale onSuccess below) the builder stays
  // mounted with the whole cart intact — latch the Create button off so a
  // missed toast can't become a second order, a second stock deduction and a
  // second issued invoice.
  const [saleRecorded, setSaleRecorded] = useState(false);
  const canSave = totalItems > 0 && !saving && !saleRecorded;

  const onTermsChange = (t: string) => {
    setTerms(t);
    setDueDate(dueDateFor(issueDate, t));
    setTouchedTerms(true);
  };

  const onIssueDateChange = (v: string) => {
    setIssueDate(v);
    if (ISO_DATE.test(v)) setDueDate(dueDateFor(v, terms));
  };

  const onDueDateChange = (v: string) => {
    setDueDate(v);
    setTouchedDueDate(true);
  };

  const onReferenceNumberChange = (v: string) => {
    setReferenceNumber(v);
    setTouchedReference(true);
  };

  const onSubjectChange = (v: string) => {
    setSubject(v);
    setTouchedSubject(true);
  };

  /**
   * @param fromReview true only when the review sheet's own Create button fired
   *   this. The van-sale path is gated on it — see the sale branch below.
   */
  const onSave = (fromReview = false) => {
    if (!canSave) {
      alertInfo("Add at least one item", "Tap + on any product to start the invoice.");
      return;
    }
    // The server's own money guards, surfaced before the round-trip. Both save
    // paths below are subject to them — the sale gate's own rules already keep
    // an eligible sale clear of a line discount / invoice discount, but they
    // still apply to the POST /invoices fallback.
    if (totals.hasNegativeLine) {
      alertInfo("Check line discounts", "A line's discount is larger than the line itself.");
      return;
    }
    if (totals.discount > totals.subtotal) {
      alertInfo(
        "Discount too large",
        `The invoice discount ($${totals.discount.toFixed(2)}) can't exceed the subtotal ($${totals.subtotal.toFixed(2)}).`,
      );
      return;
    }
    const issueTrim = issueDate.trim();
    if (issueTrim && !ISO_DATE.test(issueTrim)) {
      alertInfo("Bad issue date", "Use the format YYYY-MM-DD, or leave it blank for today.");
      return;
    }

    // Van-sale mode: collapse into ONE POST /orders/sell call. saleMode.eligible
    // already re-ran the total-equality assertion against `invoiceLines` — the
    // SAME lines `totals` above was computed from — so this can never silently
    // save for a different amount than what's on screen. Every catalog line
    // sends its EFFECTIVE unitPrice explicitly (never omitted) so the server's
    // price resolution can't diverge from the previewed price.
    if (saleMode.eligible) {
      // A sale may only be recorded from the review sheet, because that is the
      // only place the "Delivered today?" control, its disclosure and a button
      // that NAMES the sale are on screen together (sheet sticky footer — see
      // SaleModeField). The catalogue footer's Create opens the sheet instead;
      // it can never move stock or issue an invoice on its own.
      if (!fromReview) {
        setReviewOpen(true);
        return;
      }
      const saleItems: CreateSaleItemInput[] = [];
      for (const [productId, line] of Object.entries(items)) {
        const p = productById.get(productId);
        if (!p) continue;
        const qty = effectiveQty(line, p.unitsPerBox);
        if (qty <= 0) continue;
        const upb = Number(p.unitsPerBox ?? 0);
        saleItems.push({
          productId,
          qty,
          unitPrice: effectiveUnitPrice(line, p, tierPriceFor(p)),
          ...(upb > 1 && line.boxes != null ? { boxes: line.boxes } : {}),
          ...(upb > 1 && line.pieces != null ? { pieces: line.pieces } : {}),
          ...(line.note?.trim() ? { notes: line.note.trim() } : {}),
        });
      }
      // Unlisted lines are NOT filtered out — the gate's total-equality
      // assertion already accounts for them, so they must ride along.
      for (const u of unlisted) {
        if (u.qty <= 0 || u.name.trim() === "" || u.unitPrice <= 0) continue;
        saleItems.push({ name: u.name.trim(), qty: u.qty, unitPrice: u.unitPrice });
      }
      createSaleMut.mutate(
        {
          customerId,
          items: saleItems,
          deliveredNow,
          ...(shippingFee && shippingFee > 0 ? { shippingFee } : {}),
          // Only a genuinely backdated sale carries orderDate — a same-day sale
          // stays unsent so deliveredAt lands at the full current timestamp.
          ...(issueTrim && issueTrim !== todayPlusDays(0) ? { orderDate: issueTrim } : {}),
          // No dueDate: gate rule 4 (lib/sale-mode.ts) makes sale mode
          // ineligible the moment the operator touches Due date or Terms, so an
          // eligible sale's `dueDate` is always this screen's hardcoded Net-30
          // default. Sending it would override the tenant's configured
          // `invoice.defaultTerms` with a date nobody chose (and put a free-text
          // field on the wire ahead of this path's ISO_DATE check).
        },
        {
          // POST /orders/sell resolves to the created INVOICE (not the order) —
          // see CreatedSaleInvoice in lib/api/orders.ts.
          onSuccess: (inv) => {
            if (inv?.id) {
              onSaved(inv.id, inv.invoiceNumber);
              return;
            }
            // Defensive only: the sale IS already recorded server-side, so lock
            // the builder instead of leaving a live Create button behind a toast
            // that's easy to miss on a phone.
            setSaleRecorded(true);
            showToast("Sale recorded — open the invoice from the Invoices tab.");
          },
          onError: (err: any) => {
            alertInfo(
              "Couldn't record the sale",
              err?.response?.data?.message ?? err?.message ?? "Try again.",
            );
          },
        },
      );
      return;
    }

    // Fallback: the existing standalone-invoice path (no order, no stock move).
    if (!ISO_DATE.test(dueDate)) {
      alertInfo("Bad due date", "Use the format YYYY-MM-DD.");
      return;
    }
    const payload: CreateInvoiceItem[] = [];
    for (const [productId, line] of Object.entries(items)) {
      const p = productById.get(productId);
      if (!p) continue;
      const qty = effectiveQty(line, p.unitsPerBox);
      if (qty <= 0) continue;
      payload.push(
        invoiceLineDto(
          {
            description: displayName(p),
            productId,
            qty,
            unitPrice: effectiveUnitPrice(line, p, tierPriceFor(p)),
            boxes: line.boxes ?? null,
            pieces: line.pieces ?? null,
            unitsPerBox: p.unitsPerBox ?? null,
            discount: line.discount,
            taxable: line.taxable,
            notes: line.note,
          },
          taxRateFraction,
        ),
      );
    }
    // Unlisted lines → `{ description, qty, unitPrice }` (no productId).
    for (const u of unlisted) {
      if (u.qty <= 0 || u.name.trim() === "" || u.unitPrice <= 0) continue;
      payload.push(
        invoiceLineDto(
          { description: u.name.trim(), qty: u.qty, unitPrice: u.unitPrice, taxable: u.taxable },
          taxRateFraction,
        ),
      );
    }
    createMut.mutate(
      {
        customerId,
        items: payload,
        dueDate,
        terms,
        send,
        ...(issueTrim ? { issueDate: issueTrim } : {}),
        ...(invDiscount && invDiscount > 0 ? { discount: invDiscount } : {}),
        ...(shippingFee && shippingFee > 0 ? { shippingFee } : {}),
        ...(referenceNumber.trim() ? { referenceNumber: referenceNumber.trim() } : {}),
        ...(subject.trim() ? { subject: subject.trim() } : {}),
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

  // The review sheet's copy of this opener is unreachable until the invoice has
  // a line, so the catalog list owns the only zero-item path to an ad-hoc item.
  const unlistedPlacement = unlistedAffordancePlacement({
    rowCount: filtered.length,
    // Suppress mid-search too: keepPreviousData means the rows on screen may
    // belong to the previous query.
    loading: productsLoading || isSearching,
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
        onSubmitEditing={() => void handleSearchSubmit()}
        trailing={
          <View style={styles.searchTrailing}>
            {isSearching ? <ActivityIndicator size="small" color={ios.gray[1]} /> : null}
            <Pressable
              onPress={() => setScanOpen(true)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Scan items"
            >
              <Ionicons name="barcode-outline" size={20} color={ios.brand} />
            </Pressable>
          </View>
        }
      />

      {visible.showCategoryChips ? (
        <View style={styles.browseBar}>
          {categoryChips.length > 1 ? (
            <View style={{ flex: 1 }}>
              <FilterChipRow chips={categoryChips} value={category} onChange={setCategory} />
            </View>
          ) : (
            <View style={{ flex: 1 }} />
          )}
          <Pressable
            onPress={() => {
              setBrowsing(false);
              setCategory("All");
            }}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Close the catalogue"
            style={styles.browseClose}
          >
            <Ionicons name="close" size={18} color={ios.label2} />
          </Pressable>
        </View>
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
        // RN's own default is Android-only; forcing it on for iOS is a known
        // source of cells failing to render. No-op on web.
        removeClippedSubviews={Platform.OS === "android"}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        onScrollToIndexFailed={onScrollToIndexFailed}
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (isPlaceholder || !hasNextPage || isFetchingNextPage) return;
          fetchNextPage();
        }}
        contentContainerStyle={styles.listContent}
        ItemSeparatorComponent={RowSpacer}
        ListEmptyComponent={
          visible.emptyHint ? (
            <View style={styles.center}>
              <Text style={styles.emptyText}>{visible.emptyHint}</Text>
            </View>
          ) : unlistedPlacement === "empty-state" ? (
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
          <>
            {visible.showBrowseButton ? (
              <Pressable
                style={styles.listUnlistedBtn}
                onPress={() => setBrowsing(true)}
                accessibilityRole="button"
                accessibilityLabel="Browse the full catalogue"
              >
                <Ionicons name="grid-outline" size={16} color={ios.brand} />
                <Text style={styles.listUnlistedText}>Browse catalogue</Text>
              </Pressable>
            ) : null}
            {unlistedPlacement === "list-footer" ? (
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
            ) : null}
            {isFetchingNextPage ? (
              <View style={styles.pageSpinner}>
                <ActivityIndicator color={ios.brand} />
              </View>
            ) : null}
          </>
        }
      />

      <View style={styles.footer}>
        {/* ONE entry point into review: the summary itself is the button —
            see NewOrderScreen's footer for the history. */}
        <Pressable
          style={[styles.footerSummaryBtn, totalItems === 0 && styles.footerSummaryBtnDisabled]}
          onPress={totalItems > 0 ? openReview : undefined}
          disabled={totalItems === 0}
          accessibilityRole="button"
          accessibilityLabel="Review invoice"
          accessibilityState={{ disabled: totalItems === 0 }}
          hitSlop={6}
        >
          <View style={styles.footerSummaryEyebrowRow}>
            <Text style={styles.footerEyebrow} numberOfLines={1}>
              {totalItems} ITEM{totalItems === 1 ? "" : "S"}
            </Text>
            {totalItems > 0 ? <Ionicons name="chevron-up" size={12} color={ios.brand} /> : null}
          </View>
          <Text style={styles.footerTotal} numberOfLines={1}>
            ${total.toFixed(2)}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.confirmBtn, !canSave && styles.confirmBtnDisabled]}
          disabled={!canSave}
          onPress={() => onSave()}
          accessibilityState={{ disabled: !canSave }}
        >
          <Text style={styles.confirmBtnText} numberOfLines={1}>
            {saving ? "Saving…" : "Create"}
          </Text>
          <Ionicons name="arrow-forward" size={14} color="#fff" />
        </Pressable>
      </View>

      <InlineToast toast={toast} onDismiss={dismissInline} bottom={96} />

      {/* Scan mode: camera over the live invoice. The sheet owns the scan
          haptics and the tray scroll; this screen only mutates the lines. */}
      <ScanOrderSheet
        visible={scanOpen}
        // Freeze decoding, don't close — see the miss path in
        // handleBarcodeScanned for why the scanner must survive a no-match.
        paused={createCode != null || pickCode != null}
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
        totals={totals}
        totalItems={totalItems}
        taxRateFraction={taxRateFraction}
        tierPriceFor={tierPriceFor}
        saving={saving}
        onClose={() => setReviewOpen(false)}
        onIncrement={addOne}
        onDecrement={removeOne}
        onChangeQty={setQty}
        onChangeBoxes={setBoxes}
        onChangePieces={setPieces}
        onChangePrice={setLinePrice}
        onChangeDiscount={setLineDiscount}
        onToggleTaxable={toggleLineTaxable}
        onChangeNote={setLineNote}
        onToggleNote={toggleLineNote}
        onRemove={removeLine}
        onChangeUnlistedQty={updateUnlistedQty}
        onChangeUnlistedPrice={updateUnlistedPrice}
        onToggleUnlistedTaxable={toggleUnlistedTaxable}
        onRemoveUnlisted={removeUnlisted}
        onAddUnlisted={() => openUnlistedModal("")}
        details={{
          terms,
          onChangeTerms: onTermsChange,
          issueDate,
          onChangeIssueDate: onIssueDateChange,
          dueDate,
          onChangeDueDate: onDueDateChange,
          send,
          onToggleSend: () => setSend((s) => !s),
          referenceNumber,
          onChangeReferenceNumber: onReferenceNumberChange,
          subject,
          onChangeSubject: onSubjectChange,
          invoiceDiscount: invDiscount,
          onChangeInvoiceDiscount: setInvDiscount,
          shippingFee,
          onChangeShippingFee: setShippingFee,
          total,
          deliveredNow,
          onChangeDeliveredNow: setDeliveredNow,
          saleEligible: saleMode.eligible,
          saleReasons: saleMode.eligible ? [] : saleMode.reasons,
          saleControlEnabled,
        }}
        onSave={() => {
          setReviewOpen(false);
          onSave(true);
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

      {/* Ambiguous scan → pick without losing the camera. Same portal-order
          rule as the create sheet below. */}
      <ProductPickerSheet
        visible={pickCode != null}
        title="Which one?"
        initialSearch={pickCode ?? undefined}
        onClose={() => setPickCode(null)}
        onSelect={(p: { id: string }) => {
          setPickCode(null);
          acceptScannedProduct(p as unknown as Product);
        }}
      />

      {/* MUST STAY AFTER <ScanOrderSheet>: on react-native-web sibling Modals
          stack by portal-div mount order with no z-index, so rendering this
          earlier would hide it behind an open scan sheet. */}
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
  referenceNumber: string;
  onChangeReferenceNumber: (v: string) => void;
  subject: string;
  onChangeSubject: (v: string) => void;
  /** Invoice-level $ discount — applied AFTER tax. Null = unset. */
  invoiceDiscount: number | null;
  onChangeInvoiceDiscount: (v: number | null) => void;
  /** Flat shipping added after tax; never taxed. Null = unset. */
  shippingFee: number | null;
  onChangeShippingFee: (v: number | null) => void;
  /** The invoice grand total — only for the ineligible-sale disclosure copy. */
  total: number;
  // ── Van-sale mode (WP4) ──────────────────────────────────────────────────
  /** "Delivered today?" control state — default true, independent of eligibility. */
  deliveredNow: boolean;
  onChangeDeliveredNow: (v: boolean) => void;
  /** Whether the current cart can collapse into POST /orders/sell (saleModeGate). */
  saleEligible: boolean;
  /** Operator-facing reasons it can't, when ineligible ([] when eligible). */
  saleReasons: string[];
  /**
   * Whether the Yes/No control itself may be operated. NOT `saleEligible`:
   * gate rule 5 ("sending now without delivery") is a function of this
   * control's own value, so disabling on it would strand the operator on "No".
   * True whenever the CART could collapse at the control's clean position.
   */
  saleControlEnabled: boolean;
}

function ReviewSheet({
  open,
  items,
  productById,
  unlisted,
  totals,
  totalItems,
  taxRateFraction,
  tierPriceFor,
  saving,
  onClose,
  onIncrement,
  onDecrement,
  onChangeQty,
  onChangeBoxes,
  onChangePieces,
  onChangePrice,
  onChangeDiscount,
  onToggleTaxable,
  onChangeNote,
  onToggleNote,
  onRemove,
  onChangeUnlistedQty,
  onChangeUnlistedPrice,
  onToggleUnlistedTaxable,
  onRemoveUnlisted,
  onAddUnlisted,
  details,
  onSave,
}: {
  open: boolean;
  items: Record<string, LineState>;
  productById: Map<string, Product>;
  unlisted: UnlistedLine[];
  totals: InvoiceTotals;
  totalItems: number;
  /** 0 hides every taxable toggle (no tenant rate, or tax-exempt customer). */
  taxRateFraction: number;
  /** The customer's effective (tier / customer-price) catalog price per product. */
  tierPriceFor: (p: Product) => number;
  saving: boolean;
  onClose: () => void;
  onIncrement: (id: string) => void;
  onDecrement: (id: string) => void;
  onChangeQty: (id: string, n: number) => void;
  onChangeBoxes: (id: string, n: number) => void;
  onChangePieces: (id: string, n: number) => void;
  onChangePrice: (id: string, value: number | null) => void;
  onChangeDiscount: (id: string, value: number | null) => void;
  onToggleTaxable: (id: string) => void;
  onChangeNote: (id: string, note: string) => void;
  onToggleNote: (id: string) => void;
  onRemove: (id: string) => void;
  onChangeUnlistedQty: (id: string, n: number) => void;
  onChangeUnlistedPrice: (id: string, value: number | null) => void;
  onToggleUnlistedTaxable: (id: string) => void;
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
                    taxRateFraction={taxRateFraction}
                    catalogPrice={tierPriceFor(product)}
                    onIncrement={() => onIncrement(id)}
                    onDecrement={() => onDecrement(id)}
                    onChangeQty={(n) => onChangeQty(id, n)}
                    onChangeBoxes={(n) => onChangeBoxes(id, n)}
                    onChangePieces={(n) => onChangePieces(id, n)}
                    onChangePrice={(v) => onChangePrice(id, v)}
                    onChangeDiscount={(v) => onChangeDiscount(id, v)}
                    onToggleTaxable={() => onToggleTaxable(id)}
                    onChangeNote={(t) => onChangeNote(id, t)}
                    onToggleNote={() => onToggleNote(id)}
                    onRemove={() => onRemove(id)}
                  />
                ))}
                {unlisted.map((u) => (
                  <UnlistedReviewRow
                    key={u.id}
                    line={u}
                    taxRateFraction={taxRateFraction}
                    onChangeQty={(n) => onChangeUnlistedQty(u.id, n)}
                    onChangePrice={(v) => onChangeUnlistedPrice(u.id, v)}
                    onToggleTaxable={() => onToggleUnlistedTaxable(u.id)}
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
            {/* Sticky, NOT in the ScrollView above: the sale disclosure has to
                be on screen at the moment the operator commits, and anything in
                the scrolling content sits below every line row. */}
            <SaleModeField details={details} />

            {/* Money breakdown — only the rows that apply, so the common
                no-tax/no-adjustment invoice keeps the old one-line footer. */}
            {totals.taxTotal > 0 || totals.discount > 0 || totals.shippingFee > 0 ? (
              <View style={styles.breakdown}>
                <View style={styles.breakdownRow}>
                  <Text style={styles.breakdownLabel}>Subtotal</Text>
                  <Text style={styles.breakdownValue}>${totals.subtotal.toFixed(2)}</Text>
                </View>
                {totals.taxTotal > 0 ? (
                  <View style={styles.breakdownRow}>
                    <Text style={styles.breakdownLabel}>Tax</Text>
                    <Text style={styles.breakdownValue}>${totals.taxTotal.toFixed(2)}</Text>
                  </View>
                ) : null}
                {totals.discount > 0 ? (
                  <View style={styles.breakdownRow}>
                    <Text style={styles.breakdownLabel}>Discount</Text>
                    <Text style={styles.breakdownValue}>−${totals.discount.toFixed(2)}</Text>
                  </View>
                ) : null}
                {totals.shippingFee > 0 ? (
                  <View style={styles.breakdownRow}>
                    <Text style={styles.breakdownLabel}>Shipping</Text>
                    <Text style={styles.breakdownValue}>+${totals.shippingFee.toFixed(2)}</Text>
                  </View>
                ) : null}
              </View>
            ) : null}
            <View style={styles.cartFooterRow}>
              <View>
                <Text style={styles.footerEyebrow}>INVOICE TOTAL</Text>
                <Text style={styles.footerTotal}>${totals.total.toFixed(2)}</Text>
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
                  <Text style={styles.confirmBtnText}>
                    {saving
                      ? "Saving…"
                      : saveActionLabel(details.saleEligible, details.deliveredNow)}
                  </Text>
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
  taxRateFraction,
  catalogPrice: catalogPriceProp,
  onIncrement,
  onDecrement,
  onChangeQty,
  onChangeBoxes,
  onChangePieces,
  onChangePrice,
  onChangeDiscount,
  onToggleTaxable,
  onChangeNote,
  onToggleNote,
  onRemove,
}: {
  product: Product;
  line: LineState;
  taxRateFraction: number;
  /** Customer-resolved (tier / customer-price) catalog price; list when absent. */
  catalogPrice?: number;
  onIncrement: () => void;
  onDecrement: () => void;
  onChangeQty: (n: number) => void;
  onChangeBoxes: (n: number) => void;
  onChangePieces: (n: number) => void;
  onChangePrice: (value: number | null) => void;
  onChangeDiscount: (value: number | null) => void;
  onToggleTaxable: () => void;
  onChangeNote: (note: string) => void;
  onToggleNote: () => void;
  onRemove: () => void;
}) {
  const upb = Number(product.unitsPerBox ?? 0);
  const isBoxed = upb > 1;
  const catalogPrice = catalogPriceProp ?? toNumber(product.pricePerUnit);
  const effUnit = effectiveUnitPrice(line, product, catalogPrice);
  const isOverridden = line.unitPrice != null && line.unitPrice !== catalogPrice;
  const qty = effectiveQty(line, product.unitsPerBox);
  // Post-discount, matching the server's stored line subtotal (tax rides in the
  // sheet footer, never on the row).
  const lineTotal = Math.max(
    0,
    computeLineSubtotal({
      unitPrice: effUnit,
      qty,
      boxes: line.boxes ?? null,
      pieces: line.pieces ?? null,
      unitsPerBox: product.unitsPerBox ?? null,
    }) - (line.discount ?? 0),
  );

  return (
    <View style={styles.cartRow}>
      <View style={styles.cartRowHeader}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.cartRowName} numberOfLines={2}>
            {displayName(product)}
          </Text>
          <Text style={styles.cartRowMeta} numberOfLines={1}>
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
            <Text style={styles.cartPriceWas} numberOfLines={1}>
              ${catalogPrice.toFixed(2)}
            </Text>
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

      {/* Line discount — flat $ off, comes off BEFORE tax (server rule). */}
      <View style={styles.cartPriceRow}>
        <Text style={styles.cartPriceLabel}>Discount</Text>
        <View style={styles.cartPriceInputWrap}>
          <Text style={styles.cartPriceCurrency}>−$</Text>
          <MoneyTextInput
            style={[styles.cartPriceInput, (line.discount ?? 0) > 0 && styles.cartPriceInputActive]}
            value={line.discount ?? null}
            onChangeValue={onChangeDiscount}
            placeholder="0.00"
            returnKeyType="done"
          />
        </View>
      </View>

      {/* Taxable — hidden when there's no tenant rate or the customer is exempt. */}
      {taxRateFraction > 0 ? (
        <TaxableRow
          taxable={!!line.taxable}
          rateFraction={taxRateFraction}
          onToggle={onToggleTaxable}
        />
      ) : null}

      {/* Per-line note — prints under the description on the invoice PDF. */}
      {line.noteOpen || line.note?.trim() ? (
        <TextInput
          value={line.note ?? ""}
          onChangeText={onChangeNote}
          placeholder="Note for this item (prints on invoice)"
          placeholderTextColor={ios.label3}
          maxLength={500}
          returnKeyType="done"
          style={styles.cartNoteInput}
        />
      ) : (
        <Pressable onPress={onToggleNote} hitSlop={6} style={styles.cartNoteAdd}>
          <Ionicons name="create-outline" size={14} color={ios.brand} />
          <Text style={styles.cartNoteAddText}>Add note</Text>
        </Pressable>
      )}

      <View style={styles.cartRowFooter}>
        <Text style={styles.cartRowFooterLabel}>Line total</Text>
        <Text style={styles.cartRowFooterValue}>${lineTotal.toFixed(2)}</Text>
      </View>
    </View>
  );
}

/** "Taxable (8.25%)" checkbox row shared by catalog + unlisted review rows. */
function TaxableRow({
  taxable,
  rateFraction,
  onToggle,
}: {
  taxable: boolean;
  rateFraction: number;
  onToggle: () => void;
}) {
  return (
    <Pressable style={styles.sendRow} onPress={onToggle} hitSlop={4} accessibilityRole="checkbox">
      <View style={[styles.checkbox, taxable && styles.checkboxOn]}>
        {taxable ? <Text style={styles.checkboxTick}>✓</Text> : null}
      </View>
      <Text style={styles.sendLabel}>
        Taxable ({(rateFraction * 100).toFixed(2).replace(/\.?0+$/, "")}%)
      </Text>
    </Pressable>
  );
}

/** Review row for an ad-hoc (unlisted) line: editable price + qty, "Custom" tag.
 *  Taxable is the only money exception here — the price is already free-entry,
 *  so a separate discount field would just be a second way to type the price. */
function UnlistedReviewRow({
  line,
  taxRateFraction,
  onChangeQty,
  onChangePrice,
  onToggleTaxable,
  onRemove,
}: {
  line: UnlistedLine;
  taxRateFraction: number;
  onChangeQty: (n: number) => void;
  onChangePrice: (value: number | null) => void;
  onToggleTaxable: () => void;
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

      {taxRateFraction > 0 ? (
        <TaxableRow
          taxable={!!line.taxable}
          rateFraction={taxRateFraction}
          onToggle={onToggleTaxable}
        />
      ) : null}

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
        <Text style={styles.stepperLabel} numberOfLines={1}>
          {label}
        </Text>
        {hint ? (
          <Text style={styles.stepperHint} numberOfLines={1}>
            {hint}
          </Text>
        ) : null}
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

/**
 * What the button about to be tapped will actually do. A van sale creates an
 * order, deducts stock and (delivered-today) issues AND sends the invoice, so
 * the label may never keep saying "Create invoice" on that path.
 */
function saveActionLabel(saleEligible: boolean, deliveredNow: boolean): string {
  if (!saleEligible) return "Create invoice";
  return deliveredNow ? "Record sale" : "Create order";
}

/**
 * Van-sale mode (WP4/PR-4): collapses create→confirm→deliver→invoice→send into
 * ONE POST /orders/sell call when saleModeGate says the previewed total can't
 * silently change at save. Locked (both items disabled) when the CART can't
 * collapse at all; the reason is always shown.
 *
 * This lives in the review sheet's STICKY footer, next to the Create button —
 * never inside the scrolling content, which sits below every line row and so
 * could let an operator record a sale without the disclosure ever rendering.
 */
function SaleModeField({ details: d }: { details: InvoiceDetails }) {
  const disclosure = !d.saleEligible
    ? `Saving as a regular invoice (no delivery tracking) — ${d.saleReasons.join(", ")}. Your total stays $${d.total.toFixed(2)} exactly as shown.`
    : d.deliveredNow
      ? "Records the sale now: the order is marked delivered, stock is deducted, and the invoice is issued and sent. Available customer credit is applied automatically."
      : "Creates a pending order with a draft invoice. Stock is deducted now; the invoice unlocks for sending once the order is delivered.";

  return (
    <View style={styles.saleModeField}>
      <Text style={styles.detailLabel}>Delivered today?</Text>
      <SegmentedControl
        items={["Yes", "No"]}
        value={d.deliveredNow ? "Yes" : "No"}
        onChange={(v) => d.onChangeDeliveredNow(v === "Yes")}
        disabledItems={d.saleControlEnabled ? [] : ["Yes", "No"]}
      />
      <Text style={styles.detailHelp}>{disclosure}</Text>
    </View>
  );
}

/** Terms, dates and delivery — everything that isn't a line, in one card. */
function InvoiceDetailsCard({ details: d }: { details: InvoiceDetails }) {
  // Sending is implied (not optional) only once the sale path is actually
  // going to run — eligible AND the operator asked for delivered-today. An
  // ineligible cart, or a NO (deliver-later) sale, still needs an explicit
  // Send choice.
  const showSendToggle = !(d.saleEligible && d.deliveredNow);

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

      <View style={styles.detailField}>
        <Text style={styles.detailLabel}>Reference number</Text>
        <TextInput
          value={d.referenceNumber}
          onChangeText={d.onChangeReferenceNumber}
          placeholder="PO / reference (optional)"
          placeholderTextColor={ios.label3}
          style={styles.detailInput}
        />
      </View>

      <View style={styles.detailField}>
        <Text style={styles.detailLabel}>Subject</Text>
        <TextInput
          value={d.subject}
          onChangeText={d.onChangeSubject}
          placeholder="Shown on the invoice header (optional)"
          placeholderTextColor={ios.label3}
          style={styles.detailInput}
        />
      </View>

      {/* Whole-invoice adjustments. Discount comes off AFTER tax; shipping is
          never taxed — the review footer shows both applied. */}
      <View style={styles.detailMoneyRow}>
        <View style={styles.detailMoneyCol}>
          <Text style={styles.detailLabel}>Invoice discount ($)</Text>
          <MoneyTextInput
            value={d.invoiceDiscount}
            onChangeValue={d.onChangeInvoiceDiscount}
            placeholder="0.00"
            placeholderTextColor={ios.label3}
            style={styles.detailInput}
            returnKeyType="done"
          />
        </View>
        <View style={styles.detailMoneyCol}>
          <Text style={styles.detailLabel}>Shipping fee ($)</Text>
          <MoneyTextInput
            value={d.shippingFee}
            onChangeValue={d.onChangeShippingFee}
            placeholder="0.00"
            placeholderTextColor={ios.label3}
            style={styles.detailInput}
            returnKeyType="done"
          />
        </View>
      </View>

      {showSendToggle ? (
        <Pressable style={styles.sendRow} onPress={d.onToggleSend}>
          <View style={[styles.checkbox, d.send && styles.checkboxOn]}>
            {d.send ? <Text style={styles.checkboxTick}>✓</Text> : null}
          </View>
          <Text style={styles.sendLabel}>Send immediately on create</Text>
        </Pressable>
      ) : null}
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

  browseBar: { flexDirection: "row", alignItems: "center", gap: 4, paddingRight: 12 },
  browseClose: { padding: 6 },
  catalogList: { flex: 1 },
  listContent: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 16, flexGrow: 1 },
  pageSpinner: { paddingVertical: 16, alignItems: "center" },
  searchTrailing: { flexDirection: "row", alignItems: "center", gap: 10 },
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
  footerSummaryBtn: {
    backgroundColor: ios.brandWash,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
    flexShrink: 1,
    minWidth: 0,
  },
  footerSummaryBtnDisabled: { backgroundColor: "transparent", paddingHorizontal: 0 },
  footerSummaryEyebrowRow: { flexDirection: "row", alignItems: "center", gap: 4 },
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
  cartPriceInputWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
    minWidth: 0,
  },
  cartPriceCurrency: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },
  cartPriceInput: {
    minWidth: 70,
    // Caps the react-native-web intrinsic width; never binds on native.
    maxWidth: MONEY_INPUT_MAX_WIDTH,
    flexShrink: 0,
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
  // Per-line note affordance — same recipe as NewOrderScreen's cart rows.
  cartNoteAdd: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
  },
  cartNoteAddText: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.brand },
  cartNoteInput: {
    backgroundColor: ios.fill3,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label,
  },
  // Review-footer money breakdown (only rendered when tax/discount/shipping apply).
  breakdown: {
    gap: 3,
    paddingBottom: 8,
    marginBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  breakdownRow: { flexDirection: "row", justifyContent: "space-between" },
  breakdownLabel: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  breakdownValue: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
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
  // Same field styling, but it sits in the sheet's sticky footer above the
  // money breakdown — hence its own rule off.
  saleModeField: {
    gap: 6,
    paddingBottom: 10,
    marginBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
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
  detailMoneyRow: { flexDirection: "row", gap: 10 },
  // flex-basis split, not flex:1 — RNW TextInputs carry an intrinsic width that
  // otherwise pushes the second column off a 320px sheet (see lib/row-layout.ts).
  detailMoneyCol: { flexBasis: 0, flexGrow: 1, minWidth: 0, gap: 6 },
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
