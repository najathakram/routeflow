import { useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavAction, NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { BarcodeFab } from "../../../components/BarcodeFab";
import { ProductPickerSheet } from "../../../components/ProductPickerSheet";
import { resolveProductByCode } from "../../../lib/barcode-resolve";
import { sanitizeIntInput } from "../../../lib/qty";
import { showToast } from "../../../lib/toast";
import { confirm } from "../../../lib/confirm";
import type { ScanOutcome } from "../../../lib/scan-loop";
import {
  addScanToRows,
  buildCommitItems,
  changedRowCount,
  newSessionId,
  rowVariance,
  type StockCountMode,
  type StockCountRow,
} from "../../../lib/stock-count-logic";
import { useCommitStockCount } from "../../../lib/api/stock-count";

export default function StockCountScreen() {
  const router = useRouter();
  const [rows, setRows] = useState<StockCountRow[]>([]);
  const [qtyPerScan, setQtyPerScan] = useState(1);
  const [defaultMode, setDefaultMode] = useState<StockCountMode>("REPLACE");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const commitMut = useCommitStockCount();

  // Refs so the (possibly ref-cached) scan handler always reads the latest
  // per-scan qty + mode without restarting the camera.
  const qtyRef = useRef(qtyPerScan);
  qtyRef.current = qtyPerScan;
  const modeRef = useRef(defaultMode);
  modeRef.current = defaultMode;

  const addProduct = (p: {
    id: string;
    name: string;
    sku?: string | null;
    unit?: string | null;
    currentStock?: number | string | null;
  }) => setRows((prev) => addScanToRows(prev, p, qtyRef.current, modeRef.current));

  const handleScanned = async (code: string): Promise<ScanOutcome> => {
    const res = await resolveProductByCode(code);
    if (res.notFound || !res.product) {
      return { feedback: { kind: "error", text: `No product for "${code.trim()}"` } };
    }
    addProduct(res.product);
    return { feedback: { kind: "added", text: `Counted ${res.product.name}` } };
  };

  const setCounted = (productId: string, counted: number) =>
    setRows((prev) =>
      prev.map((r) => (r.productId === productId ? { ...r, counted: Math.max(0, counted) } : r)),
    );
  const setMode = (productId: string, mode: StockCountMode) =>
    setRows((prev) => prev.map((r) => (r.productId === productId ? { ...r, mode } : r)));
  const removeRow = (productId: string) =>
    setRows((prev) => prev.filter((r) => r.productId !== productId));

  const changed = changedRowCount(rows);

  const onCommit = () => {
    if (rows.length === 0) return;
    commitMut.mutate(
      {
        sessionId: newSessionId(),
        items: buildCommitItems(rows),
        notes: notes.trim() || undefined,
      },
      {
        onSuccess: (r) => {
          showToast(
            `Count committed — ${r.applied} updated${r.skipped ? `, ${r.skipped} unchanged` : ""}`,
          );
          setRows([]);
          setNotes("");
          setReviewOpen(false);
          router.back();
        },
        onError: (e: any) =>
          showToast(e?.response?.data?.message ?? e?.message ?? "Couldn't commit the count."),
      },
    );
  };

  const onBack = () => {
    if (rows.length > 0) {
      confirm(
        "Discard this count?",
        `${rows.length} counted line${rows.length === 1 ? "" : "s"} will be lost.`,
        () => router.back(),
        { confirmText: "Discard", destructive: true },
      );
      return;
    }
    router.back();
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Stock count"
        leading={<NavBackButton label="Warehouse" onPress={onBack} />}
        trailing={
          rows.length > 0 ? (
            <NavAction label="Review" bold onPress={() => setReviewOpen(true)} />
          ) : undefined
        }
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: 16, gap: 14 }}
      >
        {/* Scan defaults */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Scan settings</Text>
          <View style={styles.settingRow}>
            <Text style={styles.settingLabel}>Per scan</Text>
            <View style={styles.stepper}>
              <Pressable
                style={styles.stepBtn}
                onPress={() => setQtyPerScan((q) => Math.max(1, q - 1))}
              >
                <Text style={styles.stepBtnText}>−</Text>
              </Pressable>
              <Text style={styles.stepQty}>{qtyPerScan}</Text>
              <Pressable style={styles.stepBtn} onPress={() => setQtyPerScan((q) => q + 1)}>
                <Text style={styles.stepBtnText}>+</Text>
              </Pressable>
            </View>
          </View>
          <View style={styles.settingRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.settingLabel}>New rows: set on-hand</Text>
              <Text style={styles.settingHint}>
                On = &quot;set to counted&quot; (REPLACE). Off = &quot;add to on-hand&quot; (ADD).
              </Text>
            </View>
            <Switch
              value={defaultMode === "REPLACE"}
              onValueChange={(v) => setDefaultMode(v ? "REPLACE" : "ADD")}
              trackColor={{ true: ios.brand }}
            />
          </View>
          <Pressable style={styles.addBtn} onPress={() => setPickerOpen(true)}>
            <Ionicons name="add-circle-outline" size={16} color={ios.brand} />
            <Text style={styles.addBtnText}>Add product manually</Text>
          </Pressable>
        </View>

        {/* Counted rows */}
        {rows.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="scan-outline" size={26} color={ios.label3} />
            <Text style={styles.emptyText}>
              Scan items with the camera button, or add them manually. Each scan adds {qtyPerScan}.
            </Text>
          </View>
        ) : (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>
                {rows.length} line{rows.length === 1 ? "" : "s"} · {changed} to change
              </Text>
            </View>
            {rows.map((r, i) => {
              const { delta, after } = rowVariance(r);
              return (
                <View
                  key={r.productId}
                  style={[
                    styles.row,
                    i > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: ios.separator,
                    },
                  ]}
                >
                  <View style={styles.rowHead}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {r.name}
                    </Text>
                    <Pressable onPress={() => removeRow(r.productId)} hitSlop={8}>
                      <Ionicons name="trash-outline" size={16} color={ios.system.redInk} />
                    </Pressable>
                  </View>
                  <View style={styles.rowBody}>
                    <View style={styles.stepper}>
                      <Pressable
                        style={styles.stepBtn}
                        onPress={() => setCounted(r.productId, r.counted - 1)}
                      >
                        <Text style={styles.stepBtnText}>−</Text>
                      </Pressable>
                      <TextInput
                        style={styles.countInput}
                        value={String(r.counted)}
                        onChangeText={(v) =>
                          setCounted(r.productId, Number(sanitizeIntInput(v)) || 0)
                        }
                        keyboardType="number-pad"
                      />
                      <Pressable
                        style={styles.stepBtn}
                        onPress={() => setCounted(r.productId, r.counted + 1)}
                      >
                        <Text style={styles.stepBtnText}>+</Text>
                      </Pressable>
                    </View>
                    <Pressable
                      style={styles.modeChip}
                      onPress={() => setMode(r.productId, r.mode === "REPLACE" ? "ADD" : "REPLACE")}
                    >
                      <Text style={styles.modeChipText}>
                        {r.mode === "REPLACE" ? "Set to" : "Add"}
                      </Text>
                    </Pressable>
                  </View>
                  <Text style={styles.rowVariance}>
                    {r.stockBefore} → {after}{" "}
                    <Text
                      style={{
                        color:
                          delta > 0
                            ? ios.system.greenInk
                            : delta < 0
                              ? ios.system.redInk
                              : ios.label3,
                      }}
                    >
                      ({delta >= 0 ? "+" : ""}
                      {delta})
                    </Text>
                    {r.unit ? ` ${r.unit}` : ""}
                  </Text>
                </View>
              );
            })}
          </View>
        )}
        <View style={{ height: 80 }} />
      </ScrollView>

      {rows.length > 0 ? (
        <View style={styles.footer}>
          <Pressable style={styles.reviewBtn} onPress={() => setReviewOpen(true)}>
            <Text style={styles.reviewBtnText}>
              Review &amp; commit ({changed} change{changed === 1 ? "" : "s"})
            </Text>
            <Ionicons name="arrow-forward" size={16} color="#fff" />
          </Pressable>
        </View>
      ) : null}

      <BarcodeFab continuous onScanned={handleScanned} hidden={pickerOpen || reviewOpen} />

      <ProductPickerSheet
        visible={pickerOpen}
        title="Add to count"
        onClose={() => setPickerOpen(false)}
        onSelect={(p) => {
          addProduct(p);
          setPickerOpen(false);
        }}
      />

      <ReviewModal
        open={reviewOpen}
        rows={rows}
        notes={notes}
        onNotes={setNotes}
        committing={commitMut.isPending}
        onClose={() => setReviewOpen(false)}
        onCommit={onCommit}
      />
    </SafeAreaView>
  );
}

function ReviewModal({
  open,
  rows,
  notes,
  onNotes,
  committing,
  onClose,
  onCommit,
}: {
  open: boolean;
  rows: StockCountRow[];
  notes: string;
  onNotes: (v: string) => void;
  committing: boolean;
  onClose: () => void;
  onCommit: () => void;
}) {
  const changed = changedRowCount(rows);
  return (
    <Modal visible={open} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Review count"
          leading={<NavBackButton label="Back" onPress={onClose} />}
        />
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
          <Text style={styles.reviewSummary}>
            {changed} of {rows.length} line{rows.length === 1 ? "" : "s"} will change stock.
            Unchanged lines are skipped.
          </Text>
          <View style={styles.card}>
            {rows.map((r, i) => {
              const { delta, after } = rowVariance(r);
              return (
                <View
                  key={r.productId}
                  style={[
                    styles.reviewRow,
                    i > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: ios.separator,
                    },
                  ]}
                >
                  <Text style={styles.reviewName} numberOfLines={1}>
                    {r.name}
                  </Text>
                  <Text style={styles.reviewDelta}>
                    {r.stockBefore} → {after}{" "}
                    <Text
                      style={{
                        color:
                          delta > 0
                            ? ios.system.greenInk
                            : delta < 0
                              ? ios.system.redInk
                              : ios.label3,
                      }}
                    >
                      ({delta >= 0 ? "+" : ""}
                      {delta})
                    </Text>
                  </Text>
                </View>
              );
            })}
          </View>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Notes (optional)</Text>
            <TextInput
              style={styles.notesInput}
              value={notes}
              onChangeText={onNotes}
              placeholder="e.g. Monthly count — aisle 3"
              placeholderTextColor={ios.label3}
              multiline
            />
          </View>
          <Pressable
            style={[styles.commitBtn, committing && { opacity: 0.5 }]}
            disabled={committing}
            onPress={onCommit}
          >
            <Text style={styles.commitBtnText}>{committing ? "Committing…" : "Commit count"}</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14 },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, marginBottom: 8 },
  settingRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 },
  settingLabel: { flex: 1, fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  settingHint: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 8 },
  addBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.brand },
  empty: { alignItems: "center", gap: 10, paddingVertical: 40, paddingHorizontal: 20 },
  emptyText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
  },
  row: { paddingVertical: 12, gap: 8 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  rowName: { flex: 1, fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  rowBody: { flexDirection: "row", alignItems: "center", gap: 10 },
  stepper: { flexDirection: "row", alignItems: "center", gap: 8 },
  stepBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: ios.fill3,
    alignItems: "center",
    justifyContent: "center",
  },
  stepBtnText: { fontSize: 20, fontFamily: "Inter_600SemiBold", color: ios.label },
  stepQty: {
    minWidth: 28,
    textAlign: "center",
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
  },
  countInput: {
    width: 60,
    height: 34,
    backgroundColor: ios.fill3,
    borderRadius: 8,
    textAlign: "center",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
  },
  modeChip: {
    backgroundColor: ios.brandWash,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  modeChipText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.brand },
  rowVariance: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
    fontVariant: ["tabular-nums"],
  },
  footer: {
    padding: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
    backgroundColor: ios.bg,
  },
  reviewBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingVertical: 15,
  },
  reviewBtnText: { color: "#fff", fontSize: 16, fontFamily: "Inter_600SemiBold" },
  reviewSummary: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  reviewRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 },
  reviewName: { flex: 1, fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  reviewDelta: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  notesInput: {
    minHeight: 60,
    backgroundColor: ios.fill3,
    borderRadius: 10,
    padding: 12,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    textAlignVertical: "top",
  },
  commitBtn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
  },
  commitBtnText: { color: "#fff", fontSize: 16, fontFamily: "Inter_600SemiBold" },
});
