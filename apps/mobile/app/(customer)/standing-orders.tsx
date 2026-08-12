import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { useBuyerTemplates, useBuyerReorder, useBuyerUpdateTemplate } from "../../lib/api/buyer";
import { showToast } from "../../lib/toast";
import { confirm } from "../../lib/confirm";

// ISO weekdays (Mon=1 … Sun=7) — indexing the old Sun-first 0-indexed array by
// the raw value silently dropped Sunday (7 → undefined) and shifted every label.
const ISO_DAY_ABBR = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function formatDaysOfWeek(days: number[] | undefined): string {
  if (!days?.length) return "";
  return [...days]
    .sort((a, b) => a - b)
    .map((d) => ISO_DAY_ABBR[d] ?? "")
    .filter(Boolean)
    .join(" · ");
}

function formatNextFireDate(dateStr: string | undefined | null): string | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff > 0 && diff <= 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function StandingOrdersScreen() {
  const router = useRouter();
  const { data: templates, isLoading } = useBuyerTemplates();
  const reorderMut = useBuyerReorder();
  const updateMut = useBuyerUpdateTemplate();

  const onReorder = (id: string, name: string) =>
    confirm(
      `Reorder from "${name}"?`,
      "A new order will be created.",
      () =>
        reorderMut.mutate(id, {
          onSuccess: (order) => {
            showToast("Order created");
            router.push(`/(customer)/orders/${order.id}`);
          },
          onError: (e: any) => showToast(e?.response?.data?.message ?? "Try again."),
        }),
      { confirmText: "Reorder" },
    );

  const onTogglePause = (id: string, name: string, isActive: boolean) => {
    const action = isActive ? "Pause" : "Resume";
    const message = isActive
      ? "No new orders will be auto-generated until you resume."
      : "Auto-orders will resume on the next scheduled day.";
    confirm(
      `${action} "${name}"?`,
      message,
      () =>
        updateMut.mutate(
          { id, isActive: !isActive },
          {
            onSuccess: () =>
              showToast(isActive ? "Standing order paused" : "Standing order resumed"),
            onError: (e: any) => showToast(e?.response?.data?.message ?? "Try again."),
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
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : !templates || templates.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>No standing orders.</Text>
          </View>
        ) : (
          <View style={styles.list}>
            {templates.map((t) => (
              <Pressable
                key={t.id}
                style={styles.card}
                onPress={() => onReorder(t.id, t.name ?? "Standing order")}
              >
                <View style={styles.cardTop}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardName}>{t.name ?? "Standing order"}</Text>
                    <Text style={styles.cardMeta}>
                      {formatDaysOfWeek(t.daysOfWeek) ||
                        t.frequencyLabel ||
                        t.frequency ||
                        "No schedule"}{" "}
                      · {t.items?.length ?? 0} items
                    </Text>
                    {/* First 2 product names inline */}
                    {t.items && t.items.length > 0 && (
                      <Text style={styles.cardItems} numberOfLines={1}>
                        {t.items
                          .slice(0, 2)
                          .map((i: any) => i.product?.name ?? i.name ?? "")
                          .filter(Boolean)
                          .join(", ")}
                        {t.items.length > 2 ? ` +${t.items.length - 2} more` : ""}
                      </Text>
                    )}
                    {/* Next fire date */}
                    {formatNextFireDate(t.nextFireDate) ? (
                      <Text style={styles.cardNextFire}>
                        Next order: {formatNextFireDate(t.nextFireDate)}
                      </Text>
                    ) : null}
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
                    onPress={() =>
                      onTogglePause(t.id, t.name ?? "Standing order", t.isActive !== false)
                    }
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
              </Pressable>
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
  cardItems: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label3, marginTop: 2 },
  cardNextFire: { fontSize: 11, fontFamily: "Inter_600SemiBold", color: ios.brand, marginTop: 3 },
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
