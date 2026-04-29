import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { useBuyerTemplates, useBuyerReorder, useBuyerUpdateTemplate } from "../../lib/api/buyer";
import { showToast } from "../../lib/toast";
import { confirm } from "../../lib/confirm";

const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function formatDaysOfWeek(days: number[] | undefined): string {
  if (!days?.length) return "";
  return [...days].sort((a, b) => a - b).map((d) => DAY_ABBR[d] ?? "").filter(Boolean).join(" · ");
}

export default function StandingOrdersScreen() {
  const router = useRouter();
  const { data: templates, isLoading } = useBuyerTemplates();
  const reorderMut = useBuyerReorder();
  const updateMut = useBuyerUpdateTemplate();

  const onReorder = (id: string, name: string) =>
    confirm(`Reorder from "${name}"?`, "A new order will be created.", () =>
      reorderMut.mutate(id, {
        onSuccess: (order) => {
          showToast("Order created");
          router.push(`/(customer)/orders/${order.id}`);
        },
        onError: (e: any) =>
          showToast(e?.response?.data?.message ?? "Try again."),
      }),
      { confirmText: "Reorder" },
    );

  const onTogglePause = (id: string, name: string, isActive: boolean) => {
    const action = isActive ? "Pause" : "Resume";
    const message = isActive
      ? "No new orders will be auto-generated until you resume."
      : "Auto-orders will resume on the next scheduled day.";
    confirm(`${action} "${name}"?`, message, () =>
      updateMut.mutate(
        { id, isActive: !isActive },
        {
          onSuccess: () => showToast(isActive ? "Standing order paused" : "Standing order resumed"),
          onError: (e: any) =>
            showToast(e?.response?.data?.message ?? "Try again."),
        },
      ),
      { confirmText: action },
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Standing Orders"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />
      <ScrollView showsVerticalScrollIndicator={false}>
        {isLoading ? (
          <View style={styles.center}><ActivityIndicator color={ios.brand} /></View>
        ) : !templates || templates.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>No standing orders.</Text>
          </View>
        ) : (
          <View style={styles.list}>
            {templates.map((t) => (
              <View key={t.id} style={styles.card}>
                <View style={styles.cardTop}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardName}>{t.name ?? "Standing order"}</Text>
                    <Text style={styles.cardMeta}>
                      {formatDaysOfWeek(t.daysOfWeek) || t.frequencyLabel || t.frequency || "No schedule"} · {t.items?.length ?? 0} items
                    </Text>
                  </View>
                  {t.isActive === false ? (
                    <View style={styles.pausedBadge}>
                      <Text style={styles.pausedBadgeText}>Paused</Text>
                    </View>
                  ) : null}
                </View>
                <View style={styles.cardActions}>
                  <Pressable
                    style={[styles.actionBtn, styles.reorderBtn]}
                    onPress={() => onReorder(t.id, t.name ?? "Standing order")}
                    disabled={reorderMut.isPending || t.isActive === false}
                  >
                    <Ionicons name="refresh-outline" size={14} color={ios.brand} />
                    <Text style={styles.reorderText}>Order now</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.actionBtn, styles.pauseBtn]}
                    onPress={() => onTogglePause(t.id, t.name ?? "Standing order", t.isActive !== false)}
                    disabled={updateMut.isPending}
                  >
                    <Ionicons
                      name={t.isActive === false ? "play-outline" : "pause-outline"}
                      size={14}
                      color={ios.label2}
                    />
                    <Text style={styles.pauseText}>
                      {t.isActive === false ? "Resume" : "Pause"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  empty: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label2 },
  list: { paddingHorizontal: 16, gap: 8, paddingBottom: 32 },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14, gap: 12 },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  cardName: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  cardMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  pausedBadge: {
    backgroundColor: ios.fill2,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  pausedBadgeText: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.label2 },
  cardActions: { flexDirection: "row", gap: 8 },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  reorderBtn: { backgroundColor: ios.brandWash },
  reorderText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.brand },
  pauseBtn: { backgroundColor: ios.fill2 },
  pauseText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label2 },
});
