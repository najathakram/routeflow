import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import {
  KpiCard,
  NavBar,
  Pill,
  ProgressTrack,
} from "@routeflow/ui/mobile/ios";

// TODO: wire /admin/dashboard KPI endpoints (existing)
const ROUTES = [
  { n: "Route 07", who: "Marcus R.", stops: "12 stops · 148 km", pct: 100, status: "Rolled", color: ios.system.green, variant: "green" as const },
  { n: "Route 03", who: "Ana P.", stops: "9 stops · 92 km", pct: 100, status: "Rolled", color: ios.system.green, variant: "green" as const },
  { n: "Route 11", who: "Dmitri K.", stops: "14 stops · 176 km", pct: 74, status: "Loading", color: ios.brand, variant: "brand" as const },
  { n: "Route 05", who: "Samira H.", stops: "11 stops · 112 km", pct: 42, status: "Picking", color: ios.system.orange, variant: "orange" as const },
  { n: "Route 02", who: "— unassigned", stops: "8 stops · 86 km", pct: 0, status: "No driver", color: ios.system.red, variant: "red" as const },
];

export default function OperatorHomeScreen() {
  const router = useRouter();
  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Warehouse"
        subtitle="North Depot · 6 routes ready to roll"
        leading={
          <Text style={styles.dateEyebrow}>THURSDAY · APR 19 · 06:42</Text>
        }
        trailing={
          <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
            <Pressable style={styles.navIcon}>
              <Ionicons name="notifications-outline" size={17} color={ios.label} />
              <View style={styles.badge} />
            </Pressable>
            <View style={styles.navAvatar}>
              <Text style={styles.navAvatarText}>JL</Text>
            </View>
          </View>
        }
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Readiness hero */}
        <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
          <LinearGradient
            colors={[ios.brandGradient[0]!, ios.brandGradient[1]!, ios.brandGradient[2]!]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.hero}
          >
            <Text style={styles.heroEyebrow}>DISPATCH READINESS</Text>
            <View style={styles.heroRow}>
              <Text style={styles.heroValue}>83%</Text>
              <Text style={styles.heroSub}>4 of 6 routes loaded</Text>
            </View>
            <View style={styles.heroTrack}>
              <View style={[styles.heroTrackFill, { width: "83%" }]} />
            </View>
            <View style={styles.heroActions}>
              <Pressable style={styles.heroBtnFilled}>
                <Text style={styles.heroBtnFilledText}>Release all</Text>
              </Pressable>
              <Pressable style={styles.heroBtnGhost}>
                <Text style={styles.heroBtnGhostText}>Run sheet</Text>
              </Pressable>
            </View>
          </LinearGradient>
        </View>

        {/* KPIs */}
        <View style={styles.kpiGrid}>
          <KpiCard
            icon={<Ionicons name="people-outline" size={18} color={ios.brand} />}
            iconBg={ios.brandWash}
            value="6 / 7"
            label="Drivers checked in"
            delta="Rita — no show"
            deltaTone="neutral"
          />
          <KpiCard
            icon={<Ionicons name="checkmark" size={18} color={ios.system.greenInk} />}
            iconBg={ios.system.greenWash}
            value="74"
            label="Stops scheduled"
            delta="↑ 12 vs yesterday"
            deltaTone="up"
          />
        </View>
        <View style={[styles.kpiGrid, { marginTop: 12 }]}>
          <KpiCard
            icon={<Ionicons name="time-outline" size={18} color={ios.system.orangeInk} />}
            iconBg={ios.system.orangeWash}
            value="7"
            label="Short-picks"
            delta="3 need substitution"
            deltaTone="down"
          />
          <KpiCard
            icon={<Ionicons name="cube-outline" size={18} color={ios.system.purpleInk} />}
            iconBg={ios.system.purpleWash}
            value="$28.4k"
            label="Out for delivery"
            delta="148 invoices"
            deltaTone="neutral"
          />
        </View>

        {/* Routes list */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Routes today</Text>
          <Pressable onPress={() => router.push("/(operator)/dispatch")}>
            <Text style={styles.sectionLink}>All</Text>
          </Pressable>
        </View>

        <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 20 }}>
          {ROUTES.map((r) => (
            <View key={r.n} style={styles.routeCard}>
              <View style={styles.routeHead}>
                <View style={[styles.routeBadge, { backgroundColor: r.color }]}>
                  <Text style={styles.routeBadgeText}>{r.n.split(" ")[1]}</Text>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.routeName}>
                    {r.n} · {r.who}
                  </Text>
                  <Text style={styles.routeMeta}>{r.stops}</Text>
                </View>
                <Pill variant={r.variant} dot>
                  {r.status}
                </Pill>
              </View>
              <View style={styles.routeProgress}>
                <View style={{ flex: 1 }}>
                  <ProgressTrack
                    percent={r.pct}
                    fill={r.variant === "brand" ? "brand" : r.variant === "green" ? "green" : r.variant === "red" ? "red" : "orange"}
                  />
                </View>
                <Text style={styles.routePct}>{r.pct}%</Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  dateEyebrow: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.4,
  },
  navIcon: {
    width: 34,
    height: 34,
    borderRadius: 999,
    backgroundColor: ios.fill3,
    alignItems: "center",
    justifyContent: "center",
  },
  badge: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: ios.system.red,
  },
  navAvatar: {
    width: 34,
    height: 34,
    borderRadius: 999,
    backgroundColor: ios.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  navAvatarText: { color: "#fff", fontSize: 13, fontFamily: "Inter_700Bold" },
  hero: { borderRadius: 20, padding: 18, overflow: "hidden" },
  heroEyebrow: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    color: "rgba(255,255,255,0.8)",
    letterSpacing: 1.2,
  },
  heroRow: { flexDirection: "row", alignItems: "baseline", gap: 8, marginTop: 4 },
  heroValue: {
    fontSize: 42,
    fontFamily: "Inter_700Bold",
    color: "#fff",
    letterSpacing: -1.2,
    fontVariant: ["tabular-nums"],
  },
  heroSub: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.85)",
  },
  heroTrack: {
    height: 6,
    backgroundColor: "rgba(255,255,255,0.24)",
    borderRadius: 999,
    marginTop: 12,
    overflow: "hidden",
  },
  heroTrackFill: {
    height: "100%",
    backgroundColor: "#fff",
    borderRadius: 999,
  },
  heroActions: { flexDirection: "row", gap: 6, marginTop: 14 },
  heroBtnFilled: {
    backgroundColor: "#fff",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  heroBtnFilledText: { color: ios.brandInk, fontSize: 13, fontFamily: "Inter_600SemiBold" },
  heroBtnGhost: {
    backgroundColor: "rgba(255,255,255,0.2)",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  heroBtnGhostText: { color: "#fff", fontSize: 13, fontFamily: "Inter_600SemiBold" },
  kpiGrid: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
    marginTop: 14,
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 8,
  },
  sectionTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.3,
  },
  sectionLink: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.brand },
  routeCard: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 12, paddingHorizontal: 14 },
  routeHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  routeBadge: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  routeBadgeText: { color: "#fff", fontSize: 12, fontFamily: "Inter_700Bold" },
  routeName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  routeMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 1 },
  routeProgress: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 10 },
  routePct: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    minWidth: 34,
    textAlign: "right",
    fontVariant: ["tabular-nums"],
  },
});
