import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import { useCreateOrderAsDriver, useActiveOrderForCustomer } from "../lib/api/orders";
import { showToast } from "../lib/toast";
import { resolveProductByCode } from "../lib/barcode-resolve";
import { computeLineSubtotal, effectiveQty } from "../lib/pricing";
import { useAuthStore } from "../lib/auth-store";
import { BarcodeScanner } from "./BarcodeScanner";

export interface NewOrderScreenProps {
  /** When present, customer is locked (e.g. invoked from a specific stop). */
  customerId?: string;
  customerName?: string;
  /** When present, the order is linked to this run/stop on the backend. */
  runId?: string;
  stopId?: string;
  /** Label shown on the back button. */
  backLabel?: string;
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
};

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

export function NewOrderScreen({
  customerId: initialCustomerId,
  customerName: initialCustomerName,
  runId,
  stopId,
  backLabel,
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

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      {needsCustomer ? (
        <CustomerPickerView
          backLabel={backLabel}
          onBack={() => router.back()}
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
          onBack={() => router.back()}
          onChangeCustomer={() => {
            setPickedCustomerId(null);
            setPickedCustomerName(null);
          }}
          onSaved={(orderNumber: string) => {
            showToast(`Order ${orderNumber} saved`);
            router.back();
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
  const [scanOpen, setScanOpen] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  /**
   * Products discovered via barcode scan that aren't in the locally-cached
   * product list (e.g. beyond the 200-item page, or filtered out by the
   * current search). Without this, scanned items wouldn't contribute to the
   * running total or appear in the cart review (see user feedback: "the
   * actual cost of the order is not updating … while scanning items").
   */
  const [scannedById, setScannedById] = useState<Record<string, Product>>({});

  const { data: productsData, isLoading: productsLoading } = useProducts({
    search: search.trim() || undefined,
    limit: 200,
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
    setItems((m) => {
      const prev = m[id] ?? { qty: 0 };
      if (isBoxed) {
        const boxes = (prev.boxes ?? 0) + 1;
        const pieces = prev.pieces ?? 0;
        return { ...m, [id]: { qty: boxes * upb + pieces, boxes, pieces } };
      }
      return { ...m, [id]: { qty: (prev.qty ?? 0) + 1 } };
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
      showToast(`Added ${displayName(local)}`);
      return;
    }

    // 2) Server fallback: barcode → exact SKU → name/SKU substring → notFound.
    try {
      const result = await resolveProductByCode<Product>(trimmed);
      if (!result.notFound && result.product?.id) {
        addOne(result.product.id, result.product);
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
      Alert.alert(
        `No product for "${trimmed}"`,
        "Add it as a new product? (Your in-progress order won't be saved if you continue.)",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Create",
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
        unitPrice: toNumber(p.pricePerUnit),
        qty,
        boxes: line.boxes ?? null,
        pieces: line.pieces ?? null,
        unitsPerBox: p.unitsPerBox ?? null,
      });
    }
    return { total, totalItems };
  }, [items, productById]);

  const inc = (id: string) => addOne(id);
  const dec = (id: string) => removeOne(id);

  const createOrder = useCreateOrderAsDriver();
  // Pre-check the customer's open draft/pending order so we can ask before submitting.
  const { data: activeOrder } = useActiveOrderForCustomer(customerId);

  const canSave = totalItems > 0 && !createOrder.isPending;

  /** Submit with a specific (or no) merge choice. */
  const submitOrder = (mergeChoice?: 'merge' | 'separate') => {
    const itemPayload = Object.entries(items)
      .map(([productId, line]) => {
        const p = productById.get(productId);
        const qty = effectiveQty(line, p?.unitsPerBox);
        const base = { productId, qty };
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
      .filter((it) => it.qty > 0);

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
          if (mergeChoice === 'merge') {
            showToast(`Merged into order ${order.orderNumber}`);
          }
          onSaved(order.orderNumber);
        },
        onError: (err: Error) => {
          const errAny = err as unknown as {
            response?: { status?: number; data?: { message?: string; code?: string; activeOrder?: any } };
          };
          // Belt-and-braces: if the API reports 409 MERGE_CHOICE_REQUIRED (e.g. the
          // pre-check missed a race), prompt the operator now from the error response.
          const body = errAny?.response?.data;
          if (errAny?.response?.status === 409 && body?.code === 'MERGE_CHOICE_REQUIRED' && body?.activeOrder) {
            promptMergeChoice(body.activeOrder);
            return;
          }
          const msg = body?.message ?? err?.message ?? "Unable to save order.";
          Alert.alert("Couldn't save order", String(msg));
        },
      },
    );
  };

  const promptMergeChoice = (existing: { orderNumber: string | null; itemCount: number; total: number }) => {
    Alert.alert(
      "Open order exists",
      `This customer has an open order ${existing.orderNumber ?? ""} with ${existing.itemCount} item${existing.itemCount === 1 ? "" : "s"} ($${existing.total.toFixed(2)}). Merge into it or create a separate order?`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Merge", onPress: () => submitOrder('merge') },
        { text: "Create separate", onPress: () => submitOrder('separate') },
      ],
      { cancelable: true },
    );
  };

  const onSave = () => {
    if (totalItems === 0) {
      Alert.alert("Add at least one item", "Tap + on any product to start the order.");
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

      <ScrollView showsVerticalScrollIndicator={false}>
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

        {productsLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : filtered.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyText}>No products{search ? " match your search" : ""}.</Text>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, paddingTop: 14, gap: 10 }}>
            {filtered.map((p) => {
              const line = items[p.id];
              const q = line ? effectiveQty(line, p.unitsPerBox) : 0;
              const price = toNumber(p.pricePerUnit);
              const upb = Number(p.unitsPerBox ?? 0);
              const isBoxed = upb > 1;
              const stepLabel = isBoxed
                ? `${line?.boxes ?? 0} box${(line?.boxes ?? 0) === 1 ? "" : "es"}${
                    (line?.pieces ?? 0) > 0 ? ` + ${line?.pieces ?? 0}` : ""
                  }`
                : `${q}`;
              return (
                <View key={p.id} style={styles.productRow}>
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
                  {q > 0 ? (
                    <View style={styles.stepper}>
                      <Pressable style={styles.stepBtn} onPress={() => dec(p.id)}>
                        <Text style={styles.stepBtnText}>−</Text>
                      </Pressable>
                      <Text style={styles.stepQty}>{stepLabel}</Text>
                      <Pressable style={styles.stepBtn} onPress={() => inc(p.id)}>
                        <Text style={styles.stepBtnText}>+</Text>
                      </Pressable>
                    </View>
                  ) : (
                    <Pressable style={styles.addBtn} onPress={() => inc(p.id)}>
                      <Text style={styles.addBtnText}>+</Text>
                    </Pressable>
                  )}
                </View>
              );
            })}
          </View>
        )}
        <View style={{ height: 16 }} />
      </ScrollView>

      <View style={styles.footer}>
        <View style={styles.footerRow}>
          {/* Tap the running total to open the cart review. The hint nudges
              the operator that there's more to see — they were missing the
              ability to inspect/adjust before confirming. */}
          <Pressable
            style={styles.footerTotalTap}
            onPress={totalItems > 0 ? () => setCartOpen(true) : undefined}
            disabled={totalItems === 0}
            hitSlop={6}
          >
            <Text style={styles.footerEyebrow}>
              {totalItems} ITEM{totalItems === 1 ? "" : "S"}
              {totalItems > 0 ? " · TAP TO REVIEW" : ""}
            </Text>
            <Text style={styles.footerTotal}>${total.toFixed(2)}</Text>
          </Pressable>
          <View style={{ alignItems: "flex-end" }}>
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
                {createOrder.isPending ? "Saving…" : "Confirm order"}
              </Text>
              <Ionicons name="arrow-forward" size={14} color="#fff" />
            </Pressable>
            {totalItems === 0 && !createOrder.isPending ? (
              <Text style={{ color: ios.label3, fontSize: 12, marginTop: 4 }}>
                Add at least one item
              </Text>
            ) : null}
          </View>
        </View>
      </View>

      {scanOpen ? (
        <BarcodeScanner
          onScanned={handleBarcodeScanned}
          onClose={() => setScanOpen(false)}
        />
      ) : null}

      <CartModal
        open={cartOpen}
        items={items}
        productById={productById}
        total={total}
        totalItems={totalItems}
        saving={createOrder.isPending}
        onClose={() => setCartOpen(false)}
        onChangeBoxes={setBoxes}
        onChangePieces={setPieces}
        onChangeQty={setQty}
        onIncrement={addOne}
        onDecrement={removeOne}
        onRemove={removeLine}
        onSave={() => {
          setCartOpen(false);
          onSave();
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
  total,
  totalItems,
  saving,
  onClose,
  onChangeBoxes,
  onChangePieces,
  onChangeQty,
  onIncrement,
  onDecrement,
  onRemove,
  onSave,
}: {
  open: boolean;
  items: Record<string, LineState>;
  productById: Map<string, Product>;
  total: number;
  totalItems: number;
  saving: boolean;
  onClose: () => void;
  onChangeBoxes: (id: string, n: number) => void;
  onChangePieces: (id: string, n: number) => void;
  onChangeQty: (id: string, n: number) => void;
  onIncrement: (id: string) => void;
  onDecrement: (id: string) => void;
  onRemove: (id: string) => void;
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
    <Modal
      visible={open}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
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
            {rows.length === 0 ? (
              <View style={[styles.center, { paddingVertical: 40 }]}>
                <Text style={styles.emptyText}>Cart is empty.</Text>
              </View>
            ) : (
              rows.map(({ id, product, line }) => (
                <CartRow
                  key={id}
                  product={product}
                  line={line}
                  onChangeBoxes={(n) => onChangeBoxes(id, n)}
                  onChangePieces={(n) => onChangePieces(id, n)}
                  onChangeQty={(n) => onChangeQty(id, n)}
                  onIncrement={() => onIncrement(id)}
                  onDecrement={() => onDecrement(id)}
                  onRemove={() => onRemove(id)}
                />
              ))
            )}
          </ScrollView>

          {/* Sticky footer: total + actions */}
          <View style={styles.cartFooter}>
            <View style={styles.cartFooterRow}>
              <View>
                <Text style={styles.footerEyebrow}>ORDER TOTAL</Text>
                <Text style={styles.footerTotal}>${total.toFixed(2)}</Text>
              </View>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Pressable
                  style={styles.cartContinueBtn}
                  onPress={onClose}
                  hitSlop={6}
                >
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
                    {saving ? "Saving…" : "Save order"}
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

function CartRow({
  product,
  line,
  onChangeBoxes,
  onChangePieces,
  onChangeQty,
  onIncrement,
  onDecrement,
  onRemove,
}: {
  product: Product;
  line: LineState;
  onChangeBoxes: (n: number) => void;
  onChangePieces: (n: number) => void;
  onChangeQty: (n: number) => void;
  onIncrement: () => void;
  onDecrement: () => void;
  onRemove: () => void;
}) {
  const upb = Number(product.unitsPerBox ?? 0);
  const isBoxed = upb > 1;
  const unitPrice = toNumber(product.pricePerUnit);
  const qty = effectiveQty(line, product.unitsPerBox);
  const lineTotal = computeLineSubtotal({
    unitPrice,
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
            ${unitPrice.toFixed(2)}
            {isBoxed ? ` / box of ${upb}` : product.unit ? ` / ${product.unit}` : ""}
            {product.sku ? ` · ${product.sku}` : ""}
          </Text>
        </View>
        <Pressable onPress={onRemove} hitSlop={8} style={styles.cartRowRemove}>
          <Ionicons name="trash-outline" size={18} color={ios.system.redInk} />
        </Pressable>
      </View>

      {isBoxed ? (
        <>
          <CartStepperRow
            label="Boxes"
            value={line.boxes ?? 0}
            onChange={onChangeBoxes}
          />
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
            // accept digits only; live-commit when valid; allow empty mid-edit
            if (/^\d*$/.test(txt)) {
              setDraft(txt);
              if (txt === "") return;
              const n = Number(txt);
              if (Number.isFinite(n)) {
                const clamped = max != null ? Math.min(max, n) : n;
                onChange(clamped);
              }
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
});
