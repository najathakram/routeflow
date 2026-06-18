import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  usePurchaseOrder,
  useSendPO,
  useClosePO,
  type POItem,
  type POStatus,
} from "../../../lib/api/purchase-orders";
import { showToast } from "../../../lib/toast";
import { confirm } from "../../../lib/confirm";

function statusPill(status: POStatus): {
  variant: "brand" | "green" | "orange" | "red" | "gray";
  label: string;
} {
  switch (status) {
    case "DRAFT":
      return { variant: "gray", label: "Draft" };
    case "SENT":
      return { variant: "orange", label: "Sent" };
    case "PARTIALLY_RECEIVED":
      return { variant: "brand", label: "Partially Received" };
    case "RECEIVED":
      return { variant: "green", label: "Received" };
    case "CLOSED":
      return { variant: "gray", label: "Closed" };
    default:
      return { variant: "gray", label: status };
  }
}

function fmtCurrency(n: number | string | null | undefined): string {
  const v = Number(n) || 0;
  return `$${v.toFixed(2)}`;
}

export default function PurchaseOrderDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: po, isLoading } = usePurchaseOrder(id ?? "");
  const sendMut = useSendPO();
  const closeMut = useClosePO();

  if (isLoading || !po) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Purchase Order"
          leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const s = statusPill(po.status);
  const canReceive = po.status === "SENT" || po.status === "PARTIALLY_RECEIVED";
  const canSend = po.status === "DRAFT";
  const canClose = po.status === "RECEIVED";

  const handleSend = () => {
    confirm(
      "Send PO?",
      "This will mark the PO as Sent to the supplier.",
      () =>
        sendMut.mutate(id ?? "", {
          onSuccess: () => showToast("PO sent to supplier"),
          onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
        }),
      { confirmText: "Send" },
    );
  };

  const handleClose = () => {
    confirm(
      "Close PO?",
      "Mark as closed. This cannot be undone.",
      () =>
        closeMut.mutate(id ?? "", {
          onSuccess: () => showToast("PO closed"),
          onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
        }),
      { confirmText: "Close", destructive: true },
    );
  };

  const totalOrdered = po.items.reduce((sum, it) => sum + Number(it.qtyOrdered), 0);
  const totalReceived = po.items.reduce((sum, it) => sum + Number(it.qtyReceived), 0);
  const receivedRatio = totalOrdered > 0 ? totalReceived / totalOrdered : 0;

  const computedTotal = po.items.reduce(
    (sum, it) => sum + Number(it.qtyOrdered) * Number(it.unitCost),
    0,
  );
  const displayTotal = Number(po.totalAmount) || computedTotal;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={po.poNumber}
        leading={<NavBackButton label="Purchase Orders" onPress={() => router.back()} />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ padding: 16, gap: 14 }}>
          {/* Header card */}
          <View style={styles.card}>
            <View style={styles.headerRow}>
              <Pill variant={s.variant} dot>
                {s.label}
              </Pill>
            </View>
            <Text style={styles.supplierName}>{po.supplier?.name ?? "Supplier"}</Text>
            {po.expectedDate ? (
              <Text style={styles.meta}>
                Expected{" "}
                {new Date(po.expectedDate).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}
              </Text>
            ) : null}
            {po.notes ? <Text style={styles.notes}>{po.notes}</Text> : null}
          </View>

          {/* Receipt progress */}
          {totalOrdered > 0 ? (
            <View style={styles.card}>
              <View style={styles.progressLabelRow}>
                <Text style={styles.progressLabel}>Items received</Text>
                <Text style={styles.progressCount}>
                  {totalReceived} / {totalOrdered}
                </Text>
              </View>
              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${Math.round(receivedRatio * 100)}%` as any },
                  ]}
                />
              </View>
            </View>
          ) : null}

          {/* Receive button */}
          {canReceive ? (
            <Pressable
              style={styles.receiveBtn}
              onPress={() => router.push(`/(operator)/purchase-orders/${id}/receive`)}
            >
              <Text style={styles.receiveBtnText}>Receive Items</Text>
            </Pressable>
          ) : null}

          {/* Send PO button (DRAFT → SENT) */}
          {canSend ? (
            <Pressable
              style={[styles.receiveBtn, { backgroundColor: ios.system.orangeInk }]}
              onPress={handleSend}
              disabled={sendMut.isPending}
            >
              <Text style={styles.receiveBtnText}>
                {sendMut.isPending ? "Sending…" : "Send to Supplier"}
              </Text>
            </Pressable>
          ) : null}

          {/* Close PO button (RECEIVED → CLOSED) */}
          {canClose ? (
            <Pressable
              style={[styles.receiveBtn, { backgroundColor: ios.label2 }]}
              onPress={handleClose}
              disabled={closeMut.isPending}
            >
              <Text style={styles.receiveBtnText}>
                {closeMut.isPending ? "Closing…" : "Close PO"}
              </Text>
            </Pressable>
          ) : null}

          {/* Items table */}
          {po.items.length > 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Items</Text>
              {po.items.map((item, i) => (
                <ItemRow key={item.id} item={item} isFirst={i === 0} />
              ))}
              <View style={styles.totalRow}>
                <Text style={styles.totalLabelMain}>Total</Text>
                <Text style={styles.totalValueMain}>{fmtCurrency(displayTotal)}</Text>
              </View>
            </View>
          ) : null}
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function ItemRow({ item, isFirst }: { item: POItem; isFirst: boolean }) {
  const productName = item.product?.name ?? `Product ${item.productId}`;
  const subtotal = Number(item.qtyOrdered) * Number(item.unitCost);
  const remaining = Number(item.qtyOrdered) - Number(item.qtyReceived);

  return (
    <View
      style={[
        styles.itemRow,
        !isFirst && {
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: ios.separator,
        },
      ]}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.itemName} numberOfLines={1}>
          {productName}
        </Text>
        <Text style={styles.itemSub}>
          Ordered: {item.qtyOrdered} · Received: {item.qtyReceived}
          {remaining > 0 ? ` · Remaining: ${remaining}` : ""}
        </Text>
        <Text style={styles.itemSub}>{fmtCurrency(item.unitCost)} / unit</Text>
      </View>
      <Text style={styles.itemTotal}>{fmtCurrency(subtotal)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14 },
  cardTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    marginBottom: 8,
  },
  headerRow: { flexDirection: "row", alignItems: "center" },
  supplierName: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    marginTop: 10,
    letterSpacing: -0.4,
  },
  meta: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
    marginTop: 6,
  },
  notes: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 8,
    fontStyle: "italic",
  },
  progressLabelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  progressLabel: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
  },
  progressCount: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  progressTrack: {
    height: 8,
    backgroundColor: ios.fill3,
    borderRadius: 4,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: ios.brand,
    borderRadius: 4,
  },
  receiveBtn: {
    backgroundColor: ios.brand,
    borderRadius: 12,
    height: 50,
    alignItems: "center",
    justifyContent: "center",
  },
  receiveBtnText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 10,
    gap: 10,
  },
  itemName: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: ios.label,
  },
  itemSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 2,
  },
  itemTotal: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
    marginTop: 2,
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 12,
    marginTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  totalLabelMain: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: ios.label,
  },
  totalValueMain: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
});
