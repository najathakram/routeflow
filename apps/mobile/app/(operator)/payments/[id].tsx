import { useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import { usePayment, useSetCheckStatus, useVoidPayment } from "../../../lib/api/payments";
import {
  checkNextStates,
  paymentActionFlags,
  paymentMethodPill,
  paymentStatusPill,
} from "../../../lib/payments-logic";
import { checkBadgeFor } from "../../../lib/check-badge";
import { MoneyTextInput } from "../../../components/MoneyTextInput";
import { showToast } from "../../../lib/toast";
import { confirm } from "../../../lib/confirm";
import { roundMoney } from "@routeflow/pricing";

function fmtCurrency(n: number | string | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

const onErr = (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again.");

export default function PaymentDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const { data: payment, isLoading, refetch } = usePayment(id ?? "");
  const voidMut = useVoidPayment();
  const checkMut = useSetCheckStatus();
  // Bounce needs an NSF-fee prompt; Cleared offers a bank-date. Both are small
  // modals; deposit is a plain confirm.
  const [bounceOpen, setBounceOpen] = useState(false);
  const [nsfFee, setNsfFee] = useState<number | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearBankDate, setClearBankDate] = useState("");

  if (isLoading || !payment) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Payment" leading={<NavBackButton onPress={() => router.back()} />} />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const s = paymentStatusPill(payment.status);
  const m = paymentMethodPill(payment.method);
  const flags = paymentActionFlags(payment.status, payment.method);
  const received = payment.paidAt ?? payment.createdAt;
  const check = checkBadgeFor(payment);
  const nextCheckStates = checkNextStates(payment);

  const runCheckStatus = (
    status: "DEPOSITED" | "CLEARED" | "BOUNCED",
    extra?: { nsfFeeAmount?: number; settledAt?: string },
  ) => {
    if (!id) return;
    checkMut.mutate(
      { invoiceId: payment.invoice.id, paymentId: id, status, ...extra },
      {
        onSuccess: () => {
          showToast(
            status === "BOUNCED"
              ? "Check marked as bounced"
              : `Check marked as ${status.toLowerCase()}`,
          );
          setBounceOpen(false);
          setClearOpen(false);
          refetch();
        },
        onError: onErr,
      },
    );
  };

  const handleVoid = () => {
    if (!id) return;
    confirm(
      "Void payment?",
      `${payment.paymentNumber ?? "This payment"} will be reversed on ${payment.invoice.invoiceNumber}. This can't be undone.`,
      () =>
        voidMut.mutate(
          { invoiceId: payment.invoice.id, paymentId: id },
          {
            onSuccess: () => {
              showToast("Payment voided");
              refetch();
            },
            onError: onErr,
          },
        ),
      { confirmText: "Void", destructive: true },
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={payment.paymentNumber ?? "Payment"}
        leading={<NavBackButton label="Payments" onPress={() => router.back()} />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ padding: 16, gap: 14 }}>
          {/* Header */}
          <View style={styles.card}>
            <View style={styles.headerPills}>
              <Pill variant={s.variant} dot>
                {s.label}
              </Pill>
              {check ? (
                <Pill variant={check.variant} dot>
                  {check.label}
                </Pill>
              ) : null}
            </View>
            <Text style={styles.customer}>
              {payment.invoice.customer?.businessName ?? "Customer"}
            </Text>
            <Text style={styles.total}>{fmtCurrency(payment.amount)}</Text>
            <Text style={styles.dates}>Received {new Date(received).toLocaleDateString()}</Text>
            {payment.checkStatus === "BOUNCED" && Number(payment.nsfFeeAmount ?? 0) > 0 ? (
              <Text style={styles.nsfLine}>
                + {fmtCurrency(payment.nsfFeeAmount ?? 0)} NSF fee billed to the invoice
              </Text>
            ) : null}
          </View>

          {/* Receipt */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Receipt</Text>
            <KVRow
              label="Received from"
              value={payment.invoice.customer?.businessName ?? "Customer"}
            />
            <KVRow label="Payment date" value={new Date(received).toLocaleDateString()} />
            {payment.settledAt ? (
              <KVRow
                label="Money received in bank"
                value={new Date(payment.settledAt).toLocaleDateString()}
              />
            ) : null}
            <KVRow label="Payment mode" value={m.label} icon={m.icon} />
            {payment.depositedAt ? (
              <KVRow label="Deposited" value={new Date(payment.depositedAt).toLocaleDateString()} />
            ) : null}
            {payment.clearedAt ? (
              <KVRow label="Cleared" value={new Date(payment.clearedAt).toLocaleDateString()} />
            ) : null}
            {payment.bouncedAt ? (
              <KVRow label="Bounced" value={new Date(payment.bouncedAt).toLocaleDateString()} />
            ) : null}
            {payment.reference ? <KVRow label="Reference" value={payment.reference} /> : null}
            {payment.bankCharges && payment.bankCharges > 0 ? (
              <KVRow label="Bank charges" value={`-${fmtCurrency(payment.bankCharges)}`} />
            ) : null}
            {/* Applied invoice — tap through */}
            <Pressable
              style={styles.linkRow}
              onPress={() => router.push(`/(operator)/invoices/${payment.invoice.id}`)}
            >
              <Text style={styles.kvLabel}>Applied to invoice</Text>
              <View style={styles.linkVal}>
                <Text style={styles.linkText}>{payment.invoice.invoiceNumber}</Text>
                <Ionicons name="chevron-forward" size={14} color={ios.label3} />
              </View>
            </Pressable>
          </View>

          {/* Actions — check lifecycle first (gated by the server transition
              table mirror), then void. */}
          {flags.canVoid || nextCheckStates.length > 0 ? (
            <View style={styles.actionsGrid}>
              {nextCheckStates.includes("DEPOSITED") ? (
                <ActionTile
                  icon="business-outline"
                  label={checkMut.isPending ? "Saving…" : "Mark deposited"}
                  onPress={() =>
                    confirm(
                      "Mark check as deposited?",
                      "Bookkeeping only — the invoice balance doesn't change.",
                      () => runCheckStatus("DEPOSITED"),
                      { confirmText: "Deposited" },
                    )
                  }
                />
              ) : null}
              {nextCheckStates.includes("CLEARED") ? (
                <ActionTile
                  icon="checkmark-circle-outline"
                  label={checkMut.isPending ? "Saving…" : "Mark cleared"}
                  onPress={() => {
                    setClearBankDate("");
                    setClearOpen(true);
                  }}
                />
              ) : null}
              {nextCheckStates.includes("BOUNCED") ? (
                <ActionTile
                  icon="alert-circle-outline"
                  label="Mark bounced…"
                  tone="danger"
                  onPress={() => {
                    setNsfFee(null);
                    setBounceOpen(true);
                  }}
                />
              ) : null}
              {flags.canVoid ? (
                <ActionTile
                  icon="ban-outline"
                  label={voidMut.isPending ? "Voiding…" : "Void payment"}
                  tone="danger"
                  onPress={handleVoid}
                />
              ) : null}
            </View>
          ) : (
            <Text style={styles.readonly}>This payment has been voided.</Text>
          )}

          {/* Notes */}
          {payment.notes ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Notes</Text>
              <Text style={styles.notes}>{payment.notes}</Text>
            </View>
          ) : null}
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>

      {/* Mark cleared — optional true bank landing date (sets clearedAt AND
          settledAt; cash-basis reporting windows on settledAt). */}
      <Modal
        visible={clearOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setClearOpen(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setClearOpen(false)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>Mark check as cleared?</Text>
            <Text style={styles.modalBody}>
              Optionally record the day the funds actually landed — it drives cash-basis reporting.
              Leave blank to keep the payment&apos;s current bank date.
            </Text>
            <Text style={styles.modalLabel}>Bank landing date (YYYY-MM-DD, optional)</Text>
            <TextInput
              style={styles.modalInput}
              value={clearBankDate}
              onChangeText={setClearBankDate}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={ios.label3}
              keyboardType="numbers-and-punctuation"
            />
            <View style={styles.modalBtns}>
              <Pressable style={styles.modalBtnGhost} onPress={() => setClearOpen(false)}>
                <Text style={styles.modalBtnGhostText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalBtnFill, checkMut.isPending && { opacity: 0.6 }]}
                disabled={checkMut.isPending}
                onPress={() => {
                  const d = clearBankDate.trim();
                  if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
                    showToast("Bank date must be YYYY-MM-DD (or blank).");
                    return;
                  }
                  runCheckStatus("CLEARED", d ? { settledAt: d } : undefined);
                }}
              >
                <Text style={styles.modalBtnFillText}>
                  {checkMut.isPending ? "Saving…" : "Mark cleared"}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Mark bounced — voids the payment, re-opens the invoice, optional NSF
          fee billed as a non-taxable line. */}
      <Modal
        visible={bounceOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setBounceOpen(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setBounceOpen(false)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>Mark check as bounced?</Text>
            <Text style={styles.modalBody}>
              This check for {fmtCurrency(payment.amount)} will be voided (NSF) and{" "}
              {payment.invoice.invoiceNumber}&apos;s balance will re-open. This can&apos;t be
              undone.
            </Text>
            <Text style={styles.modalLabel}>NSF fee ($, optional)</Text>
            <View style={styles.modalMoneyRow}>
              <Text style={styles.modalCurrency}>$</Text>
              <MoneyTextInput
                style={styles.modalMoneyInput}
                value={nsfFee}
                onChangeValue={setNsfFee}
                placeholder="0.00"
                returnKeyType="done"
              />
            </View>
            <Text style={styles.modalHelp}>
              Adds a non-taxable fee line to the invoice for the returned-check charge.
            </Text>
            <View style={styles.modalBtns}>
              <Pressable style={styles.modalBtnGhost} onPress={() => setBounceOpen(false)}>
                <Text style={styles.modalBtnGhostText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalBtnDanger, checkMut.isPending && { opacity: 0.6 }]}
                disabled={checkMut.isPending}
                onPress={() =>
                  runCheckStatus("BOUNCED", {
                    nsfFeeAmount: nsfFee != null && nsfFee > 0 ? roundMoney(nsfFee) : 0,
                  })
                }
              >
                <Text style={styles.modalBtnFillText}>
                  {checkMut.isPending ? "Saving…" : "Mark bounced"}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function KVRow({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvLabel}>{label}</Text>
      <View style={styles.kvValWrap}>
        {icon ? <Ionicons name={icon} size={14} color={ios.label2} /> : null}
        <Text style={styles.kvValue}>{value}</Text>
      </View>
    </View>
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
    <Pressable style={[styles.tile, isDanger && styles.tileDanger]} onPress={onPress}>
      <Ionicons name={icon} size={22} color={isDanger ? ios.system.red : ios.brand} />
      <Text style={[styles.tileLabel, isDanger && { color: ios.system.red }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14 },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, marginBottom: 8 },
  headerPills: { flexDirection: "row", alignItems: "center", gap: 6 },
  nsfLine: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.system.redInk,
    marginTop: 4,
  },
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
    maxWidth: 360,
    gap: 8,
  },
  modalTitle: { fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label },
  modalBody: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, lineHeight: 19 },
  modalLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    marginTop: 6,
  },
  modalInput: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: ios.label,
  },
  modalMoneyRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  modalCurrency: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.label2 },
  modalMoneyInput: {
    flex: 1,
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  modalHelp: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label3 },
  modalBtns: { flexDirection: "row", gap: 10, marginTop: 8 },
  modalBtnGhost: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: ios.fill3,
  },
  modalBtnGhostText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  modalBtnFill: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: ios.brand,
  },
  modalBtnDanger: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: ios.system.red,
  },
  modalBtnFillText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#fff" },
  customer: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, marginTop: 8 },
  total: {
    fontSize: 32,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    marginTop: 6,
    fontVariant: ["tabular-nums"],
    letterSpacing: -0.8,
  },
  dates: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  notes: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, lineHeight: 20 },
  readonly: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    color: ios.label2,
    paddingHorizontal: 4,
  },
  kvRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 8,
    gap: 12,
  },
  kvLabel: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  kvValWrap: { flexDirection: "row", alignItems: "center", gap: 5, flexShrink: 1 },
  kvValue: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label, textAlign: "right" },
  linkRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    marginTop: 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  linkVal: { flexDirection: "row", alignItems: "center", gap: 4 },
  linkText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.brand },
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
  tileLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    textAlign: "center",
  },
});
