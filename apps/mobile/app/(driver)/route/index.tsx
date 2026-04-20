import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import {
  InlineStats,
  ListGroup,
  ListRow,
  NavBar,
  Pill,
  ProgressTrack,
  StopCard,
} from "@routeflow/ui/mobile/ios";

type RouteState = "pre-depart" | "on-route";

// TODO: replace with live RouteRun data from useRouteStore() / /routes API
const STOPS = [
  { n: 1, name: "North Deli", addr: "18 North Parade · $246 collected", status: "done" as const, pill: "Delivered" },
  { n: 2, name: "Bayside Bistro", addr: "7 Bay Rd · $312 cash", status: "done" as const, pill: "Delivered" },
  { n: 3, name: "Atlas Catering", addr: "92 River St · $198", status: "done" as const, pill: "Delivered" },
  { n: 4, name: "Green Market", addr: "14 Ferry Lane · Left at door", status: "done" as const, pill: "Unattended" },
  { n: 5, name: "Luna Roastery", addr: "6 Grove St · $312", status: "done" as const, pill: "Delivered" },
  { n: 6, name: "Harbor Café", addr: "42 Harbour St · 3 items · $184", status: "next" as const, pill: "Up next" },
  { n: 7, name: "Westpark Grill", addr: "15 West End Blvd · 5 items", status: "pending" as const, pill: undefined },
  { n: 8, name: "Central Kitchen", addr: "3 Market Sq · 4 items", status: "pending" as const, pill: "Call ahead" },
];

export default function DriverRouteScreen() {
  const router = useRouter();
  // TODO: derive from useRouteStore() — active RouteRun? Pre-depart state shows SOD; otherwise today's route.
  const [state] = useState<RouteState>("on-route");

  if (state === "pre-depart") return <StartOfDay />;
  return <TodaysRoute onOpenStop={(id) => router.push(`/(driver)/route/stop/${id}`)} />;
}

function StartOfDay() {
  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Good morning, Marcus"
        trailing={
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>MR</Text>
          </View>
        }
      />
      <ScrollView showsVerticalScrollIndicator={false}>
        <Text style={styles.dateEyebrow}>THURSDAY · APR 19</Text>

        <View style={{ padding: 16, paddingTop: 0 }}>
          <LinearGradient
            colors={[ios.brandGradient[0]!, ios.brandGradient[1]!, ios.brandGradient[2]!]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.heroCard}
          >
            <Text style={styles.heroEyebrow}>ROUTE 07 — NORTH SHORE</Text>
            <Text style={styles.heroTitle}>12 stops · $3,480</Text>
            <Text style={styles.heroSub}>Est. 7h 10m · 148 km</Text>
            <View style={styles.heroActions}>
              <Pressable style={styles.heroBtnFilled}>
                <Ionicons name="play" size={14} color={ios.brandInk} />
                <Text style={styles.heroBtnFilledText}>Start day</Text>
              </Pressable>
              <Pressable style={styles.heroBtnGhost}>
                <Text style={styles.heroBtnGhostText}>View manifest</Text>
              </Pressable>
            </View>
          </LinearGradient>
        </View>

        <SectionHeader title="Preflight" action="Skip" />
        <ListGroup>
          <ListRow
            icon={<Ionicons name="checkmark" size={16} color={ios.system.greenInk} />}
            iconBg={ios.system.greenWash}
            title="Van inspection"
            subtitle="Tyres · Mirrors · Fuel 78% · 142,308 km"
            trailing={<Pill variant="green">Done</Pill>}
          />
          <ListRow
            icon={<Ionicons name="barcode-outline" size={16} color={ios.brand} />}
            iconBg={ios.brandWash}
            title="Scan pick list"
            subtitle="78 / 84 items loaded · 6 short"
            trailing={<Pill variant="orange">Review</Pill>}
          />
          <ListRow
            icon={<Ionicons name="wallet-outline" size={16} color={ios.gray[1]} />}
            iconBg={ios.fill3}
            title="Opening float"
            subtitle="$200 cash · petty"
            chevron
          />
        </ListGroup>

        <SectionHeader title="Heads up" />
        <ListGroup>
          <ListRow
            icon={<Ionicons name="alert-circle-outline" size={16} color={ios.system.red} />}
            iconBg={ios.system.redWash}
            title="Harbor Café — overdue $420"
            subtitle="Collect before delivery per dispatch"
            chevron
          />
          <ListRow
            icon={<Ionicons name="warning-outline" size={16} color={ios.system.yellowInk} />}
            iconBg={ios.system.yellowWash}
            title="Road closure · King St"
            subtitle="Auto-rerouted stops 9–11"
            chevron
          />
        </ListGroup>
        <View style={{ height: 16 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function TodaysRoute({ onOpenStop }: { onOpenStop: (id: string | number) => void }) {
  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Today's Route"
        leading={
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Pill variant="green" dot>On time</Pill>
            <Pill variant="gray">Route 07</Pill>
          </View>
        }
        trailing={<Ionicons name="ellipsis-vertical" size={20} color={ios.brand} />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          <InlineStats
            stats={[
              { value: "12", label: "Stops" },
              { value: "5", label: "Done", color: ios.system.greenInk },
              { value: "7", label: "Left", color: ios.brand },
              { value: "2h10", label: "ETA home" },
            ]}
          />
          <View style={styles.progressRow}>
            <View style={{ flex: 1 }}>
              <ProgressTrack percent={42} fill="green" />
            </View>
            <Text style={styles.progressText}>42%</Text>
          </View>
        </View>

        <View style={{ padding: 16, paddingTop: 14 }}>
          <LinearGradient
            colors={[ios.brandGradient[0]!, ios.brandGradient[1]!, ios.brandGradient[2]!]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.heroCard}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={styles.heroNumBadge}>
                <Text style={styles.heroNumText}>6</Text>
              </View>
              <Text style={styles.heroEyebrowLow}>UP NEXT · 0.8 MI</Text>
            </View>
            <Text style={styles.heroTitleLg}>Harbor Café</Text>
            <Text style={styles.heroSub}>42 Harbour St · 3 items · $184</Text>
            <View style={styles.heroActions}>
              <Pressable style={[styles.heroBtnFilled, { flex: 1, justifyContent: "center" }]}>
                <Text style={styles.heroBtnFilledText}>Navigate</Text>
              </Pressable>
              <Pressable
                style={[styles.heroBtnGhost, { flex: 1, justifyContent: "center", alignItems: "center" }]}
                onPress={() => onOpenStop(6)}
              >
                <Text style={styles.heroBtnGhostText}>Open stop</Text>
              </Pressable>
              <Pressable style={styles.heroBtnIcon}>
                <Ionicons name="call-outline" size={18} color="#fff" />
              </Pressable>
            </View>
          </LinearGradient>
        </View>

        <SectionHeader
          title="Stops"
          rightSlot={
            <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
              <Text style={styles.linkText}>Reorder</Text>
              <Text style={styles.linkDot}>·</Text>
              <Text style={styles.linkText}>Map</Text>
            </View>
          }
        />

        <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 16 }}>
          {STOPS.map((s) => (
            <StopCard
              key={s.n}
              number={s.n}
              name={s.name}
              subtitle={s.addr}
              status={s.status}
              pillLabel={s.pill}
              onPress={() => onOpenStop(s.n)}
            />
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function SectionHeader({
  title,
  action,
  rightSlot,
}: {
  title: string;
  action?: string;
  rightSlot?: React.ReactNode;
}) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {rightSlot ?? (action ? <Text style={styles.linkText}>{action}</Text> : null)}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
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
  heroCard: {
    borderRadius: 20,
    padding: 18,
    overflow: "hidden",
  },
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
  heroActions: {
    flexDirection: "row",
    gap: 8,
    marginTop: 16,
  },
  heroBtnFilled: {
    backgroundColor: "#fff",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  heroBtnFilledText: {
    color: ios.brandInk,
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  heroBtnGhost: {
    backgroundColor: "rgba(255,255,255,0.18)",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
  },
  heroBtnGhostText: {
    color: "#fff",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  heroBtnIcon: {
    width: 44,
    height: 40,
    backgroundColor: "rgba(255,255,255,0.18)",
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  heroNumBadge: {
    width: 26,
    height: 26,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.22)",
    alignItems: "center",
    justifyContent: "center",
  },
  heroNumText: {
    color: "#fff",
    fontSize: 13,
    fontFamily: "Inter_700Bold",
  },
  progressRow: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
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
  linkText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.brand,
  },
  linkDot: { color: ios.label3 },
});
