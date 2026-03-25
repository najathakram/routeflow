import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { router, Stack } from "expo-router";
import { format, parseISO } from "date-fns";
import { Ionicons } from "@expo/vector-icons";
import { StatusBadge } from "@routeflow/ui/mobile";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useDriverHistory, type RouteRun } from "../../../lib/api/routes";
import { NetworkError } from "../../../components/NetworkError";

function statusForBadge(status: RouteRun["status"]) {
  if (status === "IN_PROGRESS") return "IN_PROGRESS";
  if (status === "COMPLETED") return "COMPLETED";
  if (status === "CANCELLED") return "CANCELLED";
  return "PENDING";
}

function RunCard({ run }: { run: RouteRun & { _count?: { stops: number } } }) {
  const stops = run.stops ?? [];
  const totalStops = (run as any)._count?.stops ?? stops.length;
  const completedStops = stops.filter(
    (s) => s.status === "COMPLETED" || s.status === "SKIPPED",
  ).length;
  const scheduledDate = run.scheduledDate
    ? format(parseISO(run.scheduledDate), "EEE, MMM d")
    : "—";

  return (
    <Pressable
      style={styles.card}
      onPress={() => router.push(`/(driver)/route?runId=${run.id}` as any)}
      accessibilityRole="button"
      accessibilityLabel={`Route run on ${scheduledDate}`}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardLeft}>
          <Text style={styles.routeName}>{run.route?.name ?? "Route"}</Text>
          <Text style={styles.dateText}>{scheduledDate}</Text>
        </View>
        <StatusBadge status={statusForBadge(run.status)} />
      </View>

      <View style={styles.cardFooter}>
        <View style={styles.stat}>
          <Ionicons name="flag-outline" size={16} color="#94a3b8" />
          <Text style={styles.statText}>
            {completedStops} / {totalStops} stops
          </Text>
        </View>
        {run.startedAt && (
          <View style={styles.stat}>
            <Ionicons name="time-outline" size={16} color="#94a3b8" />
            <Text style={styles.statText}>
              Started {format(parseISO(run.startedAt), "h:mm a")}
            </Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

export default function DriverHistoryScreen() {
  const { data, isLoading, isError, refetch } = useDriverHistory();

  if (isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: "History", headerBackTitle: "Route" }} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      </>
    );
  }

  if (isError) {
    return (
      <>
        <Stack.Screen options={{ title: "History", headerBackTitle: "Route" }} />
        <NetworkError onRetry={() => refetch()} />
      </>
    );
  }

  const runs = data?.data ?? [];

  return (
    <>
      <Stack.Screen options={{ title: "Delivery History", headerBackTitle: "Route" }} />
      <FlatList
        data={runs}
        keyExtractor={(item) => item.id}
        style={styles.list}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="archive-outline" size={48} color="#cbd5e1" />
            <Text style={styles.emptyText}>No delivery history yet.</Text>
          </View>
        }
        renderItem={({ item }) => <RunCard run={item} />}
      />
    </>
  );
}

const styles = StyleSheet.create({
  list: { backgroundColor: colors.surface.raised },
  content: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 32,
    gap: 10,
  },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: {
    alignItems: "center",
    paddingTop: 64,
    gap: 12,
  },
  emptyText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 12,
    ...shadows.card,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cardLeft: { gap: 2 },
  routeName: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  dateText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  cardFooter: {
    flexDirection: "row",
    gap: 16,
  },
  stat: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  statText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "#64748b",
  },
});
