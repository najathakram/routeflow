import {
  ActivityIndicator,
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
import { useQueryClient } from "@tanstack/react-query";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import { useBuyerSellers, useDisconnectSeller } from "../../lib/api/buyer";
import {
  sellerStatusPill,
  canOpenSeller,
  canCancelRequest,
} from "../../lib/seller-directory-logic";
import { useBuyerSessionStore } from "../../lib/buyer-session-store";
import { useCartStore } from "../../store/cartStore";
import { showToast } from "../../lib/toast";
import { confirm } from "../../lib/confirm";
import type { BuyerSeller } from "../../lib/buyer-auth";

export default function SellersScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const { activeSeller, setActiveSeller } = useBuyerSessionStore();
  const { data: sellers, isLoading, refetch, isRefetching } = useBuyerSellers();
  const cancelMut = useDisconnectSeller();

  const onOpen = async (seller: BuyerSeller) => {
    if (seller.tenant.slug === activeSeller?.tenant.slug) {
      router.replace("/(customer)/(tabs)/home");
      return;
    }
    // Switching seller re-points every buyer-scoped request at a different
    // tenant (X-Tenant-Slug header). Clear the local cart (product ids are
    // seller-specific) AND the whole React Query cache — invalidate() alone
    // can still flash stale cross-tenant data during refetch; clear() drops
    // it immediately. Mirrors signOut() in buyer-session-store.ts, which
    // clears the cart for the identical reason.
    await setActiveSeller(seller);
    useCartStore.getState().clear();
    qc.clear();
    router.replace("/(customer)/(tabs)/home");
  };

  const onCancelRequest = (seller: BuyerSeller) =>
    confirm(
      "Cancel request?",
      `Withdraw your connection request to ${seller.tenant.name}?`,
      () =>
        cancelMut.mutate(seller.tenant.slug, {
          onSuccess: () => showToast("Request cancelled"),
          onError: (e: any) => showToast(e?.response?.data?.message ?? "Try again."),
        }),
      { confirmText: "Cancel request", destructive: true },
    );

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Your Sellers"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        trailing={
          <Pressable onPress={() => router.push("/(customer)/sellers/connect")} hitSlop={8}>
            <Ionicons name="add" size={24} color={ios.brand} />
          </Pressable>
        }
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
        contentContainerStyle={{ paddingBottom: 32 }}
      >
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : !sellers || sellers.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="business-outline" size={40} color={ios.label3} />
            <Text style={styles.emptyTitle}>No sellers connected</Text>
            <Text style={styles.emptyText}>
              Connect with a seller to view your orders, invoices, and delivery updates.
            </Text>
            <Pressable
              style={styles.connectBtn}
              onPress={() => router.push("/(customer)/sellers/connect")}
            >
              <Text style={styles.connectBtnText}>Connect a seller</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.list}>
            {sellers.map((seller) => {
              const pill = sellerStatusPill(seller.linkStatus);
              const openable = canOpenSeller(seller);
              const cancellable = canCancelRequest(seller);
              const isCurrent = seller.tenant.slug === activeSeller?.tenant.slug;
              return (
                <Pressable
                  key={seller.linkId}
                  style={[styles.card, isCurrent && styles.cardCurrent]}
                  onPress={openable ? () => onOpen(seller) : undefined}
                  disabled={!openable}
                >
                  <View style={styles.cardTop}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cardName} numberOfLines={1}>
                        {seller.tenant.name}
                      </Text>
                      <Text style={styles.cardSub} numberOfLines={1}>
                        {seller.customer
                          ? `as ${seller.customer.businessName}`
                          : "Pending approval"}
                        {isCurrent ? " · Current" : ""}
                      </Text>
                    </View>
                    <Pill variant={pill.variant} small>
                      {pill.label}
                    </Pill>
                  </View>
                  {openable ? (
                    <View style={styles.cardActionRow}>
                      <Text style={styles.openHint}>Tap to open</Text>
                      <Ionicons name="chevron-forward" size={16} color={ios.label3} />
                    </View>
                  ) : cancellable ? (
                    <Pressable
                      style={styles.cancelBtn}
                      onPress={() => onCancelRequest(seller)}
                      disabled={cancelMut.isPending}
                    >
                      <Text style={styles.cancelBtnText}>Cancel request</Text>
                    </Pressable>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        )}

        {/* "Got an invite link?" hint — mirrors web's empty-state footer copy */}
        <View style={styles.hintCard}>
          <Ionicons name="mail-outline" size={18} color={ios.label3} />
          <View style={{ flex: 1 }}>
            <Text style={styles.hintTitle}>Got an invite link?</Text>
            <Text style={styles.hintText}>
              Check your email — clicking a seller's invite connects you instantly, no approval
              wait.
            </Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 60, alignItems: "center" },
  empty: { padding: 40, alignItems: "center", gap: 10 },
  emptyTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: ios.label, marginTop: 4 },
  emptyText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
  },
  connectBtn: {
    backgroundColor: ios.brand,
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
    marginTop: 8,
  },
  connectBtnText: { color: "#fff", fontSize: 14, fontFamily: "Inter_600SemiBold" },
  list: { paddingHorizontal: 16, gap: 10, paddingTop: 12 },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14, gap: 10 },
  cardCurrent: { borderWidth: 1.5, borderColor: ios.brand },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  cardName: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  cardSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  cardActionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 2,
  },
  openHint: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.label3 },
  cancelBtn: { alignSelf: "flex-start" },
  cancelBtnText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.system.redInk },
  hintCard: {
    flexDirection: "row",
    gap: 10,
    marginHorizontal: 16,
    marginTop: 16,
    padding: 14,
    borderRadius: 12,
    backgroundColor: ios.brandWash,
  },
  hintTitle: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label },
  hintText: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
});
