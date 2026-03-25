import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import {
  useMyStandingOrder,
  useToggleStandingOrder,
} from "../../../lib/api/standing-orders";
import { NetworkError } from "../../../components/NetworkError";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_FULL_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function StandingOrderDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: order, isLoading, isError, refetch } = useMyStandingOrder(id ?? "");
  const { mutate: toggleActive, isPending: isToggling } = useToggleStandingOrder();

  if (isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: "Standing Order", headerBackTitle: "Standing Orders" }} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      </>
    );
  }

  if (isError || !order) {
    return (
      <>
        <Stack.Screen options={{ title: "Standing Order", headerBackTitle: "Standing Orders" }} />
        <NetworkError onRetry={() => refetch()} />
      </>
    );
  }

  const sortedDays = [...(order.daysOfWeek ?? [])].sort((a, b) => a - b);
  const totalItems = (order.items ?? []).reduce((s, i) => s + i.qty, 0);

  const handleToggle = (value: boolean) => {
    const action = value ? "activate" : "pause";
    Alert.alert(
      value ? "Activate Standing Order?" : "Pause Standing Order?",
      value
        ? "This will resume automatic orders on the scheduled days."
        : "No more automatic orders will be generated until you reactivate.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: value ? "Activate" : "Pause",
          style: value ? "default" : "destructive",
          onPress: () =>
            toggleActive(
              { id: order.id, isActive: value },
              {
                onError: () =>
                  Alert.alert("Error", `Failed to ${action} standing order.`),
              },
            ),
        },
      ],
    );
  };

  return (
    <>
      <Stack.Screen
        options={{ title: order.name, headerBackTitle: "Standing Orders" }}
      />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Active toggle card */}
        <View style={styles.section}>
          <View style={styles.toggleRow}>
            <View style={styles.toggleLeft}>
              <Ionicons
                name={order.isActive ? "repeat" : "pause-circle-outline"}
                size={20}
                color={order.isActive ? colors.success.DEFAULT : "#94a3b8"}
              />
              <View>
                <Text style={styles.toggleTitle}>
                  {order.isActive ? "Active" : "Paused"}
                </Text>
                <Text style={styles.toggleSubtitle}>
                  {order.isActive
                    ? "Orders are generated automatically"
                    : "No orders are being generated"}
                </Text>
              </View>
            </View>
            {isToggling ? (
              <ActivityIndicator size="small" color={colors.brand[500]} />
            ) : (
              <Switch
                value={order.isActive}
                onValueChange={handleToggle}
                trackColor={{
                  false: colors.surface.border,
                  true: colors.success.DEFAULT,
                }}
                thumbColor="#fff"
              />
            )}
          </View>
        </View>

        {/* Schedule */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Schedule</Text>
          <View style={styles.daysGrid}>
            {[0, 1, 2, 3, 4, 5, 6].map((day) => {
              const active = sortedDays.includes(day);
              return (
                <View
                  key={day}
                  style={[
                    styles.dayChip,
                    active && { backgroundColor: colors.brand[500] },
                  ]}
                >
                  <Text
                    style={[
                      styles.dayChipText,
                      active && { color: "#fff" },
                    ]}
                  >
                    {DAY_LABELS[day]}
                  </Text>
                </View>
              );
            })}
          </View>
          {sortedDays.length > 0 ? (
            <Text style={styles.scheduleDetail}>
              Runs every {sortedDays.map((d) => DAY_FULL_LABELS[d]).join(", ")}
            </Text>
          ) : null}
        </View>

        {/* Items */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            Items ({order.items?.length ?? 0} products · {totalItems} total units)
          </Text>
          {(order.items ?? []).map((item, idx) => (
            <View
              key={item.id}
              style={[
                styles.itemRow,
                idx === (order.items?.length ?? 0) - 1 && styles.itemRowLast,
              ]}
            >
              <View style={styles.qtyBubble}>
                <Text style={styles.qtyBubbleText}>{item.qty}</Text>
              </View>
              <View style={styles.itemInfo}>
                <Text style={styles.itemName}>
                  {item.product?.name ?? item.productId}
                </Text>
                {item.product?.unit ? (
                  <Text style={styles.itemUnit}>{item.product.unit}</Text>
                ) : null}
                {item.notes ? (
                  <Text style={styles.itemNote}>{item.notes}</Text>
                ) : null}
              </View>
              {item.product?.pricePerUnit ? (
                <Text style={styles.itemPrice}>
                  ${Number(item.product.pricePerUnit).toFixed(2)}
                </Text>
              ) : null}
            </View>
          ))}
        </View>

        {/* Notes */}
        {order.notes ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Notes</Text>
            <Text style={styles.notesText}>{order.notes}</Text>
          </View>
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  scroll: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 32,
    gap: 12,
  },
  section: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 12,
    ...shadows.card,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  toggleLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flex: 1,
  },
  toggleTitle: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  toggleSubtitle: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    marginTop: 1,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  daysGrid: {
    flexDirection: "row",
    gap: 6,
    flexWrap: "wrap",
  },
  dayChip: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surface.raised,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.surface.border,
  },
  dayChipText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
  },
  scheduleDetail: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
    gap: 12,
  },
  itemRowLast: { borderBottomWidth: 0 },
  qtyBubble: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.brand[500],
    alignItems: "center",
    justifyContent: "center",
  },
  qtyBubbleText: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
  itemInfo: { flex: 1 },
  itemName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  itemUnit: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    marginTop: 1,
  },
  itemNote: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    fontStyle: "italic",
    marginTop: 2,
  },
  itemPrice: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: "#64748b",
  },
  notesText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    lineHeight: 20,
  },
});
