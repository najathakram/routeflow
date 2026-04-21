import { useMemo } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import {
  InlineStats,
  NavBar,
  Pill,
  ProgressTrack,
  StopCard,
} from "@routeflow/ui/mobile/ios";
import {
  useActiveRouteRun,
  useScheduledRouteRuns,
  useUpdateRunStatus,
  type RouteRun,
  type RouteRunStop,
} from "../../../lib/api/routes";
import { useAuthStore } from "../../../lib/auth-store";

export default function DriverRouteScreen() {
  const router = useRouter();
  const { data: activeData, isLoading: activeLoading } = useActiveRouteRun();
  const { data: scheduledData, isLoading: scheduledLoading } = useScheduledRouteRuns();

  const active = activeData?.data?.[0] ?? null;
  const upcoming = scheduledData?.data?.[0] ?? null;

  if (activeLoading || scheduledLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar largeTitle="Today" />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  if (active) {
    return <TodaysRoute run={active} onOpenStop={(id) => router.push(`/(driver)/route/stop/${id}`)} />;
  }
  if (upcoming) {
    return <StartOfDay run={upcoming} />;
  }
  return <NoRoute />;
}

function StartOfDay({ run }: { run: RouteRun }) {
  const user = useAuthStore((s) => s.user);
  const updateStatus = useUpdateRunStatus();

  const firstName = user?.username?.split(/[._\s]/)[0] ?? "driver";
  const greetingName = firstName.charAt(0).toUpperCase() + firstName.slice(1);

  const stopCount = run.stops?.length ?? 0;
  const totalValue = (run.stops ?? []).reduce((sum, stop) => {
    const orderTotal = (stop.orders ?? []).reduce((t, o) => {
      return t + (o.lineItems ?? []).reduce((s, li) => s + li.qty * li.unitPrice, 0);
    }, 0);
    return sum + orderTotal;
  }, 0);
  const dateLabel = new Date(run.scheduledDate).toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  }).toUpperCase();

  const onStart = () => updateStatus.mutate({ id: run.id, status: "IN_PROGRESS" });

  const initials =
    greetingName.slice(0, 2).toUpperCase() || "ME";

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle={`Good morning, ${greetingName}`}
        trailing={
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
        }
      />
      <ScrollView showsVerticalScrollIndicator={false}>
        <Text style={styles.dateEyebrow}>{dateLabel}</Text>

        <View style={{ padding: 16, paddingTop: 0 }}>
          <LinearGradient
            colors={[ios.brandGradient[0]!, ios.brandGradient[1]!, ios.brandGradient[2]!]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.heroCard}
          >
            <Text style={styles.heroEyebrow}>
              {(run.route?.name ?? "ROUTE").toUpperCase()}
            </Text>
            <Text style={styles.heroTitle}>
              {stopCount} stop{stopCount === 1 ? "" : "s"} · ${totalValue.toFixed(0)}
            </Text>
            <Text style={styles.heroSub}>Scheduled · ready to depart</Text>
            <View style={styles.heroActions}>
              <Pressable
                style={styles.heroBtnFilled}
                onPress={onStart}
                disabled={updateStatus.isPending}
              >
                <Ionicons name="play" size={14} color={ios.brandInk} />
                <Text style={styles.heroBtnFilledText}>
                  {updateStatus.isPending ? "Starting…" : "Start day"}
                </Text>
              </Pressable>
            </View>
          </LinearGradient>
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function TodaysRoute({
  run,
  onOpenStop,
}: {
  run: RouteRun;
  onOpenStop: (id: string) => void;
}) {
  const stops = run.stops ?? [];
  const { done, pending, nextStop, totalStops } = useMemo(() => {
    const completed = stops.filter((s) => s.status === "COMPLETED" || s.status === "SKIPPED");
    const remaining = stops.filter(
      (s) => s.status === "PENDING" || s.status === "IN_PROGRESS",
    );
    const sortedRemaining = remaining.sort((a, b) => a.stopNumber - b.stopNumber);
    return {
      done: completed.length,
      pending: remaining.length,
      nextStop: sortedRemaining[0] ?? null,
      totalStops: stops.length,
    };
  }, [stops]);

  const pct = totalStops ? Math.round((done / totalStops) * 100) : 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Today's Route"
        leading={
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Pill variant="green" dot>
              On route
            </Pill>
            {run.route?.name ? <Pill variant="gray">{run.route.name}</Pill> : null}
          </View>
        }
        trailing={null}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          <InlineStats
            stats={[
              { value: String(totalStops), label: "Stops" },
              { value: String(done), label: "Done", color: ios.system.greenInk },
              { value: String(pending), label: "Left", color: ios.brand },
            ]}
          />
          <View style={styles.progressRow}>
            <View style={{ flex: 1 }}>
              <ProgressTrack percent={pct} fill="green" />
            </View>
            <Text style={styles.progressText}>{pct}%</Text>
          </View>
        </View>

        {nextStop ? (
          <View style={{ padding: 16, paddingTop: 14 }}>
            <LinearGradient
              colors={[ios.brandGradient[0]!, ios.brandGradient[1]!, ios.brandGradient[2]!]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.heroCard}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View style={styles.heroNumBadge}>
                  <Text style={styles.heroNumText}>{nextStop.stopNumber}</Text>
                </View>
                <Text style={styles.heroEyebrowLow}>UP NEXT</Text>
              </View>
              <Text style={styles.heroTitleLg}>
                {nextStop.customer?.businessName ?? "Stop"}
              </Text>
              <Text style={styles.heroSub}>{formatStopSub(nextStop)}</Text>
              <View style={styles.heroActions}>
                <Pressable
                  style={[styles.heroBtnGhost, { flex: 1, alignItems: "center" }]}
                  onPress={() => onOpenStop(nextStop.id)}
                >
                  <Text style={styles.heroBtnGhostText}>Open stop</Text>
                </Pressable>
              </View>
            </LinearGradient>
          </View>
        ) : null}

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Stops</Text>
        </View>

        <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 24 }}>
          {stops.map((stop) => (
            <StopCard
              key={stop.id}
              number={stop.stopNumber}
              name={stop.customer?.businessName ?? "Stop"}
              subtitle={formatStopSub(stop)}
              status={stopStatus(stop, nextStop?.id)}
              pillLabel={stopPill(stop, nextStop?.id)}
              onPress={() => onOpenStop(stop.id)}
            />
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function formatStopSub(stop: RouteRunStop): string {
  const parts: string[] = [];
  if (stop.customerAddress?.line1) parts.push(stop.customerAddress.line1);
  const itemCount = (stop.orders ?? []).reduce(
    (t, o) => t + (o.lineItems?.length ?? 0),
    0,
  );
  if (itemCount) parts.push(`${itemCount} item${itemCount === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function stopStatus(stop: RouteRunStop, nextId?: string): "done" | "next" | "pending" {
  if (stop.status === "COMPLETED" || stop.status === "SKIPPED") return "done";
  if (stop.id === nextId) return "next";
  return "pending";
}

function stopPill(stop: RouteRunStop, nextId?: string): string | undefined {
  if (stop.status === "COMPLETED") return "Delivered";
  if (stop.status === "SKIPPED") return "Skipped";
  if (stop.id === nextId) return "Up next";
  return undefined;
}

function NoRoute() {
  const router = useRouter();
  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar largeTitle="Today" />
      <View style={styles.center}>
        <Ionicons name="map-outline" size={48} color={ios.label3} />
        <Text style={styles.emptyTitle}>No route assigned</Text>
        <Text style={styles.emptySub}>
          Check back with dispatch for today's manifest, or start an ad-hoc
          order for a walk-in customer.
        </Text>
        <Pressable
          style={styles.adHocBtn}
          onPress={() => router.push("/(driver)/driver-new-order")}
        >
          <Ionicons name="add" size={16} color="#fff" />
          <Text style={styles.adHocBtnText}>Create ad-hoc order</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 40 },
  adHocBtn: {
    marginTop: 14,
    backgroundColor: ios.brand,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  adHocBtnText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
  emptyTitle: { fontSize: 18, fontFamily: "Inter_600SemiBold", color: ios.label, marginTop: 6 },
  emptySub: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, textAlign: "center" },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 999,
    backgroundColor: ios.brandWash,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: ios.brand, fontSize: 13, fontFamily: "Inter_700Bold" },
  dateEyebrow: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.5,
    paddingHorizontal: 20,
    paddingBottom: 14,
  },
  heroCard: { borderRadius: 20, padding: 18, overflow: "hidden" },
  heroEyebrow: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "rgba(255,255,255,0.75)",
    letterSpacing: 1.2,
  },
  heroEyebrowLow: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "rgba(255,255,255,0.8)",
    letterSpacing: 1,
  },
  heroTitle: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: "#fff",
    letterSpacing: -0.6,
    marginTop: 4,
  },
  heroTitleLg: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: "#fff",
    letterSpacing: -0.4,
    marginTop: 10,
  },
  heroSub: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.85)",
    marginTop: 2,
  },
  heroActions: { flexDirection: "row", gap: 8, marginTop: 16 },
  heroBtnFilled: {
    backgroundColor: "#fff",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  heroBtnFilledText: { color: ios.brandInk, fontSize: 15, fontFamily: "Inter_600SemiBold" },
  heroBtnGhost: {
    backgroundColor: "rgba(255,255,255,0.18)",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
  },
  heroBtnGhostText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
  heroNumBadge: {
    width: 26,
    height: 26,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.22)",
    alignItems: "center",
    justifyContent: "center",
  },
  heroNumText: { color: "#fff", fontSize: 13, fontFamily: "Inter_700Bold" },
  progressRow: { marginTop: 10, flexDirection: "row", alignItems: "center", gap: 10 },
  progressText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    fontVariant: ["tabular-nums"],
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 8,
  },
  sectionTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.3,
  },
});
