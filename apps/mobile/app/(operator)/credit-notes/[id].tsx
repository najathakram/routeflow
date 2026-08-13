import { useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  useApplyCreditNote,
  useCreditNote,
  useIssueCreditNote,
  useOpenInvoicesForCustomer,
  useVoidCreditNote,
} from "../../../lib/api/credit-notes";
import {
  creditNoteActionFlags,
  creditNotePillFor,
  isCreditOpenForApply,
  openCreditBalance,
} from "../../../lib/credit-notes-logic";
import { showToast } from "../../../lib/toast";
import { confirm } from "../../../lib/confirm";

const OPEN_INVOICE_STATUSES = ["SENT", "VIEWED", "PARTIAL", "OVERDUE"];

function fmtCurrency(n: number | string | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

const onErr = (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again.");

export default function CreditNoteDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const { data: cn, isLoading, refetch } = useCreditNote(id ?? "");
  const issueMut = useIssueCreditNote();
  const applyMut = useApplyCreditNote();
  const voidMut = useVoidCreditNote();
  const [pickerOpen, setPickerOpen] = useState(false);

  if (isLoading || !cn) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Credit Note"
          leading={<NavBackButton onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const s = creditNotePillFor(cn.status);
  const flags = creditNoteActionFlags(cn.status);
  const issued = cn.issueDate ?? cn.createdAt;
  const remaining = openCreditBalance(cn);
  const used = Math.max(0, Number(cn.amount) - remaining);
  const expired = !!cn.expiresAt && new Date(cn.expiresAt) <= new Date();
  // Apply is gated on the FULL open predicate, not status alone — an expired
  // or fully-consumed ISSUED note would just 400 on apply.
  const canApply = flags.canApply && isCreditOpenForApply(cn, new Date());

  const handleIssue = () => {
    if (!id) return;
    issueMut.mutate(id, {
      onSuccess: () => {
        showToast("Credit note issued");
        refetch();
      },
      onError: onErr,
    });
  };

  const handleApply = (invoiceId: string) => {
    if (!id) return;
    setPickerOpen(false);
    applyMut.mutate(
      { id, invoiceId },
      {
        onSuccess: (inv) => {
          showToast("Credit applied to invoice");
          // apply returns the updated INVOICE (keyed `id`), not the credit note.
          router.push(`/(operator)/invoices/${inv.id}`);
        },
        onError: onErr,
      },
    );
  };

  const handleVoid = () => {
    if (!id) return;
    confirm(
      "Void credit note?",
      `${cn.creditNoteNumber} will be voided and can't be undone.`,
      () =>
        voidMut.mutate(id, {
          onSuccess: () => {
            showToast("Credit note voided");
            refetch();
          },
          onError: onErr,
        }),
      { confirmText: "Void", destructive: true },
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={cn.creditNoteNumber}
        leading={<NavBackButton label="Credit Notes" onPress={() => router.back()} />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ padding: 16, gap: 14 }}>
          {/* Header */}
          <View style={styles.card}>
            <Pill variant={s.variant} dot>
              {s.label}
            </Pill>
            <Text style={styles.customer}>{cn.customer?.businessName ?? "Customer"}</Text>
            {cn.customer?.contactName ? (
              <Text style={styles.contact}>{cn.customer.contactName}</Text>
            ) : null}
            <Text style={styles.total}>{fmtCurrency(cn.amount)}</Text>
            <Text style={styles.dates}>
              Issued {new Date(issued).toLocaleDateString()}
              {cn.invoiceId ? " · Applies to invoice" : " · Applies to next invoice (auto)"}
            </Text>
            {/* The face amount alone reads as "untouched" after a partial
                apply — state what's applied and what's LEFT (mirrors web's
                sidebar Amount/Applied/Remaining). */}
            <View style={styles.balanceRow}>
              <View style={styles.balanceCell}>
                <Text style={styles.balanceLabel}>Applied</Text>
                <Text style={styles.balanceValue}>{fmtCurrency(used)}</Text>
              </View>
              <View style={styles.balanceCell}>
                <Text style={styles.balanceLabel}>Remaining</Text>
                <Text style={[styles.balanceValue, remaining > 0 && styles.balanceRemaining]}>
                  {fmtCurrency(remaining)}
                </Text>
              </View>
              {cn.expiresAt ? (
                <View style={styles.balanceCell}>
                  <Text style={styles.balanceLabel}>{expired ? "Expired" : "Expires"}</Text>
                  <Text style={[styles.balanceValue, expired && styles.balanceExpired]}>
                    {new Date(cn.expiresAt).toLocaleDateString()}
                  </Text>
                </View>
              ) : null}
            </View>
          </View>

          {/* Actions */}
          {flags.canIssue || flags.canApply || flags.canVoid ? (
            <View style={styles.actionsGrid}>
              {flags.canIssue ? (
                <ActionTile
                  icon="paper-plane-outline"
                  label={issueMut.isPending ? "Issuing…" : "Issue"}
                  onPress={handleIssue}
                />
              ) : null}
              {canApply ? (
                <ActionTile
                  icon="checkmark-circle-outline"
                  label={applyMut.isPending ? "Applying…" : "Apply to invoice"}
                  onPress={() => setPickerOpen(true)}
                />
              ) : null}
              {flags.canVoid ? (
                <ActionTile icon="ban-outline" label="Void" tone="danger" onPress={handleVoid} />
              ) : null}
            </View>
          ) : (
            <Text style={styles.readonly}>
              {cn.status === "APPLIED"
                ? "This credit note has been applied."
                : "This credit note is void."}
            </Text>
          )}

          {/* Reason */}
          {cn.reason ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Reason</Text>
              <Text style={styles.notes}>{cn.reason}</Text>
            </View>
          ) : null}

          {/* Notes */}
          {cn.notes ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Notes</Text>
              <Text style={styles.notes}>{cn.notes}</Text>
            </View>
          ) : null}
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>

      <ApplyInvoicePicker
        visible={pickerOpen}
        customerId={cn.customerId}
        onClose={() => setPickerOpen(false)}
        onPick={handleApply}
      />
    </SafeAreaView>
  );
}

function ApplyInvoicePicker({
  visible,
  customerId,
  onClose,
  onPick,
}: {
  visible: boolean;
  customerId?: string;
  onClose: () => void;
  onPick: (invoiceId: string) => void;
}) {
  const { data, isLoading } = useOpenInvoicesForCustomer(visible ? customerId : undefined);
  const open = (data?.data ?? []).filter((i) => OPEN_INVOICE_STATUSES.includes(i.status));

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <Text style={styles.sheetTitle}>Apply to invoice</Text>
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : open.length === 0 ? (
          <Text style={styles.empty}>No open invoices found for this customer.</Text>
        ) : (
          <ScrollView style={{ maxHeight: 320 }}>
            {open.map((inv) => (
              <Pressable key={inv.id} style={styles.invRow} onPress={() => onPick(inv.id)}>
                <Text style={styles.invNum}>{inv.invoiceNumber}</Text>
                {/* The BALANCE is what the credit lands against — the face
                    total misreads on partially-paid invoices (web's modal
                    lists balanceDue too). */}
                <Text style={styles.invTotal}>
                  {fmtCurrency((inv as any).balanceDue ?? inv.total)} due
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        )}
        <Pressable style={styles.cancelBtn} onPress={onClose}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
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
  customer: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, marginTop: 8 },
  contact: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  total: {
    fontSize: 32,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    marginTop: 6,
    fontVariant: ["tabular-nums"],
    letterSpacing: -0.8,
  },
  dates: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  balanceRow: {
    flexDirection: "row",
    gap: 18,
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  balanceCell: { minWidth: 72 },
  balanceLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  balanceValue: {
    marginTop: 2,
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  balanceRemaining: { color: ios.brand },
  balanceExpired: { color: ios.system.redInk },
  readonly: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    color: ios.label2,
    paddingHorizontal: 4,
  },
  notes: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, lineHeight: 20 },
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
  empty: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    padding: 20,
    textAlign: "center",
  },
  // Apply picker sheet
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: {
    backgroundColor: ios.bgElev,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 16,
    paddingBottom: 32,
    gap: 10,
  },
  sheetTitle: { fontSize: 16, fontFamily: "Inter_700Bold", color: ios.label, marginBottom: 4 },
  invRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  invNum: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  invTotal: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
    fontVariant: ["tabular-nums"],
  },
  cancelBtn: { alignItems: "center", padding: 12, marginTop: 4 },
  cancelText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.brand },
});
