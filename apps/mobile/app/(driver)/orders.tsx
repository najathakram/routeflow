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
import { ios } from "@routeflow/ui/tokens";
import {
  FilterChipRow,
  NavBar,
  Pill,
  SearchBar,
} from "@routeflow/ui/mobile/ios";
import { useMyStandingOrders, type StandingOrder } from "../../lib/api/standing-orders";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function initialsFromName(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("") || "?";
}

function frequencyLabel(days: number[]): string {
  if (days.length === 0) return "No schedule";
  if (days.length === 7) return "Daily";
  if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) {
    return "Every weekday";
  }
  return days
    .slice()
    .sort()
    .map((d) => DAY_LABELS[d])
    .join(" · ");
}

function templateTotal(t: StandingOrder): number {
  return (t.items ?? []).reduce(
    (sum, it) => sum + it.qty * Number(it.product?.pricePerUnit ?? 0),
    0,
  );
}

function colorForName(name: string): string {
  const palette = [
    "#0B6E6B",
    "#D2691E",
    "#5856D6",
    "#34C759",
    "#FF9500",
    "#AF52DE",
    "#0BA8A4",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length]!;
}

export default function OrdersScreen() {
  const [filter, setFilter] = useState("Active");
  const [search, setSearch] = useState("");
  const { data, isLoading } = useMyStandingOrders();
  const templates = data?.data ?? [];

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return templates.filter((t) => {
      if (filter === "Active" && !t.isActive) return false;
      if (filter === "Paused" && t.isActive) return false;
      if (!s) return true;
      return (
        t.name.toLowerCase().includes(s) ||
        (t.customer?.businessName ?? "").toLowerCase().includes(s)
      );
    });
  }, [templates, filter, search]);

  const activeCount = templates.filter((t) => t.isActive).length;
  const pausedCount = templates.filter((t) => !t.isActive).length;
  const chips = [
    { label: "Active", count: activeCount },
    { label: "Paused", count: pausedCount },
    { label: "All", count: templates.length },
  ];

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Standing orders"
        trailing={<Ionicons name="add" size={22} color={ios.brand} />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <SearchBar
          placeholder="Search customers…"
          value={search}
          onChangeText={setSearch}
        />
        <FilterChipRow chips={chips} value={filter} onChange={setFilter} />

        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : filtered.length === 0 ? (
          <View style={styles.center}>
            <Ionicons name="calendar-outline" size={40} color={ios.label3} />
            <Text style={styles.emptyTitle}>No standing orders</Text>
            <Text style={styles.emptySub}>
              {filter === "Paused"
                ? "No paused templates."
                : "Standing orders repeat on a schedule. None found for this filter."}
            </Text>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, paddingTop: 4, gap: 10, paddingBottom: 16 }}>
            {filtered.map((t) => {
              const customerName = t.customer?.businessName ?? t.name;
              const color = colorForName(customerName);
              const total = templateTotal(t);
              const itemCount = t.items?.length ?? 0;
              return (
                <Pressable key={t.id} style={styles.card}>
                  <View style={styles.cardHead}>
                    <View style={[styles.avatar, { backgroundColor: color }]}>
                      <Text style={styles.avatarText}>{initialsFromName(customerName)}</Text>
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={styles.nameRow}>
                        <Text style={styles.name} numberOfLines={1}>
                          {customerName}
                        </Text>
                      </View>
                      <Text style={styles.freq}>{frequencyLabel(t.daysOfWeek)}</Text>
                    </View>
                    {t.isActive ? (
                      <Text style={styles.chev}>›</Text>
                    ) : (
                      <Pill variant="gray">Paused</Pill>
                    )}
                  </View>
                  <View style={styles.cardFoot}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.footEyebrow}>NAME</Text>
                      <Text style={styles.footValue} numberOfLines={1}>
                        {t.name}
                      </Text>
                    </View>
                    <View style={{ flex: 2, alignItems: "flex-end" }}>
                      <Text style={styles.footEyebrow}>ORDER</Text>
                      <Text style={styles.footValue} numberOfLines={1}>
                        {itemCount} item{itemCount === 1 ? "" : "s"} · ${total.toFixed(0)}
                      </Text>
                    </View>
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { alignItems: "center", justifyContent: "center", padding: 40, gap: 8 },
  emptyTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: ios.label },
  emptySub: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, textAlign: "center" },
  card: { backgroundColor: ios.bgElev, borderRadius: 16, overflow: "hidden" },
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
});
