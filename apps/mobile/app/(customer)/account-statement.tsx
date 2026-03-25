import { ActivityIndicator, FlatList, StyleSheet, Text, View } from "react-native";
import { Stack } from "expo-router";
import { format, parseISO } from "date-fns";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useMyAccountSummary, type AccountTransaction, type TransactionType } from "../../lib/api/customers";
import { NetworkError } from "../../components/NetworkError";

const TRANSACTION_CONFIG: Record<TransactionType, { icon: string; label: string; color: string }> = {
  INVOICE:     { icon: "document-text-outline",      label: "Invoice",     color: colors.navy.DEFAULT },
  PAYMENT:     { icon: "checkmark-circle-outline",   label: "Payment",     color: colors.success.DEFAULT },
  CREDIT_NOTE: { icon: "receipt-outline",            label: "Credit Note", color: colors.brand[500] },
  ADJUSTMENT:  { icon: "swap-horizontal-outline",    label: "Adjustment",  color: "#64748b" },
};

function BalanceStat({
  label,
  value,
  valueColor,
  subLabel,
}: {
  label: string;
  value: string;
  valueColor?: string;
  subLabel?: string;
}) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, valueColor ? { color: valueColor } : null]}>{value}</Text>
      {subLabel ? <Text style={styles.statSub}>{subLabel}</Text> : null}
    </View>
  );
}

function TransactionRow({ tx }: { tx: AccountTransaction }) {
  const cfg = TRANSACTION_CONFIG[tx.type] ?? TRANSACTION_CONFIG.ADJUSTMENT;
  const isCredit = tx.amount < 0;
  const amountColor = isCredit ? colors.success.DEFAULT : colors.navy.DEFAULT;
  const amountPrefix = isCredit ? "−" : "+";

  return (
    <View style={styles.txRow}>
      <View style={[styles.txIconWrap, { backgroundColor: isCredit ? colors.success.bg : colors.surface.raised }]}>
        <Ionicons name={cfg.icon as any} size={18} color={isCredit ? colors.success.DEFAULT : "#64748b"} />
      </View>
      <View style={styles.txCenter}>
        <Text style={styles.txDescription}>{tx.description}</Text>
        <Text style={styles.txMeta}>
          {cfg.label} · {format(parseISO(tx.date), "MMM d, yyyy")}
        </Text>
      </View>
      <View style={styles.txRight}>
        <Text style={[styles.txAmount, { color: amountColor }]}>
          {amountPrefix}${Math.abs(tx.amount).toFixed(2)}
        </Text>
        <Text style={styles.txBalance}>Bal: ${tx.runningBalance.toFixed(2)}</Text>
      </View>
    </View>
  );
}

export default function AccountStatementScreen() {
  const { data: summary, isLoading, isError, refetch } = useMyAccountSummary();

  if (isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: "Account Statement" }} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      </>
    );
  }

  if (isError || !summary) {
    return (
      <>
        <Stack.Screen options={{ title: "Account Statement" }} />
        <NetworkError onRetry={() => refetch()} />
      </>
    );
  }

  const overdueColor = summary.overdueAmount > 0 ? colors.danger.DEFAULT : colors.success.DEFAULT;

  return (
    <>
      <Stack.Screen options={{ title: "Account Statement" }} />
      <FlatList
        style={styles.container}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        data={summary.transactions}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={
          <>
            {/* Balance summary card */}
            <View style={styles.balanceCard}>
              <Text style={styles.balanceTitle}>Account Balance</Text>
              <View style={styles.statsRow}>
                <BalanceStat
                  label="Outstanding"
                  value={`$${Number(summary.outstandingAmount).toFixed(2)}`}
                />
                <View style={styles.statDivider} />
                <BalanceStat
                  label="Overdue"
                  value={`$${Number(summary.overdueAmount).toFixed(2)}`}
                  valueColor={overdueColor}
                  subLabel={summary.overdueAmount > 0 ? "Past due" : undefined}
                />
                <View style={styles.statDivider} />
                <BalanceStat
                  label="Available Credit"
                  value={`$${Number(summary.availableCredit).toFixed(2)}`}
                  valueColor={summary.availableCredit > 0 ? colors.brand[500] : undefined}
                />
              </View>
            </View>

            {/* Transactions heading */}
            <Text style={styles.sectionHeading}>Transaction History</Text>
          </>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="swap-horizontal-outline" size={48} color="#cbd5e1" />
            <Text style={styles.emptyText}>No transactions yet.</Text>
          </View>
        }
        renderItem={({ item, index }) => (
          <View
            style={[
              styles.txCard,
              index === 0 && styles.txCardFirst,
              index === summary.transactions.length - 1 && styles.txCardLast,
            ]}
          >
            <TransactionRow tx={item} />
          </View>
        )}
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },
  content: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 40,
  },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  balanceCard: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    marginBottom: 20,
    ...shadows.card,
  },
  balanceTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 14,
  },
  statsRow: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  stat: {
    flex: 1,
    alignItems: "center",
    gap: 4,
  },
  statLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    textAlign: "center",
  },
  statValue: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
    textAlign: "center",
  },
  statSub: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: colors.danger.DEFAULT,
    textAlign: "center",
  },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: colors.surface.border,
    alignSelf: "stretch",
    marginHorizontal: 4,
  },
  sectionHeading: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  txCard: {
    backgroundColor: "#fff",
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
  },
  txCardFirst: {
    borderTopLeftRadius: borderRadius.lg,
    borderTopRightRadius: borderRadius.lg,
    ...shadows.card,
  },
  txCardLast: {
    borderBottomLeftRadius: borderRadius.lg,
    borderBottomRightRadius: borderRadius.lg,
    borderBottomWidth: 0,
  },
  txRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    gap: 12,
  },
  txIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface.raised,
  },
  txCenter: {
    flex: 1,
    gap: 3,
  },
  txDescription: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  txMeta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  txRight: {
    alignItems: "flex-end",
    gap: 3,
  },
  txAmount: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
  },
  txBalance: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  empty: {
    alignItems: "center",
    paddingTop: 48,
    gap: 12,
  },
  emptyText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
});
