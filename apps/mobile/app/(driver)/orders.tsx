import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import {
  FilterChipRow,
  NavBar,
  Pill,
  SearchBar,
} from "@routeflow/ui/mobile/ios";

// TODO: wire /standing-orders endpoint (already exists on API).
const TEMPLATES = [
  {
    name: "Harbor Café",
    freq: "Mon · Wed · Fri",
    items: "3 items · $184",
    next: "Apr 22",
    color: "#D2691E",
    init: "HC",
  },
  {
    name: "North Deli",
    freq: "Every weekday",
    items: "8 items · $246",
    next: "Apr 21",
    color: "#0B6E6B",
    init: "ND",
    badge: "Auto-ship",
  },
  {
    name: "Bayside Bistro",
    freq: "Tuesdays",
    items: "12 items · $420",
    next: "Apr 22",
    color: "#5856D6",
    init: "BB",
  },
  {
    name: "Central Kitchen",
    freq: "Daily",
    items: "6 items · $198",
    next: "Tomorrow",
    color: "#34C759",
    init: "CK",
  },
  {
    name: "Luna Roastery",
    freq: "Every Thursday",
    items: "4 items · $88",
    next: "paused",
    color: "#8E8E93",
    init: "LR",
    paused: true,
  },
];

export default function OrdersScreen() {
  const [filter, setFilter] = useState("Active · 24");
  const chips = [
    { label: "Active · 24" },
    { label: "Paused · 3" },
    { label: "Daily" },
    { label: "Weekly" },
    { label: "Monthly" },
  ];

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Standing orders"
        leading={
          <View style={styles.syncRow}>
            <Ionicons name="refresh" size={16} color={ios.brand} />
            <Text style={styles.syncText}>Synced 2m ago</Text>
          </View>
        }
        trailing={<Ionicons name="add" size={22} color={ios.brand} />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <SearchBar placeholder="Search customers…" />
        <FilterChipRow chips={chips} value={filter} onChange={setFilter} />

        <View style={{ paddingHorizontal: 16, paddingTop: 4, gap: 10, paddingBottom: 16 }}>
          {TEMPLATES.map((t) => (
            <View key={t.name} style={styles.card}>
              <View style={styles.cardHead}>
                <View style={[styles.avatar, { backgroundColor: t.color }]}>
                  <Text style={styles.avatarText}>{t.init}</Text>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={styles.nameRow}>
                    <Text style={styles.name}>{t.name}</Text>
                    {t.badge ? (
                      <View style={{ marginLeft: 6 }}>
                        <Pill variant="brand" small>
                          {t.badge}
                        </Pill>
                      </View>
                    ) : null}
                  </View>
                  <Text style={styles.freq}>{t.freq}</Text>
                </View>
                {t.paused ? (
                  <Pill variant="gray">Paused</Pill>
                ) : (
                  <Text style={styles.chev}>›</Text>
                )}
              </View>
              <View style={styles.cardFoot}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.footEyebrow}>NEXT</Text>
                  <Text style={styles.footValue}>{t.next}</Text>
                </View>
                <View style={{ flex: 2, alignItems: "flex-end" }}>
                  <Text style={styles.footEyebrow}>ORDER</Text>
                  <Text style={styles.footValue}>{t.items}</Text>
                </View>
                <Pressable style={styles.footIcon}>
                  <Ionicons name="reorder-three-outline" size={16} color={ios.brand} />
                </Pressable>
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
  syncRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  syncText: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.brand },
  card: {
    backgroundColor: ios.bgElev,
    borderRadius: 16,
    overflow: "hidden",
  },
  cardHead: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontSize: 14, fontFamily: "Inter_700Bold" },
  nameRow: { flexDirection: "row", alignItems: "center" },
  name: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  freq: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 1 },
  chev: { fontSize: 22, color: ios.gray[3], fontFamily: "Inter_400Regular" },
  cardFoot: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: ios.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  footEyebrow: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.6,
  },
  footValue: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  footIcon: {
    width: 34,
    height: 34,
    backgroundColor: ios.brandWash,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
});
