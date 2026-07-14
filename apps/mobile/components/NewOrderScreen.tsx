import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
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
import { NavAction, NavBackButton, NavBar, SearchBar } from "@routeflow/ui/mobile/ios";
import { useAdminCustomers } from "../lib/api/admin";
import { useProducts } from "../lib/api/products";
import { useCustomer, useCustomerPrices } from "../lib/api/customers";
import {
  useCreateOrderAsDriver,
  useActiveOrderForCustomer,
  useCustomerPriceHistory,
  type CreateOrderItemInput,
  type CustomerPriceHistory,
} from "../lib/api/orders";
import { showToast } from "../lib/toast";
import { resolveProductByCode } from "../lib/barcode-resolve";
// Compose "<Parent> - <Variant>" so scanned variants don't show as "Strawberry" alone.
import { displayProductName as displayName } from "../lib/product-display";
import {
  classifyMargin,
  computeLineSubtotal,
  computeMarginFraction,
  costPerSellingUnit,
  effectiveQty,
  getTierPrice,
  roundMoney,
} from "../lib/pricing";
import { useMarginConfig, floorForCategory } from "../lib/api/margin";
import { useTrackedCategories } from "../lib/api/tracked-categories";
import {
  groupLinesForInvoiceSplit,
  type InvoiceSplitCategory,
  type InvoiceSplitLineInput,
  type InvoiceSplitPreview,
} from "../lib/invoice-split";
import { MoneyTextInput } from "./MoneyTextInput";
import { InlineCreateProductSheet } from "./InlineCreateProductSheet";
import type { CreatedProduct } from "../lib/api/products";
import { sanitizeIntInput } from "../lib/qty";
import { useAuthStore } from "../lib/auth-store";
// chooseAction + alertInfo render the same dialogs cross-platform — RN's
// Alert.alert silently no-ops 3-button alerts on Expo Web (the user's
// "Confirm button frozen" report), so use these everywhere instead.
import { alertInfo, chooseAction } from "../lib/confirm";
import { BarcodeScanner } from "./BarcodeScanner";
import { BarcodeFab } from "./BarcodeFab";
import { LicenseGuardModal } from "./LicenseGuardModal";
import { parseRegulatedAuthError, type BlockedCategory } from "../lib/api/authorizations";
import { ScanOutcome } from "../lib/scan-loop";
import { withCartRows } from "../lib/visible-cart";
import { orderSubmitGate } from "../lib/order-draft-logic";

export interface NewOrderScreenProps {
  /** When present, customer is locked (e.g. invoked from a specific stop). */
  customerId?: string;
  customerName?: string;
  /** When present, the order is linked to this run/stop on the backend. */
  runId?: string;
  stopId?: string;
  /** Label shown on the back button. */
  backLabel?: string;
  /**
   * Where to land after a successful save. The default `router.back()`
   * leaves the operator on whatever they came from (e.g. /home), but the
   * user wanted "after creating an order it should go back to all orders
   * and give the option to navigate as you need" — operator routes pass
   * a custom callback that lands on /orders explicitly. Driver flows keep
   * the default so they return to the stop.
   */
  onSaved?: (orderNumber: string) => void;
  /**
   * What to do when the back button is tapped. The default tries
   * `router.back()` and falls back to `router.replace("/home")` if the
   * back stack is empty (which is the case when the user opened this
   * URL directly — `router.back()` was a silent no-op then, the user's
   * "back is not working" report).
   */
  onBack?: () => void;
}

type Product = {
  id: string;
  name: string;
  sku?: string | null;
  barcode?: string | null;
  unit?: string;
  pricePerUnit: number | string;
  // Tier price columns (Decimal, serialised as strings; 0 ⇒ inherit list). The
  // /products payload already carries these — getTierPrice coerces + guards.
  priceTier2?: number | string | null;
  priceTier3?: number | string | null;
  priceTier4?: number | string | null;
  priceTier5?: number | string | null;
  category?: string | null;
  /** Regulated category this product belongs to (drives the license-guard remove-line exit). */
  trackedCategoryId?: string | null;
  /** Per-piece average cost — drives the live margin hint + the cost eye (web uses
   *  averageCost, not standardCost). Operator/driver endpoints return it; buyers
   *  never get this screen and their endpoints strip cost fields. */
  averageCost?: number | string | null;
  standardCost?: number | string | null;
  unitsPerBox?: number | null;
  parentProductId?: string | null;
  parent?: { id: string; name: string } | null;
};

/**
 * Per-line cart state. `qty` is total pieces and stays the source of truth for
 * non-boxed products. When `boxes`/`pieces` are set, the server recomputes qty
 * from them on submit (see apps/api/src/orders/orders.service.ts:594) and the
 * line subtotal uses the BOX price × box-equivalent formula.
 */
type LineState = {
  qty: number;
  boxes?: number;
  pieces?: number;
  /**
   * Optional one-time price override (the "discounted price"). When unset the
   * catalog price is used. For boxed products this is the BOX price, matching
   * the catalog price unit; computeLineSubtotal prorates loose pieces.
   */
  unitPrice?: number;
  /** Optional per-line note — carried onto the invoice line (buyer-visible). */
  note?: string;
  /** Note input expanded for this row (note text survives collapse). */
  noteOpen?: boolean;
};

/**
 * An ad-hoc, non-catalog ("unlisted") line. Has a free-text name + a required
 * per-piece price; never boxed. Serialised as `{ name, qty, unitPrice }` on
 * submit (no productId). Keyed locally by a synthetic id.
 */
type UnlistedLine = {
  id: string;
  name: string;
  unitPrice: number;
  qty: number;
  /** Optional per-line note — carried onto the invoice line (buyer-visible). */
  note?: string;
  noteOpen?: boolean;
};

function newLocalId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toNumber(v: number | string | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** The effective per-unit price for a line: the override, else the resolved base
 *  (tier) price. Callers pass the customer's effective tier price as `basePrice`. */
function effectiveUnitPrice(line: LineState | undefined, basePrice: number): number {
  return line?.unitPrice != null ? line.unitPrice : basePrice;
}

export function NewOrderScreen({
  customerId: initialCustomerId,
  customerName: initialCustomerName,
  runId,
  stopId,
  backLabel,
  onSaved,
  onBack,
}: NewOrderScreenProps) {
  const router = useRouter();
  const [pickedCustomerId, setPickedCustomerId] = useState<string | null>(
    initialCustomerId ?? null,
  );
  const [pickedCustomerName, setPickedCustomerName] = useState<string | null>(
    initialCustomerName ?? null,
  );
  const customerLocked = !!initialCustomerId;

  // If a customer isn't selected yet, the picker takes over — product list hidden.
  const needsCustomer = !pickedCustomerId;

  /**
   * Cross-platform-safe back handler. `router.back()` is a no-op on web when
   * the user opened this URL directly (empty history stack) — the cause of
   * the "back is not working" report. Fall back to a sensible default if the
   * caller didn't supply one.
   */
  const handleBack = () => {
    if (onBack) {
      onBack();
      return;
    }
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/(operator)/(tabs)/home" as any);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      {needsCustomer ? (
        <CustomerPickerView
          backLabel={backLabel}
          onBack={handleBack}
          onPick={(id, name) => {
            setPickedCustomerId(id);
            setPickedCustomerName(name);
          }}
        />
      ) : (
        <ProductPickView
          customerId={pickedCustomerId!}
          customerName={pickedCustomerName}
          customerLocked={customerLocked}
          runId={runId}
          stopId={stopId}
          backLabel={backLabel}
          onBack={handleBack}
          onChangeCustomer={() => {
            setPickedCustomerId(null);
            setPickedCustomerName(null);
          }}
          onSaved={(orderNumber: string) => {
            showToast(`Order ${orderNumber} saved`);
            if (onSaved) onSaved(orderNumber);
            else if (router.canGoBack()) router.back();
            else router.replace("/(operator)/(tabs)/orders" as any);
          }}
        />
      )}
    </SafeAreaView>
  );
}

// ─────────────────────── Customer picker ───────────────────────

function CustomerPickerView({
  backLabel,
  onBack,
  onPick,
}: {
  backLabel?: string;
  onBack: () => void;
  onPick: (id: string, name: string) => void;
}) {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useAdminCustomers({
    search: search.trim() || undefined,
    limit: 50,
  });
  const customers = data?.data ?? [];

  return (
    <>
      <NavBar
        inlineTitle="Choose customer"
        leading={<NavBackButton label={backLabel ?? "Back"} onPress={onBack} />}
      />
      <SearchBar placeholder="Search customers…" value={search} onChangeText={setSearch} />
      <ScrollView showsVerticalScrollIndicator={false}>
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : customers.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyText}>
              {search ? "No customers match that search." : "No customers yet."}
            </Text>
          </View>
        ) : (
          <View style={styles.list}>
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
                  {c.contactName || c.phone ? (
                    <Text style={styles.customerSub} numberOfLines={1}>
                      {[c.contactName, c.phone].filter(Boolean).join(" · ")}
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

// ─────────────────────── Product pick + save ───────────────────────

function ProductPickView({
  customerId,
  customerName,
  customerLocked,
  runId,
  stopId,
  backLabel,
  onBack,
  onChangeCustomer,
  onSaved,
}: {
  customerId: string;
  customerName: string | null;
  customerLocked: boolean;
  runId?: string;
  stopId?: string;
  backLabel?: string;
  onBack: () => void;
  onChangeCustomer: () => void;
  onSaved: (orderNumber: string) => void;
}) {
  const router = useRouter();
  const userRole = useAuthStore((s) => s.user?.role);
  const canCreateProducts = userRole === "OPERATOR" || userRole === "TENANT_ADMIN";
  // Cost eye: every SELLER role (drivers negotiate at the stop; the operator
  // endpoints already return cost to them). Buyers never reach this screen.
  const canSeeCost =
    userRole === "OPERATOR" || userRole === "TENANT_ADMIN" || userRole === "DRIVER";

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [items, setItems] = useState<Record<string, LineState>>({});
  // Ad-hoc lines not in the product catalog (productId null on submit).
  const [unlisted, setUnlisted] = useState<UnlistedLine[]>([]);
  const [unlistedModalOpen, setUnlistedModalOpen] = useState(false);
  // Fetched once when customer is confirmed — price pre-fill is instant during scanning.
  const { data: priceHistory } = useCustomerPriceHistory(customerId);
  // Customer tier pricing (mirrors web CreateOrderModal): the effective tier is
  // the per-product CustomerPrice override, else the customer's default tier.
  // Prices shown/summed/submitted use getTierPrice(product, effectiveTier), not
  // the raw list price — so a tier-N customer sees the price the server bills.
  const { data: customerDetail } = useCustomer(customerId);
  const { data: customerPrices } = useCustomerPrices(customerId);
  // Tenant margin config for the live cost/margin hint in the cart rows.
  const { data: marginConfig } = useMarginConfig();
  // REG-4: category lookup for the invoice-split preview. Reuses the shipped
  // P10-REG-A hook — no new API surface. Called unconditionally, matching the
  // rest of this screen's hooks (tenants with no regulated categories just get []).
  const { data: splitTrackedCategories } = useTrackedCategories({ active: true });
  const splitCategoryById = useMemo(() => {
    const m = new Map<string, InvoiceSplitCategory>();
    for (const c of splitTrackedCategories ?? [])
      m.set(c.id, { id: c.id, name: c.name, invoiceTreatment: c.invoiceTreatment });
    return m;
  }, [splitTrackedCategories]);
  const customerTier = customerDetail?.pricingTier ?? 1;
  const cpMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const cp of customerPrices ?? []) m.set(cp.productId, cp.pricingTier);
    return m;
  }, [customerPrices]);
  const effectiveTierFor = (id: string) => cpMap.get(id) ?? customerTier ?? 1;
  /** The customer's effective per-selling-unit (box) price for a product. */
  const tierPriceFor = (p: Product) => getTierPrice(p, effectiveTierFor(p.id));
  const [scanOpen, setScanOpen] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  // Regulated-license guard: the blocked categories from a 409, and which
  // submitOrder(mergeChoice) to replay once the license/override is captured.
  const [licenseBlock, setLicenseBlock] = useState<BlockedCategory[] | null>(null);
  const licenseRetryRef = useRef<"merge" | "separate" | undefined>(undefined);
  // Order-level options (mirror web CreateOrderModal): notes, urgent flag,
  // requested delivery date (YYYY-MM-DD), and an order-level discount.
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [orderNotes, setOrderNotes] = useState("");
  const [orderUrgent, setOrderUrgent] = useState(false);
  const [deliveryDate, setDeliveryDate] = useState("");
  const [discountRaw, setDiscountRaw] = useState("");
  // Scroll the just-scanned product row into view. We track the product list's
  // top offset within the ScrollView plus each row's offset within the list.
  const scrollRef = useRef<ScrollView>(null);
  const listTopRef = useRef(0);
  const rowYRef = useRef<Map<string, number>>(new Map());
  const [scrollToId, setScrollToId] = useState<string | null>(null);
  // Scanned/typed code with no product match → prefills the inline create sheet.
  const [createCode, setCreateCode] = useState<string | null>(null);
  // The pending scroll target survives across renders so a freshly-pinned row
  // (a just-scanned out-of-catalog item, mounted this commit) can complete the
  // scroll from its own onLayout — which fires AFTER this effect. Without it,
  // rowYRef has no entry yet at effect time and the scroll silently no-ops.
  const scrollToIdRef = useRef<string | null>(null);
  const scrollToRow = (id: string) => {
    const y = rowYRef.current.get(id);
    if (y == null) return false;
    scrollRef.current?.scrollTo({ y: Math.max(0, listTopRef.current + y - 12), animated: true });
    return true;
  };
  useEffect(() => {
    if (!scrollToId) return;
    scrollToIdRef.current = scrollToId;
    if (scrollToRow(scrollToId)) {
      scrollToIdRef.current = null;
      setScrollToId(null);
    }
    // else: leave it pending for the row's onLayout to finish once measured.
  }, [scrollToId, items]);
  /**
   * Products discovered via barcode scan that aren't in the locally-cached
   * product list (e.g. beyond the 200-item page, or filtered out by the
   * current search). Without this, scanned items wouldn't contribute to the
   * running total or appear in the cart review (see user feedback: "the
   * actual cost of the order is not updating … while scanning items").
   */
  const [scannedById, setScannedById] = useState<Record<string, Product>>({});

  // limit: 0 → API treats as "all" (capped server-side at 100k). The previous
  // 200 cap chopped catalogues with > 200 products in half — the user's
  // "suggestions stop halfway" report. Server-side `search` already trims the
  // payload by the typed query, so the only inflated path is the empty-search
  // browse list, which is acceptable on mobile (single-tenant catalogues are
  // typically a few hundred SKUs at most).
  const { data: productsData, isLoading: productsLoading } = useProducts({
    search: search.trim() || undefined,
    limit: 0,
  });
  const products: Product[] = productsData?.data ?? [];

  // Unified product lookup: local list ∪ scanned-only items.
  const productById = useMemo(() => {
    const m = new Map<string, Product>();
    for (const p of products) m.set(p.id, p);
    for (const id of Object.keys(scannedById)) {
      if (!m.has(id)) m.set(id, scannedById[id]);
    }
    return m;
  }, [products, scannedById]);

  /**
   * Add 1 box (boxed product) or 1 piece (non-boxed) to the cart line for
   * `id`. If the product isn't yet known to the screen, the caller passes
   * the resolved Product so we can stash it for the totals/cart UI.
   */
  const addOne = (id: string, productSnapshot?: Product) => {
    const p = productSnapshot ?? productById.get(id);
    const upb = Number(p?.unitsPerBox ?? 0);
    const isBoxed = upb > 1;
    // Conditional remembered-price pre-fill (mirrors web CreateOrderModal): only
    // a genuine one-time DISCOUNT (below the tier price) or UPSELL (above list)
    // pre-fills — never over a SPECIAL tier price, which is already the customer's
    // permanent price. Equal-to-tier remembered prices don't pre-fill (strict <>).
    const histEntry = priceHistory?.[id];
    const listPrice = p ? toNumber(p.pricePerUnit) : 0;
    const tierPrice = p ? tierPriceFor(p) : 0;
    const isSpecial = effectiveTierFor(id) !== 1;
    const prefill =
      !isSpecial &&
      histEntry != null &&
      (histEntry.lastPrice < tierPrice || histEntry.lastPrice > listPrice)
        ? histEntry.lastPrice
        : undefined;
    setItems((m) => {
      const isNew = !m[id];
      const prev = m[id] ?? { qty: 0 };
      if (isBoxed) {
        const boxes = (prev.boxes ?? 0) + 1;
        const pieces = prev.pieces ?? 0;
        const line: LineState = { qty: boxes * upb + pieces, boxes, pieces };
        if (isNew && prefill != null) line.unitPrice = prefill;
        return { ...m, [id]: line };
      }
      const line: LineState = { qty: (prev.qty ?? 0) + 1 };
      if (isNew && prefill != null) line.unitPrice = prefill;
      return { ...m, [id]: line };
    });
    // Always retain a scanned product's snapshot — even one currently in the
    // local list. The empty-search products query can be GC'd (~5min) while a
    // non-empty search is held, so the setSearch("") after a local scan may hit
    // a cold refetch where `products` is briefly []; the snapshot keeps this row
    // resolvable for the totals and list. productById prefers the live entry, so
    // the snapshot only ever acts as a fallback.
    if (productSnapshot) {
      setScannedById((m) => (id in m ? m : { ...m, [id]: productSnapshot }));
    }
  };

  const removeOne = (id: string) => {
    const p = productById.get(id);
    const upb = Number(p?.unitsPerBox ?? 0);
    const isBoxed = upb > 1;
    setItems((m) => {
      const prev = m[id];
      if (!prev) return m;
      if (isBoxed) {
        const boxes = Math.max(0, (prev.boxes ?? 0) - 1);
        const pieces = prev.pieces ?? 0;
        if (boxes === 0 && pieces === 0) {
          const next = { ...m };
          delete next[id];
          return next;
        }
        return { ...m, [id]: { qty: boxes * upb + pieces, boxes, pieces } };
      }
      const qty = Math.max(0, (prev.qty ?? 0) - 1);
      if (qty === 0) {
        const next = { ...m };
        delete next[id];
        return next;
      }
      return { ...m, [id]: { qty } };
    });
  };

  const setBoxes = (id: string, boxes: number) =>
    setItems((m) => {
      const p = productById.get(id);
      const upb = Number(p?.unitsPerBox ?? 0);
      const prev = m[id] ?? { qty: 0 };
      const b = Math.max(0, Math.floor(boxes));
      const pieces = prev.pieces ?? 0;
      const qty = b * upb + pieces;
      if (qty === 0) {
        const next = { ...m };
        delete next[id];
        return next;
      }
      return { ...m, [id]: { qty, boxes: b, pieces } };
    });

  const setPieces = (id: string, pieces: number) =>
    setItems((m) => {
      const p = productById.get(id);
      const upb = Number(p?.unitsPerBox ?? 0);
      const prev = m[id] ?? { qty: 0 };
      const pcs = Math.max(0, Math.floor(pieces));
      const boxes = prev.boxes ?? 0;
      const qty = boxes * upb + pcs;
      if (qty === 0) {
        const next = { ...m };
        delete next[id];
        return next;
      }
      return { ...m, [id]: { qty, boxes, pieces: pcs } };
    });

  const setQty = (id: string, qty: number) =>
    setItems((m) => {
      const q = Math.max(0, Math.floor(qty));
      if (q === 0) {
        const next = { ...m };
        delete next[id];
        return next;
      }
      // Plain qty path — clear boxes/pieces so server doesn't try to recompute
      return { ...m, [id]: { qty: q } };
    });

  const removeLine = (id: string) =>
    setItems((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });

  const setLineNote = (id: string, note: string) =>
    setItems((m) => (m[id] ? { ...m, [id]: { ...m[id], note } } : m));
  const toggleLineNote = (id: string) =>
    setItems((m) => (m[id] ? { ...m, [id]: { ...m[id], noteOpen: !m[id].noteOpen } } : m));

  // Set (or clear) a one-time price override for a line. Empty/invalid clears it
  // so the line falls back to the catalog price.
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
  const updateUnlistedNote = (id: string, note: string) =>
    setUnlisted((u) => u.map((x) => (x.id === id ? { ...x, note } : x)));
  const toggleUnlistedNote = (id: string) =>
    setUnlisted((u) => u.map((x) => (x.id === id ? { ...x, noteOpen: !x.noteOpen } : x)));
  const removeUnlisted = (id: string) => setUnlisted((u) => u.filter((x) => x.id !== id));

  // Continuous-scan handler: the scanner overlay stays open between items and
  // renders the returned feedback ("Added … — scan next"); only the
  // create-product hand-off (and the Done button) closes it.
  const handleBarcodeScanned = async (code: string): Promise<ScanOutcome> => {
    const trimmed = code.trim();
    if (!trimmed) return;

    // 1) Local fast-path: match against barcode, sku OR id of cached items.
    //    The previous version only checked sku, missing items where the
    //    operator scans a barcode label or a different identifier.
    const lower = trimmed.toLowerCase();
    const local = products.find(
      (p) =>
        (p.barcode ?? "").toLowerCase() === lower ||
        (p.sku ?? "").toLowerCase() === lower ||
        (p.id ?? "").toLowerCase() === lower,
    );
    if (local) {
      addOne(local.id, local);
      setSearch(""); // an active search would hide the added row (web clears too)
      setScrollToId(local.id);
      return { feedback: { kind: "added", text: `Added ${displayName(local)}` } };
    }

    // 2) Server fallback: barcode → exact SKU → name/SKU substring → notFound.
    try {
      const result = await resolveProductByCode<Product>(trimmed);
      if (!result.notFound && result.product?.id) {
        addOne(result.product.id, result.product);
        setSearch("");
        setScrollToId(result.product.id);
        return { feedback: { kind: "added", text: `Added ${displayName(result.product)}` } };
      }
    } catch (err: any) {
      // Network / 5xx — surface so the operator can retry instead of silently
      // showing "no product found" (which implies the item doesn't exist).
      const msg = err?.response?.data?.message ?? err?.message ?? "Couldn't look up barcode.";
      return { feedback: { kind: "error", text: msg } };
    }

    // 3) Nothing matched. Mirror web's behaviour: offer to create the product
    //    inline (as a new product OR a variant of an existing one) WITHOUT
    //    leaving the screen, so the in-progress order is preserved.
    if (canCreateProducts) {
      chooseAction(
        `No product for "${trimmed}"`,
        "Add it as a new product or a variant of an existing one? Your order stays as it is.",
        [
          { label: "Cancel", style: "cancel" },
          { label: "Create", onPress: () => setCreateCode(trimmed) },
        ],
      );
      return { close: true };
    }
    return { feedback: { kind: "error", text: `No product for "${trimmed}"` } };
  };

  // Non-null while the inline create sheet is open; holds the scanned/typed code
  // to prefill. On success the new product is dropped straight into the cart.
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
    setScrollToId(product.id);
    setCreateCode(null);
    showToast(`Added ${displayName(snapshot, products)}`);
  };

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) if (p.category) set.add(p.category);
    return ["All", ...Array.from(set).slice(0, 6)];
  }, [products]);

  const filtered = useMemo(() => {
    const base = category === "All" ? products : products.filter((p) => p.category === category);
    // While browsing (no active search), pin cart lines the filter would hide
    // — scanned items outside the category/page must keep a visible row.
    if (search.trim()) return base;
    return withCartRows(base, Object.keys(items), (id) => productById.get(id));
  }, [products, category, search, items, productById]);

  // Total + count, computed from items + the unified product map so scanned
  // items that aren't in the local list still contribute. Subtotal uses the
  // shared box/piece-aware formula so the footer agrees with what the server
  // will compute on submit.
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
        unitPrice: effectiveUnitPrice(line, tierPriceFor(p)),
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, productById, unlisted, cpMap, customerTier]);

  // REG-4: live, DISPLAY-ONLY preview of how this cart will split into invoices.
  // Same iteration/inputs as the total memo above (by design — it can never
  // disagree with what's on screen). NEVER used for money: computeLineSubtotal
  // inside groupLinesForInvoiceSplit produces the same pre-tax per-line amounts
  // the total memo already sums; this just also buckets them by category. The
  // server (createSplitInvoices) is the sole source of truth for the real split.
  const invoiceSplit: InvoiceSplitPreview = useMemo(() => {
    const splitLines: InvoiceSplitLineInput[] = [];
    for (const [id, line] of Object.entries(items)) {
      const p = productById.get(id);
      if (!p) continue;
      const qty = effectiveQty(line, p.unitsPerBox);
      if (qty <= 0) continue;
      splitLines.push({
        trackedCategoryId: p.trackedCategoryId ?? null,
        unitPrice: effectiveUnitPrice(line, tierPriceFor(p)),
        qty,
        boxes: line.boxes ?? null,
        pieces: line.pieces ?? null,
        unitsPerBox: p.unitsPerBox ?? null,
      });
    }
    for (const u of unlisted) {
      if (u.qty <= 0) continue;
      splitLines.push({ trackedCategoryId: null, unitPrice: u.unitPrice, qty: u.qty });
    }
    return groupLinesForInvoiceSplit(splitLines, splitCategoryById);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, productById, unlisted, splitCategoryById, cpMap, customerTier]);

  const inc = (id: string) => addOne(id);
  const dec = (id: string) => removeOne(id);

  const createOrder = useCreateOrderAsDriver();
  // Pre-check the customer's open draft/pending order so we can ask before submitting.
  const { data: activeOrder } = useActiveOrderForCustomer(customerId);

  const canSave = totalItems > 0 && !createOrder.isPending;
  // "Save as draft" needs only a customer (a zero-item DRAFT is allowed server-side).
  const canSaveDraft = !!customerId && !createOrder.isPending;

  /** Submit with a specific (or no) merge choice; `asDraft` parks it as a DRAFT. */
  const submitOrder = (mergeChoice?: "merge" | "separate", asDraft = false) => {
    const catalogPayload: CreateOrderItemInput[] = Object.entries(items)
      .map(([productId, line]): CreateOrderItemInput => {
        const p = productById.get(productId);
        const qty = effectiveQty(line, p?.unitsPerBox);
        // Send a unitPrice override only when the operator set a price that
        // differs from the customer's TIER price — a one-time discount (below)
        // or upsell (above). A line sitting at the tier price sends nothing so
        // the server applies the SPECIAL/tier price authoritatively.
        const catalog = p ? tierPriceFor(p) : 0;
        const override =
          line.unitPrice != null && line.unitPrice !== catalog ? { unitPrice: line.unitPrice } : {};
        const note = line.note?.trim() ? { notes: line.note.trim() } : {};
        const base = { productId, qty, ...override, ...note };
        // Include boxes/pieces when set so the server uses the BOX-price math
        // for proration and stores the split alongside the order line.
        if (line.boxes != null || line.pieces != null) {
          return {
            ...base,
            boxes: line.boxes ?? 0,
            pieces: line.pieces ?? 0,
          };
        }
        return base;
      })
      .filter((it) => "productId" in it && it.qty > 0);
    // Unlisted lines → `{ name, qty, unitPrice }` (no productId; never boxed).
    const unlistedPayload: CreateOrderItemInput[] = unlisted
      .filter((u) => u.qty > 0 && u.name.trim() !== "" && u.unitPrice > 0)
      .map((u) => ({
        name: u.name.trim(),
        qty: u.qty,
        unitPrice: u.unitPrice,
        ...(u.note?.trim() ? { notes: u.note.trim() } : {}),
      }));
    const itemPayload = [...catalogPayload, ...unlistedPayload];

    const discountAmount = Math.max(0, parseFloat(discountRaw) || 0);
    const deliveryTrim = deliveryDate.trim();
    createOrder.mutate(
      {
        customerId,
        items: itemPayload,
        routeRunId: runId,
        routeRunStopId: stopId,
        ...(asDraft ? { status: "DRAFT" as const } : {}),
        ...(orderNotes.trim() ? { notes: orderNotes.trim() } : {}),
        ...(orderUrgent ? { urgent: true } : {}),
        ...(deliveryTrim ? { requestedDeliveryDate: deliveryTrim } : {}),
        ...(discountAmount > 0 ? { discountAmount } : {}),
        ...(mergeChoice ? { mergeChoice } : {}),
      },
      {
        onSuccess: (order) => {
          if (mergeChoice === "merge") {
            showToast(`Merged into order ${order.orderNumber}`);
          } else if (asDraft) {
            showToast("Saved as draft");
          }
          onSaved(order.orderNumber);
        },
        onError: (err: Error) => {
          const errAny = err as unknown as {
            response?: {
              status?: number;
              data?: { message?: string; code?: string; activeOrder?: any };
            };
          };
          // Belt-and-braces: if the API reports 409 MERGE_CHOICE_REQUIRED (e.g. the
          // pre-check missed a race), prompt the operator now from the error response.
          const body = errAny?.response?.data;
          if (
            errAny?.response?.status === 409 &&
            body?.code === "MERGE_CHOICE_REQUIRED" &&
            body?.activeOrder
          ) {
            // Forward asDraft so a draft that races a 409 stays a draft after
            // the operator picks Merge / Create separate.
            promptMergeChoice(body.activeOrder, asDraft);
            return;
          }
          // Regulated-sale block: open the license guard and replay this exact
          // submit (same mergeChoice) once the license/override is captured.
          const blocked = parseRegulatedAuthError(err);
          if (blocked && blocked.length > 0) {
            licenseRetryRef.current = mergeChoice;
            setLicenseBlock(blocked);
            return;
          }
          const msg = body?.message ?? err?.message ?? "Unable to save order.";
          alertInfo("Couldn't save order", String(msg));
        },
      },
    );
  };

  const promptMergeChoice = (
    existing: {
      orderNumber: string | null;
      itemCount: number;
      total: number;
    },
    asDraft = false,
  ) => {
    chooseAction(
      "Open order exists",
      `This customer has an open order ${existing.orderNumber ?? ""} with ${existing.itemCount} item${existing.itemCount === 1 ? "" : "s"} ($${existing.total.toFixed(2)}). Merge into it or create a separate order?`,
      [
        { label: "Cancel", style: "cancel" },
        { label: "Merge", onPress: () => submitOrder("merge", asDraft) },
        { label: "Create separate", onPress: () => submitOrder("separate", asDraft) },
      ],
    );
  };

  const onSave = (asDraft = false) => {
    const gate = orderSubmitGate({ hasCustomer: !!customerId, itemCount: totalItems, asDraft });
    if (!gate.ok) {
      alertInfo(gate.title ?? "Can't save yet", gate.message ?? "");
      return;
    }

    // If the customer already has an active draft/pending order, ask the operator
    // explicitly — never silently merge or silently duplicate.
    if (activeOrder) {
      promptMergeChoice(activeOrder, asDraft);
      return;
    }
    submitOrder(undefined, asDraft);
  };

  return (
    <>
      <NavBar
        inlineTitle="New order"
        leading={<NavBackButton label={backLabel ?? customerName ?? "Back"} onPress={onBack} />}
        trailing={
          <NavAction
            label={createOrder.isPending ? "Saving…" : "Save"}
            bold
            onPress={canSave ? () => onSave() : undefined}
          />
        }
      />

      {/* Customer chip — tappable to re-pick when not locked */}
      <View style={styles.customerChipWrap}>
        <Pressable
          style={styles.customerChip}
          onPress={customerLocked ? undefined : onChangeCustomer}
          disabled={customerLocked}
        >
          <Ionicons name="person-outline" size={14} color={ios.brand} />
          <Text style={styles.customerChipText} numberOfLines={1}>
            {customerName ?? "Customer"}
          </Text>
          {customerLocked ? null : <Text style={styles.customerChipChange}>Change</Text>}
        </Pressable>
      </View>

      <ScrollView ref={scrollRef} showsVerticalScrollIndicator={false}>
        {/* Order options — notes, urgent, delivery date, order-level discount. */}
        <View style={styles.optionsWrap}>
          <Pressable style={styles.optionsHeader} onPress={() => setOptionsOpen((o) => !o)}>
            <Ionicons name="options-outline" size={16} color={ios.brand} />
            <Text style={styles.optionsTitle}>Order options</Text>
            {!optionsOpen && (orderUrgent || deliveryDate || discountRaw || orderNotes) ? (
              <Text style={styles.optionsSummary} numberOfLines={1}>
                {[
                  orderUrgent ? "Urgent" : null,
                  deliveryDate ? `Deliver ${deliveryDate}` : null,
                  parseFloat(discountRaw) > 0 ? `-$${parseFloat(discountRaw).toFixed(2)}` : null,
                  orderNotes.trim() ? "Notes" : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            ) : null}
            <Ionicons
              name={optionsOpen ? "chevron-up" : "chevron-down"}
              size={16}
              color={ios.label3}
            />
          </Pressable>
          {optionsOpen ? (
            <View style={styles.optionsBody}>
              <Pressable style={styles.optionRow} onPress={() => setOrderUrgent((u) => !u)}>
                <Ionicons
                  name={orderUrgent ? "flame" : "flame-outline"}
                  size={18}
                  color={orderUrgent ? ios.system.orange : ios.label2}
                />
                <Text style={styles.optionLabel}>Urgent</Text>
                <View style={[styles.toggle, orderUrgent && styles.toggleOn]}>
                  <View style={[styles.toggleDot, orderUrgent && styles.toggleDotOn]} />
                </View>
              </Pressable>
              <View style={styles.optionField}>
                <Text style={styles.optionLabel}>Delivery date</Text>
                <TextInput
                  value={deliveryDate}
                  onChangeText={setDeliveryDate}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={ios.label3}
                  keyboardType="numbers-and-punctuation"
                  style={styles.optionInput}
                />
              </View>
              <View style={styles.optionField}>
                <Text style={styles.optionLabel}>Order discount ($)</Text>
                <TextInput
                  value={discountRaw}
                  onChangeText={setDiscountRaw}
                  placeholder="0.00"
                  placeholderTextColor={ios.label3}
                  keyboardType="decimal-pad"
                  style={styles.optionInput}
                />
              </View>
              <View style={styles.optionField}>
                <Text style={styles.optionLabel}>Notes</Text>
                <TextInput
                  value={orderNotes}
                  onChangeText={setOrderNotes}
                  placeholder="Delivery / handling notes…"
                  placeholderTextColor={ios.label3}
                  multiline
                  style={[styles.optionInput, { minHeight: 60, textAlignVertical: "top" }]}
                />
              </View>
            </View>
          ) : null}
        </View>

        <SearchBar
          placeholder="Search items…"
          value={search}
          onChangeText={setSearch}
          trailing={
            <Pressable onPress={() => setScanOpen(true)} hitSlop={10}>
              <Ionicons name="barcode-outline" size={20} color={ios.brand} />
            </Pressable>
          }
        />

        {categories.length > 1 ? (
          <View style={styles.chipRow}>
            {categories.map((c) => (
              <Pressable
                key={c}
                onPress={() => setCategory(c)}
                style={[styles.chip, category === c ? styles.chipActive : styles.chipInactive]}
              >
                <Text
                  style={[
                    styles.chipText,
                    category === c ? styles.chipTextActive : styles.chipTextInactive,
                  ]}
                >
                  {c}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {/* Add an ad-hoc line that isn't in the catalog (free-text name + price). */}
        <View style={styles.unlistedCtaWrap}>
          <Pressable style={styles.unlistedCta} onPress={() => setUnlistedModalOpen(true)}>
            <Ionicons name="add-circle-outline" size={18} color={ios.brand} />
            <Text style={styles.unlistedCtaText}>Add unlisted item</Text>
          </Pressable>
          {unlisted.length > 0 ? (
            <Text style={styles.unlistedCount}>
              {unlisted.length} custom line{unlisted.length === 1 ? "" : "s"}
            </Text>
          ) : null}
        </View>

        {productsLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : filtered.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyText}>No products{search ? " match your search" : ""}.</Text>
          </View>
        ) : (
          <View
            style={{ paddingHorizontal: 16, paddingTop: 14, gap: 10 }}
            onLayout={(e) => {
              listTopRef.current = e.nativeEvent.layout.y;
            }}
          >
            {filtered.map((p) => {
              const line = items[p.id];
              const q = line ? effectiveQty(line, p.unitsPerBox) : 0;
              const price = tierPriceFor(p);
              const listPrice = toNumber(p.pricePerUnit);
              const isSpecial = price < listPrice - 0.0001;
              const upb = Number(p.unitsPerBox ?? 0);
              const isBoxed = upb > 1;
              return (
                <View
                  key={p.id}
                  onLayout={(e) => {
                    rowYRef.current.set(p.id, e.nativeEvent.layout.y);
                    // Complete a scroll waiting on this row's first measurement.
                    if (scrollToIdRef.current === p.id && scrollToRow(p.id)) {
                      scrollToIdRef.current = null;
                      setScrollToId(null);
                    }
                  }}
                  style={[
                    styles.productRow,
                    // Boxed + added: switch to a column layout so we can stack
                    // Box and Loose pieces steppers below the product header.
                    isBoxed && q > 0 && { flexDirection: "column", alignItems: "stretch" },
                  ]}
                >
                  {/* Top row: image + name + meta + add button (or qty for non-boxed) */}
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 12,
                      width: "100%",
                    }}
                  >
                    <View style={styles.productImg} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.productName} numberOfLines={1}>
                        {displayName(p)}
                      </Text>
                      <Text style={styles.productMeta}>
                        {p.sku ? `SKU ${p.sku} · ` : ""}
                        {isSpecial ? (
                          <Text style={styles.metaWas}>${listPrice.toFixed(2)} </Text>
                        ) : null}
                        <Text style={isSpecial ? styles.metaSpecial : undefined}>
                          ${price.toFixed(2)}
                        </Text>
                        {isBoxed ? ` / box of ${upb}` : p.unit ? ` / ${p.unit}` : ""}
                      </Text>
                    </View>
                    {q === 0 ? (
                      <Pressable style={styles.addBtn} onPress={() => inc(p.id)}>
                        <Text style={styles.addBtnText}>+</Text>
                      </Pressable>
                    ) : !isBoxed ? (
                      <View style={styles.stepper}>
                        <Pressable style={styles.stepBtn} onPress={() => dec(p.id)}>
                          <Text style={styles.stepBtnText}>−</Text>
                        </Pressable>
                        <Text style={styles.stepQty}>{q}</Text>
                        <Pressable style={styles.stepBtn} onPress={() => inc(p.id)}>
                          <Text style={styles.stepBtnText}>+</Text>
                        </Pressable>
                      </View>
                    ) : null}
                  </View>

                  {/* Boxed + added: dual stepper row so the operator can dial
                      Boxes and Loose pieces independently without opening the
                      cart sheet. (The cart sheet still works for the same edits.) */}
                  {isBoxed && q > 0 ? (
                    <View style={styles.boxedDualRow}>
                      <View style={styles.boxedQtyControl}>
                        <Text style={styles.boxedQtyLabel}>Boxes</Text>
                        <View style={styles.miniStepper}>
                          <Pressable
                            style={styles.miniStepBtn}
                            onPress={() => setBoxes(p.id, Math.max(0, (line?.boxes ?? 0) - 1))}
                          >
                            <Text style={styles.miniStepText}>−</Text>
                          </Pressable>
                          <Text style={styles.miniStepQty}>{line?.boxes ?? 0}</Text>
                          <Pressable
                            style={styles.miniStepBtn}
                            onPress={() => setBoxes(p.id, (line?.boxes ?? 0) + 1)}
                          >
                            <Text style={styles.miniStepText}>+</Text>
                          </Pressable>
                        </View>
                      </View>
                      <View style={styles.boxedQtyControl}>
                        <Text style={styles.boxedQtyLabel}>Loose {p.unit ?? "pcs"}</Text>
                        <View style={styles.miniStepper}>
                          <Pressable
                            style={styles.miniStepBtn}
                            onPress={() => setPieces(p.id, Math.max(0, (line?.pieces ?? 0) - 1))}
                          >
                            <Text style={styles.miniStepText}>−</Text>
                          </Pressable>
                          <Text style={styles.miniStepQty}>{line?.pieces ?? 0}</Text>
                          <Pressable
                            style={styles.miniStepBtn}
                            onPress={() =>
                              setPieces(p.id, Math.min(upb - 1, (line?.pieces ?? 0) + 1))
                            }
                          >
                            <Text style={styles.miniStepText}>+</Text>
                          </Pressable>
                        </View>
                      </View>
                      <Pressable
                        onPress={() => removeLine(p.id)}
                        hitSlop={6}
                        style={styles.boxedRemoveBtn}
                      >
                        <Ionicons name="trash-outline" size={16} color={ios.system.redInk} />
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        )}
        <View style={{ height: 16 }} />
      </ScrollView>

      <View style={styles.footer}>
        <View style={styles.footerRow}>
          {/* Tap the running total OR the explicit "View" button to open the
              cart review. The button is now visible on its own (the implicit
              "tap the total" hint was missed by users who wanted an obvious
              way to see + edit before confirming). */}
          <Pressable
            style={styles.footerTotalTap}
            onPress={totalItems > 0 ? () => setCartOpen(true) : undefined}
            disabled={totalItems === 0}
            hitSlop={6}
          >
            <Text style={styles.footerEyebrow}>
              {totalItems} ITEM{totalItems === 1 ? "" : "S"}
            </Text>
            <Text style={styles.footerTotal}>${total.toFixed(2)}</Text>
            {invoiceSplit.willSplit ? (
              <View style={styles.splitBadge}>
                <Ionicons name="layers-outline" size={10} color={ios.system.orangeInk} />
                <Text style={styles.splitBadgeText}>Splits × {invoiceSplit.groups.length}</Text>
              </View>
            ) : null}
          </Pressable>
          <View style={styles.footerActions}>
            {totalItems > 0 ? (
              <Pressable
                style={styles.viewBtn}
                onPress={() => setCartOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="View and edit order"
                hitSlop={4}
              >
                <Ionicons name="list-outline" size={14} color={ios.brand} />
                <Text style={styles.viewBtnText}>View / edit</Text>
              </Pressable>
            ) : null}
            <Pressable
              style={[
                styles.confirmBtn,
                (!canSave || createOrder.isPending) && styles.confirmBtnDisabled,
              ]}
              disabled={!canSave}
              onPress={() => onSave()}
              accessibilityState={{ disabled: !canSave }}
            >
              <Text style={styles.confirmBtnText}>
                {createOrder.isPending ? "Saving…" : "Confirm"}
              </Text>
              <Ionicons name="arrow-forward" size={14} color="#fff" />
            </Pressable>
          </View>
        </View>
        <View style={styles.footerSubRow}>
          {totalItems === 0 && !createOrder.isPending ? (
            <Text style={styles.footerHint}>Add an item to confirm, or save a draft.</Text>
          ) : (
            <View style={{ flex: 1 }} />
          )}
          {canSaveDraft || createOrder.isPending ? (
            <Pressable onPress={() => onSave(true)} disabled={!canSaveDraft} hitSlop={6}>
              <Text style={[styles.footerDraftText, !canSaveDraft && { opacity: 0.4 }]}>
                Save as draft
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {scanOpen ? (
        <BarcodeScanner
          continuous
          onScanned={handleBarcodeScanned}
          onClose={() => setScanOpen(false)}
        />
      ) : null}

      {/* Floating, draggable scan button — keeps the scanner one tap away even
          when the operator has scrolled deep into the product list. Hidden
          while the cart sheet or the in-list scanner is up so it doesn't
          stack on top of either. */}
      <BarcodeFab continuous onScanned={handleBarcodeScanned} hidden={cartOpen || scanOpen} />

      <LicenseGuardModal
        open={!!licenseBlock}
        customerId={customerId}
        blocked={licenseBlock ?? []}
        readOnly={!canCreateProducts}
        onResolved={() => {
          const mc = licenseRetryRef.current;
          setLicenseBlock(null);
          submitOrder(mc);
        }}
        onRemoveLines={(categoryIds) => {
          setItems((prev) => {
            const next = { ...prev };
            for (const pid of Object.keys(next)) {
              const p = productById.get(pid);
              if (p?.trackedCategoryId && categoryIds.includes(p.trackedCategoryId))
                delete next[pid];
            }
            return next;
          });
          setLicenseBlock(null);
          showToast("Removed regulated line(s)");
        }}
        onClose={() => setLicenseBlock(null)}
      />

      {/* Create-on-miss: overlays the cart (never navigates away) so the
          in-progress order survives. Supports new-product OR variant-of. */}
      <InlineCreateProductSheet
        visible={createCode != null}
        initialCode={createCode ?? undefined}
        onClose={() => setCreateCode(null)}
        onCreated={handleInlineCreated}
      />

      <CartModal
        open={cartOpen}
        items={items}
        productById={productById}
        priceHistory={priceHistory}
        tierPriceFor={tierPriceFor}
        marginFloorFor={(p) => floorForCategory(marginConfig, p.category)}
        unlisted={unlisted}
        total={total}
        totalItems={totalItems}
        invoiceSplit={invoiceSplit}
        saving={createOrder.isPending}
        onClose={() => setCartOpen(false)}
        onChangeBoxes={setBoxes}
        onChangePieces={setPieces}
        onChangeQty={setQty}
        onChangePrice={setLinePrice}
        onChangeNote={setLineNote}
        onToggleNote={toggleLineNote}
        showCostEye={canSeeCost}
        onIncrement={addOne}
        onDecrement={removeOne}
        onRemove={removeLine}
        onChangeUnlistedQty={updateUnlistedQty}
        onChangeUnlistedPrice={updateUnlistedPrice}
        onChangeUnlistedNote={updateUnlistedNote}
        onToggleUnlistedNote={toggleUnlistedNote}
        onRemoveUnlisted={removeUnlisted}
        onAddUnlisted={() => setUnlistedModalOpen(true)}
        onSave={() => {
          setCartOpen(false);
          onSave();
        }}
      />

      <UnlistedItemModal
        open={unlistedModalOpen}
        onClose={() => setUnlistedModalOpen(false)}
        onAdd={(name, unitPrice, qty) => {
          addUnlisted(name, unitPrice, qty);
          setUnlistedModalOpen(false);
          showToast(`Added ${name}`);
        }}
      />
    </>
  );
}

// ─────────────────────── Cart review modal ───────────────────────

/**
 * Slide-up sheet that lets the operator inspect every added line, tweak
 * box/piece counts (or qty for non-boxed), remove rows, and finally save.
 * The footer total/Confirm action stays in sync with this list because both
 * read from the same `items` + `productById` state in the parent.
 */
function CartModal({
  open,
  items,
  productById,
  priceHistory,
  tierPriceFor,
  marginFloorFor,
  unlisted,
  total,
  totalItems,
  invoiceSplit,
  saving,
  onClose,
  onChangeBoxes,
  onChangePieces,
  onChangeQty,
  onChangePrice,
  onChangeNote,
  onToggleNote,
  showCostEye,
  onIncrement,
  onDecrement,
  onRemove,
  onChangeUnlistedQty,
  onChangeUnlistedPrice,
  onChangeUnlistedNote,
  onToggleUnlistedNote,
  onRemoveUnlisted,
  onAddUnlisted,
  onSave,
}: {
  open: boolean;
  items: Record<string, LineState>;
  productById: Map<string, Product>;
  priceHistory?: CustomerPriceHistory;
  tierPriceFor: (p: Product) => number;
  /** The customer's effective margin floor (fraction) for a product's category. */
  marginFloorFor: (p: Product) => number;
  unlisted: UnlistedLine[];
  total: number;
  totalItems: number;
  invoiceSplit: InvoiceSplitPreview;
  saving: boolean;
  onClose: () => void;
  onChangeBoxes: (id: string, n: number) => void;
  onChangePieces: (id: string, n: number) => void;
  onChangeQty: (id: string, n: number) => void;
  onChangePrice: (id: string, value: number | null) => void;
  onChangeNote: (id: string, text: string) => void;
  onToggleNote: (id: string) => void;
  /** Whether this role may reveal cost/margin (seller roles only). */
  showCostEye: boolean;
  onIncrement: (id: string) => void;
  onDecrement: (id: string) => void;
  onRemove: (id: string) => void;
  onChangeUnlistedQty: (id: string, n: number) => void;
  onChangeUnlistedPrice: (id: string, value: number | null) => void;
  onChangeUnlistedNote: (id: string, text: string) => void;
  onToggleUnlistedNote: (id: string) => void;
  onRemoveUnlisted: (id: string) => void;
  onAddUnlisted: () => void;
  onSave: () => void;
}) {
  // Stable iteration order: name asc, so the cart doesn't reshuffle as the
  // operator edits a row.
  const rows = useMemo(() => {
    const list: { id: string; product: Product; line: LineState }[] = [];
    for (const [id, line] of Object.entries(items)) {
      const product = productById.get(id);
      if (!product) continue;
      list.push({ id, product, line });
    }
    list.sort((a, b) => displayName(a.product).localeCompare(displayName(b.product)));
    return list;
  }, [items, productById]);

  return (
    <Modal visible={open} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.cartBackdrop}>
        <View style={styles.cartSheet}>
          {/* Header with close + title */}
          <View style={styles.cartHeader}>
            <Pressable onPress={onClose} hitSlop={8} style={styles.cartHeaderBtn}>
              <Ionicons name="chevron-down" size={22} color={ios.label2} />
            </Pressable>
            <Text style={styles.cartTitle}>Review order</Text>
            <Text style={styles.cartHeaderCount}>
              {totalItems} item{totalItems === 1 ? "" : "s"}
            </Text>
          </View>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16, gap: 10 }}
            showsVerticalScrollIndicator={false}
          >
            {rows.length === 0 && unlisted.length === 0 ? (
              <View style={[styles.center, { paddingVertical: 40 }]}>
                <Text style={styles.emptyText}>Cart is empty.</Text>
              </View>
            ) : (
              <>
                {rows.map(({ id, product, line }) => (
                  <CartRow
                    key={id}
                    product={product}
                    line={line}
                    catalogPrice={tierPriceFor(product)}
                    marginFloor={marginFloorFor(product)}
                    historyPrice={priceHistory?.[id]?.lastPrice}
                    onChangeBoxes={(n) => onChangeBoxes(id, n)}
                    onChangePieces={(n) => onChangePieces(id, n)}
                    onChangeQty={(n) => onChangeQty(id, n)}
                    onChangePrice={(raw) => onChangePrice(id, raw)}
                    onChangeNote={(t) => onChangeNote(id, t)}
                    onToggleNote={() => onToggleNote(id)}
                    showCostEye={showCostEye}
                    onIncrement={() => onIncrement(id)}
                    onDecrement={() => onDecrement(id)}
                    onRemove={() => onRemove(id)}
                  />
                ))}
                {unlisted.map((u) => (
                  <UnlistedCartRow
                    key={u.id}
                    line={u}
                    onChangeQty={(n) => onChangeUnlistedQty(u.id, n)}
                    onChangePrice={(raw) => onChangeUnlistedPrice(u.id, raw)}
                    onChangeNote={(t) => onChangeUnlistedNote(u.id, t)}
                    onToggleNote={() => onToggleUnlistedNote(u.id)}
                    onRemove={() => onRemoveUnlisted(u.id)}
                  />
                ))}
              </>
            )}
            {invoiceSplit.willSplit ? (
              <View style={styles.splitBanner}>
                <Text style={styles.splitBannerHeader}>
                  SPLITS INTO {invoiceSplit.groups.length} INVOICES
                </Text>
                {invoiceSplit.groups.map((g, i) => (
                  <View key={g.label} style={styles.splitGroupRow}>
                    <Text style={styles.splitGroupLabel} numberOfLines={1}>
                      Invoice {i + 1} — {g.label} ({g.count} {g.count === 1 ? "item" : "items"})
                    </Text>
                    <Text style={styles.splitGroupAmount}>${g.subtotal.toFixed(2)}</Text>
                  </View>
                ))}
                <Text style={styles.splitFootnote}>
                  Regulated categories are billed on their own invoice. Amounts shown are pre-tax
                  subtotals.
                </Text>
              </View>
            ) : null}
            <Pressable style={styles.cartAddUnlisted} onPress={onAddUnlisted} hitSlop={4}>
              <Ionicons name="add-circle-outline" size={16} color={ios.brand} />
              <Text style={styles.cartAddUnlistedText}>Add unlisted item</Text>
            </Pressable>
          </ScrollView>

          {/* Sticky footer: total + actions */}
          <View style={styles.cartFooter}>
            <View style={styles.cartFooterRow}>
              <View>
                <Text style={styles.footerEyebrow}>ORDER TOTAL</Text>
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
                  <Text style={styles.confirmBtnText}>{saving ? "Saving…" : "Save order"}</Text>
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

function CartRow({
  product,
  line,
  catalogPrice,
  marginFloor,
  historyPrice,
  onChangeBoxes,
  onChangePieces,
  onChangeQty,
  onChangePrice,
  onChangeNote,
  onToggleNote,
  showCostEye,
  onIncrement,
  onDecrement,
  onRemove,
}: {
  product: Product;
  line: LineState;
  /** The customer's effective tier price for this product (the base to compare
   *  an override against and to fall back to when no override is set). */
  catalogPrice: number;
  /** Category margin floor (fraction) for the live cost/margin hint. */
  marginFloor: number;
  historyPrice?: number;
  onChangeBoxes: (n: number) => void;
  onChangePieces: (n: number) => void;
  onChangeQty: (n: number) => void;
  onChangePrice: (value: number | null) => void;
  onChangeNote: (text: string) => void;
  onToggleNote: () => void;
  showCostEye: boolean;
  onIncrement: () => void;
  onDecrement: () => void;
  onRemove: () => void;
}) {
  const upb = Number(product.unitsPerBox ?? 0);
  const isBoxed = upb > 1;
  const effUnit = effectiveUnitPrice(line, catalogPrice);
  const isOverridden = line.unitPrice != null && line.unitPrice !== catalogPrice;
  const qty = effectiveQty(line, product.unitsPerBox);
  const lineTotal = computeLineSubtotal({
    unitPrice: effUnit,
    qty,
    boxes: line.boxes ?? null,
    pieces: line.pieces ?? null,
    unitsPerBox: product.unitsPerBox ?? null,
  });

  // Cost eye + live margin hint (mirror web): both read one per-piece cost —
  // averageCost, else standardCost. Cost eye is hidden by default (session-local);
  // the margin pill (classifyMargin vs the category floor) hides when no cost.
  const [costVisible, setCostVisible] = useState(false);
  const pieceCost =
    product.averageCost != null
      ? toNumber(product.averageCost)
      : product.standardCost != null
        ? toNumber(product.standardCost)
        : null;
  // 0 is a real cost; only null hides the eye/hint entirely.
  const hasCost = pieceCost != null && Number.isFinite(pieceCost);
  const sellingUnitCost = hasCost ? costPerSellingUnit(pieceCost!, product.unitsPerBox) : null;
  const marginFrac = hasCost
    ? computeMarginFraction(effUnit, pieceCost, product.unitsPerBox)
    : null;
  const marginClass = classifyMargin(marginFrac, marginFloor);

  return (
    <View style={styles.cartRow}>
      <View style={styles.cartRowHeader}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.cartRowName} numberOfLines={2}>
            {displayName(product)}
          </Text>
          <Text style={styles.cartRowMeta}>
            {isBoxed ? `box of ${upb}` : product.unit ? `per ${product.unit}` : ""}
            {product.sku ? `${isBoxed || product.unit ? " · " : ""}${product.sku}` : ""}
          </Text>
        </View>
        <Pressable onPress={onRemove} hitSlop={8} style={styles.cartRowRemove}>
          <Ionicons name="trash-outline" size={18} color={ios.system.redInk} />
        </Pressable>
      </View>

      {/* Editable price — the "discounted price". Defaults to the catalog price;
          typing a lower value records a one-time override sent as the line's
          unitPrice. */}
      <View style={styles.cartPriceRow}>
        <Text style={styles.cartPriceLabel}>Price{isBoxed ? " / box" : ""}</Text>
        <View style={styles.cartPriceInputWrap}>
          <Text style={styles.cartPriceCurrency}>$</Text>
          <MoneyTextInput
            style={[styles.cartPriceInput, isOverridden && styles.cartPriceInputActive]}
            value={line.unitPrice ?? null}
            onChangeValue={onChangePrice}
            placeholder={catalogPrice.toFixed(2)}
            returnKeyType="done"
          />
          {isOverridden && line.unitPrice != null && line.unitPrice > catalogPrice ? (
            <Text style={{ color: ios.system.greenInk, fontSize: 11, fontWeight: "600" }}>
              Upsell
            </Text>
          ) : isOverridden ? (
            <Text style={styles.cartPriceWas}>Current: ${catalogPrice.toFixed(2)}</Text>
          ) : historyPrice != null && historyPrice !== catalogPrice ? (
            <Text style={styles.cartPriceWas}>Last: ${historyPrice.toFixed(2)}</Text>
          ) : null}
        </View>
      </View>

      {/* Live margin hint — margin on the effective price vs the product's cost. */}
      {marginFrac != null ? (
        <Text
          style={[
            styles.marginHint,
            marginClass === "belowCost" || marginClass === "belowFloor"
              ? { color: ios.system.red }
              : marginClass === "warn"
                ? { color: ios.system.orange }
                : { color: ios.label2 },
          ]}
        >
          {marginClass === "belowCost"
            ? `Below cost (${Math.round(marginFrac * 100)}%)`
            : marginClass === "belowFloor"
              ? `Below floor · ${Math.round(marginFrac * 100)}% margin`
              : `${Math.round(marginFrac * 100)}% margin`}
        </Text>
      ) : null}

      {isBoxed ? (
        <>
          <CartStepperRow label="Boxes" value={line.boxes ?? 0} onChange={onChangeBoxes} />
          <CartStepperRow
            label={`Loose ${product.unit ?? "pieces"}`}
            value={line.pieces ?? 0}
            onChange={onChangePieces}
            max={upb - 1}
            hint={`${upb} per box`}
          />
        </>
      ) : (
        <CartStepperRow
          label={`Qty${product.unit ? ` (${product.unit})` : ""}`}
          value={line.qty ?? 0}
          onChange={onChangeQty}
          onIncrement={onIncrement}
          onDecrement={onDecrement}
        />
      )}

      {/* Cost eye — OFF by default; reveals the selling-unit cost + margin. */}
      {showCostEye && hasCost ? (
        <Pressable onPress={() => setCostVisible((v) => !v)} hitSlop={6} style={styles.cartNoteAdd}>
          <Ionicons
            name={costVisible ? "eye-off-outline" : "eye-outline"}
            size={14}
            color={costVisible ? ios.label2 : ios.brand}
          />
          {costVisible ? (
            <Text style={styles.cartCostText}>
              Cost ${sellingUnitCost!.toFixed(2)}
              {isBoxed ? " / box" : ""}
              {marginFrac != null ? ` · ${(marginFrac * 100).toFixed(1)}%` : ""}
            </Text>
          ) : (
            <Text style={styles.cartNoteAddText}>Cost</Text>
          )}
        </Pressable>
      ) : null}

      {/* Per-line note — carried onto the invoice line (buyer-visible). */}
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

function CartStepperRow({
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
  // Local string state so the user can clear the input mid-edit without it
  // snapping back to "0". Synced to `value` whenever the parent updates it
  // (e.g. via the stepper buttons or another row affecting the line state).
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const dec = () => {
    if (onDecrement) onDecrement();
    else onChange(Math.max(0, value - 1));
  };
  const inc = () => {
    if (onIncrement) onIncrement();
    else {
      const next = max != null ? Math.min(max, value + 1) : value + 1;
      onChange(next);
    }
  };

  return (
    <View style={styles.cartStepperRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.cartStepperLabel}>{label}</Text>
        {hint ? <Text style={styles.cartStepperHint}>{hint}</Text> : null}
      </View>
      <View style={styles.stepper}>
        <Pressable style={styles.stepBtn} onPress={dec} hitSlop={6}>
          <Text style={styles.stepBtnText}>−</Text>
        </Pressable>
        <TextInput
          style={styles.cartStepperInput}
          value={draft}
          onChangeText={(txt) => {
            // Integer-only: strip non-digits + leading zeros live (no "05", no
            // decimals even when Android shows a decimal key); allow empty mid-edit.
            const clean = sanitizeIntInput(txt);
            setDraft(clean);
            if (clean === "") return;
            const n = parseInt(clean, 10);
            if (Number.isFinite(n)) {
              const clamped = max != null ? Math.min(max, n) : n;
              onChange(clamped);
            }
          }}
          onBlur={() => {
            // Empty input → commit 0 (which removes the line if both fields are 0)
            if (draft === "") onChange(0);
            setDraft(String(value));
          }}
          keyboardType="number-pad"
          returnKeyType="done"
          maxLength={5}
          selectTextOnFocus
        />
        <Pressable style={styles.stepBtn} onPress={inc} hitSlop={6}>
          <Text style={styles.stepBtnText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Cart row for an ad-hoc (unlisted) line: editable price + qty, "Custom" tag, no image. */
function UnlistedCartRow({
  line,
  onChangeQty,
  onChangePrice,
  onChangeNote,
  onToggleNote,
  onRemove,
}: {
  line: UnlistedLine;
  onChangeQty: (n: number) => void;
  onChangePrice: (value: number | null) => void;
  onChangeNote: (text: string) => void;
  onToggleNote: () => void;
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

      <CartStepperRow
        label="Qty"
        value={line.qty}
        onChange={onChangeQty}
        onIncrement={() => onChangeQty(line.qty + 1)}
        onDecrement={() => onChangeQty(Math.max(0, line.qty - 1))}
      />

      {/* Per-line note — carried onto the invoice line (buyer-visible). */}
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

/**
 * Small modal to compose a new unlisted line: free-text name, unit price
 * (required), integer qty. Mirrors the PriceOverrideModal styling.
 */
function UnlistedItemModal({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (name: string, unitPrice: number, qty: number) => void;
}) {
  const [name, setName] = useState("");
  const [priceText, setPriceText] = useState("");
  const [qtyText, setQtyText] = useState("1");

  // Reset fields whenever the modal is (re)opened.
  useEffect(() => {
    if (open) {
      setName("");
      setPriceText("");
      setQtyText("1");
    }
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

          <Text style={styles.unlistedFieldLabel}>Item name</Text>
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

          <View style={[styles.modalBtns, { marginTop: 4 }]}>
            <Pressable style={styles.modalBtnGhost} onPress={onClose}>
              <Text style={styles.modalBtnGhostText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.modalBtnFill, !valid && styles.modalBtnDisabled]}
              onPress={() => valid && onAdd(name.trim(), price, qty)}
              disabled={!valid}
            >
              <Text style={styles.modalBtnFillText}>Add to order</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bgElev },
  center: { padding: 40, alignItems: "center" },
  emptyText: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },
  list: {
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
  customerSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 1 },
  customerChipWrap: {
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  optionsWrap: { marginHorizontal: 16, marginTop: 10 },
  optionsHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 },
  optionsTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  optionsSummary: { flex: 1, fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  optionsBody: {
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    padding: 12,
    gap: 12,
    marginBottom: 4,
  },
  optionRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  optionField: { gap: 6 },
  optionLabel: { flex: 1, fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },
  optionInput: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label,
  },
  toggle: {
    width: 44,
    height: 26,
    borderRadius: 13,
    backgroundColor: ios.fill3,
    padding: 3,
    justifyContent: "center",
  },
  toggleOn: { backgroundColor: ios.brand },
  toggleDot: { width: 20, height: 20, borderRadius: 10, backgroundColor: "#fff" },
  toggleDotOn: { alignSelf: "flex-end" },
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
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 4,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    minHeight: 28,
    justifyContent: "center",
  },
  chipActive: { backgroundColor: ios.brand },
  chipInactive: { backgroundColor: ios.fill3 },
  chipText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  chipTextActive: { color: "#fff" },
  chipTextInactive: { color: ios.label },
  productRow: {
    backgroundColor: ios.bg,
    borderRadius: 14,
    padding: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  productImg: {
    width: 48,
    height: 48,
    borderRadius: 10,
    backgroundColor: ios.brandWash,
  },
  productName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  productMeta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 1,
    fontVariant: ["tabular-nums"],
  },
  metaWas: { color: ios.label3, textDecorationLine: "line-through" },
  metaSpecial: { color: ios.brand, fontFamily: "Inter_600SemiBold" },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: ios.bgElev,
    borderRadius: 10,
    padding: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
  },
  stepBtn: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  stepBtnText: { color: ios.brand, fontSize: 18 },
  stepQty: {
    minWidth: 28,
    textAlign: "center",
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  addBtn: {
    width: 36,
    height: 36,
    backgroundColor: ios.brandWash,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  addBtnText: { color: ios.brand, fontSize: 20 },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 16,
    backgroundColor: ios.bgElev,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  footerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  footerEyebrow: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.4,
  },
  footerTotal: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.6,
    fontVariant: ["tabular-nums"],
  },
  splitBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    marginTop: 3,
    alignSelf: "flex-start",
    backgroundColor: ios.system.orangeWash,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  splitBadgeText: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: ios.system.orangeInk,
    letterSpacing: 0.2,
  },
  confirmBtn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingHorizontal: 20,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  confirmBtnDisabled: { opacity: 0.35 },
  confirmBtnText: { color: "#fff", fontSize: 16, fontFamily: "Inter_600SemiBold" },

  // ── Inline boxed product editor (dual stepper) ───────────────────────────
  boxedDualRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  boxedQtyControl: {
    flex: 1,
    alignItems: "center",
    gap: 4,
  },
  boxedQtyLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.3,
  },
  miniStepper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: ios.bgElev,
    borderRadius: 10,
    padding: 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
  },
  miniStepBtn: { width: 26, height: 26, alignItems: "center", justifyContent: "center" },
  miniStepText: { color: ios.brand, fontSize: 16 },
  miniStepQty: {
    minWidth: 24,
    textAlign: "center",
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  boxedRemoveBtn: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: ios.system.redWash,
    borderRadius: 8,
  },

  // ── Footer extras ─────────────────────────────────────────────────────────
  footerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
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
  footerHint: {
    color: ios.label3,
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    flex: 1,
  },
  footerSubRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginTop: 6,
  },
  footerDraftText: {
    color: ios.brand,
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },

  // ── Cart review modal ─────────────────────────────────────────────────────
  footerTotalTap: { paddingVertical: 4, paddingRight: 8 },
  cartBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
  },
  cartSheet: {
    backgroundColor: ios.bg,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    maxHeight: "92%",
    minHeight: "55%",
  },
  cartHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  cartHeaderBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  cartTitle: {
    flex: 1,
    textAlign: "center",
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: ios.label,
  },
  cartHeaderCount: {
    width: 60,
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
  cartPriceLabel: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: ios.label,
  },
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
  marginHint: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    marginTop: -4,
    marginBottom: 2,
    textAlign: "right",
  },
  cartPriceWas: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textDecorationLine: "line-through",
  },
  cartStepperRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  cartStepperLabel: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: ios.label,
  },
  cartStepperHint: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: ios.label3,
    marginTop: 1,
  },
  cartStepperInput: {
    minWidth: 48,
    paddingHorizontal: 6,
    paddingVertical: 4,
    textAlign: "center",
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  cartNoteAdd: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
  },
  cartNoteAddText: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.brand },
  cartCostText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
    fontVariant: ["tabular-nums"],
  },
  cartNoteInput: {
    backgroundColor: ios.fill3,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    marginBottom: 6,
  },
  cartRowFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  cartRowFooterLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
  },
  cartRowFooterValue: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  splitBanner: {
    marginTop: 4,
    marginBottom: 4,
    backgroundColor: ios.system.orangeWash,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.system.orange,
    borderRadius: 12,
    padding: 12,
    gap: 4,
  },
  splitBannerHeader: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    color: ios.system.orangeInk,
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  splitGroupRow: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  splitGroupLabel: { flex: 1, fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  splitGroupAmount: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  splitFootnote: {
    fontSize: 10,
    fontFamily: "Inter_400Regular",
    color: ios.label3,
    marginTop: 2,
  },
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
  cartContinueText: {
    color: ios.label,
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },

  // ── Unlisted item CTA + cart row + tag ────────────────────────────────────
  unlistedCtaWrap: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  unlistedCta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: ios.brandWash,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  unlistedCtaText: { color: ios.brand, fontSize: 14, fontFamily: "Inter_600SemiBold" },
  unlistedCount: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.label2 },
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

  // ── Unlisted item modal ───────────────────────────────────────────────────
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
  modalBtns: { flexDirection: "row", gap: 10 },
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
