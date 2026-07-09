import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  useAcceptEstimate,
  useConvertEstimateToInvoice,
  useDeclineEstimate,
  useEstimate,
  useSendEstimate,
  useVoidEstimate,
} from "../../../lib/api/estimates";
import {
  estimateActionFlags,
  estimateLineAmount,
  estimatePillFor,
} from "../../../lib/estimates-logic";
import { showToast } from "../../../lib/toast";
import { confirm } from "../../../lib/confirm";

function fmtCurrency(n: number | string | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

const onErr = (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again.");

export default function EstimateDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const { data: estimate, isLoading, refetch } = useEstimate(id ?? "");
  const sendMut = useSendEstimate();
  const acceptMut = useAcceptEstimate();
  const declineMut = useDeclineEstimate();
  const convertMut = useConvertEstimateToInvoice();
  const voidMut = useVoidEstimate();

  if (isLoading || !estimate) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Estimate" leading={<NavBackButton onPress={() => router.back()} />} />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const s = estimatePillFor(estimate.status);
  const flags = estimateActionFlags(estimate.status);

  const handleSend = () => {
    if (!id) return;
    sendMut.mutate(id, {
      onSuccess: () => {
        showToast("Estimate sent");
        refetch();
      },
      onError: onErr,
    });
  };

  const handleAccept = () => {
    if (!id) return;
    acceptMut.mutate(id, {
      onSuccess: () => {
        showToast("Estimate accepted");
        refetch();
      },
      onError: onErr,
    });
  };

  const handleDecline = () => {
    if (!id) return;
    confirm(
      "Decline estimate?",
      `${estimate.estimateNumber} will be marked declined.`,
      () =>
        declineMut.mutate(id, {
          onSuccess: () => {
            showToast("Estimate declined");
            refetch();
          },
          onError: onErr,
        }),
      { confirmText: "Decline", destructive: true },
    );
  };

  const handleConvert = () => {
    if (!id) return;
    convertMut.mutate(id, {
      onSuccess: (inv) => {
        showToast("Converted to invoice");
        // Server returns the created Invoice keyed `id` (not `invoiceId`).
        router.push(`/(operator)/invoices/${inv.id}`);
      },
      onError: onErr,
    });
  };

  const handleVoid = () => {
    if (!id) return;
    confirm(
      "Void estimate?",
      "This marks it declined and can't be undone.",
      () =>
        voidMut.mutate(id, {
          onSuccess: () => {
            showToast("Estimate voided");
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
        inlineTitle={estimate.estimateNumber}
        leading={<NavBackButton label="Estimates" onPress={() => router.back()} />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ padding: 16, gap: 14 }}>
          {/* Header */}
          <View style={styles.card}>
            <Pill variant={s.variant} dot>
              {s.label}
            </Pill>
            <Text style={styles.customer}>{estimate.customer?.businessName ?? "Customer"}</Text>
            {estimate.customer?.contactName ? (
              <Text style={styles.contact}>{estimate.customer.contactName}</Text>
            ) : null}
            <Text style={styles.total}>{fmtCurrency(estimate.total)}</Text>
            <Text style={styles.dates}>
              Issued {new Date(estimate.createdAt).toLocaleDateString()}
              {estimate.expiresAt
                ? ` · Valid to ${new Date(estimate.expiresAt).toLocaleDateString()}`
                : ""}
            </Text>
          </View>

          {/* Actions */}
          {flags.canSend || flags.canAcceptDecline || flags.canConvert || flags.canVoid ? (
            <View style={styles.actionsGrid}>
              {flags.canSend ? (
                <ActionTile
                  icon="paper-plane-outline"
                  label={sendMut.isPending ? "Sending…" : "Send"}
                  onPress={handleSend}
                />
              ) : null}
              {flags.canAcceptDecline ? (
                <ActionTile
                  icon="checkmark-circle-outline"
                  label={acceptMut.isPending ? "Accepting…" : "Accept"}
                  onPress={handleAccept}
                />
              ) : null}
              {flags.canAcceptDecline ? (
                <ActionTile
                  icon="close-circle-outline"
                  label="Decline"
                  tone="danger"
                  onPress={handleDecline}
                />
              ) : null}
              {flags.canConvert ? (
                <ActionTile
                  icon="swap-horizontal-outline"
                  label={convertMut.isPending ? "Converting…" : "Convert to invoice"}
                  onPress={handleConvert}
                />
              ) : null}
              {flags.canVoid ? (
                <ActionTile icon="ban-outline" label="Void" tone="danger" onPress={handleVoid} />
              ) : null}
            </View>
          ) : null}

          {/* Items */}
          {estimate.items && estimate.items.length > 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Items</Text>
              {estimate.items.map((it, i) => (
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
                  <Text style={styles.itemTotal}>{fmtCurrency(estimateLineAmount(it))}</Text>
                </View>
              ))}
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Subtotal</Text>
                <Text style={styles.totalValue}>{fmtCurrency(estimate.subtotal)}</Text>
              </View>
              {estimate.taxAmount ? (
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Tax</Text>
                  <Text style={styles.totalValue}>{fmtCurrency(estimate.taxAmount)}</Text>
                </View>
              ) : null}
              {estimate.discount ? (
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Discount</Text>
                  <Text style={styles.totalValue}>{fmtCurrency(estimate.discount)}</Text>
                </View>
              ) : null}
              <View style={[styles.totalRow, { borderTopWidth: 0 }]}>
                <Text style={styles.totalLabelMain}>Total</Text>
                <Text style={styles.totalValueMain}>{fmtCurrency(estimate.total)}</Text>
              </View>
            </View>
          ) : null}

          {/* Notes */}
          {estimate.notes ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Notes</Text>
              <Text style={styles.notes}>{estimate.notes}</Text>
            </View>
          ) : null}
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>
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
  itemRow: { flexDirection: "row", alignItems: "center", paddingVertical: 8, gap: 10 },
  itemName: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  itemSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  itemTotal: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 8,
    marginTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  totalLabel: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  totalValue: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  totalLabelMain: { fontSize: 15, fontFamily: "Inter_700Bold", color: ios.label },
  totalValueMain: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
});
