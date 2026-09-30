/**
 * Full statement ledger for a customer — the transaction list behind the
 * "Account standing" tiles, plus monthly statement-PDF download (the operator
 * twins of the buyer-portal endpoints).
 *
 * Ledger semantics (server `getStatementForOperator`): rows are newest-first
 * INVOICE / CREDIT_NOTE / ADVANCE_PAYMENT entries; `runningBalance` is NOT a
 * cumulative total — per row it's the invoice's remaining owed (negative),
 * a credit note's unused remainder, or an advance's wallet balance. Payments
 * are folded into invoices, never separate rows. Rendered as "remaining".
 */
import { useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavAction, NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  fetchCustomerStatementPdfUrl,
  useCustomer,
  useCustomerStatement,
  useCustomerStatementMonths,
} from "../../../../lib/api/customers";
import { OptionPickerSheet } from "../../../../components/OptionPickerSheet";
import { sharePdf } from "../../../../lib/share-pdf";
import { showToast } from "../../../../lib/toast";

const fmtMoney = (n: number) =>
  `$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const TYPE_META: Record<string, { label: string; variant: "brand" | "green" | "purple" | "gray" }> =
  {
    INVOICE: { label: "Invoice", variant: "brand" },
    CREDIT_NOTE: { label: "Credit note", variant: "green" },
    ADVANCE_PAYMENT: { label: "Advance", variant: "purple" },
  };

function monthLabel(month: string): string {
  const d = new Date(`${month}-01T12:00:00`);
  return Number.isNaN(d.getTime())
    ? month
    : d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export default function CustomerStatementScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const customerId = id!;

  const { data: customer } = useCustomer(customerId);
  const { data, isLoading, isFetching, refetch, isError } = useCustomerStatement(customerId);
  const { data: monthsData } = useCustomerStatementMonths(customerId);

  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const months = monthsData?.months ?? [];
  const transactions = data?.transactions ?? [];

  const downloadPdf = async (month: string) => {
    setDownloading(true);
    try {
      const url = await fetchCustomerStatementPdfUrl(customerId, month);
      await sharePdf({
        url,
        filename: `statement-${month}.pdf`,
        dialogTitle: `Statement ${monthLabel(month)}`,
      });
    } catch (e: any) {
      showToast(e?.response?.data?.message ?? e?.message ?? "Could not fetch the statement PDF.");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Statement"
        leading={
          <NavBackButton label={customer?.businessName ?? "Back"} onPress={() => router.back()} />
        }
        trailing={
          downloading ? (
            <ActivityIndicator color={ios.brand} />
          ) : months.length > 0 ? (
            <NavAction label="PDF" bold onPress={() => setMonthPickerOpen(true)} />
          ) : undefined
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
        ) : isError || !data ? (
          <View style={styles.center}>
            <Text style={styles.empty}>Couldn&apos;t load the statement. Pull to retry.</Text>
          </View>
        ) : (
          <View style={{ padding: 16, gap: 14 }}>
            {/* Summary tiles — same figures as the hub card, kept for context. */}
            <View style={styles.tiles}>
              <View style={styles.tile}>
                <Text style={styles.tileLabel}>Outstanding</Text>
                <Text style={styles.tileValue}>{fmtMoney(data.outstandingAmount)}</Text>
              </View>
              <View style={styles.tile}>
                <Text style={styles.tileLabel}>Overdue</Text>
                <Text style={[styles.tileValue, data.overdueAmount > 0 && styles.tileDanger]}>
                  {fmtMoney(data.overdueAmount)}
                </Text>
              </View>
              <View style={styles.tile}>
                <Text style={styles.tileLabel}>Credit</Text>
                <Text style={styles.tileValue}>{fmtMoney(data.availableCredit)}</Text>
              </View>
              <View style={styles.tile}>
                <Text style={styles.tileLabel}>Advances</Text>
                <Text style={styles.tileValue}>{fmtMoney(data.advanceBalance)}</Text>
              </View>
            </View>

            {/* B110: the ledger is a capped read — say so when the server flags it,
                and stay silent (no scary label) when the ledger IS complete. */}
            {data.transactionsTruncated === true ? (
              <Text style={styles.truncNote}>
                Showing the most recent transactions only — older entries are not listed in this
                ledger.
              </Text>
            ) : null}

            {transactions.length === 0 ? (
              <View style={styles.center}>
                <Text style={styles.empty}>No activity yet.</Text>
              </View>
            ) : (
              <View style={{ gap: 8 }}>
                {transactions.map((t) => {
                  const meta = TYPE_META[t.type] ?? { label: t.type, variant: "gray" as const };
                  const remainingLabel =
                    t.type === "INVOICE"
                      ? "owed"
                      : t.type === "CREDIT_NOTE"
                        ? "unused"
                        : "in wallet";
                  return (
                    <View key={`${t.type}-${t.id}`} style={styles.row}>
                      <View style={styles.rowHead}>
                        <Pill variant={meta.variant}>{meta.label}</Pill>
                        <Text style={styles.rowDate}>{new Date(t.date).toLocaleDateString()}</Text>
                        <Text style={styles.rowAmount}>{fmtMoney(t.amount)}</Text>
                      </View>
                      <Text style={styles.rowDesc} numberOfLines={1}>
                        {t.description}
                      </Text>
                      <View style={styles.rowFoot}>
                        {t.status ? <Text style={styles.rowStatus}>{t.status}</Text> : <View />}
                        <Text style={styles.rowRemaining}>
                          {fmtMoney(Math.abs(t.runningBalance))} {remainingLabel}
                        </Text>
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </View>
        )}
      </ScrollView>

      <OptionPickerSheet
        visible={monthPickerOpen}
        title="Statement month"
        options={months.map((m) => ({ id: m, label: monthLabel(m) }))}
        onClose={() => setMonthPickerOpen(false)}
        onSelect={(opt) => {
          setMonthPickerOpen(false);
          void downloadPdf(opt.id);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, textAlign: "center" },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tile: {
    flexGrow: 1,
    flexBasis: "45%",
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    padding: 12,
  },
  tileLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  tileValue: {
    marginTop: 4,
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  tileDanger: { color: ios.system.redInk },
  truncNote: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  row: { backgroundColor: ios.bgElev, borderRadius: 12, padding: 12 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowDate: { flex: 1, fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  rowAmount: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  rowDesc: { marginTop: 6, fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label },
  rowFoot: {
    marginTop: 6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rowStatus: { fontSize: 11, fontFamily: "Inter_600SemiBold", color: ios.label2 },
  rowRemaining: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    fontVariant: ["tabular-nums"],
  },
});
