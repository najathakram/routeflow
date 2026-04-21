import { View, Text, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { useBuyerProfile } from "../../lib/api/buyer";
import { ActivityIndicator } from "react-native";

export default function CustomerProfileScreen() {
  const router = useRouter();
  const { data: profile, isLoading } = useBuyerProfile();

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Profile"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />
      {isLoading ? (
        <View style={styles.center}><ActivityIndicator color={ios.brand} /></View>
      ) : (
        <View style={styles.section}>
          <View style={styles.card}>
            <Row label="Business name" value={profile?.businessName ?? "—"} />
            <Row label="Email" value={profile?.email ?? "—"} />
            <Row label="Phone" value={profile?.phone ?? "—"} />
            {profile?.address?.line1 ? (
              <Row label="Address" value={[profile.address.line1, profile.address.city, profile.address.postcode].filter(Boolean).join(", ")} />
            ) : null}
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value} numberOfLines={2}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  section: { padding: 16 },
  card: { backgroundColor: ios.bgElev, borderRadius: 12, overflow: "hidden" },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
    gap: 12,
  },
  label: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label2, flexShrink: 0 },
  value: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label, flex: 1, textAlign: "right" },
});
