import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  useApproveReturn,
  useMarkReturnInTransit,
  useReceiveReturn,
  useRefundReturn,
  useRejectReturn,
  useReturn,
  type RefundMethod,
} from "../../../lib/api/returns";
import { returnActionFlags, returnPillFor } from "../../../lib/returns-logic";
import { showToast } from "../../../lib/toast";
import { chooseAction, confirm } from "../../../lib/confirm";

function fmtQty(v: number | string | null | undefined): string {
  const n = Number(v ?? 0);
  return Number.isInteger(n) ? String(n) : String(n);
}

function fmtCurrency(n: number | string | null | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

const REFUND_METHOD_LABELS: Record<RefundMethod, string> = {
  CREDIT_NOTE: "Store credit (credit note)",
  EXTERNAL_REFUND: "Refunded outside RouteFlow",
};

export default function ReturnDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: ret, isLoading } = useReturn(id ?? "");

  const approveMut = useApproveReturn();
  const rejectMut = useRejectReturn();
  const inTransitMut = useMarkReturnInTransit();
  const receiveMut = useReceiveReturn();
  const refundMut = useRefundReturn();

  const run = (mut: { mutate: (id: string, opts: any) => void }, okMsg: string) => {
    if (!id) return;
    mut.mutate(id, {
      onSuccess: () => showToast(okMsg),
      onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
    });
  };

  const resolveReturn = (method: RefundMethod) => {
    if (!id) return;
    refundMut.mutate(
      { id, method },
      {
        onSuccess: () =>
          showToast(method === "CREDIT_NOTE" ? "Store credit issued" : "Refund recorded"),
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  const openResolveChoice = () => {
    chooseAction("Resolve return", "How was this return settled with the customer?", [
      {
        label: "Issue store credit",
        style: "default",
        onPress: () => resolveReturn("CREDIT_NOTE"),
      },
      {
        label: "Refunded outside app",
        style: "default",
        onPress: () => resolveReturn("EXTERNAL_REFUND"),
      },
      { label: "Cancel", style: "cancel" },
    ]);
  };

  // "Resolve without receiving": receive with restocking suppressed, then the same
  // three-way choice. If the operator backs out of the choice dialog, the return
  // simply sits at RECEIVED — nothing was minted or restocked, which is truthful.
  const handleResolveWithoutReceiving = () => {
    if (!id) return;
    receiveMut.mutate(
      { id, restock: false },
      {
        onSuccess: () => openResolveChoice(),
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  if (isLoading || !ret) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Return" leading={<NavBackButton onPress={() => router.back()} />} />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const pill = returnPillFor(ret.status);
  const flags = returnActionFlags(ret.status);
  const anyPending =
    approveMut.isPending ||
    rejectMut.isPending ||
    inTransitMut.isPending ||
    receiveMut.isPending ||
    refundMut.isPending;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={ret.returnNumber ?? "Return"}
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ padding: 16, gap: 12 }}>
          {/* Header */}
          <View style={styles.card}>
            <View style={styles.headRow}>
              <Text style={styles.number}>{ret.returnNumber ?? "Return"}</Text>
              <Pill variant={pill.variant} dot>
                {pill.label}
              </Pill>
            </View>
            <Text style={styles.meta}>
              {ret.customer?.businessName ?? "Customer"}
              {ret.order?.orderNumber ? ` · Order ${ret.order.orderNumber}` : ""}
            </Text>
            <Text style={styles.meta}>
              {ret.reason ? ret.reason.replace(/_/g, " ").toLowerCase() : ""} ·{" "}
              {new Date(ret.createdAt).toLocaleDateString()}
            </Text>
            {ret.notes ? <Text style={styles.notes}>{ret.notes}</Text> : null}
          </View>

          {/* Actions */}
          {!flags.terminal ? (
            <View style={styles.actionsGrid}>
              {flags.canApprove ? (
                <ActionTile
                  icon="checkmark-circle-outline"
                  label="Approve"
                  disabled={anyPending}
                  onPress={() => run(approveMut, "Return approved")}
                />
              ) : null}
              {flags.canReject ? (
                <ActionTile
                  icon="close-circle-outline"
                  label="Reject"
                  tone="danger"
                  disabled={anyPending}
                  onPress={() =>
                    confirm(
                      "Reject return?",
                      "The return will be rejected.",
                      () => run(rejectMut, "Return rejected"),
                      { confirmText: "Reject", destructive: true },
                    )
                  }
                />
              ) : null}
              {flags.canMarkInTransit ? (
                <ActionTile
                  icon="car-outline"
                  label="Mark in transit"
                  disabled={anyPending}
                  onPress={() => run(inTransitMut, "Marked in transit")}
                />
              ) : null}
              {flags.canReceive ? (
                <ActionTile
                  icon="archive-outline"
                  label="Mark received"
                  disabled={anyPending}
                  onPress={() => run(receiveMut, "Marked received")}
                />
              ) : null}
              {flags.canResolveWithoutReceipt ? (
                <ActionTile
                  icon="play-skip-forward-outline"
                  label="Resolve without receiving"
                  disabled={anyPending}
                  onPress={handleResolveWithoutReceiving}
                />
              ) : null}
              {flags.canRefund ? (
                <ActionTile
                  icon="cash-outline"
                  label="Resolve return"
                  disabled={anyPending}
                  onPress={openResolveChoice}
                />
              ) : null}
            </View>
          ) : (
            <Text style={styles.terminalNote}>
              No further actions — this return is {pill.label.toLowerCase()}.
            </Text>
          )}

          {/* Resolution — how this return was settled with the customer.
              creditNoteId is part of the gate on purpose: returns refunded before the
              refundMethod/refundAmount/refundedAt columns shipped carry only creditNoteId
              (no backfill), and the credit-note link must still reach them. */}
          {ret.refundMethod || ret.refundedAt || ret.creditNoteId ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Resolution</Text>
              <View style={styles.resolutionRow}>
                <Text style={styles.resolutionLabel}>Method</Text>
                <Text style={styles.resolutionValue}>
                  {ret.refundMethod ? REFUND_METHOD_LABELS[ret.refundMethod] : "—"}
                </Text>
              </View>
              <View style={styles.resolutionRow}>
                <Text style={styles.resolutionLabel}>Amount</Text>
                <Text style={styles.resolutionValue}>
                  {ret.refundAmount == null ? "—" : fmtCurrency(ret.refundAmount)}
                </Text>
              </View>
              <View style={styles.resolutionRow}>
                <Text style={styles.resolutionLabel}>Date</Text>
                <Text style={styles.resolutionValue}>
                  {ret.refundedAt ? new Date(ret.refundedAt).toLocaleDateString() : "—"}
                </Text>
              </View>
              {ret.creditNoteId ? (
                <Pressable
                  style={styles.creditNoteLink}
                  onPress={() => router.push(`/(operator)/credit-notes/${ret.creditNoteId}`)}
                >
                  <Ionicons name="document-text-outline" size={16} color={ios.brand} />
                  <Text style={styles.creditNoteLinkText}>
                    {ret.creditNote?.creditNoteNumber ?? "View credit note"}
                  </Text>
                  <Ionicons name="chevron-forward" size={16} color={ios.label2} />
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {/* Items */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Items</Text>
            {ret.items.map((it, i) => (
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
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemName} numberOfLines={1}>
                    {it.product?.name ?? "Item"}
                  </Text>
                  {it.orderedQty != null ? (
                    <Text style={styles.itemMeta}>Ordered {fmtQty(it.orderedQty)}</Text>
                  ) : null}
                </View>
                <Text style={styles.itemQty}>Return {fmtQty(it.qty)}</Text>
              </View>
            ))}
          </View>
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function ActionTile({
  icon,
  label,
  tone,
  disabled,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  tone?: "danger";
  disabled?: boolean;
  onPress: () => void;
}) {
  const danger = tone === "danger";
  return (
    <Pressable
      style={[styles.tile, disabled && { opacity: 0.5 }]}
      onPress={disabled ? undefined : onPress}
    >
      <Ionicons name={icon} size={22} color={danger ? ios.system.red : ios.brand} />
      <Text style={[styles.tileLabel, danger && { color: ios.system.red }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  card: { backgroundColor: ios.bgElev, borderRadius: 12, padding: 14, gap: 6 },
  headRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  number: { flex: 1, fontSize: 18, fontFamily: "Inter_700Bold", color: ios.label },
  meta: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textTransform: "capitalize",
  },
  notes: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label, marginTop: 4 },
  actionsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tile: {
    width: "48%",
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
    gap: 6,
  },
  tileLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    textAlign: "center",
  },
  terminalNote: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    paddingHorizontal: 4,
  },
  cardTitle: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label2, marginBottom: 4 },
  resolutionRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  resolutionLabel: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  resolutionValue: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label },
  creditNoteLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 6,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  creditNoteLinkText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.brand,
  },
  itemRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, gap: 10 },
  itemName: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  itemMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  itemQty: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
});
