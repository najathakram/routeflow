import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  useBuyerPayments,
  useBuyerStatement,
  useBuyerRemittance,
  useBuyerStatementMonths,
  fetchStatementPdfUrl,
  type BuyerPayment,
} from "../../lib/api/buyer";
import { checkBadgeFor } from "../../lib/check-badge";
import { fmtCalendarDate } from "../../lib/calendar-date";
import {
  activeCreditRows,
  formatPaymentMethod,
  monthLabel,
  paymentRowFlags,
} from "../../lib/buyer-payments-logic";
import { sharePdf } from "../../lib/share-pdf";
import { showToast } from "../../lib/toast";

/** Formatter-only — figures are always server values, never re-derived. */
function money(n: number | string | undefined | null): string {
  const v = Number(n);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

function fmtDate(s?: string | null) {
  if (!s) return "";
  return new Date(s).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const PAGE_LIMIT = 20;

export default function BuyerPaymentsScreen() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const { data: payments, isLoading, isError } = useBuyerPayments({ page, limit: PAGE_LIMIT });

  // Independent fetches — never gate the page's load/error state on these
  // (mirrors web payments/page.tsx). Wallet value is the SAME cache entry
  // Finances reads (useBuyerStatement().availableCredit) — never recomputed.
  const { data: statement } = useBuyerStatement();
  const { data: remittance } = useBuyerRemittance();
  const { data: statementMonths } = useBuyerStatementMonths();

  const months = statementMonths?.months ?? [];
  const [selectedMonth, setSelectedMonth] = useState<string>("");
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!selectedMonth && months.length > 0) {
      setSelectedMonth(months[0]);
    }
  }, [months, selectedMonth]);

  const credits = activeCreditRows(statement?.transactions);
  // M3: "active" presence and the sub-label read the uncapped `availableCredit`
  // total, never a count of `credits` — that list is a capped, partial view of
  // the ledger (the `transactions` array stops at the API's own take cap).
  const hasActiveCredit = (statement?.availableCredit ?? 0) > 0;

  async function handleDownload() {
    if (!selectedMonth || downloading) return;
    setDownloading(true);
    try {
      const url = await fetchStatementPdfUrl(selectedMonth);
      await sharePdf({
        url,
        filename: `statement-${selectedMonth}.pdf`,
        dialogTitle: `Statement ${monthLabel(selectedMonth)}`,
      });
    } catch (e: any) {
      showToast(e?.message ?? "Couldn't download the statement.");
    } finally {
      setDownloading(false);
    }
  }

  const rows = payments?.data ?? [];
  const meta = payments?.meta;
  const hasRemittance =
    !!remittance && Object.values(remittance).some((v) => v && String(v).trim());

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Payments"
        leading={<NavBackButton label="More" onPress={() => router.back()} />}
      />

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      ) : isError || !payments ? (
        <View style={styles.center}>
          <Text style={styles.empty}>Couldn&apos;t load your payments. Pull to retry.</Text>
        </View>
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: 16, gap: 14 }}
        >
          {/* Wallet tiles */}
          <View style={styles.tileRow}>
            <Tile
              label="Store credit"
              value={money(statement?.availableCredit)}
              sub={hasActiveCredit ? "Available" : "None available"}
              tint={ios.brand}
            />
            <Tile
              label="Outstanding"
              value={money(statement?.outstandingAmount)}
              tint={ios.system.orangeInk}
            />
          </View>

          {/* Active credits */}
          {hasActiveCredit ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Active credits</Text>
              {statement?.transactionsTruncated ? (
                <Text style={styles.truncationNote}>
                  Showing the most recent transactions only — older entries are not listed in this
                  ledger.
                </Text>
              ) : null}
              {credits.map((c, i) => (
                <View
                  key={c.id}
                  style={[
                    styles.creditRow,
                    i > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: ios.separator,
                    },
                  ]}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.creditDesc} numberOfLines={1}>
                      {c.description}
                    </Text>
                    <Text style={styles.creditSub}>
                      {fmtDate(c.date)}
                      {c.expiresAt ? ` · expires ${fmtCalendarDate(c.expiresAt, "short")}` : ""}
                    </Text>
                  </View>
                  <Text style={styles.creditAmount}>{money(c.runningBalance)}</Text>
                </View>
              ))}
            </View>
          ) : null}

          {/* Monthly statement */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Monthly statement</Text>
            {months.length === 0 ? (
              <Text style={styles.empty}>
                Statements become available after your first invoice.
              </Text>
            ) : (
              <>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 8, paddingVertical: 4 }}
                >
                  {months.map((m) => {
                    const selected = m === selectedMonth;
                    return (
                      <Pressable
                        key={m}
                        style={[styles.monthChip, selected && styles.monthChipActive]}
                        onPress={() => setSelectedMonth(m)}
                      >
                        <Text
                          style={[styles.monthChipText, selected && styles.monthChipTextActive]}
                        >
                          {monthLabel(m)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
                <Pressable
                  style={[styles.downloadBtn, (!selectedMonth || downloading) && { opacity: 0.6 }]}
                  onPress={handleDownload}
                  disabled={!selectedMonth || downloading}
                >
                  {downloading ? (
                    <ActivityIndicator size="small" color={ios.brand} />
                  ) : (
                    <Ionicons name="download-outline" size={16} color={ios.brand} />
                  )}
                  <Text style={styles.downloadBtnText}>Download</Text>
                </Pressable>
              </>
            )}
          </View>

          {/* Payment history */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Payment history</Text>
            {rows.length === 0 ? (
              <Text style={styles.empty}>No payments yet.</Text>
            ) : (
              rows.map((p, i) => <PaymentRow key={p.id} p={p} first={i === 0} />)
            )}
            {meta && meta.totalPages > 1 ? (
              <View style={styles.pager}>
                <Pressable
                  style={[styles.pagerBtn, page === 1 && styles.pagerBtnDisabled]}
                  onPress={() => setPage((cur) => cur - 1)}
                  disabled={page === 1}
                >
                  <Ionicons
                    name="chevron-back"
                    size={16}
                    color={page === 1 ? ios.label3 : ios.label}
                  />
                </Pressable>
                <Text style={styles.pagerLabel}>
                  Page {meta.page} of {meta.totalPages}
                </Text>
                <Pressable
                  style={[styles.pagerBtn, page === meta.totalPages && styles.pagerBtnDisabled]}
                  onPress={() => setPage((cur) => cur + 1)}
                  disabled={page === meta.totalPages}
                >
                  <Ionicons
                    name="chevron-forward"
                    size={16}
                    color={page === meta.totalPages ? ios.label3 : ios.label}
                  />
                </Pressable>
              </View>
            ) : null}
          </View>

          {/* How to pay */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>How to pay</Text>
            {!hasRemittance ? (
              <Text style={styles.empty}>
                This seller hasn&apos;t added payment instructions yet.
              </Text>
            ) : (
              <View style={{ gap: 10 }}>
                <Field label="Pay to" value={remittance?.payToName} />
                <Field label="Bank" value={remittance?.bankName} />
                <Field label="Account name" value={remittance?.accountName} />
                <Field label="Account number" value={remittance?.accountNumber} />
                <Field label="Routing number" value={remittance?.routingNumber} />
                <Field label="Mail checks to" value={remittance?.mailingAddress} />
                <Field label="Paying by check" value={remittance?.checkInstructions} />
                <Field label="ACH" value={remittance?.achInstructions} />
                <Field label="Wire" value={remittance?.wireInstructions} />
                <Field label="Notes" value={remittance?.notes} />
              </View>
            )}
          </View>

          <View style={{ height: 24 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function PaymentRow({ p, first }: { p: BuyerPayment; first: boolean }) {
  const router = useRouter();
  const badge = checkBadgeFor(p);
  const flags = paymentRowFlags(p);
  return (
    <Pressable
      style={[
        styles.payRow,
        !first && {
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: ios.separator,
        },
      ]}
      onPress={() => router.push(`/(customer)/invoices/${p.invoiceId}`)}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.payInvoice} numberOfLines={1}>
          {p.invoiceNumber || "Payment"}
        </Text>
        <View style={styles.payMetaRow}>
          <Text style={styles.paySub}>
            {fmtDate(p.paidAt)} · {formatPaymentMethod(p.method)}
          </Text>
          {badge ? (
            <Pill variant={badge.variant} small>
              {badge.label}
            </Pill>
          ) : null}
        </View>
        {flags.showNsfFee ? (
          <Text style={styles.nsfNote}>+ {money(p.nsfFeeAmount)} NSF fee</Text>
        ) : null}
      </View>
      <Text style={[styles.payAmount, flags.voided && styles.voidAmount]}>{money(p.amount)}</Text>
    </Pressable>
  );
}

function Field({ label, value }: { label: string; value?: string }) {
  if (!value || !value.trim()) return null;
  return (
    <View>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue}>{value}</Text>
    </View>
  );
}

function Tile({
  label,
  value,
  sub,
  tint,
}: {
  label: string;
  value: string;
  sub?: string;
  tint?: string;
}) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={[styles.tileValue, tint ? { color: tint } : null]}>{value}</Text>
      {sub ? <Text style={styles.tileSub}>{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, padding: 40, alignItems: "center", justifyContent: "center" },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, textAlign: "center" },
  tileRow: { flexDirection: "row", gap: 12 },
  tile: { flex: 1, backgroundColor: ios.bgElev, borderRadius: 14, padding: 14 },
  tileLabel: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.label2 },
  tileValue: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.5,
    marginTop: 4,
    fontVariant: ["tabular-nums"],
  },
  tileSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14 },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, marginBottom: 10 },
  creditRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 },
  creditDesc: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  creditSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  truncationNote: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginBottom: 10,
  },
  creditAmount: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.system.greenInk,
    fontVariant: ["tabular-nums"],
  },
  monthChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: ios.fill3,
  },
  monthChipActive: { backgroundColor: ios.brandWash },
  monthChipText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label2 },
  monthChipTextActive: { color: ios.brand, fontFamily: "Inter_600SemiBold" },
  downloadBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 12,
    backgroundColor: ios.fill3,
    borderRadius: 12,
    paddingVertical: 12,
  },
  downloadBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.brand },
  payRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 },
  payInvoice: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  payMetaRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 2 },
  paySub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  nsfNote: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: ios.system.redInk,
    marginTop: 2,
  },
  payAmount: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.system.greenInk,
    fontVariant: ["tabular-nums"],
  },
  voidAmount: {
    color: ios.system.redInk,
    textDecorationLine: "line-through",
  },
  pager: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    paddingTop: 12,
    marginTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  pagerBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: ios.fill3,
    alignItems: "center",
    justifyContent: "center",
  },
  pagerBtnDisabled: { opacity: 0.5 },
  pagerLabel: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label2 },
  fieldLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  fieldValue: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label, marginTop: 2 },
});
