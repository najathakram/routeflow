import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import { useBuyerOrder, useBuyerCancelOrder } from "../../../lib/api/buyer";
import { showToast } from "../../../lib/toast";
import { confirm } from "../../../lib/confirm";

function orderPill(status: string) {
  switch (status) {
    case "PENDING": return { variant: "orange" as const, label: "Pending" };
    case "CONFIRMED": return { variant: "brand" as const, label: "Confirmed" };
    case "DRAFT": return { variant: "gray" as const, label: "Draft" };
    case "IN_TRANSIT": return { variant: "brand" as const, label: "In transit" };
    case "DELIVERED": return { variant: "green" as const, label: "Delivered" };
    case "CANCELLED": return { variant: "gray" as const, label: "Cancelled" };
    default: return { variant: "gray" as const, label: status };
  }
}

export default function CustomerOrderDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: order, isLoading } = useBuyerOrder(id);
  const cancelMut = useBuyerCancelOrder();

  if (isLoading || !order) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Order" leading={<NavBackButton label="Back" onPress={() => router.back()} />} />
        <View style={styles.center}><ActivityIndicator color={ios.brand} /></View>
      </SafeAreaView>
    );
  }

  const p = orderPill(order.status);
  const total = Number(order.total) || order.lineItems.reduce((s, i) => s + Number(i.qty) * Number(i.unitPrice), 0);
  const canCancel = order.status === "PENDING" || order.status === "DRAFT";

  const onCancel = () =>
    confirm("Cancel order?", "This cannot be undone.", () =>
      cancelMut.mutate(id, {
        onSuccess: () => {
          showToast("Order cancelled");
          router.back();
        },
        onError: (e: any) =>
          showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      }),
      { confirmText: "Cancel order", destructive: true },
    );

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Order"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={styles.headerCard}>
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.orderNum}>
                {order.orderNumber ? `#${order.orderNumber}` : "Order"}
              </Text>
              <Text style={styles.orderDate}>
                {new Date(order.createdAt).toLocaleDateString(undefined, {
                  month: "long", day: "numeric", year: "numeric",
                })}
              </Text>
            </View>
            <Pill variant={p.variant} dot>{p.label}</Pill>
          </View>
          <Text style={styles.total}>${total.toFixed(2)}</Text>
          {order.requestedDeliveryDate ? (
            <Text style={styles.deliveryDate}>
              Delivery:{" "}
              {new Date(order.requestedDeliveryDate).toLocaleDateString(undefined, {
                month: "short", day: "numeric", year: "numeric",
              })}
            </Text>
          ) : null}
          {order.notes ? <Text style={styles.notes}>{order.notes}</Text> : null}
        </View>

        {/* Line items */}
        {order.lineItems.length > 0 ? (
          <>
            <View style={styles.sectionRow}>
              <Text style={styles.sectionTitle}>Items</Text>
            </View>
            <View style={styles.itemsList}>
              {order.lineItems.map((item, i) => (
                <View
                  key={item.id}
                  style={[
                    styles.itemRow,
                    i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: ios.separator },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemName} numberOfLines={1}>
                      {item.product?.name ?? "Product"}
                    </Text>
                    <Text style={styles.itemMeta}>
                      {Number(item.qty)} × ${Number(item.unitPrice).toFixed(2)}
                      {item.product?.unit ? ` / ${item.product.unit}` : ""}
                    </Text>
                  </View>
                  <Text style={styles.itemTotal}>${(Number(item.qty) * Number(item.unitPrice)).toFixed(2)}</Text>
                </View>
              ))}
            </View>
          </>
        ) : null}

        {/* Cancel */}
        {canCancel ? (
          <View style={{ paddingHorizontal: 16, marginTop: 24 }}>
            <Pressable
              style={styles.cancelBtn}
              onPress={onCancel}
              disabled={cancelMut.isPending}
            >
              <Text style={styles.cancelBtnText}>
                {cancelMut.isPending ? "Cancelling…" : "Cancel order"}
              </Text>
            </Pressable>
          </View>
        ) : null}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  headerCard: { margin: 16, backgroundColor: ios.bgElev, borderRadius: 16, padding: 18, gap: 6 },
  headerRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  orderNum: { fontSize: 18, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.3 },
  orderDate: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  total: { fontSize: 28, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.6, marginTop: 4 },
  deliveryDate: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  notes: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  sectionRow: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  sectionTitle: { fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.3 },
  itemsList: { marginHorizontal: 16, backgroundColor: ios.bgElev, borderRadius: 12, overflow: "hidden" },
  itemRow: { paddingHorizontal: 16, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  itemName: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label },
  itemMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  itemTotal: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label, fontVariant: ["tabular-nums"] },
  cancelBtn: { backgroundColor: ios.fill3, borderRadius: 14, paddingVertical: 14, alignItems: "center" },
  cancelBtnText: { color: ios.system.redInk, fontSize: 15, fontFamily: "Inter_500Medium" },
});
