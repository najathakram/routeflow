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
} from "../../../lib/api/returns";
import { returnActionFlags, returnPillFor } from "../../../lib/returns-logic";
import { showToast } from "../../../lib/toast";
import { confirm } from "../../../lib/confirm";

function fmtQty(v: number | string | null | undefined): string {
  const n = Number(v ?? 0);
  return Number.isInteger(n) ? String(n) : String(n);
}

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
              {flags.canRefund ? (
                <ActionTile
                  icon="cash-outline"
                  label="Process refund"
                  disabled={anyPending}
                  onPress={() =>
                    confirm(
                      "Process refund?",
                      "This marks the return as Refunded. Restock was decided when the return was created.",
                      () => run(refundMut, "Refund processed"),
                      { confirmText: "Refund" },
                    )
                  }
                />
              ) : null}
            </View>
          ) : (
            <Text style={styles.terminalNote}>
              No further actions — this return is {pill.label.toLowerCase()}.
            </Text>
          )}

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
  tileLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label },
  terminalNote: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    paddingHorizontal: 4,
  },
  cardTitle: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label2, marginBottom: 4 },
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
