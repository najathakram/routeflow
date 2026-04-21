import {
  ActivityIndicator,
  Alert,
  Linking,
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
import { NavAction, NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import { useCustomer, useDeleteCustomer } from "../../../lib/api/customers";
import { AppMapView } from "../../../components/MapView";
import { openInMaps } from "../../../components/openInMaps";
import { showToast } from "../../../lib/toast";

export default function CustomerDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: customer, isLoading } = useCustomer(id ?? "");
  const deleteMut = useDeleteCustomer();

  if (isLoading || !customer) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Customer" leading={<NavBackButton onPress={() => router.back()} />} />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const primaryAddress = customer.addresses?.find((a) => a.isDefault) ?? customer.addresses?.[0];
  const hasCoords =
    primaryAddress &&
    typeof (primaryAddress as any).lat === "number" &&
    typeof (primaryAddress as any).lng === "number";

  const handleDelete = () => {
    if (!id) return;
    Alert.alert(
      "Delete customer?",
      `${customer.businessName} will be removed. This is permanent.`,
      [
        { text: "Keep it", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            deleteMut.mutate(id, {
              onSuccess: () => {
                showToast("Customer deleted");
                router.back();
              },
              onError: (e: any) =>
                Alert.alert(
                  "Couldn't delete",
                  e?.response?.data?.message ?? e?.message ?? "Try again.",
                ),
            }),
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={customer.businessName}
        leading={<NavBackButton label="Customers" onPress={() => router.back()} />}
        trailing={
          <NavAction
            label="Edit"
            bold
            onPress={() => router.push(`/(operator)/customers/${id}/edit`)}
          />
        }
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ padding: 16, gap: 14 }}>
          <View style={styles.card}>
            <Text style={styles.name}>{customer.businessName}</Text>
            {customer.contactName ? (
              <Text style={styles.contact}>{customer.contactName}</Text>
            ) : null}
            <View style={styles.actionRow}>
              {customer.phone ? (
                <Pressable
                  style={styles.actionBtn}
                  onPress={() => Linking.openURL(`tel:${customer.phone}`)}
                >
                  <Ionicons name="call-outline" size={16} color={ios.brand} />
                  <Text style={styles.actionText}>Call</Text>
                </Pressable>
              ) : null}
              {customer.phone ? (
                <Pressable
                  style={styles.actionBtn}
                  onPress={() => Linking.openURL(`sms:${customer.phone}`)}
                >
                  <Ionicons name="chatbubble-outline" size={16} color={ios.brand} />
                  <Text style={styles.actionText}>Text</Text>
                </Pressable>
              ) : null}
              {customer.email ? (
                <Pressable
                  style={styles.actionBtn}
                  onPress={() => Linking.openURL(`mailto:${customer.email}`)}
                >
                  <Ionicons name="mail-outline" size={16} color={ios.brand} />
                  <Text style={styles.actionText}>Email</Text>
                </Pressable>
              ) : null}
              {primaryAddress ? (
                <Pressable
                  style={styles.actionBtn}
                  onPress={() =>
                    openInMaps({
                      address: [
                        primaryAddress.line1,
                        primaryAddress.city,
                        primaryAddress.state,
                        primaryAddress.zip,
                      ]
                        .filter(Boolean)
                        .join(", "),
                      lat: (primaryAddress as any).lat,
                      lng: (primaryAddress as any).lng,
                      label: customer.businessName,
                    })
                  }
                >
                  <Ionicons name="navigate-outline" size={16} color={ios.brand} />
                  <Text style={styles.actionText}>Directions</Text>
                </Pressable>
              ) : null}
            </View>
          </View>

          {primaryAddress ? (
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>Address</Text>
                <Pressable
                  onPress={() => router.push(`/(operator)/customers/${id}/addresses`)}
                >
                  <Text style={styles.linkText}>Manage</Text>
                </Pressable>
              </View>
              <Text style={styles.addressText}>
                {primaryAddress.line1}
                {primaryAddress.line2 ? `\n${primaryAddress.line2}` : ""}
                {"\n"}
                {primaryAddress.city}, {primaryAddress.state} {primaryAddress.zip}
              </Text>
              {hasCoords ? (
                <View style={styles.miniMap}>
                  <AppMapView
                    pins={[
                      {
                        id,
                        lat: (primaryAddress as any).lat,
                        lng: (primaryAddress as any).lng,
                        title: customer.businessName,
                      },
                    ]}
                    fitToPins
                  />
                </View>
              ) : null}
            </View>
          ) : (
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>Address</Text>
                <Pressable
                  onPress={() => router.push(`/(operator)/customers/${id}/addresses`)}
                >
                  <Text style={styles.linkText}>Add</Text>
                </Pressable>
              </View>
              <Text style={styles.empty}>No address on file.</Text>
            </View>
          )}

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Account</Text>
            {customer.email ? <Row label="Email" value={<Text style={styles.rowValue}>{customer.email}</Text>} /> : null}
            {customer.phone ? <Row label="Phone" value={<Text style={styles.rowValue}>{customer.phone}</Text>} /> : null}
            {customer.deliveryWindowStart || customer.deliveryWindowEnd ? (
              <Row
                label="Delivery window"
                value={
                  <Text style={styles.rowValue}>
                    {customer.deliveryWindowStart ?? "—"} – {customer.deliveryWindowEnd ?? "—"}
                  </Text>
                }
              />
            ) : null}
          </View>

          <Pressable style={styles.deleteBtn} onPress={handleDelete} disabled={deleteMut.isPending}>
            <Ionicons name="trash-outline" size={18} color={ios.system.red} />
            <Text style={styles.deleteBtnText}>Delete customer</Text>
          </Pressable>
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <View style={{ flexShrink: 1 }}>{value}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14, gap: 6 },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  linkText: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.brand },
  name: { fontSize: 22, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.4 },
  contact: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 10,
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: ios.brandWash,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
  },
  actionText: { color: ios.brand, fontSize: 13, fontFamily: "Inter_500Medium" },
  addressText: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label, lineHeight: 20 },
  miniMap: {
    height: 160,
    borderRadius: 10,
    overflow: "hidden",
    marginTop: 10,
    backgroundColor: ios.fill3,
  },
  detailRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6 },
  detailLabel: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  rowValue: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },
  empty: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, paddingVertical: 6 },
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
