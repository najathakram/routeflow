import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useLocalSearchParams } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import {
  InlineStats,
  ListGroup,
  ListRow,
  MessageBubble,
  NavBackButton,
  NavBar,
} from "@routeflow/ui/mobile/ios";

const TIMELINE = [
  { t: "09:42", title: "Delivered — Luna Roastery", sub: "$312 cash · signed", c: ios.system.green },
  { t: "09:08", title: "Delivered — Green Market", sub: "Left at door · photo", c: ios.system.green },
  { t: "08:45", title: "Arrived — Atlas Catering", sub: "0.3 mi ahead of ETA", c: ios.brand },
  { t: "07:50", title: "Left depot", sub: "Van 07 · 84 items loaded", c: ios.gray[1] },
];

export default function OperatorDriverDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const driverName = params?.id || "Marcus Renard";

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={`${driverName} · R07`}
        leading={<NavBackButton label="Fleet" onPress={() => router.back()} />}
        trailing={<Ionicons name="ellipsis-vertical" size={20} color={ios.brand} />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={styles.header}>
          <LinearGradient
            colors={[ios.brandGradient[0]!, ios.brandGradient[1]!, ios.brandGradient[2]!]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.avatar}
          >
            <Text style={styles.avatarText}>MR</Text>
          </LinearGradient>
          <Text style={styles.name}>{driverName}</Text>
          <Text style={styles.sub}>Van 07 · On route · 3.8h driven today</Text>
          <View style={styles.actions}>
            <ActionChip icon="call-outline" label="Call" />
            <ActionChip icon="chatbubble-outline" label="Message" />
            <ActionChip icon="swap-horizontal-outline" label="Reassign" />
          </View>
        </View>

        {/* Live stats */}
        <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
          <InlineStats
            stats={[
              { value: "5/12", label: "Stops" },
              { value: "$1,486", label: "Collected", color: ios.system.greenInk },
              { value: "64 km", label: "Driven" },
            ]}
          />
        </View>

        {/* Thread */}
        <SectionRow title="Thread" link="Open chat" />
        <View style={{ paddingHorizontal: 16, gap: 6 }}>
          <MessageBubble
            side="left"
            text="Harbor Café is cash-only today — bring exact change if you can."
            meta="Jamie · Dispatch · 8:42"
          />
          <MessageBubble
            side="right"
            text="Got it. Stopped at petrol for float ✓"
            meta="Marcus · 8:50"
          />
        </View>

        {/* Timeline */}
        <SectionRow title="Today's timeline" />
        <ListGroup>
          {TIMELINE.map((e) => (
            <ListRow
              key={e.t}
              icon={<View style={[styles.dot, { backgroundColor: e.c }]} />}
              iconBg="transparent"
              title={e.title}
              subtitle={e.sub}
              value={e.t}
            />
          ))}
        </ListGroup>
        <View style={{ height: 20 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function ActionChip({
  icon,
  label,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
}) {
  return (
    <View style={styles.chip}>
      <Ionicons name={icon} size={15} color={ios.label} />
      <Text style={styles.chipText}>{label}</Text>
    </View>
  );
}

function SectionRow({ title, link }: { title: string; link?: string }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {link ? <Text style={styles.sectionLink}>{link}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bgElev },
  header: {
    backgroundColor: ios.bgElev,
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 18,
    alignItems: "center",
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontSize: 22, fontFamily: "Inter_700Bold" },
  name: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    marginTop: 10,
    letterSpacing: -0.4,
  },
  sub: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  actions: { flexDirection: "row", gap: 8, marginTop: 14 },
  chip: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    backgroundColor: ios.fill3,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  chipText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label },
  sectionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 8,
  },
  sectionTitle: { fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.3 },
  sectionLink: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.brand },
  dot: { width: 8, height: 8, borderRadius: 999 },
});
