import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, Text, View, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { useAdminOrder } from "../../../../../lib/api/admin";
import { SplitInvoiceScreen } from "../../../../../components/SplitInvoiceScreen";

export default function OperatorSplitInvoice() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: order, isLoading, isError } = useAdminOrder(id ?? "");

  if (isLoading) {
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
  if (isError || !order) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Split invoice"
          leading={<NavBackButton onPress={() => router.back()} />}
        />
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
      backLabel="Order"
      items={(order.lineItems ?? []).map((li: any) => ({
        id: li.id,
        productName: li.product?.name ?? "Item",
        qty: Number(li.qty),
        invoicedQty: Number(li.invoicedQty ?? 0),
        unitPrice: Number(li.unitPrice),
        // Stored subtotal so the split preview prorates it the same way the server
        // bills — never a raw qty × unitPrice (over-charges boxed lines).
        subtotal: li.subtotal != null ? Number(li.subtotal) : undefined,
        unit: li.product?.unit,
      }))}
      onCancel={() => router.back()}
      onCreated={() => router.back()}
    />
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
