import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import Svg, { Path, Rect } from "react-native-svg";
import { ios } from "@routeflow/ui/tokens";

// UI-shell only; real map rendering can upgrade this to react-native-maps.
// TODO: wire live driver GPS + stop markers + polyline from /routes/live.
export default function DriverMapScreen() {
  return (
    <View style={styles.screen}>
      {/* Mocked map backdrop — mirrors the hi-fi design */}
      <View style={styles.mapBg}>
        <Svg width="100%" height="100%" viewBox="0 0 393 852" preserveAspectRatio="none">
          {/* Roads */}
          <Path d="M-20 280 Q 80 260 180 320 T 400 360" stroke="#fff" strokeWidth={18} fill="none" />
          <Path d="M40 -20 Q 90 200 140 360 T 220 820" stroke="#fff" strokeWidth={14} fill="none" />
          <Path d="M300 -20 Q 280 160 260 360 T 200 820" stroke="#fff" strokeWidth={12} fill="none" />
          <Path d="M-20 550 Q 100 520 220 560 T 500 620" stroke="#fff" strokeWidth={14} fill="none" />
          <Path d="M-20 700 Q 150 670 280 710 T 500 740" stroke="#fff" strokeWidth={10} fill="none" />
          {/* Parks */}
          <Rect x={240} y={420} width={130} height={100} rx={16} fill="#B9D7B1" opacity={0.7} />
          <Rect x={20} y={420} width={100} height={60} rx={10} fill="#B9D7B1" opacity={0.7} />
          {/* Water */}
          <Path
            d="M-20 820 Q 100 780 200 810 T 420 790 L 420 900 L -20 900 Z"
            fill="#A9C8D2"
            opacity={0.8}
          />
          {/* Route polyline */}
          <Path
            d="M70 240 C 120 300 130 340 170 360 C 210 380 260 370 270 420 C 280 470 230 500 220 560 C 210 620 260 660 300 680"
            stroke="#0B6E6B"
            strokeWidth={5}
            fill="none"
            strokeLinecap="round"
          />
        </Svg>
      </View>

      <SafeAreaView style={styles.overlay} edges={["top", "left", "right"]}>
        {/* Floating "next stop" card */}
        <View style={styles.topRow}>
          <View style={styles.stopCard}>
            <View style={styles.stopNumBadge}>
              <Text style={styles.stopNumText}>6</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.stopName}>Harbor Café</Text>
              <Text style={styles.stopSub}>0.8 mi · 4 min</Text>
            </View>
            <Pressable style={styles.goBtn}>
              <Text style={styles.goBtnText}>Go</Text>
            </Pressable>
          </View>
          <Pressable style={styles.sideBtn}>
            <Ionicons name="menu" size={18} color="#000" />
          </Pressable>
        </View>

        {/* Right-edge map controls */}
        <View style={styles.rightControls}>
          <MapCtrl icon="expand-outline" />
          <MapCtrl icon="add" />
          <MapCtrl icon="remove" />
        </View>

        <View style={{ flex: 1 }} />

        {/* Bottom sheet */}
        <View style={styles.sheet}>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetStats}>
            <View>
              <Text style={styles.statLabel}>ARRIVING IN</Text>
              <Text style={styles.statValueLg}>4 min</Text>
            </View>
            <View style={{ alignItems: "flex-end" }}>
              <Text style={styles.statLabel}>DIST</Text>
              <Text style={styles.statValueMd}>0.8 mi</Text>
            </View>
            <View style={{ alignItems: "flex-end" }}>
              <Text style={styles.statLabel}>STOP</Text>
              <Text style={styles.statValueMd}>6 of 12</Text>
            </View>
          </View>
          <Pressable style={styles.navBtn}>
            <Text style={styles.navBtnText}>Start navigation</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
}

function MapCtrl({ icon }: { icon: keyof typeof Ionicons.glyphMap }) {
  return (
    <View style={styles.ctrl}>
      <Ionicons name={icon} size={18} color="#000" />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#DCE7E9" },
  mapBg: { ...StyleSheet.absoluteFillObject },
  overlay: { flex: 1, paddingHorizontal: 16, paddingTop: 0 },
  topRow: { flexDirection: "row", gap: 10, marginTop: 8 },
  stopCard: {
    flex: 1,
    backgroundColor: "rgba(255,255,255,0.96)",
    borderRadius: 14,
    padding: 10,
    paddingLeft: 14,
    paddingRight: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  stopNumBadge: {
    width: 28,
    height: 28,
    borderRadius: 999,
    backgroundColor: ios.brandWash,
    alignItems: "center",
    justifyContent: "center",
  },
  stopNumText: { color: ios.brand, fontSize: 13, fontFamily: "Inter_700Bold" },
  stopName: { color: "#000", fontSize: 14, fontFamily: "Inter_600SemiBold", letterSpacing: -0.2 },
  stopSub: { color: "#636366", fontSize: 12, fontFamily: "Inter_400Regular" },
  goBtn: {
    backgroundColor: ios.brand,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 10,
  },
  goBtnText: { color: "#fff", fontSize: 13, fontFamily: "Inter_600SemiBold" },
  sideBtn: {
    width: 44,
    height: 44,
    backgroundColor: "rgba(255,255,255,0.96)",
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
  },
  rightControls: {
    position: "absolute",
    right: 16,
    top: 160,
    flexDirection: "column",
    gap: 8,
  },
  ctrl: {
    width: 44,
    height: 44,
    backgroundColor: "rgba(255,255,255,0.96)",
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  sheet: {
    backgroundColor: "rgba(255,255,255,0.98)",
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 16,
    paddingBottom: 18,
    paddingTop: 14,
    marginHorizontal: -6,
    marginBottom: 10,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 999,
    backgroundColor: "#D1D1D6",
    alignSelf: "center",
    marginBottom: 12,
  },
  sheetStats: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  statLabel: {
    color: "#636366",
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.9,
  },
  statValueLg: {
    color: "#000",
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.8,
    fontVariant: ["tabular-nums"],
  },
  statValueMd: {
    color: "#000",
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    fontVariant: ["tabular-nums"],
  },
  navBtn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: 14,
  },
  navBtnText: { color: "#fff", fontSize: 17, fontFamily: "Inter_600SemiBold" },
});
