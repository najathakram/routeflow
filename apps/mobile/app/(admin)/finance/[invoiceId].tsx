import { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Alert,
  Modal,
  TextInput,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@routeflow/ui/tokens";
import {
  useAdminInvoice,
  useVoidAdminInvoice,
  useRecordAdminPayment,
} from "../../../lib/api/admin";

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  DRAFT: { bg: "#f1f5f9", text: "#475569" },
  SENT: { bg: "#dbeafe", text: "#1e40af" },
  PARTIAL: { bg: "#fef9c3", text: "#854d0e" },
  PAID: { bg: "#d1fae5", text: "#065f46" },
  OVERDUE: { bg: "#fee2e2", text: "#991b1b" },
  VOID: { bg: "#f1f5f9", text: "#94a3b8" },
};

const PAYMENT_METHODS = ["CASH", "BANK_TRANSFER", "CHEQUE", "CARD", "OTHER"];

export default function AdminInvoiceDetailScreen() {
  const { invoiceId } = useLocalSearchParams<{ invoiceId: string }>();
  const { data: invoice, isLoading, isError, refetch } = useAdminInvoice(invoiceId);
  const voidInvoice = useVoidAdminInvoice();
  const recordPayment = useRecordAdminPayment();

  const [paymentModalVisible, setPaymentModalVisible] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("CASH");
  const [paymentRef, setPaymentRef] = useState("");

  const handleVoid = () => {
    Alert.alert(
      "Void Invoice",
      "Are you sure you want to void this invoice? This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Void Invoice",
          style: "destructive",
          onPress: () =>
            voidInvoice.mutate(invoiceId, {
              onSuccess: () => refetch(),
              onError: () => Alert.alert("Error", "Failed to void invoice"),
            }),
        },
      ]
    );
  };

  const handleRecordPayment = () => {
    const amount = parseFloat(paymentAmount);
    if (!amount || isNaN(amount) || amount <= 0) {
      Alert.alert("Invalid Amount", "Please enter a valid payment amount");
      return;
    }
    recordPayment.mutate(
      { id: invoiceId, amount, method: paymentMethod, reference: paymentRef || undefined },
      {
        onSuccess: () => {
          setPaymentModalVisible(false);
          setPaymentAmount("");
          setPaymentRef("");
          refetch();
        },
        onError: () => Alert.alert("Error", "Failed to record payment"),
      }
    );
  };

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#2563EB" />
      </View>
    );
  }

  if (isError || !invoice) {
    return (
      <View style={styles.centered}>
        <Ionicons name="cloud-offline-outline" size={40} color="#cbd5e1" />
        <Text style={styles.errorText}>Failed to load invoice</Text>
        <Pressable style={styles.retryBtn} onPress={() => refetch()}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  const sc = STATUS_COLORS[invoice.status] ?? { bg: "#f1f5f9", text: "#475569" };
  const balanceDue = invoice.balanceDue ?? 0;
  const canVoid = invoice.status === "SENT" || invoice.status === "PARTIAL";
  const canRecordPayment = invoice.status === "SENT" || invoice.status === "PARTIAL" || invoice.status === "OVERDUE";

  return (
    <>
      <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
        {/* Invoice Header */}
        <View style={styles.card}>
          <View style={styles.invoiceHeaderRow}>
            <Text style={styles.invoiceNumber}>{invoice.invoiceNumber}</Text>
            <View style={[styles.statusBadge, { backgroundColor: sc.bg }]}>
              <Text style={[styles.statusText, { color: sc.text }]}>{invoice.status}</Text>
            </View>
          </View>
          {invoice.issueDate && (
            <Text style={styles.metaText}>
              Issued: {new Date(invoice.issueDate).toLocaleDateString()}
            </Text>
          )}
          {invoice.dueDate && (
            <Text style={[styles.metaText, invoice.status === "OVERDUE" && { color: "#dc2626" }]}>
              Due: {new Date(invoice.dueDate).toLocaleDateString()}
            </Text>
          )}
        </View>

        {/* Customer */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Customer</Text>
          <Text style={styles.customerName}>{invoice.customer?.businessName ?? "—"}</Text>
        </View>

        {/* Totals */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Totals</Text>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Subtotal</Text>
            <Text style={styles.totalValue}>${Number(invoice.subtotal).toFixed(2)}</Text>
          </View>
          {invoice.taxAmount != null && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Tax</Text>
              <Text style={styles.totalValue}>${Number(invoice.taxAmount).toFixed(2)}</Text>
            </View>
          )}
          {invoice.discount != null && invoice.discount > 0 && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Discount</Text>
              <Text style={[styles.totalValue, { color: "#059669" }]}>
                -${Number(invoice.discount).toFixed(2)}
              </Text>
            </View>
          )}
          <View style={[styles.totalRow, styles.totalFinalRow]}>
            <Text style={styles.totalFinalLabel}>Total</Text>
            <Text style={styles.totalFinalValue}>${Number(invoice.total).toFixed(2)}</Text>
          </View>
          {invoice.paidAmount != null && invoice.paidAmount > 0 && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Paid</Text>
              <Text style={[styles.totalValue, { color: "#059669" }]}>
                ${Number(invoice.paidAmount).toFixed(2)}
              </Text>
            </View>
          )}
          {balanceDue > 0 && (
            <View style={[styles.totalRow, styles.balanceDueRow]}>
              <Text style={styles.balanceDueLabel}>Balance Due</Text>
              <Text style={styles.balanceDueValue}>${balanceDue.toFixed(2)}</Text>
            </View>
          )}
        </View>

        {/* Payments */}
        {(invoice.payments?.length ?? 0) > 0 && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Payment History</Text>
            {invoice.payments!.map((payment, index) => (
              <View
                key={payment.id}
                style={[
                  styles.paymentRow,
                  index === 0 && { borderTopWidth: 0 },
                ]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.paymentMethod}>{payment.method}</Text>
                  <Text style={styles.paymentDate}>
                    {new Date(payment.createdAt).toLocaleDateString()}
                  </Text>
                </View>
                <Text style={styles.paymentAmount}>
                  +${Number(payment.amount).toFixed(2)}
                </Text>
              </View>
            ))}
          </View>
        )}

        {/* Actions */}
        {(canVoid || canRecordPayment) && (
          <View style={styles.actionsCard}>
            {canRecordPayment && (
              <Pressable
                style={styles.recordPaymentBtn}
                onPress={() => setPaymentModalVisible(true)}
              >
                <Ionicons name="cash-outline" size={18} color="#fff" />
                <Text style={styles.recordPaymentBtnText}>Record Payment</Text>
              </Pressable>
            )}
            {canVoid && (
              <Pressable
                style={styles.voidBtn}
                onPress={handleVoid}
                disabled={voidInvoice.isPending}
              >
                {voidInvoice.isPending ? (
                  <ActivityIndicator size="small" color="#dc2626" />
                ) : (
                  <>
                    <Ionicons name="ban-outline" size={18} color="#dc2626" />
                    <Text style={styles.voidBtnText}>Void Invoice</Text>
                  </>
                )}
              </Pressable>
            )}
          </View>
        )}

        <View style={{ height: 32 }} />
      </ScrollView>

      {/* Record Payment Modal */}
      <Modal
        visible={paymentModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setPaymentModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Record Payment</Text>
              <Pressable onPress={() => setPaymentModalVisible(false)}>
                <Ionicons name="close" size={22} color="#64748b" />
              </Pressable>
            </View>

            <Text style={styles.modalLabel}>Amount</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="0.00"
              keyboardType="decimal-pad"
              value={paymentAmount}
              onChangeText={setPaymentAmount}
              placeholderTextColor="#94a3b8"
            />

            <Text style={styles.modalLabel}>Payment Method</Text>
            <View style={styles.methodGrid}>
              {PAYMENT_METHODS.map((method) => (
                <Pressable
                  key={method}
                  style={[
                    styles.methodChip,
                    paymentMethod === method && styles.methodChipActive,
                  ]}
                  onPress={() => setPaymentMethod(method)}
                >
                  <Text
                    style={[
                      styles.methodChipText,
                      paymentMethod === method && styles.methodChipTextActive,
                    ]}
                  >
                    {method}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.modalLabel}>Reference (optional)</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="Payment reference..."
              value={paymentRef}
              onChangeText={setPaymentRef}
              placeholderTextColor="#94a3b8"
            />

            <Pressable
              style={styles.submitBtn}
              onPress={handleRecordPayment}
              disabled={recordPayment.isPending}
            >
              {recordPayment.isPending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.submitBtnText}>Record Payment</Text>
              )}
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f8fafc" },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    backgroundColor: "#f8fafc",
  },
  errorText: { fontSize: 15, fontFamily: "Inter_400Regular", color: "#94a3b8" },
  retryBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: "#2563EB",
    borderRadius: 8,
  },
  retryText: { color: "#fff", fontFamily: "Inter_600SemiBold", fontSize: 14 },
  card: {
    backgroundColor: "#fff",
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 12,
    padding: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  invoiceHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  invoiceNumber: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 100 },
  statusText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  metaText: { fontSize: 13, fontFamily: "Inter_400Regular", color: "#64748b", marginTop: 2 },
  cardTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  customerName: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
  },
  totalFinalRow: { borderTopWidth: 1, borderTopColor: "#e2e8f0", marginTop: 4 },
  totalLabel: { fontSize: 14, fontFamily: "Inter_400Regular", color: "#64748b" },
  totalValue: { fontSize: 14, fontFamily: "Inter_500Medium", color: colors.navy.DEFAULT },
  totalFinalLabel: { fontSize: 16, fontFamily: "Inter_700Bold", color: colors.navy.DEFAULT },
  totalFinalValue: { fontSize: 16, fontFamily: "Inter_700Bold", color: colors.navy.DEFAULT },
  balanceDueRow: {
    marginTop: 4,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: "#fca5a5",
    backgroundColor: "#fff5f5",
    paddingHorizontal: 8,
    borderRadius: 8,
    marginHorizontal: -4,
  },
  balanceDueLabel: { fontSize: 16, fontFamily: "Inter_700Bold", color: "#dc2626" },
  balanceDueValue: { fontSize: 20, fontFamily: "Inter_700Bold", color: "#dc2626" },
  paymentRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
  },
  paymentMethod: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
  },
  paymentDate: { fontSize: 12, fontFamily: "Inter_400Regular", color: "#94a3b8", marginTop: 2 },
  paymentAmount: { fontSize: 15, fontFamily: "Inter_700Bold", color: "#059669" },
  actionsCard: { marginHorizontal: 16, marginTop: 12, gap: 10 },
  recordPaymentBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: "#2563EB",
  },
  recordPaymentBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
  },
  voidBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#fca5a5",
  },
  voidBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#dc2626" },
  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 40,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 20,
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  modalLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#64748b",
    marginBottom: 6,
    marginTop: 12,
  },
  modalInput: {
    backgroundColor: "#f8fafc",
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
  },
  methodGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  methodChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 100,
    backgroundColor: "#f8fafc",
    borderWidth: 1,
    borderColor: colors.surface.border,
  },
  methodChipActive: { backgroundColor: "#2563EB", borderColor: "#2563EB" },
  methodChipText: { fontSize: 13, fontFamily: "Inter_500Medium", color: "#64748b" },
  methodChipTextActive: { color: "#fff" },
  submitBtn: {
    marginTop: 20,
    backgroundColor: "#2563EB",
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  submitBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#fff" },
});
