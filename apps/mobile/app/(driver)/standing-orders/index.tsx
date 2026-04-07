import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import {
  useMyStandingOrders,
  useTodayStandingOrders,
  useToggleStandingOrder,
  useGenerateOrder,
  type StandingOrder,
} from "../../../lib/api/standing-orders";
import { NetworkError } from "../../../components/NetworkError";
import { Alert } from "react-native";

// ─── Day labels ───────────────────────────────────────────────────────────────

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function DayPills({ days }: { days: number[] }) {
  return (
    <View style={styles.dayPills}>
      {DAY_LABELS.map((label, i) => {
        const active = days.includes(i);
        return (
          <View
            key={i}
            style={[styles.dayPill, active && styles.dayPillActive]}
          >
            <Text style={[styles.dayPillText, active && styles.dayPillTextActive]}>
              {label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// ─── Template card ────────────────────────────────────────────────────────────

function TemplateCard({
  template,
  isDue,
  onPress,
  onToggle,
  onGenerate,
}: {
  template: StandingOrder;
  isDue: boolean;
  onPress: () => void;
  onToggle: () => void;
  onGenerate: () => void;
}) {
  const itemCount = template.items.length;

  return (
    <Pressable style={styles.card} onPress={onPress} accessibilityRole="button">
      {isDue && (
        <View style={styles.dueBadge}>
          <Ionicons name="today-outline" size={11} color={colors.brand[600]} />
          <Text style={styles.dueBadgeText}>Due today</Text>
        </View>
      )}

      <View style={styles.cardHeader}>
        <View style={styles.cardTitleRow}>
          <View
            style={[
              styles.activeIndicator,
              { backgroundColor: template.isActive ? colors.success.DEFAULT : "#cbd5e1" },
            ]}
          />
          <Text style={styles.cardTitle} numberOfLines={1}>
            {template.name}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color="#cbd5e1" />
      </View>

      {template.customer && (
        <Text style={styles.customerName}>{template.customer.businessName}</Text>
      )}

      <DayPills days={template.daysOfWeek} />

      <Text style={styles.itemCount}>
        {itemCount} product{itemCount !== 1 ? "s" : ""}
        {template.items.length > 0 &&
          ` — ${template.items
            .slice(0, 2)
            .map((i) => i.product?.name ?? "")
            .filter(Boolean)
            .join(", ")}${template.items.length > 2 ? "…" : ""}`}
      </Text>

      {isDue && template.isActive && (
        <View style={styles.cardActions}>
          <Pressable
            style={styles.generateBtn}
            onPress={(e) => {
              e.stopPropagation?.();
              onGenerate();
            }}
          >
            <Ionicons name="checkmark-circle-outline" size={16} color="#fff" />
            <Text style={styles.generateBtnText}>Confirm Order</Text>
          </Pressable>
        </View>
      )}
    </Pressable>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function StandingOrdersScreen() {
  const { data: allData, isLoading, isError, refetch } = useMyStandingOrders();
  const { data: todayData } = useTodayStandingOrders();
  const toggleMutation = useToggleStandingOrder();
  const generateMutation = useGenerateOrder();

  const allTemplates: StandingOrder[] = allData?.data ?? [];
  const todayTemplates: StandingOrder[] = todayData?.data ?? [];
  const todayIds = new Set(todayTemplates.map((t) => t.id));

  const active = allTemplates.filter((t) => t.isActive);
  const inactive = allTemplates.filter((t) => !t.isActive);

  function handleGenerate(template: StandingOrder) {
    Alert.alert(
      "Confirm Standing Order",
      `Generate an order from "${template.name}" now?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Confirm",
          onPress: () => {
            generateMutation.mutate(template.id, {
              onSuccess: () =>
                Alert.alert("Order Created", `Order generated from "${template.name}".`),
              onError: (e) =>
                Alert.alert("Error", e.message ?? "Failed to generate order."),
            });
          },
        },
      ],
    );
  }

  if (isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: "Standing Orders" }} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      </>
    );
  }

  if (isError) {
    return (
      <>
        <Stack.Screen options={{ title: "Standing Orders" }} />
        <NetworkError onRetry={() => refetch()} />
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: "Standing Orders" }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* Today's due section */}
        {todayTemplates.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Due Today</Text>
            {todayTemplates.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                isDue
                onPress={() => router.push(`/(driver)/standing-orders/${t.id}` as any)}
                onToggle={() =>
                  toggleMutation.mutate({ id: t.id, isActive: !t.isActive })
                }
                onGenerate={() => handleGenerate(t)}
              />
            ))}
          </View>
        )}

        {/* Active templates */}
        {active.filter((t) => !todayIds.has(t.id)).length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Active Templates</Text>
            {active
              .filter((t) => !todayIds.has(t.id))
              .map((t) => (
                <TemplateCard
                  key={t.id}
                  template={t}
                  isDue={false}
                  onPress={() => router.push(`/(driver)/standing-orders/${t.id}` as any)}
                  onToggle={() =>
                    toggleMutation.mutate({ id: t.id, isActive: !t.isActive })
                  }
                  onGenerate={() => handleGenerate(t)}
                />
              ))}
          </View>
        )}

        {/* Inactive templates */}
        {inactive.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Inactive</Text>
            {inactive.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                isDue={false}
                onPress={() => router.push(`/(driver)/standing-orders/${t.id}` as any)}
                onToggle={() =>
                  toggleMutation.mutate({ id: t.id, isActive: !t.isActive })
                }
                onGenerate={() => handleGenerate(t)}
              />
            ))}
          </View>
        )}

        {allTemplates.length === 0 && (
          <View style={styles.emptyState}>
            <Ionicons name="repeat-outline" size={48} color="#cbd5e1" />
            <Text style={styles.emptyTitle}>No Standing Orders</Text>
            <Text style={styles.emptySubtitle}>
              Tap + to create a standing order for a customer.
            </Text>
          </View>
        )}
      </ScrollView>

      {/* FAB — create new */}
      <Pressable
        style={styles.fab}
        onPress={() => router.push("/(driver)/standing-orders/new" as any)}
        accessibilityLabel="Create standing order"
        accessibilityRole="button"
      >
        <Ionicons name="add" size={28} color="#fff" />
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },
  content: { paddingBottom: 100 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },

  section: { marginTop: 24, paddingHorizontal: 16, gap: 10 },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 2,
  },

  card: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 8,
    ...shadows.card,
  },

  dueBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    backgroundColor: colors.brand[50],
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: borderRadius.full,
    marginBottom: 2,
  },
  dueBadgeText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[600],
  },

  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cardTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
  },
  activeIndicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  cardTitle: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
    flex: 1,
  },
  customerName: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    marginTop: -4,
  },

  dayPills: {
    flexDirection: "row",
    gap: 4,
  },
  dayPill: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surface.raised,
  },
  dayPillActive: {
    backgroundColor: colors.brand[50],
  },
  dayPillText: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: "#94a3b8",
  },
  dayPillTextActive: {
    color: colors.brand[600],
  },

  itemCount: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },

  cardActions: {
    marginTop: 4,
  },
  generateBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: colors.brand[600],
    borderRadius: borderRadius.DEFAULT,
    paddingVertical: 10,
  },
  generateBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
  },

  emptyState: {
    alignItems: "center",
    paddingTop: 80,
    gap: 12,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  emptySubtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    textAlign: "center",
  },

  fab: {
    position: "absolute",
    bottom: 28,
    right: 20,
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.brand[600],
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 8,
  },
});
