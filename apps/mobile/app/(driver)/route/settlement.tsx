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
import { useRouteRun, useUpdateRun, useUpdateRunStatus } from "../../../lib/api/routes";
import { useAuthStore } from "../../../lib/auth-store";
import { useRunSettlementStore } from "../../../store/runSettlementStore";
import {
  summarizeCollections,
  computeVariance,
  isReconciled,
  buildSettlementNote,
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
  const { data: run, isLoading } = useRouteRun(runId ?? "");
  const user = useAuthStore((s) => s.user);

  const collections = useRunSettlementStore((s) =>
    runId ? (s.collectionsByRun[runId] ?? EMPTY_COLLECTIONS) : EMPTY_COLLECTIONS,
  );
  const clearRun = useRunSettlementStore((s) => s.clearRun);
  const summary = useMemo(() => summarizeCollections(collections), [collections]);

  const [counted, setCounted] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const countedNum = Number(counted) || 0;
  const variance = computeVariance(summary.cashTotal, countedNum);
  const reconciled = counted !== "" && isReconciled(variance);
  const needsReason = counted !== "" && !isReconciled(variance);

  const updateRun = useUpdateRun();
  const updateStatus = useUpdateRunStatus();
  // The note append and the status flip are two separate, non-transactional
  // PATCHes. Once the note write has succeeded we must never send it again —
  // otherwise a failure on the status write (which leaves us on this screen for
  // a retry) would append a SECOND settlement note, because both mutations
  // invalidate the route-runs query and `run.notes` is refetched with the first
  // note already present. Guarded so a retry re-runs ONLY the status mutation.
  const notesAppendedRef = useRef(false);

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
    const driverLabel = user?.username ?? "Driver";
    const note =
      buildSettlementNote({
        expectedCash: summary.cashTotal,
        countedCash: countedNum,
        variance,
        overridden: needsReason,
        driverLabel,
      }) + (needsReason ? ` Reason: ${reason.trim()}` : "");
    try {
      // NOTE: `RouteRun` (lib/api/routes.ts) doesn't declare a `notes` field on
      // the run itself (only on RouteRunStop/RouteRunOrder) — the server does
      // accept/return it (see plan §2.3), the mobile type just hasn't caught
      // up. Read via `any` rather than widening that shared type here.
      if (!notesAppendedRef.current) {
        const existingNotes = (run as any).notes ?? "";
        await updateRun.mutateAsync({ id: runId, notes: existingNotes + note } as any);
        notesAppendedRef.current = true;
      }
      await updateStatus.mutateAsync({ id: runId, status: "COMPLETED" });
      clearRun(runId);
      router.replace("/(driver)/route");
    } catch (e: any) {
      setSaving(false);
      showToast(e?.response?.data?.message ?? e?.message ?? "Couldn't close the run. Try again.");
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
            <Text style={styles.rowTotalValue}>${summary.cashTotal.toFixed(2)}</Text>
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
