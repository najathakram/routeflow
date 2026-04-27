import { useMemo, useState } from "react";
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
import {
  NavAction,
  NavBackButton,
  NavBar,
  SearchBar,
} from "@routeflow/ui/mobile/ios";
import { useAdminCustomers } from "../lib/api/admin";
import { useProducts } from "../lib/api/products";
import { useCreateOrderAsDriver, useUpdateOrderItems } from "../lib/api/orders";
import { showToast } from "../lib/toast";

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
  unit?: string;
  pricePerUnit: number | string;
  category?: string | null;
};

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
            showToast(`Order ${orderNumber} created`);
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
      <SearchBar
        placeholder="Search customers…"
        value={search}
        onChangeText={setSearch}
      />
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

type PriceOverride = { unitPrice: number; reason?: string };

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
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [items, setItems] = useState<Record<string, number>>({});
  const [overrides, setOverrides] = useState<Record<string, PriceOverride>>({});
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);

  const { data: productsData, isLoading: productsLoading } = useProducts({
    search: search.trim() || undefined,
    limit: 200,
  });
  const products: Product[] = productsData?.data ?? [];

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) if (p.category) set.add(p.category);
    return ["All", ...Array.from(set).slice(0, 6)];
  }, [products]);

  const filtered = useMemo(() => {
    if (category === "All") return products;
    return products.filter((p) => p.category === category);
  }, [products, category]);

  const totalItems = Object.values(items).reduce((a, b) => a + b, 0);
  const total = products.reduce((sum, p) => {
    const q = items[p.id] ?? 0;
    const price = overrides[p.id]?.unitPrice ?? toNumber(p.pricePerUnit);
    return sum + q * price;
  }, 0);

  const inc = (id: string) =>
    setItems((m) => ({ ...m, [id]: (m[id] ?? 0) + 1 }));
  const dec = (id: string) =>
    setItems((m) => ({ ...m, [id]: Math.max(0, (m[id] ?? 0) - 1) }));

  const createOrder = useCreateOrderAsDriver();
  const updateItems = useUpdateOrderItems();

  const isSaving = createOrder.isPending || updateItems.isPending;
  const canSave = totalItems > 0 && !isSaving;

  const onSave = () => {
    const itemPayload = Object.entries(items)
      .filter(([, q]) => q > 0)
      .map(([productId, qty]) => ({ productId, qty }));

    if (itemPayload.length === 0) {
      Alert.alert("Add at least one item", "Tap + on any product to start the order.");
      return;
    }

    const hasOverrides = itemPayload.some(({ productId }) => overrides[productId]);

    createOrder.mutate(
      {
        customerId,
        items: itemPayload,
        routeRunId: runId,
        routeRunStopId: stopId,
      },
      {
        onSuccess: (order) => {
          if (!hasOverrides) {
            onSaved(order.orderNumber);
            return;
          }
          const patchItems = itemPayload.map(({ productId, qty }) => {
            const ov = overrides[productId];
            const catalogPrice = toNumber(products.find((p) => p.id === productId)?.pricePerUnit ?? 0);
            return {
              productId,
              qty,
              unitPrice: ov?.unitPrice ?? catalogPrice,
              overrideReason: ov?.reason,
            };
          });
          updateItems.mutate(
            { orderId: order.id, items: patchItems },
            {
              onSuccess: () => onSaved(order.orderNumber),
              onError: () => onSaved(order.orderNumber), // order created — don't block navigation
            },
          );
        },
        onError: (err: Error) => {
          const msg =
            (err as unknown as { response?: { data?: { message?: string } } })
              ?.response?.data?.message ?? err?.message ?? "Unable to save order.";
          Alert.alert("Couldn't save order", String(msg));
        },
      },
    );
  };

  return (
    <>
      <NavBar
        inlineTitle="New order"
        leading={
          <NavBackButton
            label={backLabel ?? customerName ?? "Back"}
            onPress={onBack}
          />
        }
        trailing={
          <NavAction
            label={isSaving ? "Saving…" : "Save"}
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
          {customerLocked ? null : (
            <Text style={styles.customerChipChange}>Change</Text>
          )}
        </Pressable>
      </View>

      <ScrollView showsVerticalScrollIndicator={false}>
        <SearchBar
          placeholder="Search items…"
          value={search}
          onChangeText={setSearch}
          trailing={<Ionicons name="barcode-outline" size={18} color={ios.label2} />}
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
            <Text style={styles.emptyText}>
              No products{search ? " match your search" : ""}.
            </Text>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, paddingTop: 14, gap: 10 }}>
            {filtered.map((p) => {
              const q = items[p.id] ?? 0;
              const catalogPrice = toNumber(p.pricePerUnit);
              const ov = overrides[p.id];
              const displayPrice = ov?.unitPrice ?? catalogPrice;
              return (
                <View key={p.id} style={styles.productRow}>
                  <View style={styles.productImg} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.productName} numberOfLines={1}>
                      {p.name}
                    </Text>
                    <View style={styles.priceRow}>
                      {ov ? (
                        <>
                          <Text style={styles.productMetaStrike}>
                            ${catalogPrice.toFixed(2)}
                          </Text>
                          <Text style={styles.productMetaOverride}>
                            ${ov.unitPrice.toFixed(2)}
                          </Text>
                        </>
                      ) : (
                        <Text style={styles.productMeta}>
                          {p.sku ? `SKU ${p.sku} · ` : ""}${displayPrice.toFixed(2)}
                          {p.unit ? ` / ${p.unit}` : ""}
                        </Text>
                      )}
                      <Pressable
                        style={styles.pencilBtn}
                        onPress={() => setEditingProduct(p)}
                        hitSlop={8}
                      >
                        <Ionicons name="pencil-outline" size={12} color={ios.label3} />
                      </Pressable>
                    </View>
                  </View>
                  {q > 0 ? (
                    <View style={styles.stepper}>
                      <Pressable style={styles.stepBtn} onPress={() => dec(p.id)}>
                        <Text style={styles.stepBtnText}>−</Text>
                      </Pressable>
                      <Text style={styles.stepQty}>{q}</Text>
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
          <View>
            <Text style={styles.footerEyebrow}>
              {totalItems} ITEM{totalItems === 1 ? "" : "S"}
            </Text>
            <Text style={styles.footerTotal}>${total.toFixed(2)}</Text>
          </View>
          <Pressable
            style={[
              styles.confirmBtn,
              (!canSave || isSaving) && styles.confirmBtnDisabled,
            ]}
            disabled={!canSave}
            onPress={onSave}
          >
            <Text style={styles.confirmBtnText}>
              {isSaving ? "Saving…" : "Confirm order"}
            </Text>
            <Ionicons name="arrow-forward" size={14} color="#fff" />
          </Pressable>
        </View>
      </View>

      {editingProduct ? (
        <PriceEditModal
          product={editingProduct}
          current={overrides[editingProduct.id]}
          onApply={(unitPrice, reason) => {
            setOverrides((m) => ({ ...m, [editingProduct.id]: { unitPrice, reason } }));
            setEditingProduct(null);
          }}
          onReset={() => {
            setOverrides((m) => {
              const next = { ...m };
              delete next[editingProduct.id];
              return next;
            });
            setEditingProduct(null);
          }}
          onClose={() => setEditingProduct(null)}
        />
      ) : null}
    </>
  );
}

// ─────────────────────── Price edit modal ───────────────────────

function PriceEditModal({
  product,
  current,
  onApply,
  onReset,
  onClose,
}: {
  product: Product;
  current?: PriceOverride;
  onApply: (unitPrice: number, reason?: string) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const catalogPrice = toNumber(product.pricePerUnit);
  const [priceText, setPriceText] = useState(
    current ? String(current.unitPrice) : String(catalogPrice),
  );
  const [reason, setReason] = useState(current?.reason ?? "");

  const apply = () => {
    const num = parseFloat(priceText);
    if (!Number.isFinite(num) || num < 0) return;
    onApply(num, reason.trim() || undefined);
  };

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.priceSheet} onPress={() => {}}>
          <Text style={styles.priceSheetTitle}>
            Override price — {product.name}
          </Text>
          <Text style={styles.priceSheetSub}>
            Catalog price: ${catalogPrice.toFixed(2)}
          </Text>
          <TextInput
            style={styles.priceInput}
            value={priceText}
            onChangeText={setPriceText}
            keyboardType="decimal-pad"
            selectTextOnFocus
            placeholder="0.00"
            placeholderTextColor={ios.label3}
          />
          <TextInput
            style={[styles.priceInput, { marginTop: 8, fontSize: 14 }]}
            value={reason}
            onChangeText={setReason}
            placeholder="Reason (optional)"
            placeholderTextColor={ios.label3}
            returnKeyType="done"
          />
          <View style={styles.priceSheetActions}>
            {current ? (
              <Pressable style={styles.priceResetBtn} onPress={onReset}>
                <Text style={styles.priceResetText}>Reset</Text>
              </Pressable>
            ) : null}
            <Pressable style={styles.priceApplyBtn} onPress={apply}>
              <Text style={styles.priceApplyText}>Apply</Text>
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
  confirmBtnDisabled: { opacity: 0.55 },
  confirmBtnText: { color: "#fff", fontSize: 16, fontFamily: "Inter_600SemiBold" },
  priceRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 1 },
  productMetaStrike: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label3,
    textDecorationLine: "line-through",
    fontVariant: ["tabular-nums"],
  },
  productMetaOverride: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.system.orangeInk,
    fontVariant: ["tabular-nums"],
  },
  pencilBtn: { padding: 2 },
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  priceSheet: {
    backgroundColor: ios.bg,
    borderRadius: 16,
    padding: 20,
    width: "100%",
    maxWidth: 380,
  },
  priceSheetTitle: { fontSize: 16, fontFamily: "Inter_700Bold", color: ios.label, marginBottom: 4 },
  priceSheetSub: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginBottom: 14 },
  priceInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    backgroundColor: ios.bgElev,
    fontVariant: ["tabular-nums"],
  },
  priceSheetActions: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 16 },
  priceResetBtn: { paddingHorizontal: 16, paddingVertical: 10 },
  priceResetText: { color: ios.system.red, fontSize: 15, fontFamily: "Inter_500Medium" },
  priceApplyBtn: { backgroundColor: ios.brand, borderRadius: 10, paddingHorizontal: 20, paddingVertical: 10 },
  priceApplyText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
});
