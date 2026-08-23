import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { FilterChipRow, NavBar, Pill, SearchBar } from "@routeflow/ui/mobile/ios";
import { useEstimates, type Estimate } from "../../../lib/api/estimates";
import { estimatePillFor } from "../../../lib/estimates-logic";
import { fmtCalendarDate } from "../../../lib/format-date";

// Mirrors the web estimates status filter (CONVERTED omitted, like web STATUS_OPTIONS).
const FILTERS = [
  { id: "ALL", label: "All" },
  { id: "DRAFT", label: "Draft" },
  { id: "SENT", label: "Sent" },
  { id: "ACCEPTED", label: "Accepted" },
  { id: "DECLINED", label: "Declined" },
  { id: "EXPIRED", label: "Expired" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

function fmtCurrency(n: number | string | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

export default function EstimatesListScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterId>("ALL");
  const [search, setSearch] = useState("");

  const { data, isLoading, isFetching, refetch, isError } = useEstimates({
    status: filter === "ALL" ? undefined : filter,
    search: search.trim() || undefined,
    limit: 50,
  });
  const estimates = data?.data ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar largeTitle="Estimates" />
      <SearchBar placeholder="Search number, customer…" value={search} onChangeText={setSearch} />
      <FilterChipRow
        chips={FILTERS.map((f) => ({ label: f.label }))}
        value={FILTERS.find((f) => f.id === filter)?.label ?? "All"}
        onChange={(label) =>
          setFilter((FILTERS.find((f) => f.label === label)?.id as FilterId) ?? "ALL")
        }
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isFetching && !isLoading} onRefresh={refetch} />
        }
      >
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : isError ? (
          <View style={styles.center}>
            <Text style={styles.empty}>Couldn&apos;t load estimates. Pull to retry.</Text>
          </View>
        ) : estimates.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>{search ? "No estimates match." : "No estimates yet."}</Text>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 24 }}>
            {estimates.map((e) => (
              <Row
                key={e.id}
                estimate={e}
                onPress={() => router.push(`/(operator)/estimates/${e.id}`)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ estimate, onPress }: { estimate: Estimate; onPress: () => void }) {
  const s = estimatePillFor(estimate.status);
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.rowHead}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title} numberOfLines={1}>
            {estimate.estimateNumber}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {estimate.customer?.businessName ?? "Customer"}
          </Text>
        </View>
        <Pill variant={s.variant} dot>
          {s.label}
        </Pill>
      </View>
      <View style={styles.rowFoot}>
        <Text style={styles.total}>{fmtCurrency(estimate.total)}</Text>
        {estimate.expiresAt ? (
          <Text style={styles.totalText}>Valid to {fmtCalendarDate(estimate.expiresAt)}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },
  row: { backgroundColor: ios.bgElev, borderRadius: 12, padding: 14 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, letterSpacing: -0.2 },
  sub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  rowFoot: { marginTop: 10, flexDirection: "row", alignItems: "baseline", gap: 6 },
  total: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  totalText: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
});
