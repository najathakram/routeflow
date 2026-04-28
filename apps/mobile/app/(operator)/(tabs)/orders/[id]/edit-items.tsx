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
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import {
  NavAction,
  NavBackButton,
  NavBar,
  SearchBar,
} from "@routeflow/ui/mobile/ios";
import { useAdminOrder } from "../../../../../lib/api/admin";
import { useUpdateOrderItems } from "../../../../../lib/api/orders";
import { useProducts } from "../../../../../lib/api/products";
import { showToast } from "../../../../../lib/toast";

type DraftItem = {
  productId: string;
  qty: number;
  unitPrice: number;
  catalogPrice: number;
  name: string;
  unit?: string;
  overrideReason?: string;
};

function toNumber(v: number | string | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export default function EditOrderItemsScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: order, isLoading } = useAdminOrder(id ?? "");
  const [draft, setDraft] = useState<Record<string, DraftItem>>({});
  const [showPicker, setShowPicker] = useState(false);
  const [substituteFor, setSubstituteFor] = useState<string | null>(null);
  const [priceEditItem, setPriceEditItem] = useState<DraftItem | null>(null);
  const updateMut = useUpdateOrderItems();

  useEffect(() => {
    if (!order) return;
    const next: Record<string, DraftItem> = {};
    for (const li of order.lineItems) {
      const catalogPrice = toNumber((li as any).product?.pricePerUnit ?? li.unitPrice);
      next[li.productId] = {
        productId: li.productId,
        qty: toNumber(li.qty),
        unitPrice: toNumber(li.unitPrice),
        catalogPrice,
        name: li.product?.name ?? "Item",
        unit: li.product?.unit,
        overrideReason: (li as any).overrideReason ?? undefined,
      };
    }
    setDraft(next);
  }, [order]);

  const totalCents = useMemo(
    () =>
      Math.round(
        Object.values(draft).reduce((sum, it) => sum + it.qty * it.unitPrice * 100, 0),
      ),
    [draft],
  );
  const total = totalCents / 100;

  const save = () => {
    if (!id) return;
    const items = Object.values(draft)
      .filter((i) => i.qty > 0)
      .map((i) => ({
        productId: i.productId,
        qty: i.qty,
        unitPrice: i.unitPrice,
        ...(i.overrideReason ? { overrideReason: i.overrideReason } : {}),
      }));
    if (items.length === 0) {
      Alert.alert("Add at least one item", "Orders can't be saved empty.");
      return;
    }
    updateMut.mutate(
      { orderId: id, items },
      {
        onSuccess: () => {
          showToast("Items updated");
          router.back();
        },
        onError: (e: any) =>
          Alert.alert("Couldn't save", e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  if (isLoading || !order) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Edit items"
          leading={<NavBackButton onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Edit items"
        leading={<NavBackButton label={order.orderNumber} onPress={() => router.back()} />}
        trailing={
          <NavAction
            label={updateMut.isPending ? "Saving…" : "Save"}
            bold
            onPress={updateMut.isPending ? undefined : save}
          />
        }
      />

      {/* Price override modal */}
      {priceEditItem ? (
        <PriceOverrideModal
          item={priceEditItem}
          onSave={(newPrice, reason) => {
            setDraft((d) => ({
              ...d,
              [priceEditItem.productId]: {
                ...priceEditItem,
                unitPrice: newPrice,
                overrideReason: reason || undefined,
              },
            }));
            setPriceEditItem(null);
          }}
          onCancel={() => setPriceEditItem(null)}
        />
      ) : null}

      {showPicker ? (
        <ProductPicker
          title={substituteFor ? "Substitute with…" : "Add product"}
          onPick={(p) => {
            const catalogPrice = toNumber(p.pricePerUnit);
            if (substituteFor) {
              // Replace the old product with the new one, preserving qty
              setDraft((d) => {
                const next = { ...d };
                const old = next[substituteFor];
                const inheritedQty = old?.qty ?? 1;
                delete next[substituteFor];
                next[p.id] = {
                  productId: p.id,
                  qty: inheritedQty,
                  unitPrice: catalogPrice,
                  catalogPrice,
                  name: p.name,
                  unit: p.unit,
                };
                return next;
              });
              setSubstituteFor(null);
            } else {
              setDraft((d) => ({
                ...d,
                [p.id]: {
                  productId: p.id,
                  qty: (d[p.id]?.qty ?? 0) + 1,
                  unitPrice: d[p.id]?.unitPrice ?? catalogPrice,
                  catalogPrice,
                  name: p.name,
                  unit: p.unit,
                  overrideReason: d[p.id]?.overrideReason,
                },
              }));
            }
            setShowPicker(false);
          }}
          onClose={() => { setShowPicker(false); setSubstituteFor(null); }}
        />
      ) : (
        <>
          <ScrollView showsVerticalScrollIndicator={false}>
            <View style={{ padding: 16, gap: 8 }}>
              {Object.values(draft).length === 0 ? (
                <Text style={styles.empty}>No items. Add one below.</Text>
              ) : (
                Object.values(draft).map((it) => {
                  const isOverridden = it.unitPrice !== it.catalogPrice;
                  return (
                    <View key={it.productId} style={styles.row}>
                      {/* Delete item */}
                      <Pressable
                        style={styles.deleteBtn}
                        onPress={() =>
                          Alert.alert("Remove item?", it.name, [
                            { text: "Keep", style: "cancel" },
                            {
                              text: "Remove",
                              style: "destructive",
                              onPress: () =>
                                setDraft((d) => {
                                  const next = { ...d };
                                  delete next[it.productId];
                                  return next;
                                }),
                            },
                          ])
                        }
                        hitSlop={4}
                      >
                        <Ionicons name="trash-outline" size={16} color={ios.system.red} />
                      </Pressable>

                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.name} numberOfLines={1}>
                          {it.name}
                        </Text>
                        {/* Price + override + substitute row */}
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 3 }}>
                          <Pressable
                            onPress={() => setPriceEditItem(it)}
                            style={styles.priceRow}
                            hitSlop={8}
                          >
                            {isOverridden ? (
                              <Text style={styles.priceStrike}>
                                ${it.catalogPrice.toFixed(2)}
                              </Text>
                            ) : null}
                            <Text
                              style={[styles.sub, isOverridden && { color: ios.system.orange }]}
                            >
                              ${it.unitPrice.toFixed(2)}
                              {it.unit ? ` / ${it.unit}` : ""}
                            </Text>
                            <Ionicons
                              name="pencil-outline"
                              size={12}
                              color={isOverridden ? ios.system.orange : ios.label3}
                            />
                          </Pressable>
                          <Pressable
                            style={styles.subBtn}
                            onPress={() => {
                              // Open product picker in substitute mode
                              setSubstituteFor(it.productId);
                              setShowPicker(true);
                            }}
                            hitSlop={4}
                          >
                            <Ionicons name="swap-horizontal-outline" size={12} color={ios.brand} />
                            <Text style={styles.subBtnText}>Sub</Text>
                          </Pressable>
                        </View>
                      </View>

                      {/* Stepper with typeable qty */}
                      <View style={styles.stepper}>
                        <Pressable
                          style={styles.stepBtn}
                          onPress={() =>
                            setDraft((d) => {
                              const next = { ...d };
                              const cur = next[it.productId];
                              if (!cur) return next;
                              const q = Math.max(0, cur.qty - 1);
                              if (q === 0) delete next[it.productId];
                              else next[it.productId] = { ...cur, qty: q };
                              return next;
                            })
                          }
                        >
                          <Text style={styles.stepText}>−</Text>
                        </Pressable>
                        <TextInput
                          style={styles.qtyInput}
                          value={String(it.qty)}
                          onChangeText={(val) => {
                            const n = parseInt(val, 10);
                            if (!isNaN(n) && n > 0) {
                              setDraft((d) => ({ ...d, [it.productId]: { ...it, qty: n } }));
                            } else if (val === "" || val === "0") {
                              setDraft((d) => {
                                const next = { ...d };
                                delete next[it.productId];
                                return next;
                              });
                            }
                          }}
                          keyboardType="number-pad"
                          selectTextOnFocus
                        />
                        <Pressable
                          style={styles.stepBtn}
                          onPress={() =>
                            setDraft((d) => ({
                              ...d,
                              [it.productId]: { ...it, qty: Number(it.qty) + 1 },
                            }))
                          }
                        >
                          <Text style={styles.stepText}>+</Text>
                        </Pressable>
                      </View>
                    </View>
                  );
                })
              )}
              <Pressable style={styles.addBtn} onPress={() => setShowPicker(true)}>
                <Ionicons name="add-circle-outline" size={18} color={ios.brand} />
                <Text style={styles.addBtnText}>Add product</Text>
              </Pressable>
            </View>
          </ScrollView>

          <View style={styles.footer}>
            <View>
              <Text style={styles.footerEyebrow}>TOTAL</Text>
              <Text style={styles.footerTotal}>${total.toFixed(2)}</Text>
            </View>
            <Pressable
              style={[styles.saveBtn, updateMut.isPending && styles.saveBtnDisabled]}
              onPress={save}
              disabled={updateMut.isPending}
            >
              <Text style={styles.saveBtnText}>
                {updateMut.isPending ? "Saving…" : "Save changes"}
              </Text>
            </Pressable>
          </View>
        </>
      )}
    </SafeAreaView>
  );
}

function PriceOverrideModal({
  item,
  onSave,
  onCancel,
}: {
  item: DraftItem;
  onSave: (newPrice: number, reason: string) => void;
  onCancel: () => void;
}) {
  const [priceText, setPriceText] = useState(item.unitPrice.toFixed(2));
  const [reason, setReason] = useState(item.overrideReason ?? "");
  const newPrice = toNumber(priceText);
  const valid = newPrice > 0;

  return (
    <Modal transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={styles.modalOverlay} onPress={onCancel}>
        <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.modalTitle}>Override price</Text>
          <Text style={styles.modalSub}>{item.name}</Text>
          <Text style={styles.modalLabel}>List price: ${item.catalogPrice.toFixed(2)}</Text>

          <Text style={styles.modalFieldLabel}>New unit price</Text>
          <TextInput
            style={styles.modalInput}
            value={priceText}
            onChangeText={setPriceText}
            keyboardType="decimal-pad"
            selectTextOnFocus
            autoFocus
            placeholder="0.00"
            placeholderTextColor={ios.label3}
          />

          <Text style={styles.modalFieldLabel}>Reason (optional)</Text>
          <TextInput
            style={[styles.modalInput, { marginBottom: 16 }]}
            value={reason}
            onChangeText={setReason}
            placeholder="e.g. daily market price"
            placeholderTextColor={ios.label3}
          />

          <View style={styles.modalBtns}>
            <Pressable style={styles.modalBtnGhost} onPress={onCancel}>
              <Text style={styles.modalBtnGhostText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.modalBtnFill, !valid && styles.modalBtnDisabled]}
              onPress={() => valid && onSave(newPrice, reason)}
              disabled={!valid}
            >
              <Text style={styles.modalBtnFillText}>Apply</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ProductPicker({
  title = "Add product",
  onPick,
  onClose,
}: {
  title?: string;
  onPick: (p: { id: string; name: string; pricePerUnit: number | string; unit?: string }) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useProducts({ search: search.trim() || undefined });
  const products = (data?.data ?? []) as Array<{
    id: string;
    name: string;
    sku?: string;
    unit?: string;
    pricePerUnit: number | string;
  }>;

  return (
    <>
      <NavBar
        inlineTitle={title}
        leading={<NavBackButton label="Cancel" onPress={onClose} />}
      />
      <SearchBar placeholder="Search products…" value={search} onChangeText={setSearch} />
      <ScrollView showsVerticalScrollIndicator={false}>
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : products.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>No products match.</Text>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 6, paddingBottom: 24 }}>
            {products.map((p) => (
              <Pressable key={p.id} style={styles.pickRow} onPress={() => onPick(p)}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.name} numberOfLines={1}>
                    {p.name}
                  </Text>
                  <Text style={styles.sub}>
                    {p.sku ? `SKU ${p.sku} · ` : ""}${toNumber(p.pricePerUnit).toFixed(2)}
                    {p.unit ? ` / ${p.unit}` : ""}
                  </Text>
                </View>
                <Ionicons name="add-circle" size={22} color={ios.brand} />
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },
  row: {
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  pickRow: {
    backgroundColor: ios.bgElev,
    borderRadius: 10,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  name: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  priceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 2,
  },
  priceStrike: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: ios.label3,
    textDecorationLine: "line-through",
  },
  sub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: ios.fill3,
    borderRadius: 10,
    padding: 3,
  },
  stepBtn: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  stepText: { color: ios.brand, fontSize: 18 },
  qty: {
    minWidth: 28,
    textAlign: "center",
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  qtyInput: {
    minWidth: 36,
    textAlign: "center",
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
    paddingVertical: 2,
  },
  deleteBtn: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: ios.system.redWash,
    borderRadius: 8,
  },
  subBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    backgroundColor: ios.brandWash,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  subBtnText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.brand,
  },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: ios.brandWash,
    borderRadius: 12,
    paddingVertical: 14,
    marginTop: 4,
  },
  addBtnText: { color: ios.brand, fontSize: 15, fontFamily: "Inter_600SemiBold" },
  footer: {
    padding: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: ios.bgElev,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  footerEyebrow: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: ios.label2, letterSpacing: 0.4 },
  footerTotal: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  saveBtn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
  // Price override modal
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    backgroundColor: ios.bgElev,
    borderRadius: 20,
    padding: 20,
    width: "100%",
    maxWidth: 380,
  },
  modalTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.3,
    marginBottom: 2,
  },
  modalSub: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginBottom: 8,
  },
  modalLabel: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginBottom: 14,
  },
  modalFieldLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.3,
    marginBottom: 6,
  },
  modalInput: {
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
