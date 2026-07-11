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
import {
  useCreateOrderAsDriver,
  useActiveOrderForCustomer,
  useCustomerPriceHistory,
  type CreateOrderItemInput,
  type CustomerPriceHistory,
} from "../lib/api/orders";
import { showToast } from "../lib/toast";
import { resolveProductByCode } from "../lib/barcode-resolve";
import { computeLineSubtotal, effectiveQty, roundMoney } from "../lib/pricing";
import { MoneyTextInput } from "./MoneyTextInput";
import { sanitizeIntInput } from "../lib/qty";
import { useAuthStore } from "../lib/auth-store";
// chooseAction + alertInfo render the same dialogs cross-platform — RN's
// Alert.alert silently no-ops 3-button alerts on Expo Web (the user's
// "Confirm button frozen" report), so use these everywhere instead.
import { alertInfo, chooseAction } from "../lib/confirm";
import { BarcodeScanner } from "./BarcodeScanner";
import { BarcodeFab } from "./BarcodeFab";

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
  category?: string | null;
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
};

function newLocalId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Compose "<Parent> - <Variant>" so scanned variants don't show as "Strawberry" alone. */
function displayName(p: Product): string {
  if (p.parent?.name) return `${p.parent.name} - ${p.name}`;
  return p.name;
}

function toNumber(v: number | string | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** The effective per-unit price for a line: the override, else the catalog price. */
function effectiveUnitPrice(line: LineState | undefined, p: Product): number {
  return line?.unitPrice != null ? line.unitPrice : toNumber(p.pricePerUnit);
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

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [items, setItems] = useState<Record<string, LineState>>({});
  // Ad-hoc lines not in the product catalog (productId null on submit).
  const [unlisted, setUnlisted] = useState<UnlistedLine[]>([]);
  const [unlistedModalOpen, setUnlistedModalOpen] = useState(false);
  // Fetched once when customer is confirmed — price pre-fill is instant during scanning.
  const { data: priceHistory } = useCustomerPriceHistory(customerId);
  const [scanOpen, setScanOpen] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  // Scroll the just-scanned product row into view. We track the product list's
  // top offset within the ScrollView plus each row's offset within the list.
  const scrollRef = useRef<ScrollView>(null);
  const listTopRef = useRef(0);
  const rowYRef = useRef<Map<string, number>>(new Map());
  const [scrollToId, setScrollToId] = useState<string | null>(null);
  useEffect(() => {
    if (!scrollToId) return;
    const y = rowYRef.current.get(scrollToId);
    if (y != null)
      scrollRef.current?.scrollTo({ y: Math.max(0, listTopRef.current + y - 12), animated: true });
    setScrollToId(null);
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
    // Snapshot history at call time (closed over — loaded before scanning starts).
    const histEntry = priceHistory?.[id];
    setItems((m) => {
      const isNew = !m[id];
      const prev = m[id] ?? { qty: 0 };
      if (isBoxed) {
        const boxes = (prev.boxes ?? 0) + 1;
        const pieces = prev.pieces ?? 0;
        const line: LineState = { qty: boxes * upb + pieces, boxes, pieces };
        if (isNew && histEntry) line.unitPrice = histEntry.lastPrice;
        return { ...m, [id]: line };
      }
      const line: LineState = { qty: (prev.qty ?? 0) + 1 };
      if (isNew && histEntry) line.unitPrice = histEntry.lastPrice;
      return { ...m, [id]: line };
    });
    if (productSnapshot && !productById.has(id)) {
      setScannedById((m) => ({ ...m, [id]: productSnapshot }));
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
  const removeUnlisted = (id: string) => setUnlisted((u) => u.filter((x) => x.id !== id));

  const handleBarcodeScanned = async (code: string) => {
    setScanOpen(false);
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
      setScrollToId(local.id);
      showToast(`Added ${displayName(local)}`);
      return;
    }

    // 2) Server fallback: barcode → exact SKU → name/SKU substring → notFound.
    try {
      const result = await resolveProductByCode<Product>(trimmed);
      if (!result.notFound && result.product?.id) {
        addOne(result.product.id, result.product);
        setScrollToId(result.product.id);
        showToast(`Added ${displayName(result.product)}`);
        return;
      }
    } catch (err: any) {
      // Network / 5xx — surface so the operator can retry instead of silently
      // showing "no product found" (which implies the item doesn't exist).
      const msg = err?.response?.data?.message ?? err?.message ?? "Couldn't look up barcode.";
      showToast(msg);
      return;
    }

    // 3) Nothing matched. Mirror web's behaviour: offer to create the product
    //    with the scanned code prefilled, so the operator isn't dead-ended.
    if (canCreateProducts) {
      chooseAction(
        `No product for "${trimmed}"`,
        "Add it as a new product? (Your in-progress order won't be saved if you continue.)",
        [
          { label: "Cancel", style: "cancel" },
          {
            label: "Create",
            onPress: () =>
              router.push({
                pathname: "/(operator)/products/new",
                params: { barcode: trimmed },
              }),
          },
        ],
      );
    } else {
      showToast(`No product for "${trimmed}"`);
    }
  };

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) if (p.category) set.add(p.category);
    return ["All", ...Array.from(set).slice(0, 6)];
  }, [products]);

  const filtered = useMemo(() => {
    if (category === "All") return products;
    return products.filter((p) => p.category === category);
  }, [products, category]);

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

  const inc = (id: string) => addOne(id);
  const dec = (id: string) => removeOne(id);

  const createOrder = useCreateOrderAsDriver();
  // Pre-check the customer's open draft/pending order so we can ask before submitting.
  const { data: activeOrder } = useActiveOrderForCustomer(customerId);

  const canSave = totalItems > 0 && !createOrder.isPending;

  /** Submit with a specific (or no) merge choice. */
  const submitOrder = (mergeChoice?: "merge" | "separate") => {
    const catalogPayload: CreateOrderItemInput[] = Object.entries(items)
      .map(([productId, line]): CreateOrderItemInput => {
        const p = productById.get(productId);
        const qty = effectiveQty(line, p?.unitsPerBox);
        // Send a unitPrice override whenever the operator set a price that differs
        // from catalog — below list (discount) OR above list (upsell). The server
        // treats it as a one-time MANUAL/DISCOUNTED override.
        const catalog = p ? toNumber(p.pricePerUnit) : 0;
        const override =
          line.unitPrice != null && line.unitPrice !== catalog ? { unitPrice: line.unitPrice } : {};
        const base = { productId, qty, ...override };
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
      .map((u) => ({ name: u.name.trim(), qty: u.qty, unitPrice: u.unitPrice }));
    const itemPayload = [...catalogPayload, ...unlistedPayload];

    createOrder.mutate(
      {
        customerId,
        items: itemPayload,
        routeRunId: runId,
        routeRunStopId: stopId,
        ...(mergeChoice ? { mergeChoice } : {}),
      },
      {
        onSuccess: (order) => {
          if (mergeChoice === "merge") {
            showToast(`Merged into order ${order.orderNumber}`);
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
            promptMergeChoice(body.activeOrder);
            return;
          }
          const msg = body?.message ?? err?.message ?? "Unable to save order.";
          alertInfo("Couldn't save order", String(msg));
        },
      },
    );
  };

  const promptMergeChoice = (existing: {
    orderNumber: string | null;
    itemCount: number;
    total: number;
  }) => {
    chooseAction(
      "Open order exists",
      `This customer has an open order ${existing.orderNumber ?? ""} with ${existing.itemCount} item${existing.itemCount === 1 ? "" : "s"} ($${existing.total.toFixed(2)}). Merge into it or create a separate order?`,
      [
        { label: "Cancel", style: "cancel" },
        { label: "Merge", onPress: () => submitOrder("merge") },
        { label: "Create separate", onPress: () => submitOrder("separate") },
      ],
    );
  };

  const onSave = () => {
    if (totalItems === 0) {
      alertInfo("Add at least one item", "Tap + on any product to start the order.");
      return;
    }

    // If the customer already has an active draft/pending order, ask the operator
    // explicitly — never silently merge or silently duplicate.
    if (activeOrder) {
      promptMergeChoice(activeOrder);
      return;
    }
    submitOrder();
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
            onPress={canSave ? onSave : undefined}
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
              const price = toNumber(p.pricePerUnit);
              const upb = Number(p.unitsPerBox ?? 0);
              const isBoxed = upb > 1;
              return (
                <View
                  key={p.id}
                  onLayout={(e) => rowYRef.current.set(p.id, e.nativeEvent.layout.y)}
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
                        {p.sku ? `SKU ${p.sku} · ` : ""}${price.toFixed(2)}
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
              onPress={onSave}
              accessibilityState={{ disabled: !canSave }}
            >
              <Text style={styles.confirmBtnText}>
                {createOrder.isPending ? "Saving…" : "Confirm"}
              </Text>
              <Ionicons name="arrow-forward" size={14} color="#fff" />
            </Pressable>
          </View>
        </View>
        {totalItems === 0 && !createOrder.isPending ? (
          <Text style={styles.footerHint}>Add at least one item to confirm.</Text>
        ) : null}
      </View>

      {scanOpen ? (
        <BarcodeScanner onScanned={handleBarcodeScanned} onClose={() => setScanOpen(false)} />
      ) : null}

      {/* Floating, draggable scan button — keeps the scanner one tap away even
          when the operator has scrolled deep into the product list. Hidden
          while the cart sheet or the in-list scanner is up so it doesn't
          stack on top of either. */}
      <BarcodeFab onScanned={handleBarcodeScanned} hidden={cartOpen || scanOpen} />

      <CartModal
        open={cartOpen}
        items={items}
        productById={productById}
        priceHistory={priceHistory}
        unlisted={unlisted}
        total={total}
        totalItems={totalItems}
        saving={createOrder.isPending}
        onClose={() => setCartOpen(false)}
        onChangeBoxes={setBoxes}
        onChangePieces={setPieces}
        onChangeQty={setQty}
        onChangePrice={setLinePrice}
        onIncrement={addOne}
        onDecrement={removeOne}
        onRemove={removeLine}
        onChangeUnlistedQty={updateUnlistedQty}
        onChangeUnlistedPrice={updateUnlistedPrice}
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
  unlisted,
  total,
  totalItems,
  saving,
  onClose,
  onChangeBoxes,
  onChangePieces,
  onChangeQty,
  onChangePrice,
  onIncrement,
  onDecrement,
  onRemove,
  onChangeUnlistedQty,
  onChangeUnlistedPrice,
  onRemoveUnlisted,
  onAddUnlisted,
  onSave,
}: {
  open: boolean;
  items: Record<string, LineState>;
  productById: Map<string, Product>;
  priceHistory?: CustomerPriceHistory;
  unlisted: UnlistedLine[];
  total: number;
  totalItems: number;
  saving: boolean;
  onClose: () => void;
  onChangeBoxes: (id: string, n: number) => void;
  onChangePieces: (id: string, n: number) => void;
  onChangeQty: (id: string, n: number) => void;
  onChangePrice: (id: string, value: number | null) => void;
  onIncrement: (id: string) => void;
  onDecrement: (id: string) => void;
  onRemove: (id: string) => void;
  onChangeUnlistedQty: (id: string, n: number) => void;
  onChangeUnlistedPrice: (id: string, value: number | null) => void;
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
                    historyPrice={priceHistory?.[id]?.lastPrice}
                    onChangeBoxes={(n) => onChangeBoxes(id, n)}
                    onChangePieces={(n) => onChangePieces(id, n)}
                    onChangeQty={(n) => onChangeQty(id, n)}
                    onChangePrice={(raw) => onChangePrice(id, raw)}
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
                    onRemove={() => onRemoveUnlisted(u.id)}
                  />
                ))}
              </>
            )}
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
  historyPrice,
  onChangeBoxes,
  onChangePieces,
  onChangeQty,
  onChangePrice,
  onIncrement,
  onDecrement,
  onRemove,
}: {
  product: Product;
  line: LineState;
  historyPrice?: number;
  onChangeBoxes: (n: number) => void;
  onChangePieces: (n: number) => void;
  onChangeQty: (n: number) => void;
  onChangePrice: (value: number | null) => void;
  onIncrement: () => void;
  onDecrement: () => void;
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

      <CartStepperRow
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
    marginTop: 6,
    textAlign: "right",
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
