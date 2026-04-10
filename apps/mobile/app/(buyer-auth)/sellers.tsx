import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useBuyerAuthStore } from "../../lib/buyer-auth-store";
import { type BuyerSeller } from "../../lib/buyer-auth";

const LINK_STATUS_CONFIG: Record<
  string,
  { label: string; color: string; bg: string; selectable: boolean }
> = {
  ACTIVE: { label: "Active", color: "#16a34a", bg: "#f0fdf4", selectable: true },
  PENDING: { label: "Pending approval", color: "#d97706", bg: "#fffbeb", selectable: false },
  SUSPENDED: { label: "Suspended", color: "#dc2626", bg: "#fef2f2", selectable: false },
};

function SellerCard({
  seller,
  onPress,
}: {
  seller: BuyerSeller;
  onPress: () => void;
}) {
  const cfg = LINK_STATUS_CONFIG[seller.linkStatus] ?? {
    label: seller.linkStatus,
    color: "#64748b",
    bg: "#f8fafc",
    selectable: false,
  };

  const initials = seller.tenant.name
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  return (
    <Pressable
      style={[styles.card, !cfg.selectable && styles.cardDisabled]}
      onPress={cfg.selectable ? onPress : undefined}
      accessibilityRole="button"
      accessibilityState={{ disabled: !cfg.selectable }}
    >
      <View style={styles.cardLeft}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials}</Text>
        </View>
        <View style={styles.cardInfo}>
          <Text style={styles.tenantName}>{seller.tenant.name}</Text>
          <Text style={styles.businessName}>{seller.customer.businessName}</Text>
        </View>
      </View>
      <View style={styles.cardRight}>
        <View style={[styles.statusBadge, { backgroundColor: cfg.bg }]}>
          <Text style={[styles.statusText, { color: cfg.color }]}>{cfg.label}</Text>
        </View>
        {cfg.selectable && (
          <Ionicons name="chevron-forward" size={16} color="#94a3b8" />
        )}
      </View>
    </Pressable>
  );
}

export default function BuyerSellersScreen() {
  const router = useRouter();
  const { sellers, fetchSellers, setActiveSeller, logout } = useBuyerAuthStore();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await fetchSellers();
      setLoading(false);
    })();
  }, []);

  const handleSelectSeller = (seller: BuyerSeller) => {
    setActiveSeller(seller);
    router.replace("/(buyer)/orders");
  };

  const handleLogout = async () => {
    await logout();
    router.replace("/(buyer-auth)/login");
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Select a Seller</Text>
          <Text style={styles.headerSubtitle}>Choose which seller to view</Text>
        </View>
        <TouchableOpacity onPress={handleLogout} style={styles.logoutBtn}>
          <Ionicons name="log-out-outline" size={20} color="#64748b" />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#4f46e5" />
        </View>
      ) : (
        <FlatList
          data={sellers}
          keyExtractor={(item) => item.linkId}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="storefront-outline" size={48} color="#cbd5e1" />
              <Text style={styles.emptyTitle}>No sellers yet</Text>
              <Text style={styles.emptySubtitle}>
                Contact your supplier to link your account.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <SellerCard
              seller={item}
              onPress={() => handleSelectSeller(item)}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#f8fafc",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 20,
    backgroundColor: "#fff",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e2e8f0",
  },
  headerTitle: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: "#1B3A5C",
  },
  headerSubtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    marginTop: 2,
  },
  logoutBtn: {
    padding: 8,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  listContent: {
    padding: 16,
    gap: 12,
    flexGrow: 1,
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  cardDisabled: {
    opacity: 0.7,
  },
  cardLeft: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    gap: 14,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#ede9fe",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#4f46e5",
  },
  cardInfo: {
    flex: 1,
    gap: 2,
  },
  tenantName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#1B3A5C",
  },
  businessName: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  cardRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 100,
  },
  statusText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 80,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: "#1B3A5C",
  },
  emptySubtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    textAlign: "center",
    paddingHorizontal: 32,
  },
});
