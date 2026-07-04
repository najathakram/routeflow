import { useEffect } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavAction, NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import { useProduct, useDeleteProduct } from "../../../lib/api/products";
import { useInventoryMovements } from "../../../lib/api/inventory";
import { showToast } from "../../../lib/toast";
import { confirm } from "../../../lib/confirm";

function toNumber(v: number | string | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export default function ProductDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  // RF-203: defensive guard — if somehow "create" reaches this screen (e.g. the
  // static create.tsx was not matched), redirect to the proper create form
  // instead of firing a doomed /products/create API call and spinning forever.
  const isCreateAlias = id === "create" || id === "new";
  useEffect(() => {
    if (isCreateAlias) router.replace("/(operator)/products/new");
  }, [isCreateAlias, router]);

  const { data: product, isLoading } = useProduct(isCreateAlias ? "" : (id ?? ""));
  const { data: movements } = useInventoryMovements({
    productId: isCreateAlias ? undefined : id,
    limit: 20,
  });
  const deleteMut = useDeleteProduct();

  if (isLoading || !product) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Product" leading={<NavBackButton onPress={() => router.back()} />} />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const stock = toNumber(product.currentStock);
  const threshold = product.reorderPoint ?? 5;
  const low = stock > 0 && stock <= threshold;
  const out = stock <= 0;

  const handleDelete = () => {
    if (!id) return;
    confirm(
      "Delete product?",
      `${product.name} will be removed permanently.`,
      () =>
        deleteMut.mutate(id, {
          onSuccess: () => {
            showToast("Product deleted");
            router.back();
          },
          onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
        }),
      { confirmText: "Delete", destructive: true },
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Product"
        leading={<NavBackButton label="Products" onPress={() => router.back()} />}
        trailing={
          <NavAction
            label="Edit"
            bold
            onPress={() => router.push(`/(operator)/products/${id}/edit`)}
          />
        }
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 14 }}>
          <View style={styles.card}>
            <Text style={styles.name}>{product.name}</Text>
            {product.description ? <Text style={styles.desc}>{product.description}</Text> : null}
            <View style={{ flexDirection: "row", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              {out ? (
                <Pill variant="red">Out of stock</Pill>
              ) : low ? (
                <Pill variant="orange">Low stock</Pill>
              ) : null}
              {!product.isActive ? <Pill variant="gray">Inactive</Pill> : null}
              {product.category ? <Pill variant="brand">{product.category}</Pill> : null}
            </View>
          </View>

          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>Details</Text>
              <Pressable onPress={() => router.push(`/(operator)/products/${id}/set-cost`)}>
                <Text style={styles.linkText}>Set cost</Text>
              </Pressable>
            </View>
            <Row label="SKU" value={product.sku ?? "—"} />
            <Row label="Barcode" value={product.barcode ?? "—"} />
            <Row label="Unit" value={product.unit ?? "ea"} />
            <Row label="Price" value={`$${toNumber(product.pricePerUnit).toFixed(2)}`} />
            {(() => {
              // Effective cost: standard cost for STANDARD products, else weighted average
              const effectiveCost = product.standardCost ?? product.averageCost;
              if (effectiveCost == null) {
                return (
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Cost</Text>
                    <View style={[styles.marginChip, { backgroundColor: "#FEF3C7" }]}>
                      <Text style={[styles.marginChipText, { color: "#92400E" }]}>No cost set</Text>
                    </View>
                  </View>
                );
              }
              const price = toNumber(product.pricePerUnit);
              const cost = toNumber(effectiveCost);
              const marginPct = price > 0 ? Math.round(((price - cost) / price) * 100) : null;
              const color =
                marginPct == null || marginPct >= 25
                  ? ios.system.greenInk
                  : marginPct >= 10
                    ? ios.system.orangeInk
                    : ios.system.redInk;
              const bg =
                marginPct == null || marginPct >= 25
                  ? ios.system.greenWash
                  : marginPct >= 10
                    ? ios.system.orangeWash
                    : ios.system.redWash;
              return (
                <>
                  <Row label="Cost" value={`$${cost.toFixed(2)}`} />
                  {marginPct != null ? (
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>Margin</Text>
                      <View style={[styles.marginChip, { backgroundColor: bg }]}>
                        <Text style={[styles.marginChipText, { color }]}>{marginPct}%</Text>
                      </View>
                    </View>
                  ) : null}
                </>
              );
            })()}
          </View>

          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>Stock</Text>
              <Pressable onPress={() => router.push(`/(operator)/products/${id}/adjust-stock`)}>
                <Text style={styles.linkText}>Adjust</Text>
              </Pressable>
            </View>
            <Row label="On hand" value={`${stock} ${product.unit ?? ""}`.trim()} />
            {product.reorderPoint != null ? (
              <Row label="Reorder at" value={`${product.reorderPoint}`} />
            ) : null}
            {product.reorderQty != null ? (
              <Row label="Reorder qty" value={`${product.reorderQty}`} />
            ) : null}
          </View>

          {movements?.data && movements.data.length > 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Recent movements</Text>
              {movements.data.slice(0, 10).map((m, i) => (
                <View
                  key={m.id}
                  style={[
                    styles.movementRow,
                    i > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: ios.separator,
                    },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.movementType}>{m.type}</Text>
                    <Text style={styles.movementMeta}>
                      {new Date(m.createdAt).toLocaleDateString()}
                      {m.notes ? ` · ${m.notes}` : ""}
                    </Text>
                  </View>
                  <Text
                    style={[
                      styles.movementQty,
                      { color: m.quantity >= 0 ? ios.system.greenInk : ios.system.redInk },
                    ]}
                  >
                    {m.quantity >= 0 ? "+" : ""}
                    {m.quantity}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          <Pressable style={styles.deleteBtn} onPress={handleDelete} disabled={deleteMut.isPending}>
            <Ionicons name="trash-outline" size={18} color={ios.system.red} />
            <Text style={styles.deleteBtnText}>Delete product</Text>
          </Pressable>
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14 },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, marginBottom: 8 },
  linkText: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.brand },
  name: { fontSize: 22, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.4 },
  desc: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 4 },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
  },
  detailLabel: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  detailValue: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  marginChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  marginChipText: { fontSize: 12, fontFamily: "Inter_700Bold" },
  movementRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
  },
  movementType: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label },
  movementMeta: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  movementQty: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    fontVariant: ["tabular-nums"],
  },
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: ios.bgElev,
    paddingVertical: 14,
    borderRadius: 12,
  },
  deleteBtnText: { color: ios.system.red, fontSize: 15, fontFamily: "Inter_500Medium" },
});
