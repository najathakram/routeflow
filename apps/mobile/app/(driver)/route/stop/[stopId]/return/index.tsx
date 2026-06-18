import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { ListGroup, NavAction, NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import {
  useActiveRouteRun,
  useRouteRun,
  type RouteRunStop,
} from "../../../../../../lib/api/routes";
import { useCreateReturn, type ReturnReason } from "../../../../../../lib/api/returns";
import { showToast } from "../../../../../../lib/toast";

function reasonForApi(label: string): ReturnReason {
  const m: Record<string, ReturnReason> = {
    Damaged: "DAMAGED",
    Expired: "QUALITY_ISSUE",
    "Wrong SKU": "WRONG_ITEM",
    "Short-dated": "QUALITY_ISSUE",
    "Customer refused": "CUSTOMER_REFUSED",
    Quality: "QUALITY_ISSUE",
    Refused: "CUSTOMER_REFUSED",
    Partial: "EXCESS_ORDER",
  };
  return m[label] ?? "DAMAGED";
}

const REASONS = ["Damaged", "Expired", "Wrong SKU", "Short-dated", "Customer refused", "Quality"];

function returnRowsFromStop(stop: RouteRunStop): Array<{
  id: string;
  name: string;
  qty: number;
  reason: string;
  amount: number;
}> {
  const rows: ReturnType<typeof returnRowsFromStop> = [];
  for (const m of stop.deliveryMutations ?? []) {
    if (m.type === "DELIVERED" || m.type === "ADD_ON") continue;
    const lineItem = (stop.orders ?? [])
      .flatMap((o) => o.lineItems ?? [])
      .find((li) => li.id === m.orderItemId);
    const price = Number(lineItem?.unitPrice ?? 0);
    rows.push({
      id: m.id,
      name: m.product?.name ?? lineItem?.product?.name ?? "Item",
      qty: Number(m.quantityDelivered ?? 0),
      reason: m.note ?? (m.type === "REFUSED" ? "Refused" : "Partial"),
      amount: price * Number(m.quantityDelivered ?? 0),
    });
  }
  return rows;
}

export default function ReturnScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ stopId: string; runId?: string }>();
  const stopId = params.stopId;

  const backToStop = () => {
    if (stopId) {
      router.replace(`/(driver)/route/stop/${stopId}` as any);
    } else {
      router.replace("/(driver)/route" as any);
    }
  };
  const [activeReason, setActiveReason] = useState<string | null>(null);

  const { data: activeData } = useActiveRouteRun();
  const runId = params.runId ?? activeData?.data?.[0]?.id;
  const { data: run, isLoading } = useRouteRun(runId ?? "");
  const stop = useMemo(() => run?.stops?.find((s) => s.id === stopId), [run, stopId]);

  const rows = stop ? returnRowsFromStop(stop) : [];
  const createReturn = useCreateReturn();

  const issue = () => {
    if (!stop) return;
    const orderId = stop.orders?.[0]?.id;
    if (!orderId) {
      showToast("This stop has no order to attach the return to.");
      return;
    }
    if (rows.length === 0) {
      showToast("Mark items as partial or refused first.");
      return;
    }
    // Map rows back to (productId, qty, reason). Driver mutations carry
    // productId via DeliveryMutation; we can re-derive that from the stop.
    const items = (stop.deliveryMutations ?? [])
      .filter((m) => m.type === "PARTIAL" || m.type === "REFUSED")
      .map((m) => ({
        productId: m.productId,
        qty: Math.round(Number(m.quantityDelivered ?? 0)),
        reason: reasonForApi(activeReason ?? (m.type === "REFUSED" ? "Refused" : "Partial")),
      }));
    createReturn.mutate(
      {
        orderId,
        reason: items[0]?.reason ?? "DAMAGED",
        items,
      },
      {
        onSuccess: () => {
          showToast("Return submitted");
          backToStop();
        },
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };
  const customerName = stop?.customer?.businessName ?? "Stop";
  const orderNumber = stop?.orders?.[0]?.orderNumber;
  const originalTotal = (stop?.orders ?? []).reduce(
    (sum, o) =>
      sum +
      (o.lineItems ?? []).reduce((s, li) => s + Number(li.qty ?? 0) * Number(li.unitPrice ?? 0), 0),
    0,
  );
  const creditTotal = rows.reduce((sum, r) => sum + r.amount, 0);

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Return & credit"
          leading={<NavBackButton label="Stop" onPress={backToStop} />}
        />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Return & credit"
        leading={<NavBackButton label="Stop" onPress={backToStop} />}
        trailing={
          <NavAction
            label={createReturn.isPending ? "…" : "Issue"}
            bold
            onPress={createReturn.isPending ? undefined : issue}
          />
        }
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View style={styles.iconBlock}>
            <Ionicons name="arrow-undo-outline" size={20} color={ios.system.red} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.custName}>{customerName}</Text>
            <Text style={styles.custSub}>
              {orderNumber ? `Order ${orderNumber} · ` : ""}${originalTotal.toFixed(2)} originally
            </Text>
          </View>
        </View>

        <SectionRow title="Returned items" action="+ Add" />
        {rows.length === 0 ? (
          <View style={styles.emptyInline}>
            <Text style={styles.emptyInlineText}>
              No partial / refused items flagged for this stop yet.
            </Text>
          </View>
        ) : (
          <ListGroup>
            {rows.map((r) => (
              <View key={r.id} style={styles.returnRow}>
                <View style={styles.returnIcon}>
                  <Ionicons name="trash-outline" size={16} color={ios.system.red} />
                </View>
                <View style={{ flex: 1 }}>
                  <View style={styles.returnTopRow}>
                    <Text style={styles.returnName}>{r.name}</Text>
                    <Text style={styles.returnAmt}>−${r.amount.toFixed(2)}</Text>
                  </View>
                  <Text style={styles.returnSub}>
                    × {r.qty} · {r.reason}
                  </Text>
                </View>
              </View>
            ))}
          </ListGroup>
        )}

        <SectionRow title="Add reason" />
        <View style={styles.reasons}>
          {REASONS.map((r) => {
            const active = r === activeReason;
            return (
              <Pressable
                key={r}
                onPress={() => setActiveReason(r)}
                style={[styles.reasonChip, active && styles.reasonChipActive]}
              >
                <Text style={[styles.reasonText, active && styles.reasonTextActive]}>{r}</Text>
              </Pressable>
            );
          })}
        </View>

        {creditTotal > 0 ? (
          <View style={{ padding: 16, paddingTop: 20 }}>
            <LinearGradient
              colors={[ios.brandGradient[0]!, ios.brandGradient[1]!, ios.brandGradient[2]!]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.creditCard}
            >
              <Text style={styles.creditEyebrow}>CREDIT NOTE</Text>
              <Text style={styles.creditValue}>−${creditTotal.toFixed(2)}</Text>
              <Text style={styles.creditSub}>Will apply to next invoice · {customerName}</Text>
            </LinearGradient>
          </View>
        ) : null}

        <View style={{ padding: 16, gap: 8 }}>
          <Pressable
            style={[
              styles.primaryBtn,
              (rows.length === 0 || createReturn.isPending) && styles.primaryBtnDisabled,
            ]}
            disabled={rows.length === 0 || createReturn.isPending}
            onPress={issue}
          >
            <Text style={styles.primaryBtnText}>
              {createReturn.isPending ? "Submitting…" : "Submit return"}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function SectionRow({ title, action }: { title: string; action?: string }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {action ? <Text style={styles.sectionLink}>{action}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bgElev },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    backgroundColor: ios.bgElev,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: "row",
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
    alignItems: "center",
  },
  iconBlock: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: ios.system.redWash,
    alignItems: "center",
    justifyContent: "center",
  },
  custName: { fontSize: 18, fontFamily: "Inter_700Bold", color: ios.label },
  custSub: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  sectionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 8,
  },
  sectionTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.3,
  },
  sectionLink: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.brand },
  emptyInline: {
    marginHorizontal: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    backgroundColor: ios.bgElev,
    borderRadius: 12,
  },
  emptyInlineText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
  },
  returnRow: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: ios.bgElev,
  },
  returnIcon: {
    width: 30,
    height: 30,
    borderRadius: 7,
    backgroundColor: ios.system.redWash,
    alignItems: "center",
    justifyContent: "center",
  },
  returnTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  returnName: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: ios.label },
  returnAmt: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  returnSub: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  reasons: {
    paddingHorizontal: 16,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  reasonChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: ios.fill3,
  },
  reasonChipActive: { backgroundColor: ios.brand },
  reasonText: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  reasonTextActive: { color: "#fff" },
  creditCard: { borderRadius: 20, padding: 16 },
  creditEyebrow: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    color: "rgba(255,255,255,0.8)",
    letterSpacing: 1,
  },
  creditValue: {
    fontSize: 38,
    fontFamily: "Inter_700Bold",
    color: "#fff",
    letterSpacing: -1,
    marginTop: 6,
    fontVariant: ["tabular-nums"],
  },
  creditSub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.85)",
    marginTop: 2,
  },
  primaryBtn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: "center",
  },
  primaryBtnDisabled: { opacity: 0.55 },
  primaryBtnText: { color: "#fff", fontSize: 17, fontFamily: "Inter_600SemiBold" },
  secondaryBtn: {
    backgroundColor: ios.fill2,
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: "center",
  },
  secondaryBtnDisabled: { opacity: 0.55 },
  secondaryBtnText: { color: ios.brand, fontSize: 17, fontFamily: "Inter_600SemiBold" },
});
