import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
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
import { orderQueryOptions } from "../../../../../../lib/api/orders";
import { showToast } from "../../../../../../lib/toast";
import { sumStopOrders } from "../../../../../../lib/run-money";
import {
  pendingReturnPayloads,
  submittedReturnKey,
  summarizeSubmissions,
  toUndeliveredStop,
  undeliveredReturnLines,
  undeliveredRowKey,
  type ReturnSubmissionResult,
  type UndeliveredReturnPayload,
  type UndeliveredReturnRow,
} from "../../../../../../lib/returns-logic";
import { returnSubmitKey } from "../../../../../../lib/return-submit-key";
import { useReturnSubmissionStore } from "../../../../../../store/returnSubmissionStore";

/** Display label for a row's derived reason (REG-B128 assigns the reason from the
 * mutation type, not a driver-picked chip — see `returns-logic.ts`). */
const REASON_LABELS: Record<ReturnReason, string> = {
  DAMAGED: "Damaged",
  WRONG_ITEM: "Wrong SKU",
  CUSTOMER_REFUSED: "Refused",
  QUALITY_ISSUE: "Quality",
  EXCESS_ORDER: "Partial",
};

function productNameFor(stop: RouteRunStop, productId: string): string {
  if (!productId) return "Item";
  for (const order of stop.orders ?? []) {
    const li = (order.lineItems ?? []).find((l) => l.productId === productId);
    if (li?.product?.name) return li.product.name;
  }
  return "Item";
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
  const { data: activeData } = useActiveRouteRun();
  const runId = params.runId ?? activeData?.data?.[0]?.id;
  const { data: run, isLoading } = useRouteRun(runId ?? "");
  const stop = useMemo(() => run?.stops?.find((s) => s.id === stopId), [run, stopId]);

  // REG-B50: the run read path carries no `promoFreeUnits`, so the credit math
  // would price a boxed BOGO line's free units as if the customer had paid for
  // them. Source the promo/box facts from the order detail exactly the way
  // payment.tsx / short-pick.tsx do — same shared query definition, so this is
  // the SAME cache entry, never a second divergent fetch.
  const stopOrderIds = useMemo(() => (stop?.orders ?? []).map((o) => o.id), [stop]);
  const { lineExtras, extrasReady, extrasFailed, retryExtras } = useQueries({
    queries: stopOrderIds.map((id) => orderQueryOptions(id)),
    combine: (results) => {
      const map: Record<string, { promoFreeUnits?: number | null; unitsPerBox?: number | null }> =
        {};
      for (const r of results) {
        for (const li of r.data?.lineItems ?? []) {
          map[li.id] = {
            promoFreeUnits: li.promoFreeUnits ?? 0,
            unitsPerBox: li.unitsPerBox ?? li.product?.unitsPerBox ?? null,
          };
        }
      }
      return {
        lineExtras: map,
        extrasReady: results.every((r) => r.isSuccess),
        // A failed order query is sticky until a refetch — an order attached to
        // another driver's run 403s outright, not transiently — so the gate needs
        // a visible error + retry, not a "try again in a moment" toast that never
        // comes true.
        extrasFailed: results.some((r) => r.isError),
        retryExtras: () => {
          for (const r of results) {
            if (r.isError) void r.refetch();
          }
        },
      };
    },
  });

  // Per-row "damaged in transit" overrides, keyed by `undeliveredRowKey`. A
  // GLOBAL reason chip is deliberately not offered — it would overwrite every
  // row's derived reason; this flips one row to DAMAGED / no-restock so refused
  // goods that came back broken are not put back into sellable stock (B61).
  const [damagedKeys, setDamagedKeys] = useState<ReadonlySet<string>>(() => new Set<string>());
  const toggleDamaged = (key: string) =>
    setDamagedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // REG-B128: ONE call derives the rows, the credit total, and the per-order
  // create payloads — they can never drift apart the way the old ad hoc
  // qty * unitPrice / quantityDelivered math did.
  const {
    rows,
    total: creditTotal,
    payloads,
    unlistedCount,
  } = useMemo(() => {
    if (!stop) {
      return {
        rows: [] as UndeliveredReturnRow[],
        total: 0,
        payloads: [] as UndeliveredReturnPayload[],
        unlistedCount: 0,
      };
    }
    return undeliveredReturnLines(toUndeliveredStop(stop, lineExtras), { damagedKeys });
  }, [stop, lineExtras, damagedKeys]);
  const createReturn = useCreateReturn();
  // Orders whose return has already landed — a retry must never re-POST one
  // (the server would either duplicate it or reject the whole batch on its
  // cumulative over-return guard, hiding the orders that did succeed).
  // REG-DRIVER-DUR-B: persisted (store/returnSubmissionStore.ts, keyed
  // `stopId:orderId`) rather than plain useState — an offline-queued return
  // that reached the queue but whose confirmation the driver never saw must
  // survive an app kill, or the identical return gets re-derived and
  // resubmitted on the next launch, double-crediting the customer.
  const submitted = useReturnSubmissionStore((s) => s.submitted);

  const issue = () => {
    if (!stop) return;
    // The promo/box facts arrive from the order detail, not the run read (REG-B50).
    // Submitting before they land would price a boxed BOGO line's free units as if
    // the customer had paid for them — the credit would be wrong, and it is minted
    // server-side, so wait rather than send.
    if (!extrasReady) {
      showToast("Still loading line pricing — try again in a moment.");
      return;
    }
    if (payloads.length === 0) {
      showToast("Mark items as partial or refused first.");
      return;
    }
    const pending = pendingReturnPayloads(payloads, submitted, stopId);
    // REG-RETURNS-IDEM-2: `markSubmitted` writes to a PERSISTED store and nothing ever unmarks
    // it, so a return that only ever reached the OFFLINE QUEUE and then hard-failed at drain
    // used to bounce the driver silently back to the stop forever, with no return on record and
    // no way to re-issue it. Every POST now carries `returnSubmitKey` keyed on a per-attempt
    // nonce (F1, independent review): a retry of ONE pending attempt (offline-queue drain, an
    // app kill mid-request, this same "reissue" tap before any of it landed) reuses the SAME
    // nonce and collapses server-side onto one return — but once an attempt actually lands, its
    // nonce is cleared (markSubmitted below), so tapping Issue again for the same stop+order
    // — a genuinely NEW return, not a retry — mints a fresh nonce and creates a genuinely new
    // return instead of silently replaying the old one.
    const reissue = pending.length === 0;
    const toSend = reissue ? payloads : pending;
    Promise.allSettled(
      toSend.map((p) => {
        const nonce = useReturnSubmissionStore
          .getState()
          .getOrCreateNonce(submittedReturnKey(stopId, p.orderId));
        return createReturn.mutateAsync({
          ...p,
          idempotencyKey: returnSubmitKey(stopId, p, nonce),
        });
      }),
    ).then((settled) => {
      const results: ReturnSubmissionResult[] = settled.map((s, i) => {
        const orderId = toSend[i]!.orderId;
        if (s.status === "fulfilled") return { orderId, ok: true };
        const e = s.reason as any;
        return {
          orderId,
          ok: false,
          // REG-B307: carry the offline-queue flag through to summarizeSubmissions.
          isOfflineQueued: e?.isOfflineQueued === true,
          message: e?.response?.data?.message ?? e?.message ?? "",
        };
      });
      // REG-B308: `queued` is always an array now (empty when nothing
      // queued), so no default is needed here.
      const { done, failed, queued } = summarizeSubmissions(results);
      if (done.length > 0 || queued.length > 0) {
        for (const id of [...done, ...queued]) {
          useReturnSubmissionStore.getState().markSubmitted(stopId, id);
        }
      }
      if (failed.length === 0) {
        // REG-B307: a queued return is a pending success, not a failure.
        showToast(
          queued.length > 0
            ? "Offline — return queued and will sync when you reconnect"
            : reissue
              ? "Return re-sent"
              : "Return submitted",
        );
        backToStop();
        return;
      }
      showToast(`${failed[0]!.message} (${failed.length} order(s) still to send)`);
    });
  };
  const customerName = stop?.customer?.businessName ?? "Stop";
  const orderNumber = stop?.orders?.[0]?.orderNumber;
  // REG-B49 (spec R2): box-aware line money, never qty * unitPrice.
  const originalTotal = stop ? sumStopOrders(stop) : 0;

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
            {rows.map((r) => {
              const key = undeliveredRowKey(r.orderId, r.lineItemId);
              const damaged = damagedKeys.has(key);
              return (
                <View key={key} style={styles.returnRow}>
                  <View style={styles.returnIcon}>
                    <Ionicons name="trash-outline" size={16} color={ios.system.red} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={styles.returnTopRow}>
                      <Text style={styles.returnName}>{productNameFor(stop!, r.productId)}</Text>
                      <Text style={styles.returnAmt}>−${r.amount.toFixed(2)}</Text>
                    </View>
                    <Text style={styles.returnSub}>
                      × {r.qty} · {REASON_LABELS[r.reason]}
                    </Text>
                    <View style={styles.rowChips}>
                      <Pressable
                        style={[styles.reasonChip, damaged && styles.reasonChipActive]}
                        onPress={() => toggleDamaged(key)}
                      >
                        <Text style={[styles.reasonText, damaged && styles.reasonTextActive]}>
                          Damaged
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                </View>
              );
            })}
          </ListGroup>
        )}

        {unlistedCount > 0 ? (
          <View style={styles.emptyInline}>
            <Text style={styles.emptyInlineText}>
              {unlistedCount} unlisted line(s) cannot be returned here — ask the office.
            </Text>
          </View>
        ) : null}

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
          {extrasFailed ? (
            <View style={styles.errorInline}>
              <Text style={styles.errorInlineText}>
                Line pricing failed to load for this stop — submitting now could credit the wrong
                amount.
              </Text>
              <Pressable style={styles.retryBtn} onPress={retryExtras}>
                <Text style={styles.retryBtnText}>Retry</Text>
              </Pressable>
            </View>
          ) : null}
          <Pressable
            style={[
              styles.primaryBtn,
              (rows.length === 0 || !extrasReady || createReturn.isPending) &&
                styles.primaryBtnDisabled,
            ]}
            disabled={rows.length === 0 || !extrasReady || createReturn.isPending}
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
  errorInline: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    backgroundColor: ios.system.redWash,
    borderRadius: 12,
    gap: 10,
  },
  errorInlineText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.system.red,
  },
  retryBtn: { alignSelf: "flex-start" },
  retryBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.brand },
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
  /** Per-row override chips (the damaged toggle) — no global reason picker. */
  rowChips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
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
