import { useEffect } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { useRouter } from "expo-router";
import { useAuthStore } from "../../lib/auth-store";
import { useTenantStore } from "../../lib/tenant-store";
import { useScheduledRouteRuns } from "../../lib/api/routes";
import { useDeveloperMode } from "../../lib/api/addons";

// This screen has no in-app entry point today — nothing navigates here. The
// gate below is defense in depth: if it ever does get reached for a non-dev
// tenant, it auto-selects Operator instead of showing a Driver option that
// leads nowhere.
export default function RolePickerScreen() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const setActiveRole = useAuthStore((s) => s.setActiveRole);
  const tenantName = useTenantStore((s) => s.branding?.businessName);
  const { enabled: devMode, isLoading: devLoading } = useDeveloperMode();
  const { data: scheduledData } = useScheduledRouteRuns();

  useEffect(() => {
    if (!devLoading && !devMode) {
      setActiveRole("operator");
      router.replace("/(operator)/home");
    }
  }, [devLoading, devMode, setActiveRole, router]);
  const nextRun = scheduledData?.data?.[0];
  const nextRunStops = nextRun?.stops?.length ?? 0;

  const initials =
    user?.username
      ?.split(/[._\s]/)
      .filter(Boolean)
      .map((p) => p[0]?.toUpperCase())
      .slice(0, 2)
      .join("") ?? "--";

  const chooseDriver = () => {
    setActiveRole("driver");
    router.replace("/(driver)/route");
  };
  const chooseOperator = () => {
    setActiveRole("operator");
    router.replace("/(operator)/home");
  };

  const driverDesc = nextRun
    ? `${nextRun.route?.name ?? "Your route"} is ready · ${nextRunStops} stop${nextRunStops === 1 ? "" : "s"}`
    : "No scheduled route for today — you can still log in as driver.";

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <View style={styles.headerWrap}>
        <View style={styles.identityRow}>
          <LinearGradient
            colors={[ios.brandGradient[0]!, ios.brandGradient[1]!, ios.brandGradient[2]!]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.avatar}
          >
            <Text style={styles.avatarText}>{initials}</Text>
          </LinearGradient>
          <View>
            <Text style={styles.name}>{user?.username ?? "RouteFlow user"}</Text>
            <Text style={styles.sub}>{tenantName ?? "Tenant"} · multi-role</Text>
          </View>
        </View>
        <Text style={styles.prompt}>How are you{"\n"}working today?</Text>
        <Text style={styles.promptSub}>You can switch anytime from the side menu.</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Driver (recommended) */}
        {devMode ? (
          <Pressable onPress={chooseDriver}>
            <LinearGradient
              colors={[ios.brandGradient[0]!, ios.brandGradient[1]!, ios.brandGradient[2]!]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.cardHero}
            >
              <View style={styles.cardHead}>
                <View style={styles.roleIconHero}>
                  <Ionicons name="car-outline" size={26} color="#fff" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.eyebrowOn}>{nextRun ? "Recommended" : "Driver"}</Text>
                  <Text style={styles.roleTitleOn}>Driver</Text>
                  <Text style={styles.roleDescOn}>{driverDesc}</Text>
                </View>
                <Ionicons name="chevron-forward" size={22} color="#fff" />
              </View>
              {nextRun ? (
                <View style={styles.heroStats}>
                  <HeroStat label="Stops" value={String(nextRunStops)} />
                  {nextRun.scheduledDate ? (
                    <HeroStat
                      label="Date"
                      value={new Date(nextRun.scheduledDate).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    />
                  ) : null}
                </View>
              ) : null}
            </LinearGradient>
          </Pressable>
        ) : null}

        {/* Operator */}
        <Pressable onPress={chooseOperator} style={styles.cardPlain}>
          <View style={styles.cardHead}>
            <View style={[styles.roleIcon, { backgroundColor: ios.system.purpleWash }]}>
              <Ionicons name="business-outline" size={26} color={ios.system.purpleInk} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.roleTitle}>Operator</Text>
              <Text style={styles.roleDesc}>Warehouse dispatch, live fleet & exceptions</Text>
            </View>
            <Ionicons name="chevron-forward" size={22} color={ios.label3} />
          </View>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text style={styles.heroStatLabel}>{label}</Text>
      <Text style={styles.heroStatValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  headerWrap: { paddingHorizontal: 20, paddingTop: 24 },
  identityRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontSize: 13, fontFamily: "Inter_700Bold" },
  name: { fontSize: 17, fontFamily: "Inter_600SemiBold", color: ios.label, letterSpacing: -0.2 },
  sub: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  prompt: {
    fontSize: 30,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.8,
    lineHeight: 34,
    marginTop: 24,
  },
  promptSub: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 6 },
  scroll: { padding: 16, gap: 12 },
  cardHero: {
    borderRadius: 20,
    padding: 20,
    overflow: "hidden",
  },
  cardPlain: {
    backgroundColor: ios.bgElev,
    borderRadius: 20,
    padding: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
  },
  cardHead: { flexDirection: "row", alignItems: "flex-start", gap: 14 },
  roleIcon: {
    width: 52,
    height: 52,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  roleIconHero: {
    width: 52,
    height: 52,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center",
    justifyContent: "center",
  },
  eyebrowOn: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    color: "rgba(255,255,255,0.85)",
    letterSpacing: 1.3,
    textTransform: "uppercase",
  },
  roleTitleOn: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: "#fff",
    letterSpacing: -0.4,
    marginTop: 2,
  },
  roleDescOn: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.9)",
    marginTop: 4,
    lineHeight: 20,
  },
  roleTitle: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.4,
  },
  roleTitleSmall: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  roleDesc: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 4,
    lineHeight: 20,
  },
  heroStats: {
    flexDirection: "row",
    gap: 16,
    marginTop: 14,
    paddingLeft: 66,
  },
  heroStatLabel: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.75)",
    letterSpacing: 0.7,
    textTransform: "uppercase",
  },
  heroStatValue: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: "#fff",
    fontVariant: ["tabular-nums"],
  },
  plainStatsRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 14,
    paddingLeft: 66,
    flexWrap: "wrap",
  },
  statusBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: ios.system.greenWash,
    borderRadius: 12,
    marginTop: 16,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: ios.system.green,
  },
  statusText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.system.greenInk,
  },
});
