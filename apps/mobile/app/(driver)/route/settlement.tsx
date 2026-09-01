import { useMemo, useRef, useState } from "react";
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
import { useRouteRun, useSettleRun, useUpdateRunStatus } from "../../../lib/api/routes";
import { useRunSettlementStore } from "../../../store/runSettlementStore";
import {
  summarizeCollections,
  computeVariance,
  expectedPhysicalCash,
  isReconciled,
  type CollectedMethod,
  type CollectionEntry,
} from "../../../lib/run-settlement";
import { showToast } from "../../../lib/toast";

// Stable reference — see route/index.tsx's identical EMPTY_COLLECTIONS
// comment (mirrors payment.tsx's EMPTY_DELIVERY_PLAN): a fresh `[]` on every
// selector call defeats useSyncExternalStore's snapshot check.
const EMPTY_COLLECTIONS: CollectionEntry[] = [];

function methodLabel(m: CollectedMethod): string {
  if (m === "CASH") return "Cash";
  if (m === "CHECK") return "Check";
  if (m === "ZELLE") return "Zelle";
  if (m === "CREDIT_CARD") return "Card";
  if (m === "ADVANCE") return "On account";
  return "Other";
}

/**
 * End-of-run cash/check reconciliation (P10-POS-9). Reached from
 * route/index.tsx's "Mark route complete" ONLY when this device recorded at
 * least one cash/check collection this run — a run with nothing physical to
 * reconcile completes directly, unchanged (never adds friction for no reason).
 */
export default function RunSettlementScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ runId: string }>();
  const runId = params.runId;
  const { data: run, isLoading, refetch: refetchRun } = useRouteRun(runId ?? "");

  const collections = useRunSettlementStore((s) =>
    runId ? (s.collectionsByRun[runId] ?? EMPTY_COLLECTIONS) : EMPTY_COLLECTIONS,
  );
  const clearRun = useRunSettlementStore((s) => s.clearRun);
  const summary = useMemo(() => summarizeCollections(collections), [collections]);
  // F05 / R8: server-truth expected cash — this device's own tally is only a
  // fallback for the brief window before `collectedPayments` has loaded. Both
  // sides are the same basis (CASH + CHECK, the physical money this screen's
  // label asks the driver to count); `collectedPayments` splits cash and checks,
  // so reading `cashTotal` alone would drop every check and invent a variance.
  const expectedCash = expectedPhysicalCash(run?.collectedPayments) ?? summary.cashTotal;

  const [counted, setCounted] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const countedNum = Number(counted) || 0;
  const variance = computeVariance(expectedCash, countedNum);
  const reconciled = counted !== "" && isReconciled(variance);
  // The server recomputes `expected` at settle time, so its variance can differ
  // from this screen's: a CONFIRMED payment landing between the run fetch and
  // the POST (an office operator recording a walk-in payment, or an offline
  // completeWithPayment replaying) moves the server figure only. That 400 would
  // otherwise be unrecoverable — the reason field is gated on the CLIENT
  // variance, so it would never render and every retry would re-400. The catch
  // in closeRun latches this, which forces the field open regardless.
  const [serverDemandsReason, setServerDemandsReason] = useState(false);
  const needsReason = (counted !== "" && !isReconciled(variance)) || serverDemandsReason;

  const settleRun = useSettleRun();
  const updateStatus = useUpdateRunStatus();
  // Set once the settlement is on record server-side — see closeRun.
  const settledRef = useRef(false);

  async function closeRun() {
    if (!runId || !run) return;
    if (counted === "") {
      setError("Enter the cash & checks you counted.");
      return;
    }
    if (needsReason && reason.trim() === "") {
      setError("Enter a reason for the variance before closing.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      // F05 / R6 / R8: the server records the settlement (expected computed
      // server-side, never trusted from the client) into its own
      // settlementNote/settlementVariance columns — no more notes-append PATCH.
      //
      // The settlement and the COMPLETED flip are two non-atomic writes: if the
      // settlement lands and the status flip fails, the driver stays here to
      // retry — and the server refuses a DRIVER's SECOND settle, which would
      // dead-end the run on this screen. So a retry re-runs ONLY the status
      // flip: `settledRef` remembers this attempt, `run.settlementNote` covers
      // a settlement recorded before this screen mounted, and the server's own
      // RUN_ALREADY_SETTLED refusal covers a settle whose response was lost.
      if (!settledRef.current && run.settlementNote == null) {
        try {
          await settleRun.mutateAsync({
            id: runId,
            countedCash: countedNum,
            varianceReason: needsReason ? reason : undefined,
          });
        } catch (e: any) {
          if (e?.response?.data?.code !== "RUN_ALREADY_SETTLED") throw e;
        }
        settledRef.current = true;
      } else {
        // Skipping the settle is never silent: a driver amends only through an
        // operator, so say so rather than let a re-typed count look recorded.
        showToast("Settlement already recorded — closing the run.");
      }
      await updateStatus.mutateAsync({ id: runId, status: "COMPLETED" });
      clearRun(runId);
      router.replace("/(driver)/route");
    } catch (e: any) {
      setSaving(false);
      const message = e?.response?.data?.message ?? e?.message ?? "Couldn't close the run.";
      // The server refused because ITS expected figure disagrees with this
      // screen's (a payment landed since the run was fetched). Latch the reason
      // field open — it is gated on the client variance and would otherwise stay
      // hidden — and refetch so the expected line stops showing a stale total.
      if (typeof message === "string" && message.includes("varianceReason")) {
        setServerDemandsReason(true);
        setError("The expected amount changed — add a reason for the variance and close again.");
        refetchRun();
        return;
      }
      showToast(message || "Couldn't close the run. Try again.");
    }
  }

  if (isLoading || !run) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Run settlement"
          leading={<NavBackButton label="Route" onPress={() => router.back()} />}
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
        inlineTitle="Run settlement"
        leading={<NavBackButton label="Route" onPress={() => router.back()} />}
      />
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.caption}>
          Collected on this device during this run — {summary.count} payment
          {summary.count === 1 ? "" : "s"}.
        </Text>

        <View style={styles.card}>
          {(["CASH", "CHECK", "ZELLE", "CREDIT_CARD", "ADVANCE", "OTHER"] as const)
            .filter((m) => summary.byMethod[m])
            .map((m) => (
              <View key={m} style={styles.row}>
                <Text style={styles.rowLabel}>{methodLabel(m)}</Text>
                <Text style={styles.rowValue}>${(summary.byMethod[m] ?? 0).toFixed(2)}</Text>
              </View>
            ))}
          <View style={[styles.row, styles.rowTotal]}>
            <Text style={styles.rowTotalLabel}>Cash & checks to reconcile</Text>
            <Text style={styles.rowTotalValue}>${expectedCash.toFixed(2)}</Text>
          </View>
        </View>

        <Text style={styles.fieldLabel}>Counted cash & checks</Text>
        <TextInput
          style={styles.input}
          placeholder="0.00"
          placeholderTextColor={ios.label3}
          keyboardType="decimal-pad"
          value={counted}
          onChangeText={setCounted}
        />

        {counted !== "" ? (
          <View style={[styles.varianceBox, reconciled ? styles.varianceOk : styles.varianceOff]}>
            <Text style={styles.varianceText}>
              {reconciled
                ? "Reconciled"
                : `Variance ${variance > 0 ? "+" : ""}$${variance.toFixed(2)}`}
            </Text>
          </View>
        ) : null}

        {needsReason ? (
          <>
            <Text style={styles.fieldLabel}>Reason for the variance</Text>
            <TextInput
              style={[styles.input, styles.inputMultiline]}
              placeholder="e.g. gave $5 change from my own pocket"
              placeholderTextColor={ios.label3}
              value={reason}
              onChangeText={setReason}
              multiline
            />
          </>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable
          style={[styles.closeBtn, saving && styles.closeBtnDisabled]}
          onPress={saving ? undefined : closeRun}
          disabled={saving}
        >
          <Text style={styles.closeBtnText}>{saving ? "Closing…" : "Close run"}</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  caption: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginBottom: 10 },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14, gap: 8, marginBottom: 18 },
  row: { flexDirection: "row", justifyContent: "space-between" },
  rowLabel: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label2 },
  rowValue: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  rowTotal: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
    paddingTop: 8,
    marginTop: 4,
  },
  rowTotalLabel: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  rowTotalValue: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  fieldLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label2, marginBottom: 6 },
  input: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    marginBottom: 14,
  },
  inputMultiline: {
    minHeight: 70,
    textAlignVertical: "top",
    fontFamily: "Inter_400Regular",
    fontSize: 14,
  },
  varianceBox: { borderRadius: 10, padding: 10, marginBottom: 14, alignItems: "center" },
  varianceOk: { backgroundColor: ios.system.greenWash },
  varianceOff: { backgroundColor: "#FEE2E2" },
  varianceText: { fontSize: 14, fontFamily: "Inter_700Bold", color: ios.label },
  error: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.system.red, marginBottom: 10 },
  closeBtn: {
    backgroundColor: ios.system.green,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
  },
  closeBtnDisabled: { opacity: 0.55 },
  closeBtnText: { color: "#fff", fontSize: 17, fontFamily: "Inter_600SemiBold" },
});
