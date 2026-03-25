import { useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, Stack } from "expo-router";
import { format, parseISO } from "date-fns";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useMyCreditNotes, type CreditNote, type CreditNoteStatus } from "../../../lib/api/credit-notes";
import { NetworkError } from "../../../components/NetworkError";

type FilterKey = "ALL" | "ISSUED" | "APPLIED" | "VOID";
const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "ALL",     label: "All" },
  { key: "ISSUED",  label: "Issued" },
  { key: "APPLIED", label: "Applied" },
  { key: "VOID",    label: "Void" },
];

function matchesCreditNoteFilter(cn: CreditNote, filter: FilterKey): boolean {
  if (filter === "ALL") return true;
  return cn.status === filter;
}

const STATUS_CONFIG: Record<CreditNoteStatus, { label: string; color: string; bg: string }> = {
  ISSUED:  { label: "Issued",  color: colors.brand[700],       bg: colors.brand[50] },
  APPLIED: { label: "Applied", color: colors.success.DEFAULT,  bg: colors.success.bg },
  VOID:    { label: "Void",    color: "#94a3b8",               bg: colors.surface.raised },
};

function StatusChip({ status }: { status: CreditNoteStatus }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.ISSUED;
  return (
    <View style={[styles.statusChip, { backgroundColor: cfg.bg }]}>
      <Text style={[styles.statusChipText, { color: cfg.color }]}>{cfg.label}</Text>
    </View>
  );
}

function CreditNoteRow({ creditNote }: { creditNote: CreditNote }) {
  const dateLabel = format(parseISO(creditNote.createdAt), "MMM d, yyyy");

  return (
    <Pressable
      style={styles.card}
      onPress={() => router.push(`/(customer)/credit-notes/${creditNote.id}` as any)}
      accessibilityRole="button"
      accessibilityLabel={`Credit Note ${creditNote.creditNoteNumber}`}
    >
      <View style={styles.cardTop}>
        <View style={styles.cardLeft}>
          <Text style={styles.creditNoteNumber}>{creditNote.creditNoteNumber}</Text>
          <Text style={styles.dateText}>{dateLabel}</Text>
        </View>
        <StatusChip status={creditNote.status} />
      </View>

      <View style={styles.cardBottom}>
        <Text style={styles.totalAmount}>${Number(creditNote.amount).toFixed(2)}</Text>
        {creditNote.reason ? (
          <Text style={styles.reasonText} numberOfLines={1}>{creditNote.reason}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export default function CreditNotesScreen() {
  const { data, isLoading, isError, refetch } = useMyCreditNotes();
  const [activeFilter, setActiveFilter] = useState<FilterKey>("ALL");

  const allCreditNotes = data?.data ?? [];
  const filtered = useMemo(
    () => allCreditNotes.filter((cn) => matchesCreditNoteFilter(cn, activeFilter)),
    [allCreditNotes, activeFilter],
  );

  if (isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: "Credit Notes" }} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      </>
    );
  }

  if (isError) {
    return (
      <>
        <Stack.Screen options={{ title: "Credit Notes" }} />
        <NetworkError onRetry={() => refetch()} />
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: "Credit Notes" }} />
      <View style={styles.container}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.filterBar}
          contentContainerStyle={styles.filterContent}
        >
          {FILTERS.map((f) => (
            <Pressable
              key={f.key}
              style={[styles.filterChip, activeFilter === f.key && styles.filterChipActive]}
              onPress={() => setActiveFilter(f.key)}
            >
              <Text style={[styles.filterChipText, activeFilter === f.key && styles.filterChipTextActive]}>
                {f.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          style={styles.list}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="receipt-outline" size={48} color="#cbd5e1" />
              <Text style={styles.emptyText}>
                {activeFilter === "ALL" ? "No credit notes yet." : `No ${activeFilter.toLowerCase()} credit notes.`}
              </Text>
            </View>
          }
          renderItem={({ item }) => <CreditNoteRow creditNote={item} />}
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },
  filterBar: {
    backgroundColor: "#fff",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
    flexGrow: 0,
  },
  filterContent: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
    borderWidth: 1.5,
    borderColor: colors.surface.border,
    backgroundColor: colors.surface.raised,
  },
  filterChipActive: {
    borderColor: colors.brand[500],
    backgroundColor: colors.brand[50],
  },
  filterChipText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
  },
  filterChipTextActive: { color: colors.brand[500] },
  list: { backgroundColor: colors.surface.raised },
  content: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 32,
    gap: 10,
  },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: {
    alignItems: "center",
    paddingTop: 64,
    gap: 12,
  },
  emptyText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 10,
    ...shadows.card,
  },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cardLeft: { gap: 2, flex: 1 },
  creditNoteNumber: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  dateText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  statusChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
  },
  statusChipText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  cardBottom: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  totalAmount: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  reasonText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    flex: 1,
    textAlign: "right",
  },
});
