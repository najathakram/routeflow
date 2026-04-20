import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import {
  KpiCard,
  NavBar,
  ProgressTrack,
  SearchBar,
} from "@routeflow/ui/mobile/ios";
import { useAdminProducts } from "../../lib/api/admin";

export default function WarehouseScreen() {
  const [search, setSearch] = useState("");
  const { data: allData, isLoading } = useAdminProducts({ limit: 100 });
  const products = allData?.data ?? [];

  const stats = useMemo(() => {
    const low = products.filter(
      (p) => p.reorderLevel != null && p.currentStock <= p.reorderLevel,
    );
    const out = products.filter((p) => p.currentStock <= 0);
    return {
      low: low.length,
      out: out.length,
      total: products.length,
      lowRows: low.sort((a, b) => a.currentStock - b.currentStock),
    };
  }, [products]);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return stats.lowRows;
    return stats.lowRows.filter(
      (p) =>
        p.name.toLowerCase().includes(s) ||
        (p.sku ?? "").toLowerCase().includes(s) ||
        (p.barcode ?? "").toLowerCase().includes(s),
    );
  }, [stats.lowRows, search]);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Warehouse"
        leading={<Text style={styles.eyebrow}>STOCK & LOW-STOCK</Text>}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <SearchBar
          placeholder="Search SKU, name or barcode…"
          value={search}
          onChangeText={setSearch}
        />

        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : (
          <>
            <View style={styles.kpiRow}>
              <KpiCard
                icon={<Ionicons name="archive-outline" size={18} color={ios.system.orangeInk} />}
                iconBg={ios.system.orangeWash}
                value={String(stats.low)}
                label="Low stock"
              />
              <KpiCard
                icon={<Ionicons name="close-circle-outline" size={18} color={ios.system.redInk} />}
                iconBg={ios.system.redWash}
                value={String(stats.out)}
                label="Out of stock"
              />
            </View>
            <View style={[styles.kpiRow, { marginTop: 12 }]}>
              <KpiCard
                icon={<Ionicons name="checkmark" size={18} color={ios.brand} />}
                iconBg={ios.brandWash}
                value={String(stats.total)}
                label="SKUs tracked"
              />
              <KpiCard
                icon={<Ionicons name="cube-outline" size={18} color={ios.system.purpleInk} />}
                iconBg={ios.system.purpleWash}
                value={String(products.filter((p) => p.isActive).length)}
                label="Active"
              />
            </View>

            <SectionRow title={stats.low > 0 ? "Low-stock alerts" : "No low stock"} />

            <View style={styles.list}>
              {filtered.length === 0 ? (
                <Text style={styles.empty}>
                  {stats.total === 0
                    ? "No products configured."
                    : search
                      ? "No matches for that search."
                      : "All stock levels healthy."}
                </Text>
              ) : (
                filtered.map((p) => {
                  const minLevel = p.reorderLevel ?? 0;
                  const pct =
                    minLevel > 0
                      ? Math.min(100, Math.round((p.currentStock / minLevel) * 100))
                      : 100;
                  return (
                    <View key={p.id} style={styles.row}>
                      <View style={{ flex: 1 }}>
                        <View style={styles.topRow}>
                          <Text style={styles.name} numberOfLines={1}>
                            {p.name}
                          </Text>
                          <Text style={styles.qty}>
                            {p.currentStock} <Text style={styles.min}>/ {minLevel}</Text>
                          </Text>
                        </View>
                        <View style={styles.progressRow}>
                          <View style={{ flex: 1 }}>
                            <ProgressTrack
                              percent={pct}
                              height={3}
                              fill={pct <= 25 ? "orange" : "brand"}
                            />
                          </View>
                          <Text style={styles.sku}>
                            {p.sku ?? p.barcode ?? ""} · {p.unit}
                          </Text>
                        </View>
                      </View>
                    </View>
                  );
                })
              )}
            </View>
          </>
        )}
        <View style={{ height: 20 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function SectionRow({ title }: { title: string }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionTitle}>{title}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
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
  sectionTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.3,
  },
  list: {
    marginHorizontal: 16,
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    overflow: "hidden",
  },
  empty: {
    textAlign: "center",
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    padding: 16,
  },
  row: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  topRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  name: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label, flex: 1, marginRight: 8 },
  qty: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  min: { color: ios.label2, fontFamily: "Inter_400Regular" },
  progressRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  sku: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    fontVariant: ["tabular-nums"],
  },
});
