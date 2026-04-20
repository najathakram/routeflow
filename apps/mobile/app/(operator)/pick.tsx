import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import {
  FilterChipRow,
  NavBackButton,
  NavBar,
  ProgressTrack,
} from "@routeflow/ui/mobile/ios";

type PickStatus = "done" | "active" | "pending" | "short";

// TODO: wire /routes/{id}/picks endpoint + barcode scan event
const PICKS: ReadonlyArray<{
  name: string;
  bin: string;
  need: number;
  got: number;
  status: PickStatus;
  note?: string;
}> = [
  { name: "Sourdough Loaf", bin: "A1·07", need: 24, got: 24, status: "done" },
  { name: "Raw milk (2L)", bin: "C2·03 · chilled", need: 18, got: 18, status: "done" },
  { name: "Butter (500g)", bin: "B3·14", need: 12, got: 7, status: "active" },
  { name: "Croissants (6pk)", bin: "A2·11", need: 18, got: 0, status: "pending" },
  { name: "Pain au chocolat", bin: "A2·12", need: 6, got: 0, status: "short", note: "Only 4 in stock" },
];

function statusColor(s: PickStatus) {
  if (s === "done") return ios.system.green;
  if (s === "active") return ios.brand;
  if (s === "short") return ios.system.orange;
  return ios.gray[4];
}
function statusBg(s: PickStatus) {
  if (s === "done") return ios.system.greenWash;
  if (s === "active") return ios.brandWash;
  if (s === "short") return ios.system.orangeWash;
  return ios.fill3;
}
function statusLabel(s: PickStatus) {
  if (s === "done") return "Loaded";
  if (s === "active") return "Scanning";
  if (s === "short") return "Short 2";
  return "Pending";
}

export default function PickScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState("Route 05 · 112");
  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Route 05 — Load"
        leading={<NavBackButton label="Dispatch" onPress={() => router.back()} />}
        trailing={<Ionicons name="barcode-outline" size={20} color={ios.brand} />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Progress */}
        <View style={styles.progressBlock}>
          <View style={styles.progressRow}>
            <View>
              <Text style={styles.progressNum}>
                47 <Text style={styles.progressDenom}>/ 112</Text>
              </Text>
              <Text style={styles.progressSub}>items loaded · 42%</Text>
            </View>
            <View style={{ alignItems: "flex-end" }}>
              <Text style={styles.etaLabel}>ETA LOAD</Text>
              <Text style={styles.etaValue}>07:28</Text>
            </View>
          </View>
          <View style={{ marginTop: 12 }}>
            <ProgressTrack percent={42} height={6} />
          </View>
        </View>

        {/* Scan hero */}
        <View style={{ padding: 16, paddingBottom: 0 }}>
          <LinearGradient
            colors={[ios.brandGradient[0]!, ios.brandGradient[1]!, ios.brandGradient[2]!]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.scanHero}
          >
            <View style={styles.scanIcon}>
              <Ionicons name="barcode-outline" size={26} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.scanEyebrow}>NEXT TO PICK</Text>
              <Text style={styles.scanName}>Butter (500g)</Text>
              <Text style={styles.scanSub}>Aisle B3 · Bin 14 · needs ×12</Text>
            </View>
          </LinearGradient>
        </View>

        <FilterChipRow
          chips={[
            { label: "Route 05 · 112" },
            { label: "Short · 3" },
            { label: "Fragile · 2" },
            { label: "Chilled · 18" },
          ]}
          value={filter}
          onChange={setFilter}
        />

        <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 8, paddingBottom: 20 }}>
          {PICKS.map((p) => {
            const c = statusColor(p.status);
            return (
              <View
                key={p.name}
                style={[
                  styles.pickCard,
                  { borderColor: p.status === "active" ? ios.brand : ios.separator, borderWidth: p.status === "active" ? 1 : StyleSheet.hairlineWidth },
                ]}
              >
                <View style={styles.pickRow}>
                  <View style={[styles.pickIcon, { backgroundColor: statusBg(p.status) }]}>
                    {p.status === "done" ? (
                      <Ionicons name="checkmark" size={16} color={c} />
                    ) : p.status === "short" ? (
                      <Ionicons name="alert-circle-outline" size={14} color={c} />
                    ) : (
                      <Ionicons name="cube-outline" size={14} color={c} />
                    )}
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.pickName}>{p.name}</Text>
                    <Text style={styles.pickBin}>
                      {p.bin}
                      {p.note ? ` · ${p.note}` : ""}
                    </Text>
                  </View>
                  <View style={{ alignItems: "flex-end" }}>
                    <Text style={styles.pickQty}>
                      {p.got}
                      <Text style={styles.pickNeed}> / {p.need}</Text>
                    </Text>
                    <Text style={[styles.pickStatus, { color: c }]}>
                      {statusLabel(p.status)}
                    </Text>
                  </View>
                </View>
              </View>
            );
          })}
        </View>
      </ScrollView>

      {/* Sticky bottom actions */}
      <View style={styles.bottomBar}>
        <Pressable style={styles.btnSecondary}>
          <Text style={styles.btnSecondaryText}>Flag short</Text>
        </Pressable>
        <Pressable style={styles.btnPrimary}>
          <Text style={styles.btnPrimaryText}>Scan next</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bgElev },
  progressBlock: {
    backgroundColor: ios.bgElev,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  progressRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  progressNum: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.6,
    fontVariant: ["tabular-nums"],
  },
  progressDenom: { color: ios.label2, fontFamily: "Inter_500Medium" },
  progressSub: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  etaLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.4,
  },
  etaValue: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  scanHero: {
    borderRadius: 18,
    padding: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  scanIcon: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  scanEyebrow: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    color: "rgba(255,255,255,0.8)",
    letterSpacing: 0.9,
  },
  scanName: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: "#fff",
    letterSpacing: -0.3,
    marginTop: 2,
  },
  scanSub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.85)",
  },
  pickCard: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 12,
    paddingHorizontal: 14,
  },
  pickRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  pickIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  pickName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  pickBin: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 1,
  },
  pickQty: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  pickNeed: { color: ios.label2, fontFamily: "Inter_500Medium" },
  pickStatus: { fontSize: 11, fontFamily: "Inter_600SemiBold", marginTop: 1 },
  bottomBar: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: ios.bgElev,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
    flexDirection: "row",
    gap: 10,
  },
  btnSecondary: {
    flex: 1,
    backgroundColor: ios.fill2,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  btnSecondaryText: { color: ios.brand, fontSize: 14, fontFamily: "Inter_600SemiBold" },
  btnPrimary: {
    flex: 1,
    backgroundColor: ios.brand,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  btnPrimaryText: { color: "#fff", fontSize: 14, fontFamily: "Inter_600SemiBold" },
});
