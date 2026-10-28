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
import { freeUnitsLabel } from "../../../lib/buyer-cart-logic";
import { fmtCalendarDate } from "../../../lib/format-date";
import { overpaidText, revisedBadgeText } from "../../../lib/invoice-revision";
import { invoiceShowsTerms } from "../../../lib/invoice-sale-terms";
import { invoiceDisplayCategoryTax, invoiceLineQtyText } from "@routeflow/pricing";
import { buyerInvoiceTotalsRows, totalsRowText } from "../../../lib/buyer-invoice-totals";
import {
  invoiceDisplayRowTexts,
  invoiceLineUnitNoun,
  usesUnitDisplay,
} from "../../../lib/invoice-line-display";

// buyer.ts's BuyerInvoiceItem doesn't declare `msrp` yet even though the
// server now snapshots it onto every InvoiceItem (display-only, per PIECE)
// and GET /buyer/invoices/:id returns it already. Widen locally rather than
// touching buyer.ts's canonical type (out of scope for this change).
type ItemMsrpField = { msrp?: number | null };

// Same reason as ItemMsrpField above: buyer.ts's BuyerInvoice doesn't declare
// `paymentTermsLabel` yet even though the server now persists it on every
// Invoice and GET /buyer/invoices/:id returns it already. Null/undefined
// (historical invoices predating this field) renders nothing.
type InvoiceTermsLabelField = { paymentTermsLabel?: string | null };

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

// Real timestamp (has a meaningful time-of-day) — kept in the viewer's local
// time, unlike the invoice issue/due dates below which are UTC-midnight
// calendar dates routed through the shared fmtCalendarDate helper.
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
  const totalsRows = buyerInvoiceTotalsRows(invoice); // server figures, no hard-coded tax name or rate
  const paidAmount = Number(invoice.paidAmount ?? invoice.amountPaid ?? 0);
  // B421: confirmed but non-cash — a credit note or advance applied to this
  // invoice reduces balanceDue but must never render as "Paid".
  const creditApplied = Number(invoice.creditApplied ?? 0);
  const advanceApplied = Number(invoice.advanceApplied ?? 0);
  const showPaid = paidAmount > 0;
  const showCredit = creditApplied > 0;
  const showAdvance = advanceApplied > 0;
  const showBalance = balanceDue > 0 && invoice.status !== "PAID";
  // Which Summary row renders last (so only IT drops the bottom border) —
  // whichever of these is true, checked in display order.
  const lastSummaryRow = showBalance
    ? "balance"
    : showAdvance
      ? "advance"
      : showCredit
        ? "credit"
        : showPaid
          ? "paid"
          : "total";
  const pdfUrl = (invoice as any).pdfUrl as string | undefined;
  const paymentTermsLabel = (invoice as typeof invoice & InvoiceTermsLabelField).paymentTermsLabel;
  // Row 401: a counter sale paid at the till shows no due date or terms (the web page's CQ-26 rule).
  const showTerms = invoiceShowsTerms(invoice);

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
                <Text style={styles.issuedDate}>
                  Issued: {fmtCalendarDate(invoice.issueDate, "short")}
                </Text>
              ) : null}
              {revisedBadgeText(invoice.revisedAt) ? (
                <Text style={styles.issuedDate}>{revisedBadgeText(invoice.revisedAt)}</Text>
              ) : null}
              {overpaidText(invoice.overpaidBy) ? (
                <Text style={styles.issuedDate}>{overpaidText(invoice.overpaidBy)}</Text>
              ) : null}
            </View>
            <Pill variant={p.variant} dot>
              {p.label}
            </Pill>
          </View>

          {totalsRows.length > 0 ? (
            <View style={{ marginTop: 4, gap: 2 }}>
              {totalsRows.map((r) => (
                <Text key={r.key} style={styles.totalLine}>
                  {totalsRowText(r)}
                </Text>
              ))}
            </View>
          ) : null}

          <Text style={styles.total}>${Number(invoice.total).toFixed(2)}</Text>

          {showTerms && invoice.dueDate ? (
            <Text style={styles.dueDate}>Due: {fmtCalendarDate(invoice.dueDate, "short")}</Text>
          ) : null}
          {showTerms && paymentTermsLabel ? (
            <Text style={styles.dueDate}>Terms: {paymentTermsLabel}</Text>
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
                const method = pmt.method; // #2703: the API sends `method` (the old `paymentMethod` never existed)
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
            <DetailRow
              label="Total"
              value={`$${Number(invoice.total).toFixed(2)}`}
              last={lastSummaryRow === "total"}
            />
            {showPaid ? (
              <DetailRow
                label="Paid"
                value={`$${paidAmount.toFixed(2)}`}
                last={lastSummaryRow === "paid"}
              />
            ) : null}
            {showCredit ? (
              <DetailRow
                label="Credit issued"
                value={`$${creditApplied.toFixed(2)}`}
                last={lastSummaryRow === "credit"}
              />
            ) : null}
            {showAdvance ? (
              <DetailRow
                label="Advance applied"
                value={`$${advanceApplied.toFixed(2)}`}
                last={lastSummaryRow === "advance"}
              />
            ) : null}
            {showBalance ? (
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
  const itemMsrp = (item as typeof item & ItemMsrpField).msrp;
  const displayRows = invoiceDisplayRowTexts({
    ...item,
    categoryTax: invoiceDisplayCategoryTax(item),
    components: item.components,
    displayUnit: item.displayUnit,
  });
  return (
    <View style={[styles.itemRow, last && { borderBottomWidth: 0 }]}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.itemName} numberOfLines={2}>
          {label}
        </Text>
        {displayRows.leading.map((text, i) => (
          <Text key={`row-${i}`} style={styles.itemMeta} testID="display-component-row">
            {text}
          </Text>
        ))}
        <Text style={styles.itemMeta}>
          {displayRows.pieces ? (
            `${displayRows.pieces.qtyText} × ${displayRows.pieces.priceText}`
          ) : (
            <>
              {/* B758 review: a units_v1 line (Case, Pallet, a factor-1 "5 Piece") shows ITS
              label via the ONE shared formatter — a bare Number(item.qty) read "36" for a
              3-Case line instead of "3 Cases". A pack line is unchanged. */}
              {usesUnitDisplay(item) ? invoiceLineQtyText(item) : Number(item.qty)} × $
              {Number(item.unitPrice).toFixed(2)}
              {/* #2046 REQUIRED (Opus): a units_v1 line's own unit noun (Case, Piece), never
              the fallen-through product.unit — a Case line read "/ ea" and a factor-1
              Piece line could read "/ box" here despite the qty text above already
              naming it correctly. The operator invoice screen already does this. */}
              {item.unitLabel?.trim()
                ? ` / ${invoiceLineUnitNoun(item)}`
                : unit
                  ? ` / ${unit}`
                  : ""}
            </>
          )}
          {item.discount ? ` − $${Number(item.discount).toFixed(2)} disc` : ""}
        </Text>
        {displayRows.subLines.map((text, i) => (
          <Text key={i} style={styles.itemMeta} testID="line-component-sub-line">
            {text}
          </Text>
        ))}
        {item.notes?.trim() ? (
          <Text style={styles.itemNote} numberOfLines={4}>
            {item.notes}
          </Text>
        ) : null}
        {/* Suggested retail price snapshot — per PIECE, display-only. */}
        {itemMsrp != null ? (
          <Text style={styles.itemMsrp}>MSRP ${Number(itemMsrp).toFixed(2)}/pc</Text>
        ) : null}
        {/* BUY_N_GET_M: name the free units, or the reduced line subtotal
            reads as a pricing error (web parity). */}
        {freeUnitsLabel(item.promoFreeUnits) ? (
          <Text style={styles.itemFreeLabel}>{freeUnitsLabel(item.promoFreeUnits)}</Text>
        ) : null}
        {displayRows.trailing.map((text, i) => (
          <Text key={`tax-${i}`} style={styles.itemMeta} testID="display-category-tax">
            {text}
          </Text>
        ))}
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
  itemNote: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  itemMsrp: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label3, marginTop: 2 },
  itemFreeLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.brand,
    marginTop: 2,
  },
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
