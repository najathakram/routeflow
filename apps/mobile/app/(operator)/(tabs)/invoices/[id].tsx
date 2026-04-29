import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useState } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import { useAdminInvoice } from "../../../../lib/api/admin";
import {
  useInvoicePdf,
  useSendInvoice,
  useUpdateInvoice,
  useVoidInvoice,
} from "../../../../lib/api/invoices";
import { showToast } from "../../../../lib/toast";
import { confirm } from "../../../../lib/confirm";

function fmtCurrency(n: number | string | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

function statusPill(status: string) {
  switch (status) {
    case "DRAFT":
      return { variant: "gray" as const, label: "Draft" };
    case "SENT":
      return { variant: "brand" as const, label: "Sent" };
    case "PARTIAL":
      return { variant: "orange" as const, label: "Partial" };
    case "PAID":
      return { variant: "green" as const, label: "Paid" };
    case "OVERDUE":
      return { variant: "red" as const, label: "Overdue" };
    case "VOID":
      return { variant: "gray" as const, label: "Voided" };
    default:
      return { variant: "gray" as const, label: status };
  }
}

export default function InvoiceDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: invoice, isLoading, refetch } = useAdminInvoice(id ?? "");
  const sendMut = useSendInvoice();
  const voidMut = useVoidInvoice();
  const pdfMut = useInvoicePdf();
  const updateMut = useUpdateInvoice();
  const [dueDateModal, setDueDateModal] = useState(false);
  const [dueDateInput, setDueDateInput] = useState("");

  if (isLoading || !invoice) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Invoice" leading={<NavBackButton onPress={() => router.back()} />} />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const s = statusPill(invoice.status);
  const balance = invoice.balanceDue ?? invoice.total;
  const isPaid = invoice.status === "PAID";
  const isVoid = invoice.status === "VOID";
  const canSend = invoice.status === "DRAFT";
  const canRecord = !isPaid && !isVoid;

  const handleSend = () => {
    if (!id) return;
    sendMut.mutate(
      { id },
      {
        onSuccess: () => {
          showToast("Invoice sent");
          refetch();
        },
        onError: (e: any) =>
          showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  const handleVoid = () => {
    if (!id) return;
    confirm("Void invoice?", `${invoice.invoiceNumber} will be marked void.`, () =>
      voidMut.mutate(id, {
        onSuccess: () => {
          showToast("Invoice voided");
          refetch();
        },
        onError: (e: any) =>
          showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      }),
      { confirmText: "Void", destructive: true },
    );
  };

  const handlePdf = () => {
    if (!id) return;
    pdfMut.mutate(id, {
      onSuccess: (data) => {
        if (data?.url) {
          Linking.openURL(data.url);
        } else {
          showToast("PDF is still generating, try again in a moment.");
        }
      },
      onError: (e: any) =>
        showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
    });
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={invoice.invoiceNumber}
        leading={<NavBackButton label="Invoices" onPress={() => router.back()} />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ padding: 16, gap: 14 }}>
          <View style={styles.card}>
            <Pill variant={s.variant} dot>
              {s.label}
            </Pill>
            <Text style={styles.customer}>{invoice.customer?.businessName ?? "Customer"}</Text>
            <Text style={styles.balance}>{fmtCurrency(balance)}</Text>
            <Text style={styles.balanceSub}>
              of {fmtCurrency(invoice.total)} · paid {fmtCurrency(invoice.paidAmount ?? 0)}
            </Text>
            <Pressable
              style={styles.dueRow}
              onPress={() => {
                setDueDateInput(
                  invoice.dueDate ? invoice.dueDate.slice(0, 10) : "",
                );
                setDueDateModal(true);
              }}
              hitSlop={4}
            >
              <Text style={styles.due}>
                {invoice.dueDate
                  ? `Due ${new Date(invoice.dueDate).toLocaleDateString()}`
                  : "Set due date"}
              </Text>
              <Ionicons name="pencil-outline" size={12} color={ios.label3} />
            </Pressable>
          </View>

          {/* Action grid */}
          <View style={styles.actionsGrid}>
            {canRecord ? (
              <ActionTile
                icon="cash-outline"
                label="Record payment"
                onPress={() => router.push(`/(operator)/invoices/${id}/record-payment`)}
              />
            ) : null}
            {canSend ? (
              <ActionTile
                icon="paper-plane-outline"
                label={sendMut.isPending ? "Sending…" : "Send"}
                onPress={handleSend}
              />
            ) : null}
            <ActionTile
              icon="document-text-outline"
              label={pdfMut.isPending ? "Loading…" : "View PDF"}
              onPress={handlePdf}
            />
            {!isVoid ? (
              <ActionTile
                icon="ban-outline"
                label="Void"
                tone="danger"
                onPress={handleVoid}
              />
            ) : null}
          </View>

          {/* Items */}
          {invoice.items && invoice.items.length > 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Items</Text>
              {invoice.items.map((it, i) => (
                <View
                  key={it.id}
                  style={[
                    styles.itemRow,
                    i > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: ios.separator,
                    },
                  ]}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.itemName} numberOfLines={1}>
                      {it.description}
                    </Text>
                    <Text style={styles.itemSub}>
                      {it.qty} × {fmtCurrency(it.unitPrice)}
                    </Text>
                  </View>
                  <Text style={styles.itemTotal}>{fmtCurrency(it.subtotal)}</Text>
                </View>
              ))}
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Subtotal</Text>
                <Text style={styles.totalValue}>{fmtCurrency(invoice.subtotal)}</Text>
              </View>
              {invoice.taxAmount ? (
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Tax</Text>
                  <Text style={styles.totalValue}>{fmtCurrency(invoice.taxAmount)}</Text>
                </View>
              ) : null}
              {invoice.discount ? (
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Discount</Text>
                  <Text style={styles.totalValue}>{fmtCurrency(invoice.discount)}</Text>
                </View>
              ) : null}
              <View style={[styles.totalRow, { borderTopWidth: 0 }]}>
                <Text style={styles.totalLabelMain}>Total</Text>
                <Text style={styles.totalValueMain}>{fmtCurrency(invoice.total)}</Text>
              </View>
            </View>
          ) : null}

          {/* Payments */}
          {invoice.payments && invoice.payments.length > 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Payments</Text>
              {invoice.payments.map((p, i) => (
                <View
                  key={p.id}
                  style={[
                    styles.payRow,
                    i > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: ios.separator,
                    },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.payMethod}>{p.method}</Text>
                    <Text style={styles.payMeta}>
                      {new Date(p.paidAt ?? p.createdAt).toLocaleDateString()}
                    </Text>
                    {p.reference ? (
                      <Text style={styles.payMeta}>Ref: {p.reference}</Text>
                    ) : null}
                    {p.notes ? (
                      <Text style={styles.payMeta}>{p.notes}</Text>
                    ) : null}
                  </View>
                  <Text style={styles.payAmount}>+{fmtCurrency(p.amount)}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>

      {/* Due date editor modal */}
      <Modal
        visible={dueDateModal}
        transparent
        animationType="fade"
        onRequestClose={() => setDueDateModal(false)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setDueDateModal(false)}
        >
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>Edit due date</Text>
            <Text style={styles.modalLabel}>Format: YYYY-MM-DD</Text>
            <TextInput
              style={styles.modalInput}
              value={dueDateInput}
              onChangeText={setDueDateInput}
              placeholder={new Date().toISOString().slice(0, 10)}
              placeholderTextColor={ios.label3}
              keyboardType="numbers-and-punctuation"
              autoFocus
            />
            <View style={{ flexDirection: "row", gap: 10, marginTop: 8 }}>
              <Pressable
                style={[styles.modalBtn, { flex: 1, backgroundColor: ios.fill3 }]}
                onPress={() => setDueDateModal(false)}
              >
                <Text style={[styles.modalBtnText, { color: ios.label }]}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.modalBtn,
                  { flex: 1, backgroundColor: ios.brand },
                  updateMut.isPending && { opacity: 0.6 },
                ]}
                onPress={() => {
                  if (!id) return;
                  updateMut.mutate(
                    { id, dueDate: dueDateInput.trim() || undefined },
                    {
                      onSuccess: () => {
                        showToast("Due date updated");
                        setDueDateModal(false);
                        refetch();
                      },
                      onError: (e: any) =>
                        showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
                    },
                  );
                }}
                disabled={updateMut.isPending}
              >
                {updateMut.isPending ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={[styles.modalBtnText, { color: "#fff" }]}>Save</Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function ActionTile({
  icon,
  label,
  onPress,
  tone = "default",
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  tone?: "default" | "danger";
}) {
  const isDanger = tone === "danger";
  return (
    <Pressable
      style={[styles.tile, isDanger && styles.tileDanger]}
      onPress={onPress}
    >
      <Ionicons
        name={icon}
        size={22}
        color={isDanger ? ios.system.red : ios.brand}
      />
      <Text style={[styles.tileLabel, isDanger && { color: ios.system.red }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14 },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, marginBottom: 8 },
  customer: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label2, marginTop: 8 },
  balance: {
    fontSize: 32,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    marginTop: 6,
    fontVariant: ["tabular-nums"],
    letterSpacing: -0.8,
  },
  balanceSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  due: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label2 },
  dueRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 6 },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    backgroundColor: ios.bgElev,
    borderRadius: 20,
    padding: 20,
    width: "100%",
    maxWidth: 340,
    gap: 6,
  },
  modalTitle: { fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label },
  modalLabel: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  modalInput: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    marginTop: 4,
  },
  modalBtn: { paddingVertical: 13, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  modalBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  actionsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  tile: {
    flexBasis: "47%",
    flexGrow: 1,
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 18,
    alignItems: "center",
    gap: 8,
  },
  tileDanger: { backgroundColor: ios.system.redWash },
  tileLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label, textAlign: "center" },
  itemRow: { flexDirection: "row", alignItems: "center", paddingVertical: 8, gap: 10 },
  itemName: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  itemSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  itemTotal: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label, fontVariant: ["tabular-nums"] },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 8,
    marginTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  totalLabel: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  totalValue: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label, fontVariant: ["tabular-nums"] },
  totalLabelMain: { fontSize: 15, fontFamily: "Inter_700Bold", color: ios.label },
  totalValueMain: { fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label, fontVariant: ["tabular-nums"] },
  payRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, gap: 10 },
  payMethod: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  payMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  payAmount: { fontSize: 14, fontFamily: "Inter_700Bold", color: ios.system.greenInk, fontVariant: ["tabular-nums"] },
});
