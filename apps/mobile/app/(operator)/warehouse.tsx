import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import {
  KpiCard,
  ListGroup,
  NavAction,
  NavBar,
  ProgressTrack,
  SearchBar,
} from "@routeflow/ui/mobile/ios";

// TODO: wire /products + stock + low-stock thresholds.
const LOW = [
  { name: "Butter (500g)", sku: "1108", bin: "B3·14", have: 24, min: 48, pct: 50 },
  { name: "Croissants (6pk)", sku: "3302", bin: "A2·11", have: 8, min: 40, pct: 20 },
  { name: "Pain au chocolat", sku: "3308", bin: "A2·12", have: 4, min: 30, pct: 13 },
  { name: "Raw milk 2L", sku: "2201", bin: "C2·03", have: 18, min: 36, pct: 50 },
];

export default function WarehouseScreen() {
  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Warehouse"
        leading={<Text style={styles.eyebrow}>NORTH DEPOT</Text>}
        trailing={<Ionicons name="barcode-outline" size={20} color={ios.brand} />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <SearchBar placeholder="Search SKU, name or bin…" />

        <View style={styles.kpiRow}>
          <KpiCard
            icon={<Ionicons name="archive-outline" size={18} color={ios.system.orangeInk} />}
            iconBg={ios.system.orangeWash}
            value="14"
            label="Low stock"
          />
          <KpiCard
            icon={<Ionicons name="close-circle-outline" size={18} color={ios.system.redInk} />}
            iconBg={ios.system.redWash}
            value="3"
            label="Out of stock"
          />
        </View>
        <View style={[styles.kpiRow, { marginTop: 12 }]}>
          <KpiCard
            icon={<Ionicons name="checkmark" size={18} color={ios.brand} />}
            iconBg={ios.brandWash}
            value="1,284"
            label="SKUs tracked"
          />
          <KpiCard
            icon={<Ionicons name="cube-outline" size={18} color={ios.system.purpleInk} />}
            iconBg={ios.system.purpleWash}
            value="6"
            label="Inbound POs"
          />
        </View>

        <SectionRow title="Low-stock alerts" action="Reorder all" />
        <ListGroup>
          {LOW.map((p) => (
            <View key={p.sku} style={styles.lowRow}>
              <View style={{ flex: 1 }}>
                <View style={styles.lowTop}>
                  <Text style={styles.lowName}>{p.name}</Text>
                  <Text style={styles.lowQty}>
                    {p.have}{" "}
                    <Text style={styles.lowMin}>/ {p.min}</Text>
                  </Text>
                </View>
                <View style={styles.lowProgress}>
                  <View style={{ flex: 1 }}>
                    <ProgressTrack percent={p.pct} height={3} fill={p.pct <= 25 ? "orange" : "brand"} />
                  </View>
                  <Text style={styles.lowBin}>{p.bin}</Text>
                </View>
              </View>
            </View>
          ))}
        </ListGroup>
        <View style={{ height: 20 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function SectionRow({ title, action }: { title: string; action?: string }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {action ? <Text style={styles.sectionLink}>{action}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  eyebrow: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.4,
  },
  kpiRow: { flexDirection: "row", gap: 12, paddingHorizontal: 16, marginTop: 4 },
  sectionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 8,
  },
  sectionTitle: { fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.3 },
  sectionLink: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.brand },
  lowRow: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    backgroundColor: ios.bgElev,
  },
  lowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  lowName: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label },
  lowQty: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  lowMin: { color: ios.label2, fontFamily: "Inter_400Regular" },
  lowProgress: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  lowBin: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    fontVariant: ["tabular-nums"],
  },
});
