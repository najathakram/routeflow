import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import {
  KpiCard,
  NavAction,
  NavBar,
  ProgressTrack,
  SearchBar,
} from "@routeflow/ui/mobile/ios";
import { useAdminProducts, type AdminProduct } from "../../../lib/api/admin";

type StockFilter = "ALL" | "LOW" | "LOW_ACTIVE" | "OUT_OF_STOCK" | "OOS_ACTIVE";

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
  const threshold = p.reorderPoint != null ? p.reorderPoint : 5;
  return stock > 0 && stock <= threshold;
}

function isOutOfStock(p: AdminProduct): boolean {
  return toNumber(p.currentStock) <= 0;
}

export default function WarehouseScreen() {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState<StockFilter>("ALL");

  const stockStatusParam =
    activeFilter === "OUT_OF_STOCK" || activeFilter === "OOS_ACTIVE"
      ? "OUT_OF_STOCK"
      : activeFilter === "LOW" || activeFilter === "LOW_ACTIVE"
        ? "LOW"
        : undefined;

  const lowQuery = useAdminProducts({
    stockStatus: "LOW",
    limit: 100,
    search: search.trim() || undefined,
  });
  const outQuery = useAdminProducts({ stockStatus: "OUT_OF_STOCK", limit: 1 });
  const allQuery = useAdminProducts({ limit: 1 });

  const filteredQuery = useAdminProducts({
    stockStatus: stockStatusParam as any,
    limit: 200,
    search: search.trim() || undefined,
  });

  const isLoading = activeFilter === "ALL" ? lowQuery.isLoading : filteredQuery.isLoading;
  const lowProducts = lowQuery.data?.data ?? [];
  const lowTotalServer = Number(lowQuery.data?.meta?.total ?? lowProducts.length);
  const outTotal = Number(outQuery.data?.meta?.total ?? 0);
  const allTotal = Number(allQuery.data?.meta?.total ?? 0);
  const lowTotal = Math.max(0, lowTotalServer - outTotal);

  const displayProducts = useMemo(() => {
    if (activeFilter === "OUT_OF_STOCK") {
      return (filteredQuery.data?.data ?? []).filter((p) => toNumber(p.currentStock) <= 0);
    }
    if (activeFilter === "OOS_ACTIVE") {
      return (filteredQuery.data?.data ?? []).filter((p) => toNumber(p.currentStock) <= 0 && p.isActive);
    }
    if (activeFilter === "LOW") {
      return (filteredQuery.data?.data ?? []).filter((p) => toNumber(p.currentStock) > 0);
    }
    if (activeFilter === "LOW_ACTIVE") {
      return (filteredQuery.data?.data ?? []).filter((p) => toNumber(p.currentStock) > 0 && p.isActive);
    }
    // ALL = show low-stock (positive stock, below threshold)
    return lowProducts
      .filter((p) => toNumber(p.currentStock) > 0)
      .sort((a, b) => toNumber(a.currentStock) - toNumber(b.currentStock));
  }, [activeFilter, filteredQuery.data, lowProducts]);

  const sectionLabel = (() => {
    const count = displayProducts.length;
    if (activeFilter === "OUT_OF_STOCK" || activeFilter === "OOS_ACTIVE") {
      return count > 0
        ? activeFilter === "OOS_ACTIVE"
          ? `Out of stock — active (${count})`
          : `Out of stock (${count})`
        : "No out-of-stock items";
    }
    if (activeFilter === "LOW" || activeFilter === "LOW_ACTIVE") {
      return count > 0
        ? activeFilter === "LOW_ACTIVE"
          ? `Low-stock — active (${count})`
          : `Low-stock alerts (${count})`
        : search.trim()
          ? "No matches for that search"
          : "No low stock";
    }
    // ALL filter
    return count > 0
      ? `Low-stock alerts (${count})`
      : "All stock levels healthy";
  })();

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Warehouse"
        leading={<Text style={styles.eyebrow}>STOCK & LOW-STOCK</Text>}
        trailing={
          <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
            <Pressable
              style={styles.navBtn}
              onPress={() => router.push("/(operator)/products/scan")}
              hitSlop={6}
            >
              <Ionicons name="barcode-outline" size={18} color={ios.label} />
            </Pressable>
            <NavAction
              label="All"
              onPress={() => router.push("/(operator)/products")}
            />
            <NavAction
              label="Add"
              bold
              onPress={() => router.push("/(operator)/products/new")}
            />
          </View>
        }
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
              <Pressable
                onPress={() =>
                  setActiveFilter((f) => (f === "LOW" ? "ALL" : "LOW"))
                }
                style={{ flex: 1 }}
              >
                <KpiCard
                  icon={
                    <Ionicons
                      name="archive-outline"
                      size={18}
                      color={activeFilter === "LOW" ? "#fff" : ios.system.orangeInk}
                    />
                  }
                  iconBg={
                    activeFilter === "LOW"
                      ? ios.system.orangeInk
                      : ios.system.orangeWash
                  }
                  value={String(lowTotal)}
                  label="Low stock"
                  highlighted={activeFilter === "LOW"}
                />
              </Pressable>
              <Pressable
                onPress={() =>
                  setActiveFilter((f) =>
                    f === "OUT_OF_STOCK" ? "ALL" : "OUT_OF_STOCK",
                  )
                }
                style={{ flex: 1 }}
              >
                <KpiCard
                  icon={
                    <Ionicons
                      name="close-circle-outline"
                      size={18}
                      color={
                        activeFilter === "OUT_OF_STOCK"
                          ? "#fff"
                          : ios.system.redInk
                      }
                    />
                  }
                  iconBg={
                    activeFilter === "OUT_OF_STOCK"
                      ? ios.system.redInk
                      : ios.system.redWash
                  }
                  value={String(outTotal)}
                  label="Out of stock"
                  highlighted={activeFilter === "OUT_OF_STOCK"}
                />
              </Pressable>
            </View>
            <View style={[styles.kpiRow, { marginTop: 12 }]}>
              <KpiCard
                icon={<Ionicons name="checkmark" size={18} color={ios.brand} />}
                iconBg={ios.brandWash}
                value={String(allTotal)}
                label="SKUs tracked"
              />
              <Pressable
                style={{ flex: 1 }}
                onPress={() => {
                  if (activeFilter === "OUT_OF_STOCK" || activeFilter === "OOS_ACTIVE") {
                    setActiveFilter((f) => (f === "OOS_ACTIVE" ? "OUT_OF_STOCK" : "OOS_ACTIVE"));
                  } else {
                    setActiveFilter((f) => (f === "LOW_ACTIVE" ? "LOW" : "LOW_ACTIVE"));
                  }
                }}
              >
                <KpiCard
                  icon={
                    <Ionicons
                      name="cube-outline"
                      size={18}
                      color={activeFilter === "LOW_ACTIVE" || activeFilter === "OOS_ACTIVE" ? "#fff" : ios.system.purpleInk}
                    />
                  }
                  iconBg={
                    activeFilter === "LOW_ACTIVE" || activeFilter === "OOS_ACTIVE"
                      ? ios.system.purpleInk
                      : ios.system.purpleWash
                  }
                  value={String(displayProducts.filter((p) => p.isActive).length)}
                  label={activeFilter === "OUT_OF_STOCK" || activeFilter === "OOS_ACTIVE" ? "OOS & active" : "Low & active"}
                  highlighted={activeFilter === "LOW_ACTIVE" || activeFilter === "OOS_ACTIVE"}
                />
              </Pressable>
            </View>

            {activeFilter !== "ALL" ? (
              <Pressable
                style={styles.filterBanner}
                onPress={() => setActiveFilter("ALL")}
              >
                <Text style={styles.filterBannerText}>
                  Filtering:{" "}
                  {activeFilter === "LOW" ? "Low stock" :
                   activeFilter === "LOW_ACTIVE" ? "Low stock · active only" :
                   activeFilter === "OOS_ACTIVE" ? "Out of stock · active only" :
                   "Out of stock"}
                </Text>
                <Ionicons name="close" size={14} color={ios.brand} />
              </Pressable>
            ) : null}

            {/* Quick actions */}
            <View style={styles.quickRow}>
              <QuickBtn
                icon="receipt-outline"
                label="Orders"
                color={ios.brand}
                bg={ios.brandWash}
                onPress={() => router.push("/(operator)/orders")}
              />
              <QuickBtn
                icon="cart-outline"
                label="Buy stock"
                color={ios.system.orangeInk}
                bg={ios.system.orangeWash}
                // TODO: replace with Modal picker (Buy stock: Scan bill / Enter manually / View all)
                onPress={() => router.push("/(operator)/vendor-bills/new" as any)}
              />
              <QuickBtn
                icon="swap-vertical-outline"
                label="Movements"
                color={ios.system.purpleInk}
                bg={ios.system.purpleWash}
                onPress={() => router.push("/(operator)/products")}
              />
              <QuickBtn
                icon="cube-outline"
                label="Adjust"
                color={ios.system.greenInk}
                bg={ios.system.greenWash}
                onPress={() => router.push("/(operator)/products/adjust-picker" as any)}
              />
            </View>

            <SectionRow title={sectionLabel} />

            <View style={styles.list}>
              {displayProducts.length === 0 ? (
                <Text style={styles.empty}>
                  {allTotal === 0
                    ? "No products configured."
                    : search
                      ? "No matches for that search."
                      : activeFilter === "OUT_OF_STOCK"
                        ? "No out-of-stock items."
                        : "All stock levels healthy."}
                </Text>
              ) : (
                displayProducts.map((p) => {
                  const stock = toNumber(p.currentStock);
                  const threshold = p.reorderPoint ?? 5;
                  const pct =
                    threshold > 0
                      ? Math.min(100, Math.round((stock / threshold) * 100))
                      : 100;
                  const out = isOutOfStock(p);
                  const low = isLowStock(p);
                  return (
                    <Pressable
                      key={p.id}
                      style={styles.row}
                      onPress={() =>
                        router.push(`/(operator)/products/${p.id}`)
                      }
                    >
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
                    </Pressable>
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

function QuickBtn({
  icon,
  label,
  color,
  bg,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  color: string;
  bg: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.quickBtn, { backgroundColor: bg }]}
      onPress={onPress}
    >
      <Ionicons name={icon} size={20} color={color} />
      <Text style={[styles.quickBtnLabel, { color }]}>{label}</Text>
    </Pressable>
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
  kpiRow: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
    marginTop: 4,
  },
  filterBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginHorizontal: 16,
    marginTop: 12,
    backgroundColor: ios.brandWash,
    borderRadius: 10,
  },
  filterBannerText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.brand,
  },
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
  topRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  name: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: ios.label,
    flex: 1,
    marginRight: 8,
  },
  qty: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  min: { color: ios.label2, fontFamily: "Inter_400Regular" },
  progressRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 6,
  },
  sku: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    fontVariant: ["tabular-nums"],
  },
  navBtn: {
    width: 32,
    height: 32,
    borderRadius: 999,
    backgroundColor: ios.fill3,
    alignItems: "center",
    justifyContent: "center",
  },
  quickRow: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 16,
    marginTop: 20,
  },
  quickBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
    borderRadius: 12,
  },
  quickBtnLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
  },
});
