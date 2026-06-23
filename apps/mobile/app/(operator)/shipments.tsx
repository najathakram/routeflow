import {
  ActivityIndicator,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { IosEmptyState, NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { useAdminInvoices, type AdminInvoice } from "../../lib/api/admin";
import { carrierLabel, getTrackingUrl } from "../../lib/shipping";
import { showToast } from "../../lib/toast";

/**
 * Operator shipments list — every invoice that has a carrier tracking number
 * (`GET /invoices?shipped=true`). Each row shows the customer, invoice number,
 * carrier, tracking number (tappable when the carrier has a known tracking URL),
 * and the shipped date. Tapping the row opens the invoice detail.
 */
export default function ShipmentsScreen() {
  const router = useRouter();
  const { data, isLoading, isFetching, refetch } = useAdminInvoices({ shipped: true, limit: 100 });
  const invoices = data?.data ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Shipments"
        inlineTitle="Shipments"
        leading={<NavBackButton label="More" onPress={() => router.back()} />}
      />
      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      ) : invoices.length === 0 ? (
        <IosEmptyState
          icon={<Ionicons name="cube-outline" size={40} color={ios.brand} />}
          title="No shipments yet"
          subtitle="Invoices with a carrier tracking number show up here."
        />
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={isFetching && !isLoading} onRefresh={refetch} />
          }
        >
          <View style={styles.countRow}>
            <Text style={styles.countText}>
              {invoices.length} shipment{invoices.length === 1 ? "" : "s"}
            </Text>
          </View>
          <View style={{ paddingHorizontal: 16, gap: 10, paddingBottom: 32 }}>
            {invoices.map((inv) => (
              <ShipmentRow
                key={inv.id}
                inv={inv}
                onPress={() => router.push(`/(operator)/invoices/${inv.id}`)}
              />
            ))}
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function ShipmentRow({ inv, onPress }: { inv: AdminInvoice; onPress: () => void }) {
  const carrier = inv.shippingCarrier ?? null;
  const tracking = inv.shippingTrackingNumber ?? null;
  const url = getTrackingUrl(carrier, tracking);

  const openTracking = () => {
    if (!url) return;
    Linking.openURL(url).catch(() => showToast("Couldn't open the tracking link."));
  };

  return (
    <Pressable style={styles.card} onPress={onPress}>
      <View style={styles.cardHead}>
        <View style={[styles.iconWrap, { backgroundColor: ios.brandWash }]}>
          <Ionicons name="cube-outline" size={18} color={ios.brand} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {inv.customer?.businessName ?? "Customer"}
          </Text>
          <Text style={styles.cardSub} numberOfLines={1}>
            {inv.invoiceNumber}
            {carrier ? ` · ${carrierLabel(carrier)}` : ""}
            {inv.shippedAt ? ` · ${new Date(inv.shippedAt).toLocaleDateString()}` : ""}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={ios.gray[3]} />
      </View>

      {tracking ? (
        url ? (
          <Pressable
            style={styles.trackRow}
            onPress={(e) => {
              e.stopPropagation?.();
              openTracking();
            }}
            hitSlop={4}
          >
            <Text style={styles.trackNumber} numberOfLines={1}>
              {tracking}
            </Text>
            <View style={styles.trackBtn}>
              <Ionicons name="open-outline" size={14} color={ios.brand} />
              <Text style={styles.trackBtnText}>Track package</Text>
            </View>
          </Pressable>
        ) : (
          <Text style={styles.trackPlain} numberOfLines={1}>
            {tracking}
          </Text>
        )
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  countRow: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 },
  countText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14, gap: 10 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  cardTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  cardSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  trackRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    backgroundColor: ios.brandWash,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  trackNumber: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  trackBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
  trackBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.brand },
  trackPlain: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
    fontVariant: ["tabular-nums"],
    paddingLeft: 48,
  },
});
