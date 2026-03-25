import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { format, parseISO } from "date-fns";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useMyReturn, type ReturnStatus, type ReturnReason } from "../../../lib/api/returns";
import { NetworkError } from "../../../components/NetworkError";

const STATUS_CONFIG: Record<ReturnStatus, { label: string; color: string; bg: string; icon: string }> = {
  PENDING:   { label: "Pending Review", color: colors.warning.DEFAULT, bg: colors.warning.bg,     icon: "time-outline" },
  PROCESSED: { label: "Processed",      color: colors.success.DEFAULT, bg: colors.success.bg,     icon: "checkmark-circle" },
  CANCELLED: { label: "Cancelled",      color: "#94a3b8",              bg: colors.surface.raised, icon: "close-circle" },
};

const REASON_LABELS: Record<ReturnReason, string> = {
  DAMAGED:          "Damaged goods",
  WRONG_ITEM:       "Wrong item delivered",
  CUSTOMER_REFUSED: "Customer refused delivery",
  QUALITY_ISSUE:    "Quality issue",
  EXCESS_ORDER:     "Excess / over-ordered",
};

export default function ReturnDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: returnItem, isLoading, isError, refetch } = useMyReturn(id ?? "");

  if (isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: "Return", headerBackTitle: "Returns" }} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      </>
    );
  }

  if (isError || !returnItem) {
    return (
      <>
        <Stack.Screen options={{ title: "Return", headerBackTitle: "Returns" }} />
        <NetworkError onRetry={() => refetch()} />
      </>
    );
  }

  const cfg = STATUS_CONFIG[returnItem.status] ?? STATUS_CONFIG.PENDING;
  const dateLabel = format(parseISO(returnItem.createdAt), "EEEE, MMMM d, yyyy");

  return (
    <>
      <Stack.Screen
        options={{
          title: returnItem.order?.orderNumber
            ? `Return · ${returnItem.order.orderNumber}`
            : "Return",
          headerBackTitle: "Returns",
        }}
      />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Status card */}
        <View style={[styles.statusCard, { backgroundColor: cfg.bg }]}>
          <Ionicons name={cfg.icon as any} size={32} color={cfg.color} />
          <View>
            <Text style={[styles.statusLabel, { color: cfg.color }]}>{cfg.label}</Text>
            <Text style={styles.statusDate}>Submitted {dateLabel}</Text>
          </View>
        </View>

        {/* Summary */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Details</Text>

          <View style={styles.row}>
            <Text style={styles.rowLabel}>Linked Order</Text>
            <Text style={styles.rowValue}>
              {returnItem.order?.orderNumber ?? "—"}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Reason</Text>
            <Text style={styles.rowValue}>
              {REASON_LABELS[returnItem.reason] ?? returnItem.reason}
            </Text>
          </View>
          {returnItem.creditNoteId ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Credit Note</Text>
              <View style={styles.creditNotePill}>
                <Ionicons name="receipt-outline" size={13} color={colors.success.DEFAULT} />
                <Text style={styles.creditNoteText}>Issued</Text>
              </View>
            </View>
          ) : null}
          <View style={[styles.row, styles.rowLast]}>
            <Text style={styles.rowLabel}>Items</Text>
            <Text style={styles.rowValue}>{returnItem.items?.length ?? 0}</Text>
          </View>
        </View>

        {/* Items */}
        {returnItem.items && returnItem.items.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Returned Items</Text>
            {returnItem.items.map((item, idx) => (
              <View
                key={item.id}
                style={[
                  styles.itemRow,
                  idx === (returnItem.items?.length ?? 0) - 1 && styles.itemRowLast,
                ]}
              >
                <View style={styles.qtyBubble}>
                  <Text style={styles.qtyBubbleText}>{item.qty}</Text>
                </View>
                <View style={styles.itemInfo}>
                  <Text style={styles.itemName}>
                    {item.product?.name ?? item.productId}
                  </Text>
                  <Text style={styles.itemReason}>
                    {REASON_LABELS[item.reason] ?? item.reason}
                  </Text>
                </View>
                {item.restock ? (
                  <View style={styles.restockBadge}>
                    <Ionicons name="arrow-undo-outline" size={12} color={colors.brand[700]} />
                    <Text style={styles.restockText}>Restock</Text>
                  </View>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}

        {/* Notes */}
        {returnItem.notes ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Notes</Text>
            <Text style={styles.notesText}>{returnItem.notes}</Text>
          </View>
        ) : null}

        {/* Credit note notice */}
        {returnItem.creditNoteId && returnItem.status === "PROCESSED" ? (
          <View style={styles.creditNoteCard}>
            <Ionicons name="checkmark-circle" size={22} color={colors.success.DEFAULT} />
            <Text style={styles.creditNoteCardText}>
              A credit note has been issued for this return. It will appear as a credit against your next invoice.
            </Text>
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
  statusCard: {
    borderRadius: borderRadius.lg,
    padding: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    ...shadows.card,
  },
  statusLabel: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
  },
  statusDate: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    marginTop: 2,
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
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
  },
  rowLast: { borderBottomWidth: 0 },
  rowLabel: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  rowValue: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
    textAlign: "right",
    flex: 1,
    paddingLeft: 12,
  },
  creditNotePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.success.bg,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
  },
  creditNoteText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: colors.success.DEFAULT,
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
    gap: 12,
  },
  itemRowLast: { borderBottomWidth: 0 },
  qtyBubble: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.danger.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  qtyBubbleText: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: colors.danger.DEFAULT,
  },
  itemInfo: { flex: 1 },
  itemName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  itemReason: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    marginTop: 2,
  },
  restockBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.brand[50],
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: borderRadius.full,
  },
  restockText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[700],
  },
  notesText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    lineHeight: 20,
    paddingVertical: 12,
  },
  creditNoteCard: {
    backgroundColor: colors.success.bg,
    borderRadius: borderRadius.lg,
    padding: 16,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    ...shadows.card,
  },
  creditNoteCardText: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.success.DEFAULT,
    lineHeight: 20,
  },
});
