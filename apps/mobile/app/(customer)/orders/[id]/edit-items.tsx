import { useState, useMemo, useEffect } from "react";
import {
  ActivityIndicator,
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
import { useBuyerOrder, useBuyerProducts, useBuyerUpdateOrderItems } from "../../../../lib/api/buyer";
import { showToast } from "../../../../lib/toast";

type DraftItem = {
  productId: string;
  name: string;
  unit?: string;
  qty: number;
  unitPrice: number;
};

export default function BuyerEditItemsScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: order, isLoading } = useBuyerOrder(id);
  const { data: catalogData } = useBuyerProducts({ limit: 200 });
  const updateMut = useBuyerUpdateOrderItems();
  const [showCatalog, setShowCatalog] = useState(false);

  const [draft, setDraft] = useState<Record<string, DraftItem>>({});

  // Populate draft once order loads
  useEffect(() => {
    if (!order) return;
    setDraft(
      Object.fromEntries(
        order.lineItems
          .filter((li) => Number(li.qty) > 0)
          .map((li) => [
            li.productId,
            {
              productId: li.productId,
              name: li.product?.name ?? "Product",
              unit: li.product?.unit,
              qty: Number(li.qty),
              unitPrice: Number(li.unitPrice),
            },
          ]),
      ),
    );
  // Run only when the order first loads — intentionally omitting draft from deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id]);

  const items = useMemo(() => Object.values(draft).filter((i) => i.qty > 0), [draft]);

  const setQty = (productId: string, qty: number) => {
    if (qty <= 0) {
      setDraft((d) => {
        const next = { ...d };
        delete next[productId];
        return next;
      });
    } else {
      setDraft((d) => ({ ...d, [productId]: { ...d[productId], qty } }));
    }
  };

  const addFromCatalog = (p: any) => {
    const price = Number(p.buyerPrice ?? p.basePrice ?? p.price) || 0;
    setDraft((d) => ({
      ...d,
      [p.id]: d[p.id]
        ? { ...d[p.id], qty: d[p.id].qty + 1 }
        : { productId: p.id, name: p.name, unit: p.unit, qty: 1, unitPrice: price },
    }));
    setShowCatalog(false);
  };

  const save = () => {
    if (items.length === 0) {
      showToast("Add at least one item.");
      return;
    }
    updateMut.mutate(
      { orderId: id, items: items.map((i) => ({ productId: i.productId, qty: i.qty })) },
      {
        onSuccess: (updated) => {
          if (updated.status === "PENDING" && order?.status === "CONFIRMED") {
            showToast("Items saved — order reverted to Pending for re-confirmation.");
          } else {
            showToast("Items updated");
          }
          router.back();
        },
        onError: (e: any) =>
          showToast(e?.response?.data?.message ?? e?.message ?? "Save failed."),
      },
    );
  };

  if (isLoading || !order) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Edit items" leading={<NavBackButton label="Back" onPress={() => router.back()} />} />
        <View style={styles.center}><ActivityIndicator color={ios.brand} /></View>
      </SafeAreaView>
    );
  }

  const catalog = catalogData?.data ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Edit items"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        {items.length === 0 ? (
          <Text style={styles.empty}>No items — add from catalog below.</Text>
        ) : (
          <View style={styles.section}>
            {items.map((item) => (
              <View key={item.productId} style={styles.itemRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemName} numberOfLines={2}>{item.name}</Text>
                  <Text style={styles.itemPrice}>${item.unitPrice.toFixed(2)}{item.unit ? ` / ${item.unit}` : ""}</Text>
                </View>
                <View style={styles.qtyRow}>
                  <Pressable style={styles.qtyBtn} onPress={() => setQty(item.productId, item.qty - 1)} hitSlop={6}>
                    <Ionicons name="remove" size={16} color={ios.brand} />
                  </Pressable>
                  <TextInput
                    style={styles.qtyInput}
                    keyboardType="number-pad"
                    value={String(item.qty)}
                    onChangeText={(t) => {
                      const n = parseInt(t, 10);
                      if (!isNaN(n)) setQty(item.productId, n);
                    }}
                  />
                  <Pressable style={styles.qtyBtn} onPress={() => setQty(item.productId, item.qty + 1)} hitSlop={6}>
                    <Ionicons name="add" size={16} color={ios.brand} />
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        )}

        <Pressable style={styles.addBtn} onPress={() => setShowCatalog((v) => !v)}>
          <Ionicons name="add-circle-outline" size={18} color={ios.brand} />
          <Text style={styles.addBtnText}>{showCatalog ? "Hide catalog" : "Add product"}</Text>
        </Pressable>

        {showCatalog && (
          <View style={styles.section}>
            {catalog.map((p) => (
              <Pressable key={p.id} style={styles.catalogRow} onPress={() => addFromCatalog(p)}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemName} numberOfLines={1}>{p.name}</Text>
                  <Text style={styles.itemPrice}>${(Number(p.buyerPrice ?? p.basePrice ?? p.price) || 0).toFixed(2)}{p.unit ? ` / ${p.unit}` : ""}</Text>
                </View>
                <Ionicons name="add" size={20} color={ios.brand} />
              </Pressable>
            ))}
          </View>
        )}

        <View style={styles.footer}>
          <Pressable style={[styles.saveBtn, updateMut.isPending && { opacity: 0.6 }]} onPress={save} disabled={updateMut.isPending}>
            <Text style={styles.saveBtnText}>{updateMut.isPending ? "Saving…" : "Save changes"}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { color: ios.label2, fontSize: 14, textAlign: "center", margin: 32 },
  section: { marginHorizontal: 16, marginTop: 12, backgroundColor: "#fff", borderRadius: 14, overflow: "hidden" },
  itemRow: {
    flexDirection: "row", alignItems: "center", padding: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: ios.separator,
  },
  catalogRow: {
    flexDirection: "row", alignItems: "center", padding: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: ios.separator,
  },
  itemName: { fontSize: 15, color: ios.label, flexShrink: 1 },
  itemPrice: { fontSize: 13, color: ios.label2, marginTop: 2 },
  qtyRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  qtyBtn: { width: 30, height: 30, borderRadius: 15, backgroundColor: ios.fill, alignItems: "center", justifyContent: "center" },
  qtyInput: { width: 36, textAlign: "center", fontSize: 15, color: ios.label, borderBottomWidth: 1, borderBottomColor: ios.separator, paddingVertical: 2 },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 16, marginTop: 16, paddingVertical: 12 },
  addBtnText: { color: ios.brand, fontSize: 15 },
  footer: { margin: 16, marginTop: 24 },
  saveBtn: { backgroundColor: ios.brand, borderRadius: 14, paddingVertical: 16, alignItems: "center" },
  saveBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
