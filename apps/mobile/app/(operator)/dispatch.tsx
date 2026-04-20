import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import {
  NavAction,
  NavBar,
  Pill,
  SegmentedControl,
} from "@routeflow/ui/mobile/ios";

// TODO: wire /routes + /drivers + POST /routes/{id}/assign
const DRIVERS = [
  { name: "Jordan M.", status: "Available · checked in 06:32", badge: "Recommended", state: "available" as const, dist: "Home zone: East" },
  { name: "Priya S.", status: "Available · checked in 06:40", state: "available" as const, dist: "Home zone: Central" },
  { name: "Leo K.", status: "On break · ETA 20 min", state: "available" as const, dist: "Home zone: East" },
  { name: "Rita A.", status: "Not checked in", state: "unavailable" as const, dist: "Was on Route 02" },
];

export default function DispatchScreen() {
  const [tab, setTab] = useState("Routes");
  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Dispatch"
        inlineTitle="Assign"
        trailing={<NavAction label="Release" bold />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ paddingHorizontal: 16, paddingTop: 6 }}>
          <SegmentedControl
            items={["Routes", "Drivers", "Conflicts · 2"]}
            value={tab}
            onChange={setTab}
          />
        </View>

        {/* Unassigned warning */}
        <View style={styles.warn}>
          <Ionicons name="alert-circle-outline" size={16} color={ios.system.redInk} />
          <Text style={styles.warnText}>
            Route 02 has no driver · 8 stops · departing 08:00
          </Text>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Assign driver → Route 02</Text>
        </View>

        <View style={{ paddingHorizontal: 16 }}>
          <View style={styles.driversCard}>
            {DRIVERS.map((d, i) => (
              <View
                key={d.name}
                style={[
                  styles.driverRow,
                  i > 0 && {
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: ios.separator,
                  },
                ]}
              >
                <View style={[styles.avatar, { backgroundColor: ios.brand }]}>
                  <Text style={styles.avatarText}>
                    {d.name.split(" ").map((n) => n[0]).join("")}
                  </Text>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Text style={styles.driverName}>{d.name}</Text>
                    {d.badge ? <Pill variant="brand" small>{d.badge}</Pill> : null}
                  </View>
                  <Text style={styles.driverStatus}>{d.status}</Text>
                  <Text style={styles.driverDist}>{d.dist}</Text>
                </View>
                {d.state === "unavailable" ? (
                  <Pill variant="red">Unavailable</Pill>
                ) : (
                  <Pressable
                    style={[
                      styles.assignBtn,
                      d.badge ? styles.assignBtnPrimary : styles.assignBtnSecondary,
                    ]}
                  >
                    <Text
                      style={[
                        styles.assignBtnText,
                        d.badge ? styles.assignBtnTextOn : styles.assignBtnTextOff,
                      ]}
                    >
                      Assign
                    </Text>
                  </Pressable>
                )}
              </View>
            ))}
          </View>
        </View>

        {/* Route summary */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Route 02 preview</Text>
        </View>
        <View style={{ paddingHorizontal: 16 }}>
          <View style={styles.previewCard}>
            <View style={styles.previewRow}>
              <PreviewStat label="STOPS" value="8" />
              <PreviewStat label="VALUE" value="$2,140" />
              <PreviewStat label="DISTANCE" value="86 km" />
              <PreviewStat label="ETA" value="5h 20" />
            </View>
            <View style={styles.previewPills}>
              <Pill variant="gray">Van 02 · 3.5t</Pill>
              <Pill variant="gray">Chilled req.</Pill>
              <Pill variant="orange">1 fragile stop</Pill>
            </View>
          </View>
        </View>
        <View style={{ height: 20 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function PreviewStat({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text style={styles.previewLabel}>{label}</Text>
      <Text style={styles.previewValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  warn: {
    marginHorizontal: 16,
    marginTop: 14,
    padding: 10,
    paddingHorizontal: 14,
    backgroundColor: ios.system.redWash,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,59,48,0.3)",
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  warnText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.system.redInk,
    flex: 1,
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
  driversCard: {
    backgroundColor: ios.bgElev,
    borderRadius: 16,
    overflow: "hidden",
  },
  driverRow: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontSize: 14, fontFamily: "Inter_700Bold" },
  driverName: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
  },
  driverStatus: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 1 },
  driverDist: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 1 },
  assignBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
  assignBtnPrimary: { backgroundColor: ios.brand },
  assignBtnSecondary: { backgroundColor: ios.fill2 },
  assignBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  assignBtnTextOn: { color: "#fff" },
  assignBtnTextOff: { color: ios.brand },
  previewCard: { backgroundColor: ios.bgElev, borderRadius: 16, padding: 14 },
  previewRow: { flexDirection: "row", gap: 14 },
  previewLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.6,
  },
  previewValue: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  previewPills: { flexDirection: "row", gap: 6, marginTop: 12, flexWrap: "wrap" },
});
