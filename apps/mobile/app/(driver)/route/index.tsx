import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { EmptyState, StatusBadge } from "@routeflow/ui/mobile";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import {
  useRouteStore,
  selectCompletedCount,
  selectCurrentStop,
} from "../../../store/routeStore";
import { RouteStop } from "../../../data/driverMockData";

const STATUS_ICON: Record<string, { name: string; color: string }> = {
  COMPLETED: { name: "checkmark-circle", color: colors.success.DEFAULT },
  IN_PROGRESS: { name: "arrow-forward-circle", color: colors.brand[500] },
  PENDING: { name: "ellipse-outline", color: "#94a3b8" },
  SKIPPED: { name: "close-circle-outline", color: "#94a3b8" },
};

function ProgressBar({ completed, total }: { completed: number; total: number }) {
  const pct = total === 0 ? 0 : (completed / total) * 100;
  return (
    <View style={progressStyles.track}>
      <View style={[progressStyles.fill, { width: `${pct}%` as any }]} />
    </View>
  );
}

const progressStyles = StyleSheet.create({
  track: {
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.surface.border,
    overflow: "hidden",
  },
  fill: {
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.success.DEFAULT,
  },
});

function StopRow({ stop }: { stop: RouteStop }) {
  const icon = STATUS_ICON[stop.status] ?? STATUS_ICON.PENDING;
  const isActive = stop.status === "IN_PROGRESS";

  return (
    <Pressable
      style={[styles.stopRow, isActive && styles.stopRowActive]}
      onPress={() => router.push(`/(driver)/route/stop/${stop.id}`)}
      accessibilityRole="button"
      accessibilityLabel={`Stop ${stop.stopNumber}: ${stop.businessName}`}
    >
      {/* Stop number bubble */}
      <View style={[styles.stopNumBubble, isActive && styles.stopNumBubbleActive]}>
        <Text style={[styles.stopNum, isActive && styles.stopNumActive]}>
          {stop.stopNumber}
        </Text>
      </View>

      {/* Details */}
      <View style={styles.stopDetails}>
        <Text style={styles.stopBusiness}>{stop.businessName}</Text>
        <Text style={styles.stopAddress} numberOfLines={1}>
          {stop.address}
        </Text>
        <Text style={styles.stopItemCount}>
          {stop.items.length} item{stop.items.length !== 1 ? "s" : ""}
        </Text>
      </View>

      {/* Status icon */}
      <Ionicons name={icon.name as any} size={28} color={icon.color} />
    </Pressable>
  );
}

export default function RouteScreen() {
  const route = useRouteStore((s) => s.route);
  const completedCount = useRouteStore(selectCompletedCount);
  const currentStop = useRouteStore(selectCurrentStop);
  const startRoute = useRouteStore((s) => s.startRoute);

  if (!route) {
    return (
      <>
        <Stack.Screen options={{ title: "My Route" }} />
        <EmptyState
          icon={<Ionicons name="map-outline" size={56} color="#cbd5e1" />}
          title="No route assigned for today."
          subtitle="Check back later or contact your dispatcher."
        />
      </>
    );
  }

  const totalStops = route.stops.length;
  const hasStarted = completedCount > 0 || currentStop !== null;
  const allDone = route.status === "COMPLETED";

  const handlePrimaryAction = () => {
    if (allDone) return;
    if (!hasStarted) {
      startRoute();
    }
    const target = currentStop ?? route.stops.find((s) => s.status === "PENDING");
    if (target) {
      router.push(`/(driver)/route/stop/${target.id}`);
    }
  };

  const primaryLabel = allDone
    ? "Route Complete"
    : !hasStarted
      ? "Start Route"
      : "Next Stop";

  return (
    <>
      <Stack.Screen options={{ title: "My Route" }} />
      <View style={styles.container}>
        {/* Route header card */}
        <View style={styles.headerCard}>
          <View style={styles.headerTop}>
            <Text style={styles.routeName}>{route.name}</Text>
            <StatusBadge
              status={route.status === "ACTIVE" ? "IN_PROGRESS" : "COMPLETED"}
            />
          </View>

          <View style={styles.progressSection}>
            <View style={styles.progressLabelRow}>
              <Text style={styles.progressLabel}>Progress</Text>
              <Text style={styles.progressValue}>
                {completedCount} of {totalStops} stops
              </Text>
            </View>
            <ProgressBar completed={completedCount} total={totalStops} />
          </View>
        </View>

        {/* Stop list */}
        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.stopsLabel}>Stops</Text>
          {route.stops.map((stop) => (
            <StopRow key={stop.id} stop={stop} />
          ))}
        </ScrollView>

        {/* Primary action */}
        <View style={styles.footer}>
          <Pressable
            style={[styles.primaryBtn, allDone && styles.primaryBtnDone]}
            onPress={handlePrimaryAction}
            disabled={allDone}
            accessibilityRole="button"
            accessibilityLabel={primaryLabel}
          >
            {!allDone && (
              <Ionicons
                name={hasStarted ? "navigate" : "play"}
                size={22}
                color="#fff"
                style={{ marginRight: 10 }}
              />
            )}
            {allDone && (
              <Ionicons
                name="checkmark-done-circle"
                size={22}
                color={colors.success.DEFAULT}
                style={{ marginRight: 10 }}
              />
            )}
            <Text
              style={[
                styles.primaryBtnText,
                allDone && { color: colors.success.DEFAULT },
              ]}
            >
              {primaryLabel}
            </Text>
          </Pressable>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.raised,
  },
  headerCard: {
    backgroundColor: "#fff",
    paddingHorizontal: 20,
    paddingVertical: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
    gap: 16,
  },
  headerTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  routeName: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  progressSection: {
    gap: 8,
  },
  progressLabelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  progressLabel: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: "#64748b",
  },
  progressValue: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 24,
    gap: 8,
  },
  stopsLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  stopRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 14,
    ...shadows.card,
  },
  stopRowActive: {
    borderWidth: 1.5,
    borderColor: colors.brand[500],
  },
  stopNumBubble: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surface.raised,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.surface.border,
  },
  stopNumBubbleActive: {
    backgroundColor: colors.brand[500],
    borderColor: colors.brand[500],
  },
  stopNum: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  stopNumActive: {
    color: "#fff",
  },
  stopDetails: {
    flex: 1,
    gap: 2,
  },
  stopBusiness: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  stopAddress: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  stopItemCount: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "#94a3b8",
  },
  footer: {
    paddingHorizontal: 16,
    paddingBottom: 28,
    paddingTop: 12,
    backgroundColor: "#fff",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
  },
  primaryBtn: {
    height: 56,
    backgroundColor: colors.brand[500],
    borderRadius: borderRadius.DEFAULT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnDone: {
    backgroundColor: colors.success.bg,
  },
  primaryBtnText: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
});
