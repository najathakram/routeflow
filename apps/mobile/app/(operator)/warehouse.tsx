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
import { useAdminProducts, type AdminProduct } from "../../lib/api/admin";

function toNumber(v: number | string | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function isLowStock(p: AdminProduct): boolean {
  const stock = toNumber(p.currentStock);
  // Schema uses Decimal for currentStock and an Int `reorderPoint`. If the
  // tenant hasn't set a reorderPoint, we treat stock ≤ 5 as the server-side
  // `LOW` default (apps/api/src/products/products.service.ts).
  const threshold = p.reorderPoint != null ? p.reorderPoint : 5;
  return stock > 0 && stock <= threshold;
}

function isOutOfStock(p: AdminProduct): boolean {
  return toNumber(p.currentStock) <= 0;
}

export default function WarehouseScreen() {
  const [search, setSearch] = useState("");

  // One query for the low-stock list (the screen's main content) and a tiny
  // parallel query just for the out-of-stock KPI count. Both are server-side
  // filters per the API (StockStatusFilter enum).
  const lowQuery = useAdminProducts({
    stockStatus: "LOW",
    limit: 100,
    search: search.trim() || undefined,
  });
  const outQuery = useAdminProducts({ stockStatus: "OUT_OF_STOCK", limit: 1 });
  const allQuery = useAdminProducts({ limit: 1 });

  const isLoading = lowQuery.isLoading;
  const lowProducts = lowQuery.data?.data ?? [];
  const lowTotal = Number(lowQuery.data?.meta?.total ?? lowProducts.length);
  const outTotal = Number(outQuery.data?.meta?.total ?? 0);
  const allTotal = Number(allQuery.data?.meta?.total ?? 0);

  const sorted = useMemo(
    () =>
      [...lowProducts].sort(
        (a, b) => toNumber(a.currentStock) - toNumber(b.currentStock),
      ),
    [lowProducts],
  );

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
                value={String(lowTotal)}
                label="Low stock"
              />
              <KpiCard
                icon={<Ionicons name="close-circle-outline" size={18} color={ios.system.redInk} />}
                iconBg={ios.system.redWash}
                value={String(outTotal)}
                label="Out of stock"
              />
            </View>
            <View style={[styles.kpiRow, { marginTop: 12 }]}>
              <KpiCard
                icon={<Ionicons name="checkmark" size={18} color={ios.brand} />}
                iconBg={ios.brandWash}
                value={String(allTotal)}
                label="SKUs tracked"
              />
              <KpiCard
                icon={<Ionicons name="cube-outline" size={18} color={ios.system.purpleInk} />}
                iconBg={ios.system.purpleWash}
                value={String(sorted.filter((p) => p.isActive).length)}
                label="Low & active"
              />
            </View>

            <SectionRow
              title={lowTotal > 0 ? "Low-stock alerts" : "No low stock"}
            />

            <View style={styles.list}>
              {sorted.length === 0 ? (
                <Text style={styles.empty}>
                  {allTotal === 0
                    ? "No products configured."
                    : search
                      ? "No matches for that search."
                      : "All stock levels healthy."}
                </Text>
              ) : (
                sorted.map((p) => {
                  const stock = toNumber(p.currentStock);
                  const threshold = p.reorderPoint ?? 5;
                  const pct =
                    threshold > 0
                      ? Math.min(100, Math.round((stock / threshold) * 100))
                      : 100;
                  const out = isOutOfStock(p);
                  const low = isLowStock(p);
                  return (
                    <View key={p.id} style={styles.row}>
                      <View style={{ flex: 1 }}>
                        <View style={styles.topRow}>
                          <Text style={styles.name} numberOfLines={1}>
                            {p.name}
                          </Text>
                          <Text style={styles.qty}>
                            {stock}{" "}
                            <Text style={styles.min}>
                              / {p.reorderPoint ?? "—"}
                            </Text>
                          </Text>
                        </View>
                        <View style={styles.progressRow}>
                          <View style={{ flex: 1 }}>
                            <ProgressTrack
                              percent={pct}
                              height={3}
                              fill={out ? "red" : low ? "orange" : "brand"}
                            />
                          </View>
                          <Text style={styles.sku}>
                            {p.sku ?? p.barcode ?? ""}
                            {p.unit ? ` · ${p.unit}` : ""}
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
