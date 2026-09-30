import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
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
import { useDriverPayments } from "../../../../../lib/api/addons";
import { orderQueryOptions, type Order, type OrderItem } from "../../../../../lib/api/orders";
import { useDeliveryPlanStore } from "../../../../../store/delivery-plan-store";
import {
  reconciledTotal,
  caseStepperCasesDelivered,
  caseStepperDecrement,
  caseStepperIncrement,
  caseStepperRemainderPieces,
  formatCaseStepperSplit,
  deliveryTypeForQty,
  deliveredSoFarByLine,
  isLineAdjustable,
  isUnitAwareLine,
  linesAwaitingEntry,
  normalizeDeliveryPlan,
  remainingByLine,
  shortPickLinesFromOrder,
  type ShortPickLine,
} from "../../../../../lib/short-pick";
import { sanitizeIntInput, parseIntQty } from "../../../../../lib/qty";

/** Same "adjustable" predicate `shortPickLinesFromOrder` applies for the
 *  money-math half — kept alongside it here since rendering needs the
 *  RICHER `OrderItem` (product name), not the pure `ShortPickLine`. */
function adjustableLines(
  order: Order | undefined,
  remainingById: Record<string, number>,
): OrderItem[] {
  return (order?.lineItems ?? []).filter((li) => isLineAdjustable(li, remainingById[li.id]));
}

/**
 * Per-line "how much did you actually deliver" review, interposed between the
 * stop detail screen and payment.tsx. Defaults every line to the full ordered
 * qty (zero taps for the common fully-delivered case — never adds friction to
 * the happy path). Persists overrides into useDeliveryPlanStore for
 * payment.tsx to consume.
 */
export default function ShortPickScreen() {
  // CTA honesty: without the driver_payments addon the next screen completes
  // the stop on account instead of collecting money.
  const { enabled: canCollect } = useDriverPayments();
  const router = useRouter();
  const params = useLocalSearchParams<{ stopId: string; runId?: string }>();
  const stopId = params.stopId;

  const { data: activeData, isLoading: activeLoading } = useActiveRouteRun();
  const runId = params.runId ?? activeData?.data?.[0]?.id;
  const { data: run, isLoading: runLoading } = useRouteRun(runId ?? "");
  const stop = useMemo(() => run?.stops?.find((s) => s.id === stopId), [run, stopId]);

  // B762: review EVERY order at the stop, not just orders[0] — a multi-order
  // stop must let the driver short-pick/refuse each order independently, or
  // the others silently complete as fully delivered no matter what actually
  // happened at the door. Same shared query definition useOrder uses
  // (orderQueryOptions), so this lands on the SAME cache entry as any other
  // screen reading one of these orders — never a second, divergent fetch
  // (mirrors return/index.tsx's existing fan-out).
  const stopOrderIds = useMemo(() => (stop?.orders ?? []).map((o) => o.id), [stop]);
  const { ordersById, ordersLoading } = useQueries({
    queries: stopOrderIds.map((id) => orderQueryOptions(id)),
    combine: (results) => ({
      ordersById: Object.fromEntries(
        stopOrderIds
          .map((id, i) => [id, results[i]?.data] as const)
          .filter((entry): entry is [string, Order] => !!entry[1]),
      ),
      ordersLoading: results.some((r) => r.isLoading),
    }),
  });

  // Per-order RICH lines for rendering (product name) — same adjustability
  // gate as adjust.tsx: not cancelled, nothing already delivered (a
  // reopened, partially-completed stop shouldn't re-offer already-settled
  // lines). Money math is derived SEPARATELY via shortPickLinesFromOrder
  // (the shared, screen-agnostic mapping payment.tsx also uses) since the
  // pure `ShortPickLine` doesn't carry a display name.
  // B785/SA-116: pieces delivered at OTHER visits, off the stop's run snapshot — a second visit
  // is offered (and bounded by) the REMAINING, never the full order.
  // SA-367a: every quantity decision (offered or not, stepper default and ceiling) reads the
  // server's per-line `remaining`; `deliveredSoFar` only prices the remaining money (SA-367b).
  const soFarById = useMemo(() => deliveredSoFarByLine(stop?.orders), [stop]);
  const remainingById = useMemo(() => remainingByLine(stop?.orders), [stop]);
  const linesByOrder = useMemo(() => {
    const map: Record<string, OrderItem[]> = {};
    for (const id of stopOrderIds) map[id] = adjustableLines(ordersById[id], remainingById);
    return map;
  }, [stopOrderIds, ordersById, remainingById]);

  // B648/B762 merge: shortPickLinesFromOrder now carries unitLabel/
  // unitsPerBox/boxes through (see lib/short-pick.ts), so this flattened,
  // multi-order form is both the B762 fan-out AND B648's whole-Case data —
  // no separate inline mapping needed.
  const shortPickLines: ShortPickLine[] = useMemo(
    () =>
      stopOrderIds.flatMap((id) =>
        shortPickLinesFromOrder(ordersById[id], remainingById, soFarById),
      ),
    [stopOrderIds, ordersById, remainingById, soFarById],
  );
  const visitLineById = useMemo(
    () => Object.fromEntries(shortPickLines.map((l) => [l.orderItemId, l])),
    [shortPickLines],
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

  // SA-094b: the ONE normalized plan every reader here must use — the row's
  // displayed qty/badge AND the total, so a stray/un-snapped entry can never
  // show one number on the row and bill a different one (must stay in step
  // with payment.tsx's own normalizedPlan, since both feed the SAME money
  // functions from lib/run-money.ts).
  const normalizedPlan = useMemo(
    () => normalizeDeliveryPlan(shortPickLines, qtyById),
    [shortPickLines, qtyById],
  );

  const total = useMemo(
    () => reconciledTotal(shortPickLines, normalizedPlan),
    [shortPickLines, normalizedPlan],
  );
  const orderedTotal = useMemo(() => reconciledTotal(shortPickLines, {}), [shortPickLines]);
  const anyShort = total < orderedTotal - 0.005;
  // SA-367a: lines the server served no remaining for, still un-entered — Continue waits on them.
  const awaiting = useMemo(
    () => linesAwaitingEntry(shortPickLines, qtyById),
    [shortPickLines, qtyById],
  );

  function handleContinue() {
    if (!stopId || awaiting.length > 0) return;
    for (const [orderItemId, qty] of Object.entries(qtyById)) {
      setPlanQty(stopId, orderItemId, qty);
    }
    router.push(`/route/stop/${stopId}/payment` as any);
  }

  if (activeLoading || runLoading || ordersLoading) {
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
        {(stop?.orders ?? []).map((o) => {
          const lines = linesByOrder[o.id] ?? [];
          if (lines.length === 0) return null;
          return (
            <View key={o.id}>
              {/* Only label sections on an actual multi-order stop — a single
                  order needs no header, matching the pre-B762 screen exactly. */}
              {stopOrderIds.length > 1 ? (
                <Text style={styles.orderHeader}>ORDER {o.orderNumber}</Text>
              ) : null}
              {lines.map((li) => (
                <ShortPickRow
                  key={li.id}
                  li={li}
                  visit={visitLineById[li.id]}
                  soFar={soFarById[li.id] ?? 0}
                  // B648/SA-094b: normalizedPlan is the stop-WIDE snapped map
                  // (item 3 of the B762 adaptation) — every order's rows read
                  // the SAME snapped number the total/badge use, never the
                  // raw qtyById entry.
                  qty={normalizedPlan[li.id] ?? (visitLineById[li.id]?.needsEntry ? 0 : li.qty)}
                  awaitingEntry={awaiting.includes(li.id)}
                  onChangeQty={(q) => setQtyById((m) => ({ ...m, [li.id]: q }))}
                />
              ))}
            </View>
          );
        })}

        <View style={styles.totalBlock}>
          <Text style={styles.totalLabel}>
            EST. TOTAL{anyShort ? " (short — see office invoice for final)" : ""}
          </Text>
          <Text style={styles.totalValue}>${total.toFixed(2)}</Text>
        </View>

        <View style={{ paddingHorizontal: 16 }}>
          {awaiting.length > 0 ? (
            <Text style={styles.hint}>
              Enter how many were delivered for the highlighted{" "}
              {awaiting.length === 1 ? "line" : `${awaiting.length} lines`} to continue.
            </Text>
          ) : null}
          <Pressable
            style={[styles.continueBtn, awaiting.length > 0 ? { opacity: 0.5 } : null]}
            onPress={handleContinue}
            disabled={awaiting.length > 0}
            accessibilityState={{ disabled: awaiting.length > 0 }}
          >
            <Text style={styles.continueBtnText}>
              {canCollect ? "Continue to payment" : "Review & complete"}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function ShortPickRow({
  li,
  visit,
  soFar,
  qty,
  awaitingEntry,
  onChangeQty,
}: {
  li: OrderItem;
  /** This visit's view of the line (B785): ordered = remaining, boxes = Cases remaining. */
  visit?: ShortPickLine;
  /** Pieces already delivered at other visits. */
  soFar: number;
  qty: number;
  /** SA-367a: no server remaining and not entered yet — the stepper shows EMPTY, never a default. */
  awaitingEntry?: boolean;
  onChangeQty: (qty: number) => void;
}) {
  // B785/SA-116: the stepper bound is what THIS visit can still deliver (count − cases delivered
  // so far), read off the per-visit line — identical to the full order on a first visit.
  const ordered = visit?.orderedQty ?? Number(li.qty);
  const type = deliveryTypeForQty(qty, ordered);
  const [draft, setDraft] = useState(awaitingEntry ? "" : String(qty));
  // SA-094/SA-094a: a units_v1 line whose OWN unitsPerBox > 1 gets a
  // whole-Case stepper — its ordered qty is base pieces, and a partial
  // piece count within one Case has no physical meaning. A factor-1 unit
  // line ("Piece") is excluded (isUnitAwareLine requires unitsPerBox > 1)
  // and keeps the ordinary piece stepper below.
  const unitAware = isUnitAwareLine(li);
  const hasUnitLabel = (li.unitLabel ?? "").trim() !== "";
  const unitsPerBox = Number(li.unitsPerBox ?? 0);
  // FIX 6 (SA-175): the STORED count (never derived from the live product) — unit-line-build.ts
  // stores `boxes = count` for a factor>1 unit line. `caseCount` is FLOORED, never rounded: on a
  // second visit `ordered` is the REMAINING qty, which is not always an exact multiple of the
  // Case size — the stepper's top value must be exactly `ordered` (the last, partial step), never
  // a rounded-up Case count that lets "+" send more than remains. `caseRemainderPieces` is what's
  // left over after `caseCount` whole Cases — 0 on a well-formed first visit, but can be nonzero
  // on a second visit (some of a Case may have been delivered at another stop).
  const caseCount =
    visit?.boxes ?? li.boxes ?? (unitsPerBox > 0 ? Math.floor(ordered / unitsPerBox) : 0);
  const caseRemainderPieces = visit?.pieces ?? caseStepperRemainderPieces(ordered, unitsPerBox);
  // Whole Cases the CURRENT qty represents — floored and capped at caseCount, so a qty that
  // includes the partial-Case remainder (i.e. qty === ordered) still shows the right Case count.
  const casesDelivered = unitAware ? caseStepperCasesDelivered(qty, ordered, unitsPerBox) : 0;
  const atFullDelivery = qty >= ordered;
  const casesDeliveredLabel = awaitingEntry
    ? "—"
    : formatCaseStepperSplit(
        casesDelivered,
        atFullDelivery ? caseRemainderPieces : 0,
        li.unitLabel,
      );
  const caseCountLabel = formatCaseStepperSplit(caseCount, caseRemainderPieces, li.unitLabel);

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.cardName} numberOfLines={2}>
            {li.product?.name ?? li.name ?? "Item"}
          </Text>
          <Text style={styles.cardMeta}>
            Ordered{" "}
            {hasUnitLabel ? `${li.boxes ?? Number(li.qty)} ${li.unitLabel}`.trim() : Number(li.qty)}
            {soFar > 0 ? ` · ${hasUnitLabel ? caseCountLabel : ordered} still to deliver` : ""}
          </Text>
        </View>
        {awaitingEntry ? (
          <View style={[styles.badge, styles.badgeShort]}>
            <Text style={styles.badgeText}>Enter qty</Text>
          </View>
        ) : type !== "DELIVERED" ? (
          <View
            style={[styles.badge, type === "REFUSED" ? styles.badgeRefused : styles.badgeShort]}
          >
            <Text style={styles.badgeText}>{type === "REFUSED" ? "Refused" : "Short"}</Text>
          </View>
        ) : null}
      </View>
      {unitAware ? (
        <View style={styles.stepperRow}>
          <Text style={styles.stepperLabel}>
            Cases delivered: {casesDeliveredLabel} of {caseCountLabel}
          </Text>
          <View style={styles.stepper}>
            <Pressable
              style={styles.stepBtn}
              onPress={() => onChangeQty(caseStepperDecrement(qty, ordered, unitsPerBox))}
              hitSlop={6}
              disabled={qty <= 0}
              accessibilityRole="button"
              accessibilityLabel={`One fewer ${li.unitLabel} delivered`}
              accessibilityState={{ disabled: qty <= 0 }}
            >
              <Text style={styles.stepText}>−</Text>
            </Pressable>
            <Text style={styles.qtyInput}>{casesDeliveredLabel}</Text>
            <Pressable
              style={styles.stepBtn}
              onPress={() => onChangeQty(caseStepperIncrement(qty, ordered, unitsPerBox))}
              hitSlop={6}
              disabled={qty >= ordered}
              accessibilityRole="button"
              accessibilityLabel={`One more ${li.unitLabel} delivered`}
              accessibilityState={{ disabled: qty >= ordered }}
            >
              <Text style={styles.stepText}>+</Text>
            </Pressable>
          </View>
        </View>
      ) : (
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
              onBlur={() => setDraft(awaitingEntry ? "" : String(qty))}
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
      )}
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
  orderHeader: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    color: ios.label2,
    letterSpacing: 0.6,
    marginHorizontal: 16,
    marginTop: 18,
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
  // SA-094a review (6): a design token instead of a hard-coded hex.
  badgeRefused: { backgroundColor: ios.system.redWash },
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
