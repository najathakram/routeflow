import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBar, NavBackButton } from "@routeflow/ui/mobile/ios";
import { useActiveRouteRun, useRouteRun } from "../../../../../lib/api/routes";
import { useOrder } from "../../../../../lib/api/orders";
import { SplitInvoiceScreen } from "../../../../../components/SplitInvoiceScreen";

/**
 * Driver-side split-invoice flow. Two modes:
 *  - Without `orderId`: show all orders on the current stop and let the driver
 *    pick one to split.
 *  - With `orderId`: render the shared SplitInvoiceScreen for that order.
 *
 * After successful create the driver returns to the stop screen to either
 * continue splitting another order or proceed with "Complete & collect".
 */
export default function DriverSplitInvoice() {
  const router = useRouter();
  const {
    stopId,
    orderId,
    runId: runIdParam,
  } = useLocalSearchParams<{
    stopId: string;
    orderId?: string;
    runId?: string;
  }>();

  const { data: activeData } = useActiveRouteRun();
  const runIdFromActive = activeData?.data?.[0]?.id;
  const runId = runIdParam ?? runIdFromActive;
  const { data: run, isLoading: runLoading } = useRouteRun(runId ?? "");

  if (orderId) {
    return <DriverSplitForOrder orderId={orderId} onClose={() => router.back()} />;
  }

  // Order picker
  if (runLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Split invoice"
          leading={<NavBackButton onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const stop = run?.stops?.find((s: any) => s.id === stopId);
  const orders = (stop?.orders ?? []) as any[];

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Split invoice"
        leading={<NavBackButton onPress={() => router.back()} />}
      />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        <Text style={styles.helper}>Pick the order you want to split into multiple invoices.</Text>
        {orders.length === 0 ? (
          <Text style={styles.empty}>No orders at this stop.</Text>
        ) : (
          orders.map((o: any) => {
            const remaining = (o.lineItems ?? []).filter(
              (li: any) => Number(li.qty) - Number(li.invoicedQty ?? 0) > 0.001,
            ).length;
            return (
              <Pressable
                key={o.id}
                style={styles.orderRow}
                onPress={() =>
                  router.push(
                    `/route/stop/${stopId}/split-invoice?orderId=${o.id}${runIdParam ? `&runId=${runIdParam}` : ""}`,
                  )
                }
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.orderNumber}>{o.orderNumber ?? o.id.slice(0, 8)}</Text>
                  <Text style={styles.orderSub}>
                    {o.lineItems?.length ?? 0} line{(o.lineItems?.length ?? 0) === 1 ? "" : "s"} ·{" "}
                    {remaining} item{remaining === 1 ? "" : "s"} left to invoice
                  </Text>
                </View>
                <Text style={styles.chevron}>›</Text>
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function DriverSplitForOrder({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const { data: order, isLoading, isError } = useOrder(orderId);
  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Split invoice" leading={<NavBackButton onPress={onClose} />} />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }
  if (isError || !order) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Split invoice" leading={<NavBackButton onPress={onClose} />} />
        <View style={styles.center}>
          <Text style={{ color: ios.label2 }}>Order not found.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SplitInvoiceScreen
      orderId={order.id}
      orderNumber={order.orderNumber}
      backLabel="Stop"
      items={(order.lineItems ?? []).map((li: any) => ({
        id: li.id,
        productName: li.product?.name ?? "Item",
        qty: Number(li.qty),
        invoicedQty: Number(li.invoicedQty ?? 0),
        unitPrice: Number(li.unitPrice),
        unit: li.product?.unit,
      }))}
      onCancel={onClose}
      onCreated={onClose}
    />
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  helper: { fontSize: 13, color: ios.label2 },
  empty: { fontSize: 14, color: ios.label2, textAlign: "center", marginTop: 16 },
  orderRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    padding: 14,
    gap: 8,
  },
  orderNumber: { fontSize: 15, fontWeight: "600", color: ios.label },
  orderSub: { fontSize: 12, color: ios.label2, marginTop: 2 },
  chevron: { fontSize: 22, color: ios.label3 },
});
