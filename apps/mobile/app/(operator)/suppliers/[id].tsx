import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavAction, NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { useSuppliers } from "../../../lib/api/purchase-orders";

export default function SupplierDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: suppliers, isLoading } = useSuppliers();
  const supplier = suppliers?.find((s) => s.id === id);

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Supplier" leading={<NavBackButton label="Back" onPress={() => router.back()} />} />
        <View style={styles.center}><ActivityIndicator color={ios.brand} /></View>
      </SafeAreaView>
    );
  }

  if (!supplier) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Supplier" leading={<NavBackButton label="Back" onPress={() => router.back()} />} />
        <View style={styles.center}>
          <Text style={styles.notFoundText}>Supplier not found</Text>
          <Pressable onPress={() => router.replace("/(operator)/suppliers" as any)} style={styles.notFoundBtn}>
            <Text style={styles.notFoundBtnText}>Back to suppliers</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={supplier.name}
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        trailing={
          <NavAction
            label="Edit"
            bold
            onPress={() => router.push(`/(operator)/suppliers/${id}/edit` as any)}
          />
        }
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.section}>
          <View style={styles.card}>
            <DetailRow label="Name" value={supplier.name} />
            {supplier.contactName ? (
              <DetailRow label="Contact" value={supplier.contactName} />
            ) : null}
          </View>
        </View>

        {(supplier.phone || supplier.email) ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Contact</Text>
            <View style={styles.card}>
              {supplier.phone ? (
                <Pressable onPress={() => Linking.openURL(`tel:${supplier.phone}`)}>
                  <DetailRow label="Phone" value={supplier.phone} tappable />
                </Pressable>
              ) : null}
              {supplier.email ? (
                <Pressable onPress={() => Linking.openURL(`mailto:${supplier.email}`)}>
                  <DetailRow label="Email" value={supplier.email} tappable />
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : null}

        {supplier.notes ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Notes</Text>
            <View style={styles.card}>
              <Text style={styles.notes}>{supplier.notes}</Text>
            </View>
          </View>
        ) : null}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function DetailRow({
  label,
  value,
  tappable,
}: {
  label: string;
  value: string;
  tappable?: boolean;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 4, justifyContent: "flex-end" }}>
        <Text style={[styles.rowValue, tappable && { color: ios.brand }]} numberOfLines={1}>
          {value}
        </Text>
        {tappable ? <Ionicons name="chevron-forward" size={12} color={ios.brand} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  notFoundText: { fontSize: 16, fontFamily: "Inter_500Medium", color: ios.label },
  notFoundBtn: { paddingVertical: 8, paddingHorizontal: 16 },
  notFoundBtnText: { fontSize: 15, color: ios.brand },
  section: { paddingHorizontal: 16, paddingTop: 16 },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  card: { backgroundColor: ios.bgElev, borderRadius: 12, overflow: "hidden" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
    gap: 12,
  },
  rowLabel: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label2, flexShrink: 0 },
  rowValue: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label, textAlign: "right" },
  notes: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label, padding: 16, lineHeight: 20 },
});
