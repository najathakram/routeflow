import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  useBuyerInvoice,
  type BuyerInvoiceItem,
  type BuyerInvoicePayment,
} from "../../../lib/api/buyer";
import { sharePdf } from "../../../lib/share-pdf";
import { showToast } from "../../../lib/toast";
import { checkBadgeFor } from "../../../lib/check-badge";
import { formatPaymentMethod, paymentRowFlags } from "../../../lib/buyer-payments-logic";

function invoicePill(status: string, isOverdue?: boolean) {
  if (isOverdue) return { variant: "gray" as const, label: "Overdue" };
  switch (status) {
    case "PAID":
      return { variant: "green" as const, label: "Paid" };
    case "PARTIAL":
      return { variant: "orange" as const, label: "Partial" };
    case "SENT":
    case "VIEWED":
      return { variant: "orange" as const, label: "Unpaid" };
    case "VOID":
      return { variant: "gray" as const, label: "Void" };
    default:
      return { variant: "gray" as const, label: status };
  }
}

function fmtDate(s?: string | null) {
  if (!s) return null;
  return new Date(s).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function CustomerInvoiceDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: invoice, isLoading } = useBuyerInvoice(id);

  if (isLoading || !invoice) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Invoice"
          leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const p = invoicePill(invoice.status, invoice.isOverdue);
  const balanceDue = Number(invoice.balanceDue ?? invoice.amountDue ?? 0);
  const paidAmount = Number(invoice.paidAmount ?? invoice.amountPaid ?? 0);
  const pdfUrl = (invoice as any).pdfUrl as string | undefined;

  const handleSharePdf = async () => {
    if (!pdfUrl) return;
    try {
      await sharePdf({
        url: pdfUrl,
        filename: `${invoice.invoiceNumber || "invoice"}.pdf`,
        dialogTitle: `Invoice ${invoice.invoiceNumber ?? ""}`.trim(),
      });
    } catch (e: any) {
      showToast(e?.message ?? "Couldn't share the PDF.");
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Invoice"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        overScrollMode="never"
        bounces={false}
      >
        {/* Header */}
        <View style={styles.headerCard}>
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.invoiceNum}>#{invoice.invoiceNumber}</Text>
              {invoice.issueDate ? (
                <Text style={styles.issuedDate}>Issued: {fmtDate(invoice.issueDate)}</Text>
              ) : null}
            </View>
            <Pill variant={p.variant} dot>
              {p.label}
            </Pill>
          </View>

          {invoice.subtotal != null && invoice.tax != null ? (
            <View style={{ marginTop: 4, gap: 2 }}>
              <Text style={styles.totalLine}>Subtotal: ${Number(invoice.subtotal).toFixed(2)}</Text>
              <Text style={styles.totalLine}>GST (10%): ${Number(invoice.tax).toFixed(2)}</Text>
            </View>
          ) : null}

          <Text style={styles.total}>${Number(invoice.total).toFixed(2)}</Text>

          {invoice.dueDate ? (
            <Text style={styles.dueDate}>Due: {fmtDate(invoice.dueDate)}</Text>
          ) : null}
        </View>

        {/* Share PDF — straight to the share sheet, no download */}
        {pdfUrl ? (
          <Pressable style={styles.shareBtn} onPress={handleSharePdf}>
            <Ionicons name="share-outline" size={18} color={ios.brand} />
            <Text style={styles.shareBtnText}>Share PDF</Text>
          </Pressable>
        ) : null}

        {/* Balance due banner */}
        {invoice.status !== "PAID" && invoice.status !== "VOID" && balanceDue > 0 ? (
          <View style={styles.dueCard}>
            <Ionicons name="alert-circle-outline" size={18} color={ios.system.orangeInk} />
            <View style={{ flex: 1 }}>
              <Text style={styles.dueCardTitle}>Amount due</Text>
              <Text style={styles.dueCardAmount}>${balanceDue.toFixed(2)}</Text>
            </View>
          </View>
        ) : null}

        {/* Line items */}
        {invoice.items && invoice.items.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Items</Text>
            <View style={styles.itemsList}>
              {invoice.items.map((item, i) => (
                <LineItemRow
                  key={item.id ?? i}
                  item={item}
                  last={i === invoice.items!.length - 1}
                />
              ))}
            </View>
          </View>
        ) : null}

        {/* Payments */}
        {invoice.payments && invoice.payments.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Payments</Text>
            <View style={styles.detailCard}>
              {invoice.payments.map((pmt, i) => {
                const method = pmt.method ?? pmt.paymentMethod;
                const badge = checkBadgeFor({
                  method,
                  status: pmt.status,
                  checkStatus: pmt.checkStatus,
                });
                const flags = paymentRowFlags(pmt);
                return (
                  <View
                    key={pmt.id ?? i}
                    style={[
                      styles.detailRow,
                      i === invoice.payments!.length - 1 && { borderBottomWidth: 0 },
                    ]}
                  >
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                        <Text style={styles.detailLabel}>{formatPaymentMethod(method)}</Text>
                        {badge ? (
                          <Pill variant={badge.variant} small>
                            {badge.label}
                          </Pill>
                        ) : null}
                      </View>
                      {pmt.reference ? (
                        <Text style={styles.detailMeta}>Ref: {pmt.reference}</Text>
                      ) : null}
                      <Text style={styles.detailMeta}>{fmtDate(pmt.paidAt ?? pmt.createdAt)}</Text>
                      {flags.showNsfFee ? (
                        <Text style={styles.nsfNote}>
                          + ${Number(pmt.nsfFeeAmount).toFixed(2)} NSF fee
                        </Text>
                      ) : null}
                    </View>
                    <Text style={[styles.detailValue, flags.voided && styles.voidAmount]}>
                      ${Number(pmt.amount).toFixed(2)}
                    </Text>
                  </View>
                );
              })}
            </View>
          </View>
        ) : null}

        {/* Summary */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Summary</Text>
          <View style={styles.detailCard}>
            <DetailRow label="Invoice #" value={`#${invoice.invoiceNumber}`} />
            <DetailRow label="Status" value={p.label} />
            <DetailRow label="Total" value={`$${Number(invoice.total).toFixed(2)}`} />
            {paidAmount > 0 ? <DetailRow label="Paid" value={`$${paidAmount.toFixed(2)}`} /> : null}
            {balanceDue > 0 && invoice.status !== "PAID" ? (
              <DetailRow label="Balance due" value={`$${balanceDue.toFixed(2)}`} last />
            ) : null}
          </View>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function LineItemRow({ item, last }: { item: BuyerInvoiceItem; last: boolean }) {
  const label = item.product?.name ?? item.description;
  const unit = item.product?.unit;
  return (
    <View style={[styles.itemRow, last && { borderBottomWidth: 0 }]}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.itemName} numberOfLines={2}>
          {label}
        </Text>
        <Text style={styles.itemMeta}>
          {Number(item.qty)} × ${Number(item.unitPrice).toFixed(2)}
          {unit ? ` / ${unit}` : ""}
          {item.discount ? ` − $${Number(item.discount).toFixed(2)} disc` : ""}
        </Text>
      </View>
      <Text style={styles.itemTotal}>${Number(item.subtotal).toFixed(2)}</Text>
    </View>
  );
}

function DetailRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View style={[styles.detailRow, last && { borderBottomWidth: 0 }]}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  headerCard: { margin: 16, backgroundColor: ios.bgElev, borderRadius: 16, padding: 18, gap: 4 },
  headerRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  invoiceNum: { fontSize: 18, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.3 },
  issuedDate: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  totalLine: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  total: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.6,
    marginTop: 2,
  },
  dueDate: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  dueCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: ios.system.orangeWash,
    borderRadius: 12,
    padding: 14,
  },
  dueCardTitle: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.system.orangeInk },
  dueCardAmount: { fontSize: 18, fontFamily: "Inter_700Bold", color: ios.system.orangeInk },
  shareBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    paddingVertical: 13,
  },
  shareBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.brand },
  section: { paddingHorizontal: 16, paddingBottom: 8 },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginBottom: 8,
    paddingTop: 12,
    paddingLeft: 4,
  },
  itemsList: { backgroundColor: ios.bgElev, borderRadius: 12, overflow: "hidden" },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
    gap: 10,
  },
  itemName: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  itemMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  itemTotal: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  detailCard: { backgroundColor: ios.bgElev, borderRadius: 12, overflow: "hidden" },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
    gap: 12,
  },
  detailLabel: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label2, flex: 1 },
  detailMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label3, marginTop: 2 },
  detailValue: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: ios.label,
    textAlign: "right",
  },
  nsfNote: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: ios.system.redInk,
    marginTop: 2,
  },
  voidAmount: {
    color: ios.system.redInk,
    textDecorationLine: "line-through",
  },
});
