import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import Svg, { Path, Rect } from "react-native-svg";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { Pill } from "@routeflow/ui/mobile/ios";

// TODO: wire live driver GPS feed (/routes/live) + polyline + markers.
const DRIVERS = [
  { name: "Marcus R.", route: "R07", progress: "5 / 12 stops · on time", color: ios.brand, init: "MR" },
  { name: "Samira H.", route: "R05", progress: "3 / 11 stops · +18m late", color: ios.system.orange, init: "SH" },
  { name: "Dmitri K.", route: "R11", progress: "2 / 14 stops · on time", color: ios.system.indigo, init: "DK" },
];

export default function FleetScreen() {
  const router = useRouter();
  return (
    <View style={styles.screen}>
      {/* Mock map backdrop */}
      <View style={styles.mapBg}>
        <Svg width="100%" height="100%" viewBox="0 0 393 852" preserveAspectRatio="none">
          <Path d="M-20 180 Q 100 200 200 240 T 420 280" stroke="#fff" strokeWidth={14} fill="none" />
          <Path d="M80 -20 Q 120 200 170 420 T 260 820" stroke="#fff" strokeWidth={12} fill="none" />
          <Path d="M-20 500 Q 120 470 240 510 T 420 540" stroke="#fff" strokeWidth={12} fill="none" />
          <Rect x={40} y={360} width={80} height={50} rx={10} fill="#B9D7B1" opacity={0.7} />
          <Rect x={260} y={420} width={110} height={80} rx={14} fill="#B9D7B1" opacity={0.7} />
          <Path
            d="M-20 820 Q 100 780 200 810 T 420 790 L 420 900 L -20 900 Z"
            fill="#A9C8D2"
            opacity={0.8}
          />
          {/* Trails */}
          <Path
            d="M110 300 Q 140 380 200 440 T 300 620"
            stroke="#0B6E6B"
            strokeWidth={3}
            fill="none"
            strokeLinecap="round"
            opacity={0.8}
          />
          <Path
            d="M260 210 Q 240 320 220 450 T 180 700"
            stroke="#5856D6"
            strokeWidth={3}
            fill="none"
            strokeLinecap="round"
            opacity={0.8}
          />
        </Svg>
      </View>

      <SafeAreaView style={styles.overlay} edges={["top", "left", "right"]}>
        {/* Top search */}
        <View style={styles.searchBar}>
          <Ionicons name="search" size={16} color="#636366" />
          <Text style={styles.searchPlaceholder}>Search driver, route, customer…</Text>
          <Pill variant="green" dot small>4 live</Pill>
        </View>

        {/* Legend */}
        <View style={styles.legend}>
          <LegendChip color={ios.brand} label="On time · 3" />
          <LegendChip color={ios.system.orange} label="Late · 1" />
          <LegendChip color={ios.system.green} label="Home · 1" />
        </View>

        <View style={{ flex: 1 }} />

        {/* Bottom sheet — driver list */}
        <View style={styles.sheet}>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>Live drivers</Text>
            <Text style={styles.msgAll}>Message all</Text>
          </View>
          {DRIVERS.map((d, i) => (
            <Pressable
              key={d.name}
              onPress={() => router.push(`/(operator)/driver?id=${encodeURIComponent(d.name)}`)}
              style={[
                styles.driverRow,
                i > 0 && {
                  borderTopWidth: StyleSheet.hairlineWidth,
                  borderTopColor: "rgba(60,60,67,0.12)",
                },
              ]}
            >
              <View style={[styles.avatar, { backgroundColor: d.color }]}>
                <Text style={styles.avatarText}>{d.init}</Text>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.driverName}>
                  {d.name} <Text style={styles.driverRoute}>· {d.route}</Text>
                </Text>
                <Text style={styles.driverProgress}>{d.progress}</Text>
              </View>
              <View style={styles.msgBtn}>
                <Ionicons name="chatbubble-outline" size={15} color={ios.brand} />
              </View>
            </Pressable>
          ))}
        </View>
      </SafeAreaView>
    </View>
  );
}

function LegendChip({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.legendChip}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#DCE7E9" },
  mapBg: { ...StyleSheet.absoluteFillObject },
  overlay: { flex: 1, paddingHorizontal: 16 },
  searchBar: {
    backgroundColor: "rgba(255,255,255,0.96)",
    borderRadius: 14,
    padding: 10,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
    marginTop: 8,
  },
  searchPlaceholder: { flex: 1, fontSize: 15, color: "#636366", fontFamily: "Inter_400Regular" },
  legend: {
    flexDirection: "row",
    gap: 6,
    marginTop: 12,
    flexWrap: "wrap",
  },
  legendChip: {
    backgroundColor: "rgba(255,255,255,0.94)",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  legendDot: { width: 8, height: 8, borderRadius: 999 },
  legendText: { fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#000" },
  sheet: {
    backgroundColor: "rgba(255,255,255,0.98)",
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    marginHorizontal: -6,
    marginBottom: 10,
    paddingBottom: 16,
    paddingTop: 12,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: -6 },
    elevation: 6,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 999,
    backgroundColor: "#D1D1D6",
    alignSelf: "center",
    marginBottom: 10,
  },
  sheetHead: {
    paddingHorizontal: 16,
    paddingBottom: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  sheetTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: "#000",
    letterSpacing: -0.3,
  },
  msgAll: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.brand },
  driverRow: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontSize: 13, fontFamily: "Inter_700Bold" },
  driverName: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#000" },
  driverRoute: { color: "#636366", fontFamily: "Inter_500Medium", fontSize: 13 },
  driverProgress: { fontSize: 12, fontFamily: "Inter_400Regular", color: "#636366", marginTop: 1 },
  msgBtn: {
    width: 34,
    height: 34,
    backgroundColor: ios.brandWash,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
});
