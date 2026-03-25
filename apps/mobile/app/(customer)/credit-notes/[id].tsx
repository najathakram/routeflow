import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { format, parseISO } from "date-fns";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useMyCreditNote, type CreditNoteStatus } from "../../../lib/api/credit-notes";
import { NetworkError } from "../../../components/NetworkError";

const STATUS_CONFIG: Record<CreditNoteStatus, { label: string; color: string; bg: string }> = {
  ISSUED:  { label: "Issued",  color: colors.brand[700],       bg: colors.brand[50] },
  APPLIED: { label: "Applied", color: colors.success.DEFAULT,  bg: colors.success.bg },
  VOID:    { label: "Void",    color: "#94a3b8",               bg: colors.surface.raised },
};

export default function CreditNoteDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: creditNote, isLoading, isError, refetch } = useMyCreditNote(id ?? "");

  if (isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: "Credit Note", headerBackTitle: "Credit Notes" }} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      </>
    );
  }

  if (isError || !creditNote) {
    return (
      <>
        <Stack.Screen options={{ title: "Credit Note", headerBackTitle: "Credit Notes" }} />
        <NetworkError onRetry={() => refetch()} />
      </>
    );
  }

  const cfg = STATUS_CONFIG[creditNote.status] ?? STATUS_CONFIG.ISSUED;

  return (
    <>
      <Stack.Screen
        options={{ title: creditNote.creditNoteNumber, headerBackTitle: "Credit Notes" }}
      />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Header card */}
        <View style={styles.headerCard}>
          <View style={styles.headerTop}>
            <Text style={styles.creditNoteNumber}>{creditNote.creditNoteNumber}</Text>
            <View style={[styles.statusChip, { backgroundColor: cfg.bg }]}>
              <Text style={[styles.statusChipText, { color: cfg.color }]}>{cfg.label}</Text>
            </View>
          </View>

          <View>
            <Text style={styles.amountLabel}>Credit Amount</Text>
            <Text style={styles.amountTotal}>${Number(creditNote.amount).toFixed(2)}</Text>
          </View>

          <View style={styles.metaRow}>
            <View style={styles.metaItem}>
              <Ionicons name="calendar-outline" size={14} color="#94a3b8" />
              <Text style={styles.metaText}>
                Issued {format(parseISO(creditNote.createdAt), "MMM d, yyyy")}
              </Text>
            </View>
          </View>

          {creditNote.reason ? (
            <View style={styles.reasonBox}>
              <Ionicons name="information-circle-outline" size={16} color={colors.brand[500]} />
              <Text style={styles.reasonText}>{creditNote.reason}</Text>
            </View>
          ) : null}
        </View>

        {/* Linked order */}
        {creditNote.orderId ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Linked Order</Text>
            <View style={styles.linkRow}>
              <Ionicons name="cube-outline" size={18} color="#64748b" />
              <Text style={styles.linkText}>Order ID: {creditNote.orderId}</Text>
            </View>
          </View>
        ) : null}

        {/* Applied to invoice */}
        {creditNote.invoiceId ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Applied to Invoice</Text>
            <View style={styles.linkRow}>
              <Ionicons name="document-text-outline" size={18} color={colors.brand[500]} />
              <Text style={[styles.linkText, { color: colors.brand[600] ?? colors.brand[500] }]}>
                Invoice ID: {creditNote.invoiceId}
              </Text>
            </View>
          </View>
        ) : null}

        {/* Items credited */}
        {creditNote.items && creditNote.items.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Items Credited</Text>
            {creditNote.items.map((item, idx) => (
              <View
                key={item.id}
                style={[
                  styles.lineItem,
                  idx === (creditNote.items?.length ?? 0) - 1 && styles.lineItemLast,
                ]}
              >
                <View style={styles.lineLeft}>
                  <Text style={styles.itemName}>{item.description}</Text>
                  <Text style={styles.itemQty}>
                    {item.qty} × ${Number(item.unitPrice).toFixed(2)}
                  </Text>
                </View>
                <Text style={styles.itemSubtotal}>
                  ${Number(item.subtotal).toFixed(2)}
                </Text>
              </View>
            ))}

            {/* Grand total */}
            <View style={styles.totalsBox}>
              <View style={[styles.totalRow, styles.totalGrandRow]}>
                <Text style={styles.grandLabel}>Total Credit</Text>
                <Text style={styles.grandValue}>${Number(creditNote.amount).toFixed(2)}</Text>
              </View>
            </View>
          </View>
        ) : null}

        {/* Notes */}
        {creditNote.notes ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Notes</Text>
            <Text style={styles.notesText}>{creditNote.notes}</Text>
          </View>
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  scroll: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 32,
    gap: 12,
  },
  headerCard: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 14,
    ...shadows.card,
  },
  headerTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  creditNoteNumber: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  statusChip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: borderRadius.full,
  },
  statusChipText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  amountLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  amountTotal: {
    fontSize: 32,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  metaRow: {
    flexDirection: "row",
    gap: 16,
    flexWrap: "wrap",
  },
  metaItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  metaText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  reasonBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: colors.brand[50],
    borderRadius: borderRadius.DEFAULT,
    padding: 12,
  },
  reasonText: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    lineHeight: 20,
  },
  section: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    paddingHorizontal: 16,
    paddingVertical: 4,
    ...shadows.card,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingTop: 14,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
    marginBottom: 4,
  },
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 14,
  },
  linkText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: "#64748b",
  },
  lineItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
  },
  lineItemLast: { borderBottomWidth: 0 },
  lineLeft: { flex: 1, paddingRight: 12 },
  itemName: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
    marginBottom: 2,
  },
  itemQty: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  itemSubtotal: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  totalsBox: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
    paddingTop: 12,
    paddingBottom: 8,
    gap: 6,
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  totalGrandRow: {
    marginTop: 8,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
  },
  grandLabel: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  grandValue: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.brand[700],
  },
  notesText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    lineHeight: 20,
    paddingVertical: 12,
  },
});
