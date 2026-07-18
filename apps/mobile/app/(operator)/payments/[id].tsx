import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import { usePayment, useVoidPayment } from "../../../lib/api/payments";
import {
  paymentActionFlags,
  paymentMethodPill,
  paymentStatusPill,
} from "../../../lib/payments-logic";
import { showToast } from "../../../lib/toast";
import { confirm } from "../../../lib/confirm";

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
            <Pill variant={s.variant} dot>
              {s.label}
            </Pill>
            <Text style={styles.customer}>
              {payment.invoice.customer?.businessName ?? "Customer"}
            </Text>
            <Text style={styles.total}>{fmtCurrency(payment.amount)}</Text>
            <Text style={styles.dates}>Received {new Date(received).toLocaleDateString()}</Text>
          </View>

          {/* Receipt */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Receipt</Text>
            <KVRow
              label="Received from"
              value={payment.invoice.customer?.businessName ?? "Customer"}
            />
            <KVRow label="Payment date" value={new Date(received).toLocaleDateString()} />
            <KVRow label="Payment mode" value={m.label} icon={m.icon} />
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

          {/* Void action */}
          {flags.canVoid ? (
            <View style={styles.actionsGrid}>
              <ActionTile
                icon="ban-outline"
                label={voidMut.isPending ? "Voiding…" : "Void payment"}
                tone="danger"
                onPress={handleVoid}
              />
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
