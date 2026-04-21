import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
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
import { useAdminOrder } from "../../../../lib/api/admin";
import { useUpdateOrderItems } from "../../../../lib/api/orders";
import { useProducts } from "../../../../lib/api/products";
import { showToast } from "../../../../lib/toast";

type DraftItem = { productId: string; qty: number; unitPrice: number; name: string; unit?: string };

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
  const updateMut = useUpdateOrderItems();

  useEffect(() => {
    if (!order) return;
    const next: Record<string, DraftItem> = {};
    for (const li of order.lineItems) {
      next[li.productId] = {
        productId: li.productId,
        qty: li.qty,
        unitPrice: toNumber(li.unitPrice),
        name: li.product?.name ?? "Item",
        unit: li.product?.unit,
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
      .map((i) => ({ productId: i.productId, qty: i.qty, unitPrice: i.unitPrice }));
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

      {showPicker ? (
        <ProductPicker
          onPick={(p) => {
            setDraft((d) => ({
              ...d,
              [p.id]: {
                productId: p.id,
                qty: (d[p.id]?.qty ?? 0) + 1,
                unitPrice: toNumber(p.pricePerUnit),
                name: p.name,
                unit: p.unit,
              },
            }));
            setShowPicker(false);
          }}
          onClose={() => setShowPicker(false)}
        />
      ) : (
        <>
          <ScrollView showsVerticalScrollIndicator={false}>
            <View style={{ padding: 16, gap: 8 }}>
              {Object.values(draft).length === 0 ? (
                <Text style={styles.empty}>No items. Add one below.</Text>
              ) : (
                Object.values(draft).map((it) => (
                  <View key={it.productId} style={styles.row}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.name} numberOfLines={1}>
                        {it.name}
                      </Text>
                      <Text style={styles.sub}>
                        ${it.unitPrice.toFixed(2)}
                        {it.unit ? ` / ${it.unit}` : ""}
                      </Text>
                    </View>
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
                      <Text style={styles.qty}>{it.qty}</Text>
                      <Pressable
                        style={styles.stepBtn}
                        onPress={() =>
                          setDraft((d) => ({
                            ...d,
                            [it.productId]: { ...it, qty: it.qty + 1 },
                          }))
                        }
                      >
                        <Text style={styles.stepText}>+</Text>
                      </Pressable>
                    </View>
                  </View>
                ))
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

function ProductPicker({
  onPick,
  onClose,
}: {
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
        inlineTitle="Add product"
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
  sub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
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
});
