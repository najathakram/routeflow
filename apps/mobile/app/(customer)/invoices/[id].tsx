import React from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { format, parseISO } from "date-fns";
import { Ionicons } from "@expo/vector-icons";
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useMyInvoice, type InvoiceStatus, type InvoicePayment } from "../../../lib/api/invoices";
import { NetworkError } from "../../../components/NetworkError";
import { apiClient } from "../../../lib/api-client";

const STATUS_CONFIG: Record<InvoiceStatus, { label: string; color: string; bg: string }> = {
  DRAFT:   { label: "Draft",   color: "#64748b",              bg: colors.surface.raised },
  SENT:    { label: "Sent",    color: colors.brand[700],       bg: colors.brand[50] },
  VIEWED:  { label: "Viewed",  color: colors.brand[700],       bg: colors.brand[50] },
  PARTIAL: { label: "Partial", color: colors.warning.DEFAULT,  bg: colors.warning.bg },
  PAID:    { label: "Paid",    color: colors.success.DEFAULT,  bg: colors.success.bg },
  OVERDUE: { label: "Overdue", color: colors.danger.DEFAULT,   bg: colors.danger.bg },
  VOID:    { label: "Void",    color: "#94a3b8",               bg: colors.surface.raised },
};

const PAYMENT_METHOD_LABELS: Record<InvoicePayment["method"], string> = {
  CASH: "Cash",
  CHECK: "Check",
  ACH: "ACH Transfer",
  OTHER: "Other",
};

export default function InvoiceDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: invoice, isLoading, isError, refetch } = useMyInvoice(id ?? "");
  const [downloading, setDownloading] = React.useState(false);

  async function handleDownloadPDF() {
    if (!invoice || downloading) return;
    setDownloading(true);
    try {
      const token = (apiClient.defaults.headers.common["Authorization"] as string)?.replace("Bearer ", "") ?? "";
      const fileUri = `${FileSystem.cacheDirectory}${invoice.invoiceNumber}.pdf`;
      const result = await FileSystem.downloadAsync(
        `${apiClient.defaults.baseURL}/invoices/${invoice.id}/pdf`,
        fileUri,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (result.status !== 200) throw new Error("Download failed");
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(result.uri, { mimeType: "application/pdf", UTI: "com.adobe.pdf" });
      } else {
        Alert.alert("Saved", `Invoice saved to ${result.uri}`);
      }
    } catch (e: any) {
      Alert.alert("Error", e.message ?? "Failed to download PDF.");
    } finally {
      setDownloading(false);
    }
  }

  if (isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: "Invoice", headerBackTitle: "Invoices" }} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      </>
    );
  }

  if (isError || !invoice) {
    return (
      <>
        <Stack.Screen options={{ title: "Invoice", headerBackTitle: "Invoices" }} />
        <NetworkError onRetry={() => refetch()} />
      </>
    );
  }

  const cfg = STATUS_CONFIG[invoice.status] ?? STATUS_CONFIG.DRAFT;
  const amountPaid = (invoice.payments ?? []).reduce((s, p) => s + Number(p.amount), 0);
  const amountDue = Math.max(0, Number(invoice.total) - amountPaid);

  return (
    <>
      <Stack.Screen
        options={{ title: invoice.invoiceNumber, headerBackTitle: "Invoices" }}
      />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Header card */}
        <View style={styles.headerCard}>
          <View style={styles.headerTop}>
            <Text style={styles.invoiceNumber}>{invoice.invoiceNumber}</Text>
            <View style={[styles.statusChip, { backgroundColor: cfg.bg }]}>
              <Text style={[styles.statusChipText, { color: cfg.color }]}>{cfg.label}</Text>
            </View>
          </View>

          <View style={styles.amountRow}>
            <View>
              <Text style={styles.amountLabel}>Total</Text>
              <Text style={styles.amountTotal}>${Number(invoice.total).toFixed(2)}</Text>
            </View>
            {amountDue > 0 && invoice.status !== "VOID" ? (
              <View style={[styles.amountDueBox, { backgroundColor: invoice.status === "OVERDUE" ? colors.danger.bg : colors.warning.bg }]}>
                <Text style={[styles.amountDueLabel, { color: invoice.status === "OVERDUE" ? colors.danger.DEFAULT : colors.warning.DEFAULT }]}>
                  Amount Due
                </Text>
                <Text style={[styles.amountDueValue, { color: invoice.status === "OVERDUE" ? colors.danger.DEFAULT : colors.warning.DEFAULT }]}>
                  ${amountDue.toFixed(2)}
                </Text>
              </View>
            ) : null}
          </View>

          <View style={styles.metaRow}>
            <View style={styles.metaItem}>
              <Ionicons name="calendar-outline" size={14} color="#94a3b8" />
              <Text style={styles.metaText}>
                Issued {format(parseISO(invoice.createdAt), "MMM d, yyyy")}
              </Text>
            </View>
            {invoice.dueDate ? (
              <View style={styles.metaItem}>
                <Ionicons name="alarm-outline" size={14} color="#94a3b8" />
                <Text style={styles.metaText}>
                  Due {format(parseISO(invoice.dueDate), "MMM d, yyyy")}
                </Text>
              </View>
            ) : null}
          </View>

          {/* PDF download */}
          <Pressable
            style={[styles.downloadBtn, downloading && { opacity: 0.6 }]}
            onPress={handleDownloadPDF}
            disabled={downloading}
            accessibilityRole="button"
            accessibilityLabel="Download invoice as PDF"
          >
            {downloading ? (
              <ActivityIndicator size="small" color={colors.brand[600]} />
            ) : (
              <Ionicons name="download-outline" size={16} color={colors.brand[600]} />
            )}
            <Text style={styles.downloadBtnText}>
              {downloading ? "Downloading…" : "Download PDF"}
            </Text>
          </Pressable>
        </View>

        {/* Line items */}
        {invoice.items && invoice.items.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Items</Text>
            {invoice.items.map((item, idx) => (
              <View
                key={item.id}
                style={[
                  styles.lineItem,
                  idx === (invoice.items?.length ?? 0) - 1 && styles.lineItemLast,
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

            {/* Totals breakdown */}
            <View style={styles.totalsBox}>
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Subtotal</Text>
                <Text style={styles.totalValue}>${Number(invoice.subtotal).toFixed(2)}</Text>
              </View>
              {Number(invoice.taxAmount) > 0 ? (
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Tax</Text>
                  <Text style={styles.totalValue}>${Number(invoice.taxAmount).toFixed(2)}</Text>
                </View>
              ) : null}
              {Number(invoice.discount) > 0 ? (
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Discount</Text>
                  <Text style={[styles.totalValue, { color: colors.success.DEFAULT }]}>
                    −${Number(invoice.discount).toFixed(2)}
                  </Text>
                </View>
              ) : null}
              <View style={[styles.totalRow, styles.totalGrandRow]}>
                <Text style={styles.grandLabel}>Total</Text>
                <Text style={styles.grandValue}>${Number(invoice.total).toFixed(2)}</Text>
              </View>
            </View>
          </View>
        ) : null}

        {/* Payments */}
        {invoice.payments && invoice.payments.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Payments Received</Text>
            {invoice.payments.map((payment, idx) => (
              <View
                key={payment.id}
                style={[
                  styles.paymentRow,
                  idx === (invoice.payments?.length ?? 0) - 1 && styles.lineItemLast,
                ]}
              >
                <View style={styles.paymentLeft}>
                  <Ionicons name="checkmark-circle" size={16} color={colors.success.DEFAULT} />
                  <View>
                    <Text style={styles.paymentMethod}>
                      {PAYMENT_METHOD_LABELS[payment.method]}
                    </Text>
                    <Text style={styles.paymentDate}>
                      {format(parseISO(payment.paidAt), "MMM d, yyyy")}
                      {payment.reference ? ` · Ref: ${payment.reference}` : ""}
                    </Text>
                  </View>
                </View>
                <Text style={styles.paymentAmount}>
                  ${Number(payment.amount).toFixed(2)}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* Notes */}
        {invoice.notes ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Notes</Text>
            <Text style={styles.notesText}>{invoice.notes}</Text>
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
  invoiceNumber: {
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
  amountRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
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
  amountDueBox: {
    borderRadius: borderRadius.DEFAULT,
    padding: 12,
    alignItems: "flex-end",
  },
  amountDueLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  amountDueValue: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
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
  totalLabel: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  totalValue: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
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
  paymentRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
  },
  paymentLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
  },
  paymentMethod: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  paymentDate: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    marginTop: 1,
  },
  paymentAmount: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: colors.success.DEFAULT,
  },
  notesText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    lineHeight: 20,
    paddingVertical: 12,
  },
  downloadBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: colors.brand[50],
    borderRadius: borderRadius.DEFAULT,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.brand[100],
  },
  downloadBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[600],
  },
});
