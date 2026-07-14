import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { useActiveRouteRun, useRouteRun } from "../../../../../lib/api/routes";
import { useOrder, type OrderItem } from "../../../../../lib/api/orders";
import { useDeliveryPlanStore } from "../../../../../store/delivery-plan-store";
import {
  reconciledTotal,
  deliveryTypeForQty,
  type ShortPickLine,
} from "../../../../../lib/short-pick";
import { sanitizeIntInput, parseIntQty } from "../../../../../lib/qty";

/**
 * Per-line "how much did you actually deliver" review, interposed between the
 * stop detail screen and payment.tsx. Defaults every line to the full ordered
 * qty (zero taps for the common fully-delivered case — never adds friction to
 * the happy path). Persists overrides into useDeliveryPlanStore for
 * payment.tsx to consume.
 */
export default function ShortPickScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ stopId: string; runId?: string }>();
  const stopId = params.stopId;

  const { data: activeData, isLoading: activeLoading } = useActiveRouteRun();
  const runId = params.runId ?? activeData?.data?.[0]?.id;
  const { data: run, isLoading: runLoading } = useRouteRun(runId ?? "");
  const stop = useMemo(() => run?.stops?.find((s) => s.id === stopId), [run, stopId]);
  const orderId = stop?.orders?.[0]?.id;
  const { data: order, isLoading: orderLoading } = useOrder(orderId ?? "");

  // Same adjustability gate as adjust.tsx: not cancelled, nothing already
  // delivered (a reopened, partially-completed stop shouldn't re-offer
  // already-settled lines).
  const lines: OrderItem[] = useMemo(
    () =>
      (order?.lineItems ?? []).filter(
        (li) => li.status !== "CANCELLED" && Number(li.deliveredQty ?? 0) === 0,
      ),
    [order],
  );

  const shortPickLines: ShortPickLine[] = useMemo(
    () =>
      lines.map((li) => ({
        orderItemId: li.id,
        productId: li.productId,
        orderedQty: Number(li.qty),
        subtotal: li.subtotal ?? null,
      })),
    [lines],
  );

  // Seed from any override this stop already has in the plan store (e.g. an
  // earlier short-pick attempt the driver backed out of without completing).
  // Without this the screen would re-render every line at full qty while the
  // store still held the stale partial — and handleContinue, iterating an
  // empty map, would never overwrite it, so payment.tsx would silently charge
  // the stale reduced total with no cue on this review screen.
  const [qtyById, setQtyById] = useState<Record<string, number>>(() =>
    stopId ? { ...(useDeliveryPlanStore.getState().plansByStop[stopId] ?? {}) } : {},
  );
  const setPlanQty = useDeliveryPlanStore((s) => s.setQty);

  const total = useMemo(() => reconciledTotal(shortPickLines, qtyById), [shortPickLines, qtyById]);
  const orderedTotal = useMemo(() => reconciledTotal(shortPickLines, {}), [shortPickLines]);
  const anyShort = total < orderedTotal - 0.005;

  function handleContinue() {
    if (!stopId) return;
    for (const [orderItemId, qty] of Object.entries(qtyById)) {
      setPlanQty(stopId, orderItemId, qty);
    }
    router.push(`/route/stop/${stopId}/payment` as any);
  }

  if (activeLoading || runLoading || orderLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Review delivery"
          leading={<NavBackButton label="Stop" onPress={() => router.back()} />}
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
        inlineTitle="Review delivery"
        leading={<NavBackButton label="Stop" onPress={() => router.back()} />}
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 24 }}
      >
        <Text style={styles.hint}>
          Everything defaults to fully delivered. Only adjust a line if you're short or the customer
          refused it.
        </Text>
        {lines.map((li) => (
          <ShortPickRow
            key={li.id}
            li={li}
            qty={qtyById[li.id] ?? li.qty}
            onChangeQty={(q) => setQtyById((m) => ({ ...m, [li.id]: q }))}
          />
        ))}

        <View style={styles.totalBlock}>
          <Text style={styles.totalLabel}>
            EST. TOTAL{anyShort ? " (short — see office invoice for final)" : ""}
          </Text>
          <Text style={styles.totalValue}>${total.toFixed(2)}</Text>
        </View>

        <View style={{ paddingHorizontal: 16 }}>
          <Pressable style={styles.continueBtn} onPress={handleContinue}>
            <Text style={styles.continueBtnText}>Continue to payment</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function ShortPickRow({
  li,
  qty,
  onChangeQty,
}: {
  li: OrderItem;
  qty: number;
  onChangeQty: (qty: number) => void;
}) {
  const ordered = Number(li.qty);
  const type = deliveryTypeForQty(qty, ordered);
  const [draft, setDraft] = useState(String(qty));

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.cardName} numberOfLines={2}>
            {li.product?.name ?? li.name ?? "Item"}
          </Text>
          <Text style={styles.cardMeta}>Ordered {ordered}</Text>
        </View>
        {type !== "DELIVERED" ? (
          <View
            style={[styles.badge, type === "REFUSED" ? styles.badgeRefused : styles.badgeShort]}
          >
            <Text style={styles.badgeText}>{type === "REFUSED" ? "Refused" : "Short"}</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.stepperRow}>
        <Text style={styles.stepperLabel}>Delivered</Text>
        <View style={styles.stepper}>
          <Pressable
            style={styles.stepBtn}
            onPress={() => {
              const n = Math.max(0, qty - 1);
              onChangeQty(n);
              setDraft(String(n));
            }}
            hitSlop={6}
          >
            <Text style={styles.stepText}>−</Text>
          </Pressable>
          <TextInput
            style={styles.qtyInput}
            value={draft}
            onChangeText={(txt) => {
              const clean = sanitizeIntInput(txt);
              setDraft(clean);
              if (clean === "") return;
              onChangeQty(Math.min(ordered, parseIntQty(clean, qty)));
            }}
            onBlur={() => setDraft(String(qty))}
            keyboardType="number-pad"
            returnKeyType="done"
            maxLength={5}
            selectTextOnFocus
          />
          <Pressable
            style={styles.stepBtn}
            onPress={() => {
              const n = Math.min(ordered, qty + 1);
              onChangeQty(n);
              setDraft(String(n));
            }}
            hitSlop={6}
          >
            <Text style={styles.stepText}>+</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  hint: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginHorizontal: 16,
    marginTop: 12,
    lineHeight: 18,
  },
  card: {
    marginHorizontal: 16,
    marginTop: 10,
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 14,
    gap: 10,
  },
  cardHeader: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  cardName: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  cardMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  badge: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  badgeShort: { backgroundColor: "#FEF3C7" },
  badgeRefused: { backgroundColor: "#FEE2E2" },
  badgeText: { fontSize: 11, fontFamily: "Inter_700Bold", color: ios.label },
  stepperRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  stepperLabel: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label2 },
  stepper: { flexDirection: "row", alignItems: "center" },
  stepBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: ios.fill3,
    alignItems: "center",
    justifyContent: "center",
  },
  stepText: { fontSize: 18, fontFamily: "Inter_600SemiBold", color: ios.label },
  qtyInput: {
    minWidth: 40,
    textAlign: "center",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
    paddingHorizontal: 6,
  },
  totalBlock: {
    marginHorizontal: 16,
    marginTop: 18,
    marginBottom: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  totalLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.6,
  },
  totalValue: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  continueBtn: {
    backgroundColor: ios.system.green,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
  },
  continueBtnText: { color: "#fff", fontSize: 17, fontFamily: "Inter_600SemiBold" },
});
