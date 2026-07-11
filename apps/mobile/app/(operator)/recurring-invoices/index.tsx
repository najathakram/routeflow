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
import { FilterChipRow, NavAction, NavBar, Pill, SearchBar } from "@routeflow/ui/mobile/ios";
import { useRecurringInvoices, type RecurringInvoice } from "../../../lib/api/recurring-invoices";
import { freqLabel, recurringPillFor } from "../../../lib/recurring-invoices-logic";

const FILTERS = [
  { id: "ALL", label: "All" },
  { id: "ACTIVE", label: "Active" },
  { id: "PAUSED", label: "Paused" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

export default function RecurringInvoicesListScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterId>("ALL");
  const [search, setSearch] = useState("");

  const { data, isLoading, isFetching, refetch, isError } = useRecurringInvoices();
  const templates = data ?? [];

  // Client-side filter + search — the list endpoint returns a bare array with no
  // status/search params.
  const q = search.trim().toLowerCase();
  const filtered = templates.filter((t) => {
    if (filter === "ACTIVE" && !t.isActive) return false;
    if (filter === "PAUSED" && t.isActive) return false;
    if (q && !(t.customer?.businessName ?? "").toLowerCase().includes(q)) return false;
    return true;
  });

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Recurring"
        trailing={
          <NavAction
            label="New"
            bold
            onPress={() => router.push("/(operator)/recurring-invoices/new")}
          />
        }
      />
      <SearchBar placeholder="Search customer…" value={search} onChangeText={setSearch} />
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
            <Text style={styles.empty}>Couldn&apos;t load recurring invoices. Pull to retry.</Text>
          </View>
        ) : filtered.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>
              {q ? "No templates match." : "No recurring templates yet."}
            </Text>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 24 }}>
            {filtered.map((t) => (
              <Row
                key={t.id}
                template={t}
                onPress={() => router.push(`/(operator)/recurring-invoices/${t.id}`)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ template, onPress }: { template: RecurringInvoice; onPress: () => void }) {
  const s = recurringPillFor(template.isActive);
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.rowHead}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title} numberOfLines={1}>
            {template.customer?.businessName ?? "Customer"}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {freqLabel(template.frequency, template.dayOfWeek, template.dayOfMonth)}
          </Text>
        </View>
        <Pill variant={s.variant} dot>
          {s.label}
        </Pill>
      </View>
      <View style={styles.rowFoot}>
        <Text style={styles.next}>Next {new Date(template.nextRunAt).toLocaleDateString()}</Text>
        {template.autoSend ? <Text style={styles.totalText}>· Auto-send</Text> : null}
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
  next: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  totalText: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
});
