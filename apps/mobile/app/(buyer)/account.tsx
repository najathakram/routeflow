import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useBuyerAuthStore } from "../../lib/buyer-auth-store";

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

export default function BuyerAccountScreen() {
  const router = useRouter();
  const { buyer, activeSeller, logout } = useBuyerAuthStore();

  const handleLogout = async () => {
    await logout();
    router.replace("/(buyer-auth)/login");
  };

  const initials = buyer?.name
    ? buyer.name.split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase()
    : "?";

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Avatar + name */}
        <View style={styles.avatarSection}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
          <Text style={styles.buyerName}>{buyer?.name ?? "Buyer"}</Text>
          <Text style={styles.buyerEmail}>{buyer?.email ?? ""}</Text>
        </View>

        {/* Active seller */}
        {activeSeller ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Active Seller</Text>
            <InfoRow label="Seller" value={activeSeller.tenant.name} />
            <InfoRow label="Your Account" value={activeSeller.customer.businessName} />
            {activeSeller.customer.email ? (
              <InfoRow label="Contact Email" value={activeSeller.customer.email} />
            ) : null}
          </View>
        ) : null}

        {/* Account info */}
        {buyer ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Account</Text>
            <InfoRow label="Name" value={buyer.name} />
            <InfoRow label="Email" value={buyer.email} />
          </View>
        ) : null}

        {/* Actions */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Settings</Text>

          <Pressable
            style={styles.actionRow}
            onPress={() => router.push("/(buyer-auth)/sellers")}
            accessibilityRole="button"
          >
            <Ionicons name="storefront-outline" size={20} color="#1B3A5C" />
            <Text style={styles.actionLabel}>Switch Seller</Text>
            <Ionicons name="chevron-forward" size={16} color="#94a3b8" style={styles.chevron} />
          </Pressable>
        </View>

        <View style={[styles.section, styles.dangerSection]}>
          <Pressable
            style={styles.actionRow}
            onPress={handleLogout}
            accessibilityRole="button"
          >
            <Ionicons name="log-out-outline" size={20} color="#dc2626" />
            <Text style={[styles.actionLabel, styles.dangerLabel]}>Sign Out</Text>
          </Pressable>
        </View>

        <Text style={styles.version}>RouteFlow Buyer Portal</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#f8fafc",
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingBottom: 40,
  },
  avatarSection: {
    alignItems: "center",
    paddingVertical: 32,
    backgroundColor: "#fff",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e2e8f0",
    marginBottom: 8,
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "#ede9fe",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  avatarText: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
    color: "#4f46e5",
  },
  buyerName: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: "#1B3A5C",
    marginBottom: 2,
  },
  buyerEmail: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  section: {
    backgroundColor: "#fff",
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  dangerSection: {
    marginTop: 4,
  },
  sectionTitle: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingVertical: 10,
  },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e2e8f0",
    gap: 12,
  },
  infoLabel: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    flex: 1,
  },
  infoValue: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: "#1B3A5C",
    flex: 2,
    textAlign: "right",
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e2e8f0",
    gap: 12,
  },
  actionLabel: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#1B3A5C",
  },
  dangerLabel: {
    color: "#dc2626",
  },
  chevron: {
    marginLeft: "auto",
  },
  version: {
    textAlign: "center",
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#cbd5e1",
    marginTop: 8,
  },
});
