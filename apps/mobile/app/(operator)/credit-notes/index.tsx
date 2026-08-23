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
import { useCreditNotes, type CreditNote } from "../../../lib/api/credit-notes";
import { creditNotePillFor, openCreditBalance } from "../../../lib/credit-notes-logic";
import { fmtCalendarDate } from "../../../lib/format-date";

// Mirrors the web credit-notes status chips.
const FILTERS = [
  { id: "ALL", label: "All" },
  { id: "DRAFT", label: "Draft" },
  { id: "ISSUED", label: "Issued" },
  { id: "APPLIED", label: "Applied" },
  { id: "VOID", label: "Void" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

function fmtCurrency(n: number | string | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

export default function CreditNotesListScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterId>("ALL");
  const [search, setSearch] = useState("");

  const { data, isLoading, isFetching, refetch, isError } = useCreditNotes({
    status: filter === "ALL" ? undefined : filter,
    search: search.trim() || undefined,
    limit: 50,
  });
  const notes = data?.data ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Credit Notes"
        trailing={
          <NavAction label="New" bold onPress={() => router.push("/(operator)/credit-notes/new")} />
        }
      />
      <SearchBar placeholder="CN #, customer or invoice…" value={search} onChangeText={setSearch} />
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
            <Text style={styles.empty}>Couldn&apos;t load credit notes. Pull to retry.</Text>
          </View>
        ) : notes.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>
              {search ? "No credit notes match." : "No credit notes yet."}
            </Text>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 24 }}>
            {notes.map((cn) => (
              <Row
                key={cn.id}
                note={cn}
                onPress={() => router.push(`/(operator)/credit-notes/${cn.id}`)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ note, onPress }: { note: CreditNote; onPress: () => void }) {
  const s = creditNotePillFor(note.status);
  // issueDate is a calendar date (UTC-safe helper); the createdAt fallback is
  // a real timestamp and must keep rendering in the viewer's local time.
  const issued = note.issueDate ?? note.createdAt;
  const issuedLabel = note.issueDate
    ? fmtCalendarDate(note.issueDate)
    : new Date(note.createdAt).toLocaleDateString();
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.rowHead}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title} numberOfLines={1}>
            {note.creditNoteNumber}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {note.customer?.businessName ?? "Customer"}
          </Text>
        </View>
        <Pill variant={s.variant} dot>
          {s.label}
        </Pill>
      </View>
      <View style={styles.rowFoot}>
        <Text style={styles.total}>{fmtCurrency(note.amount)}</Text>
        {/* A partially-applied note stays ISSUED — the face amount alone reads
            as "untouched". Surface what's actually left. */}
        {Number(note.amountUsed ?? 0) > 0 && openCreditBalance(note) > 0 ? (
          <Text style={styles.remaining}>{fmtCurrency(openCreditBalance(note))} left</Text>
        ) : null}
        {issued ? <Text style={styles.totalText}>Issued {issuedLabel}</Text> : null}
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
  remaining: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.brand,
    fontVariant: ["tabular-nums"],
  },
});
