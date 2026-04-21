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
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import {
  useCustomerPrices,
  useUpsertCustomerPrice,
  useDeleteCustomerPrice,
  type CustomerPrice,
} from "../../../../lib/api/customers";
import { useAdminProducts, type AdminProduct } from "../../../../lib/api/admin";
import { getTierPrice } from "../../../../lib/pricing";
import { showToast } from "../../../../lib/toast";

function fmt(n: number | string | undefined | null): string {
  const v = n == null ? 0 : typeof n === "string" ? Number(n) : n;
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

// ─── Add / Edit modal ─────────────────────────────────────────────────────────

interface EditModalProps {
  visible: boolean;
  customerId: string;
  existing: CustomerPrice | null;
  allProducts: AdminProduct[];
  onClose: () => void;
}

function EditTierOverrideModal({
  visible,
  customerId,
  existing,
  allProducts,
  onClose,
}: EditModalProps) {
  const [productId, setProductId] = useState(existing?.productId ?? "");
  const [productSearch, setProductSearch] = useState(existing?.product?.name ?? "");
  const [showPicker, setShowPicker] = useState(false);
  const [tier, setTier] = useState<number>(existing?.pricingTier ?? 1);
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const upsert = useUpsertCustomerPrice();

  const selectedProduct = useMemo(
    () => allProducts.find((p) => p.id === productId) ?? null,
    [allProducts, productId],
  );

  const filtered = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    if (!q) return allProducts.slice(0, 20);
    return allProducts
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.sku ?? "").toLowerCase().includes(q),
      )
      .slice(0, 20);
  }, [allProducts, productSearch]);

  const save = () => {
    if (!productId || !tier) {
      Alert.alert("Missing info", "Pick a product and a tier.");
      return;
    }
    upsert.mutate(
      { customerId, productId, pricingTier: tier, notes: notes.trim() || undefined },
      {
        onSuccess: () => {
          showToast(existing ? "Override updated" : "Override added");
          onClose();
        },
        onError: (e: unknown) => {
          const err = e as { response?: { data?: { message?: string } }; message?: string };
          Alert.alert(
            "Couldn't save",
            err?.response?.data?.message ?? err?.message ?? "Try again.",
          );
        },
      },
    );
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.modal}>
          <Text style={styles.modalTitle}>
            {existing ? "Edit Tier Override" : "Add Tier Override"}
          </Text>

          {/* Product picker */}
          <View style={{ gap: 6 }}>
            <Text style={styles.label}>Product</Text>
            {existing ? (
              <Text style={styles.lockedProduct}>{existing.product?.name ?? "—"}</Text>
            ) : (
              <>
                <TextInput
                  style={styles.input}
                  value={productSearch}
                  onChangeText={(t) => {
                    setProductSearch(t);
                    setShowPicker(true);
                    setProductId("");
                  }}
                  onFocus={() => setShowPicker(true)}
                  placeholder="Search by name or SKU…"
                  placeholderTextColor={ios.label3}
                />
                {showPicker && filtered.length > 0 && !productId ? (
                  <ScrollView
                    style={styles.picker}
                    keyboardShouldPersistTaps="handled"
                    nestedScrollEnabled
                  >
                    {filtered.map((p) => (
                      <Pressable
                        key={p.id}
                        style={styles.pickerRow}
                        onPress={() => {
                          setProductId(p.id);
                          setProductSearch(p.name);
                          setShowPicker(false);
                        }}
                      >
                        <Text style={styles.pickerName} numberOfLines={1}>
                          {p.name}
                        </Text>
                        {p.sku ? <Text style={styles.pickerSku}>{p.sku}</Text> : null}
                      </Pressable>
                    ))}
                  </ScrollView>
                ) : null}
              </>
            )}
          </View>

          {/* Tier selector */}
          <View style={{ gap: 6 }}>
            <Text style={styles.label}>Pricing Tier</Text>
            <View style={styles.tierRow}>
              {[1, 2, 3, 4, 5].map((t) => {
                const active = tier === t;
                const price = selectedProduct ? getTierPrice(selectedProduct, t) : null;
                return (
                  <Pressable
                    key={t}
                    style={[styles.tierBtn, active && styles.tierBtnActive]}
                    onPress={() => setTier(t)}
                  >
                    <Text style={[styles.tierBtnLabel, active && styles.tierBtnLabelActive]}>
                      {t}
                    </Text>
                    {price != null ? (
                      <Text
                        style={[styles.tierBtnPrice, active && styles.tierBtnPriceActive]}
                      >
                        {fmt(price)}
                      </Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
            {selectedProduct ? (
              <Text style={styles.tierHint}>
                Price at Tier {tier}:{" "}
                <Text style={styles.tierHintPrice}>
                  {fmt(getTierPrice(selectedProduct, tier))}
                </Text>
              </Text>
            ) : null}
          </View>

          {/* Notes */}
          <View style={{ gap: 6 }}>
            <Text style={styles.label}>Notes (optional)</Text>
            <TextInput
              style={[styles.input, { height: 60, textAlignVertical: "top" }]}
              value={notes}
              onChangeText={setNotes}
              placeholder="e.g. Contract price"
              placeholderTextColor={ios.label3}
              multiline
            />
          </View>

          <View style={styles.modalBtns}>
            <Pressable style={[styles.modalBtn, styles.modalBtnCancel]} onPress={onClose}>
              <Text style={styles.modalBtnCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.modalBtn, styles.modalBtnSave, upsert.isPending && { opacity: 0.6 }]}
              onPress={save}
              disabled={upsert.isPending || !productId}
            >
              <Text style={styles.modalBtnSaveText}>
                {upsert.isPending ? "Saving…" : "Save"}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function CustomerCatalogScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const customerId = id ?? "";

  const { data: prices, isLoading: pricesLoading } = useCustomerPrices(customerId);
  const { data: productsData, isLoading: productsLoading } = useAdminProducts({
    isActive: true,
    limit: 200,
  });
  const deleteMut = useDeleteCustomerPrice();

  const [editing, setEditing] = useState<CustomerPrice | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const isLoading = pricesLoading || productsLoading;
  const allProducts = productsData?.data ?? [];
  const priceList: CustomerPrice[] = prices ?? [];

  const handleDelete = (cp: CustomerPrice) => {
    Alert.alert(
      "Remove tier override?",
      `${cp.product?.name ?? "Product"} will revert to the customer's default tier.`,
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () =>
            deleteMut.mutate(
              { customerId, priceId: cp.id },
              {
                onSuccess: () => showToast("Override removed"),
                onError: () => Alert.alert("Error", "Couldn't remove. Try again."),
              },
            ),
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Tier overrides"
        leading={<NavBackButton label="Customer" onPress={() => router.back()} />}
      />

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false}>
          <View style={styles.hint}>
            <Ionicons name="information-circle-outline" size={14} color={ios.label2} />
            <Text style={styles.hintText}>
              Override the pricing tier for specific products for this customer. Only
              assigned overrides are listed.
            </Text>
          </View>

          {priceList.length === 0 ? (
            <View style={styles.emptyCard}>
              <Text style={styles.empty}>No tier overrides set.</Text>
              <Pressable onPress={() => setShowAdd(true)}>
                <Text style={styles.emptyLink}>Add the first one →</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.list}>
              {priceList.map((cp, i) => {
                const tierPrice = cp.product ? getTierPrice(cp.product, cp.pricingTier) : 0;
                const listPrice = cp.product?.pricePerUnit;
                const isLast = i === priceList.length - 1;
                return (
                  <Pressable
                    key={cp.id}
                    style={[styles.row, !isLast && styles.rowBorder]}
                    onPress={() => setEditing(cp)}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.productName} numberOfLines={1}>
                        {cp.product?.name ?? "—"}
                      </Text>
                      <Text style={styles.productSku}>
                        {cp.product?.sku ? `${cp.product.sku} · ` : ""}
                        List {fmt(listPrice)}
                        {cp.notes ? ` · ${cp.notes}` : ""}
                      </Text>
                    </View>
                    <View style={styles.priceCol}>
                      <View style={styles.tierBadge}>
                        <Text style={styles.tierBadgeText}>Tier {cp.pricingTier}</Text>
                      </View>
                      <Text style={styles.tierPriceText}>{fmt(tierPrice)}</Text>
                    </View>
                    <Pressable
                      hitSlop={10}
                      style={styles.trashBtn}
                      onPress={() => handleDelete(cp)}
                    >
                      <Ionicons name="trash-outline" size={16} color={ios.system.red} />
                    </Pressable>
                  </Pressable>
                );
              })}
            </View>
          )}

          <Pressable style={styles.addBtn} onPress={() => setShowAdd(true)}>
            <Ionicons name="add-circle-outline" size={18} color={ios.brand} />
            <Text style={styles.addBtnText}>Add override</Text>
          </Pressable>

          <View style={{ height: 24 }} />
        </ScrollView>
      )}

      {showAdd ? (
        <EditTierOverrideModal
          visible
          customerId={customerId}
          existing={null}
          allProducts={allProducts}
          onClose={() => setShowAdd(false)}
        />
      ) : null}

      {editing ? (
        <EditTierOverrideModal
          visible
          customerId={customerId}
          existing={editing}
          allProducts={allProducts}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  hint: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  hintText: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, flex: 1 },

  emptyCard: {
    marginHorizontal: 16,
    marginTop: 4,
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    paddingVertical: 32,
    alignItems: "center",
    gap: 8,
  },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },
  emptyLink: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.brand },

  list: {
    marginHorizontal: 16,
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  rowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  productName: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label },
  productSku: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  priceCol: { alignItems: "flex-end", gap: 2 },
  tierBadge: {
    backgroundColor: ios.brandWash,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  tierBadgeText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.brand,
  },
  tierPriceText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  trashBtn: {
    padding: 6,
    marginLeft: 2,
  },

  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginHorizontal: 16,
    marginTop: 14,
    paddingVertical: 14,
    backgroundColor: ios.brandWash,
    borderRadius: 12,
  },
  addBtnText: { color: ios.brand, fontSize: 15, fontFamily: "Inter_600SemiBold" },

  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  modal: {
    backgroundColor: ios.bgElev,
    borderRadius: 18,
    padding: 18,
    width: "100%",
    gap: 14,
  },
  modalTitle: { fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label, textAlign: "center" },
  label: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label2 },
  input: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label,
  },
  lockedProduct: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: ios.label,
    paddingVertical: 8,
  },
  picker: {
    maxHeight: 160,
    backgroundColor: ios.fill3,
    borderRadius: 10,
  },
  pickerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  pickerName: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label, flex: 1 },
  pickerSku: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },

  tierRow: {
    flexDirection: "row",
    gap: 6,
  },
  tierBtn: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: ios.fill3,
    gap: 2,
  },
  tierBtnActive: { backgroundColor: ios.brand },
  tierBtnLabel: { fontSize: 14, fontFamily: "Inter_700Bold", color: ios.label },
  tierBtnLabelActive: { color: "#fff" },
  tierBtnPrice: {
    fontSize: 10,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
    fontVariant: ["tabular-nums"],
  },
  tierBtnPriceActive: { color: "#fff" },
  tierHint: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  tierHintPrice: { color: ios.brand, fontFamily: "Inter_600SemiBold" },

  modalBtns: { flexDirection: "row", gap: 10, marginTop: 4 },
  modalBtn: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  modalBtnCancel: { backgroundColor: ios.fill3 },
  modalBtnCancelText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  modalBtnSave: { backgroundColor: ios.brand },
  modalBtnSaveText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#fff" },
});
