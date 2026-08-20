import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
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
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavAction, NavBackButton, NavBar, Pill, type PillVariant } from "@routeflow/ui/mobile/ios";
import { BarcodeFab } from "../../../../components/BarcodeFab";
import { ProductPickerSheet } from "../../../../components/ProductPickerSheet";
import { InlineCreateProductSheet } from "../../../../components/InlineCreateProductSheet";
import { resolveProductByCode } from "../../../../lib/barcode-resolve";
import { sanitizeIntInput } from "../../../../lib/qty";
import { showToast } from "../../../../lib/toast";
import { confirm, chooseAction } from "../../../../lib/confirm";
import { scanHaptic } from "../../../../lib/haptics";
import { fmtCurrency, fmtDate } from "../../../../utils/format";
import type { ScanOutcome } from "../../../../lib/scan-loop";
import {
  buildRowCommitSummary,
  groupRowsByVariance,
  hydrateRowsFromSession,
  rowEditPatch,
  rowVariance,
  rowVarianceMoney,
  type StockCountMode,
  type StockCountRow,
  type StockCountSessionStatus,
} from "../../../../lib/stock-count-logic";
import {
  isEditableStockCountStatus,
  useCommitStockCountSession,
  useDiscardStockCountSession,
  useStartStockCount,
  useStockCountSession,
  useRemoveStockCountLine,
  useUpsertStockCountLine,
} from "../../../../lib/api/stock-count";
import { useStockCountAutosave } from "../../../../lib/stock-count-autosave";
import { useUpdateProduct, type CreatedProduct } from "../../../../lib/api/products";

interface UndoEntry {
  productId: string;
  amount: number;
  wasNewRow: boolean;
}

const STATUS_PILL: Record<StockCountSessionStatus, PillVariant> = {
  OPEN: "brand",
  REVIEW: "orange",
  COMMITTED: "green",
  DISCARDED: "gray",
};

export default function StockCountSessionScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const sessionQuery = useStockCountSession(id);
  const session = sessionQuery.data;
  const editable = session ? isEditableStockCountStatus(session.status) : false;

  const [rows, setRows] = useState<StockCountRow[]>([]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const hydratedRef = useRef(false);

  const [qtyPerScan, setQtyPerScan] = useState(1);
  const [defaultMode, setDefaultMode] = useState<StockCountMode>("REPLACE");
  const qtyRef = useRef(qtyPerScan);
  qtyRef.current = qtyPerScan;
  const modeRef = useRef(defaultMode);
  modeRef.current = defaultMode;

  const [pickerOpen, setPickerOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [createSheet, setCreateSheet] = useState<{ code?: string } | null>(null);
  const [attachCode, setAttachCode] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);

  const upsertLineMut = useUpsertStockCountLine(id);
  const removeLineMut = useRemoveStockCountLine(id);
  const commitMut = useCommitStockCountSession(id);
  const discardMut = useDiscardStockCountSession();
  const amendMut = useStartStockCount();
  const updateProductMut = useUpdateProduct();

  /** Fold a successful line write's server truth back into the row (fresh
   * averageCost/currentStock, server-recomputed boxes/pieces from a split). */
  const mergeServerLine = (serverLine: {
    productId: string;
    mode: StockCountMode;
    countedQty: number | string;
    boxes?: number | null;
    pieces?: number | null;
    expectedQty: number | string;
    unitCostOverride?: number | string | null;
    product: { unitsPerBox?: number | null; averageCost?: number | string | null };
  }) => {
    setRows((prev) =>
      prev.map((r) =>
        r.productId === serverLine.productId
          ? {
              ...r,
              stockBefore: Number(serverLine.expectedQty),
              counted: Number(serverLine.countedQty),
              mode: serverLine.mode,
              boxes: serverLine.boxes ?? undefined,
              pieces: serverLine.pieces ?? undefined,
              unitsPerBox: serverLine.product.unitsPerBox ?? r.unitsPerBox,
              unitCostOverride:
                serverLine.unitCostOverride != null
                  ? Number(serverLine.unitCostOverride)
                  : r.unitCostOverride,
              averageCost:
                serverLine.product.averageCost != null
                  ? Number(serverLine.product.averageCost)
                  : r.averageCost,
            }
          : r,
      ),
    );
  };

  const autosave = useStockCountAutosave({
    upsertLine: (payload) =>
      upsertLineMut.mutateAsync(payload).then((line) => {
        mergeServerLine(line as any);
        return line;
      }),
    removeLine: (productId) => removeLineMut.mutateAsync(productId),
    onError: () => showToast("Couldn't save a counted line — will retry"),
  });

  // Hydrate local rows from the server ONCE (a background refetch while the
  // operator is mid-count must never clobber their in-progress edits).
  useEffect(() => {
    if (hydratedRef.current || !session) return;
    setRows(hydrateRowsFromSession(session.lines));
    setNotes(session.notes ?? "");
    hydratedRef.current = true;
  }, [session]);

  // Flush on background/inactive — a call that dropped mid-flight, plus
  // anything still sitting in the debounce window, gets a chance to land
  // before the OS suspends the JS thread.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") void autosave.flush();
    });
    return () => sub.remove();
  }, [autosave.flush]);

  // Best-effort final flush on unmount (swipe-back, tab switch, anything that
  // isn't the explicit back button below). Safe regardless of ordering
  // against the autosave hook's own cleanup — flush() only reads/clears the
  // queue, it never depends on the debounce timer still being alive.
  useEffect(() => () => void autosave.flush(), [autosave.flush]);

  const goBack = async () => {
    await autosave.flush();
    router.back();
  };

  // ─── Row mutation helpers — every edit sends the row's COMPLETE state ────

  const pushUndo = (entry: UndoEntry) => setUndoStack((s) => [...s, entry]);

  const addCountedProduct = (
    p: {
      id: string;
      name: string;
      sku?: string | null;
      unit?: string | null;
      currentStock?: number | string | null;
      unitsPerBox?: number | null;
      averageCost?: number | string | null;
    },
    amount: number,
  ) => {
    const wasNew = !rowsRef.current.some((r) => r.productId === p.id);
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.productId === p.id);
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = { ...next[idx], counted: next[idx].counted + amount };
        return next;
      }
      return [
        ...prev,
        {
          productId: p.id,
          name: p.name,
          sku: p.sku ?? undefined,
          unit: p.unit ?? undefined,
          stockBefore: Number(p.currentStock ?? 0) || 0,
          counted: amount,
          mode: modeRef.current,
          unitsPerBox: p.unitsPerBox ?? undefined,
          averageCost: p.averageCost != null ? Number(p.averageCost) : undefined,
        },
      ];
    });
    pushUndo({ productId: p.id, amount, wasNewRow: wasNew });
    autosave.queueScan(p.id, amount, modeRef.current);
  };

  const applyRowEdit = (productId: string, updater: (row: StockCountRow) => StockCountRow) => {
    const current = rowsRef.current.find((r) => r.productId === productId);
    if (!current) return;
    const updated = updater(current);
    setRows((prev) => prev.map((r) => (r.productId === productId ? updated : r)));
    autosave.queueEdit(productId, rowEditPatch(updated), updated.mode);
  };

  const setCounted = (productId: string, counted: number) =>
    applyRowEdit(productId, (r) => ({ ...r, counted: Math.max(0, counted) }));
  const setMode = (productId: string, mode: StockCountMode) =>
    applyRowEdit(productId, (r) => ({ ...r, mode }));
  const setBoxesPieces = (productId: string, boxes: number, pieces: number, unitsPerBox: number) =>
    applyRowEdit(productId, (r) => ({
      ...r,
      boxes,
      pieces,
      counted: boxes * unitsPerBox + pieces,
    }));
  const setUnitCostOverride = (productId: string, unitCostOverride: number | undefined) =>
    applyRowEdit(productId, (r) => ({ ...r, unitCostOverride }));

  const removeRow = (productId: string) => {
    setRows((prev) => prev.filter((r) => r.productId !== productId));
    autosave.queueRemove(productId);
  };

  const undoLastScan = () => {
    if (undoStack.length === 0) return;
    const last = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    const row = rowsRef.current.find((r) => r.productId === last.productId);
    if (!row) return;
    const newCounted = Math.max(0, row.counted - last.amount);
    if (last.wasNewRow && newCounted <= 0) {
      removeRow(last.productId);
      showToast(`Undid last scan — removed ${row.name}`);
      return;
    }
    applyRowEdit(last.productId, (r) => ({ ...r, counted: newCounted }));
    showToast(`Undid last scan — ${row.name} now ${newCounted}`);
  };

  // ─── Scanning ──────────────────────────────────────────────────────────

  const handleScanned = async (code: string): Promise<ScanOutcome> => {
    const res = await resolveProductByCode(code);
    if (res.notFound || !res.product) {
      const trimmed = code.trim();
      return {
        feedback: {
          kind: "error",
          text: `No product for "${trimmed}"`,
          action: { label: "Options", onPress: () => showUnknownBarcodeOptions(trimmed) },
        },
      };
    }
    const product = res.product as any;
    const existing = rowsRef.current.find((r) => r.productId === product.id);
    const newTotal = (existing?.counted ?? 0) + qtyRef.current;
    addCountedProduct(product, qtyRef.current);
    return { feedback: { kind: "added", text: `${product.name} — now ${newTotal}` } };
  };

  const wrappedHandleScanned = async (code: string): Promise<ScanOutcome> => {
    const outcome = await handleScanned(code);
    scanHaptic(outcome?.feedback?.kind === "error" ? "error" : "added");
    return outcome;
  };

  const showUnknownBarcodeOptions = (code: string) => {
    chooseAction("Not in catalogue", `No product matches "${code}".`, [
      { label: "Cancel", style: "cancel" },
      { label: "Skip (noted)", onPress: () => showToast(`Skipped "${code}" — not counted`) },
      { label: "Attach to existing product", onPress: () => setAttachCode(code) },
      { label: "Create new product", onPress: () => setCreateSheet({ code }) },
    ]);
  };

  // ─── Session lifecycle ─────────────────────────────────────────────────

  const summary = buildRowCommitSummary(rows);

  const onCommit = () => {
    if (!id) return;
    commitMut.mutate(
      { notes: notes.trim() || undefined },
      {
        onSuccess: (r) => {
          const netText =
            summary.netVarianceMoney !== 0 ? ` (${fmtCurrency(summary.netVarianceMoney)} net)` : "";
          showToast(
            r.alreadyCommitted
              ? "This count was already committed."
              : `Count committed — ${r.applied} updated${netText}${r.skipped ? `, ${r.skipped} unchanged` : ""}`,
          );
          setReviewOpen(false);
          router.replace(`/(operator)/products/stock-count/${id}` as any);
        },
        onError: (e: any) =>
          showToast(e?.response?.data?.message ?? e?.message ?? "Couldn't commit the count."),
      },
    );
  };

  const onDiscard = () => {
    if (!id) return;
    confirm(
      "Discard this count?",
      "The session is kept for the record, but no stock is adjusted. This cannot be undone.",
      () =>
        discardMut.mutate(id, {
          onSuccess: () => {
            showToast("Count discarded.");
            router.back();
          },
          onError: (e: any) =>
            showToast(e?.response?.data?.message ?? e?.message ?? "Couldn't discard the count."),
        }),
      { confirmText: "Discard", destructive: true },
    );
  };

  const onAmend = () => {
    if (!session) return;
    amendMut.mutate(
      { amendsSessionId: session.id },
      {
        onSuccess: (newSession) =>
          router.replace(`/(operator)/products/stock-count/${newSession.id}` as any),
        onError: (e: any) =>
          showToast(e?.response?.data?.message ?? e?.message ?? "Couldn't start the amendment."),
      },
    );
  };

  if (sessionQuery.isLoading || !session) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Stock count"
          leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  if (!editable) {
    return (
      <ReadOnlySessionView
        session={session}
        rows={rows}
        onBack={() => router.back()}
        onAmend={session.status === "COMMITTED" ? onAmend : undefined}
        amending={amendMut.isPending}
      />
    );
  }

  const changed = groupRowsByVariance(rows).changed.length;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={session.name?.trim() || "Stock count"}
        leading={<NavBackButton label="Warehouse" onPress={goBack} />}
        trailing={
          <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
            <Pressable onPress={onDiscard} hitSlop={8}>
              <Ionicons name="trash-outline" size={18} color={ios.system.redInk} />
            </Pressable>
            {rows.length > 0 ? (
              <NavAction label="Review" bold onPress={() => setReviewOpen(true)} />
            ) : null}
          </View>
        }
      />

      {autosave.pendingCount > 0 ? (
        <Pressable style={styles.unsavedBar} onPress={() => autosave.flush()}>
          <Ionicons name="cloud-upload-outline" size={14} color={ios.system.orangeInk} />
          <Text style={styles.unsavedText}>{autosave.pendingCount} unsaved — tap to retry</Text>
        </Pressable>
      ) : null}

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: 16, gap: 14 }}
      >
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
          <View style={styles.settingRow}>
            <Pressable style={styles.addBtn} onPress={() => setPickerOpen(true)}>
              <Ionicons name="add-circle-outline" size={16} color={ios.brand} />
              <Text style={styles.addBtnText}>Add product manually</Text>
            </Pressable>
            <Pressable
              style={[styles.undoBtn, undoStack.length === 0 && { opacity: 0.4 }]}
              onPress={undoLastScan}
              disabled={undoStack.length === 0}
            >
              <Ionicons name="arrow-undo-outline" size={16} color={ios.label} />
              <Text style={styles.undoBtnText}>Undo last scan</Text>
            </Pressable>
          </View>
        </View>

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

      <BarcodeFab
        continuous
        onScanned={wrappedHandleScanned}
        hidden={pickerOpen || reviewOpen || !!createSheet || !!attachCode}
      />

      <ProductPickerSheet
        visible={pickerOpen}
        title="Add to count"
        onClose={() => setPickerOpen(false)}
        onSelect={(p) => {
          addCountedProduct(p, qtyRef.current);
          setPickerOpen(false);
        }}
      />

      <ProductPickerSheet
        visible={!!attachCode}
        title="Attach barcode to…"
        onClose={() => setAttachCode(null)}
        onSelect={(p) => {
          const code = attachCode!;
          updateProductMut.mutate(
            { id: p.id, barcode: code },
            {
              onSuccess: () => {
                addCountedProduct({ ...p, id: p.id }, qtyRef.current);
                showToast(`Attached "${code}" to ${p.name}`);
                setAttachCode(null);
              },
              onError: (e: any) => {
                showToast(
                  e?.response?.data?.message ?? e?.message ?? "Couldn't attach that barcode.",
                );
                setAttachCode(null);
              },
            },
          );
        }}
      />

      <InlineCreateProductSheet
        visible={!!createSheet}
        initialCode={createSheet?.code}
        onClose={() => setCreateSheet(null)}
        onCreated={(product: CreatedProduct) => {
          addCountedProduct(product, qtyRef.current);
          setCreateSheet(null);
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
        onSetCounted={setCounted}
        onRemove={removeRow}
        onSetUnitCost={setUnitCostOverride}
        onSetBoxesPieces={setBoxesPieces}
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
  onSetCounted,
  onRemove,
  onSetUnitCost,
  onSetBoxesPieces,
}: {
  open: boolean;
  rows: StockCountRow[];
  notes: string;
  onNotes: (v: string) => void;
  committing: boolean;
  onClose: () => void;
  onCommit: () => void;
  onSetCounted: (productId: string, counted: number) => void;
  onRemove: (productId: string) => void;
  onSetUnitCost: (productId: string, cost: number | undefined) => void;
  onSetBoxesPieces: (productId: string, boxes: number, pieces: number, unitsPerBox: number) => void;
}) {
  const { matched, changed } = groupRowsByVariance(rows);
  const summary = buildRowCommitSummary(rows);
  const [matchedOpen, setMatchedOpen] = useState(false);

  return (
    <Modal visible={open} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Review count"
          leading={<NavBackButton label="Back" onPress={onClose} />}
        />
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
          <View style={styles.summaryCard}>
            <Text style={styles.reviewSummary}>
              Adjust {summary.changedCount} product{summary.changedCount === 1 ? "" : "s"}
              {summary.netVarianceMoney !== 0
                ? ` (${summary.netVarianceMoney > 0 ? "+" : ""}${fmtCurrency(summary.netVarianceMoney)} at avg cost)`
                : ""}
              . {rows.length - summary.changedCount} line{summary.matchedCount === 1 ? "" : "s"}{" "}
              match — unchanged. Every OTHER product in the catalogue is untouched.
            </Text>
          </View>

          {changed.length > 0 ? (
            <View style={styles.card}>
              {changed.map((r, i) => (
                <ReviewRow
                  key={r.productId}
                  row={r}
                  first={i === 0}
                  onSetCounted={onSetCounted}
                  onRemove={onRemove}
                  onSetUnitCost={onSetUnitCost}
                  onSetBoxesPieces={onSetBoxesPieces}
                />
              ))}
            </View>
          ) : null}

          {matched.length > 0 ? (
            <View style={styles.card}>
              <Pressable style={styles.matchedHeader} onPress={() => setMatchedOpen((v) => !v)}>
                <Text style={styles.cardTitle}>
                  {matched.length} line{matched.length === 1 ? "" : "s"} match
                </Text>
                <Ionicons
                  name={matchedOpen ? "chevron-up" : "chevron-down"}
                  size={16}
                  color={ios.label2}
                />
              </Pressable>
              {matchedOpen
                ? matched.map((r, i) => (
                    <ReviewRow
                      key={r.productId}
                      row={r}
                      first={i === 0}
                      onSetCounted={onSetCounted}
                      onRemove={onRemove}
                      onSetUnitCost={onSetUnitCost}
                      onSetBoxesPieces={onSetBoxesPieces}
                    />
                  ))
                : null}
            </View>
          ) : null}

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
            style={[styles.commitBtn, (committing || rows.length === 0) && { opacity: 0.5 }]}
            disabled={committing || rows.length === 0}
            onPress={onCommit}
          >
            <Text style={styles.commitBtnText}>{committing ? "Committing…" : "Commit count"}</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function ReviewRow({
  row,
  first,
  onSetCounted,
  onRemove,
  onSetUnitCost,
  onSetBoxesPieces,
}: {
  row: StockCountRow;
  first: boolean;
  onSetCounted: (productId: string, counted: number) => void;
  onRemove: (productId: string) => void;
  onSetUnitCost: (productId: string, cost: number | undefined) => void;
  onSetBoxesPieces: (productId: string, boxes: number, pieces: number, unitsPerBox: number) => void;
}) {
  const { delta, after } = rowVariance(row);
  const varianceMoney = rowVarianceMoney(row);
  const boxed = !!row.unitsPerBox && row.unitsPerBox > 1;
  const [costDraft, setCostDraft] = useState(
    row.unitCostOverride != null
      ? String(row.unitCostOverride)
      : row.averageCost != null
        ? String(row.averageCost)
        : "",
  );

  return (
    <View
      style={[
        styles.reviewRowWrap,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: ios.separator },
      ]}
    >
      <View style={styles.reviewRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.reviewName} numberOfLines={1}>
            {row.name}
          </Text>
          <Text style={styles.reviewExpected}>
            {row.stockBefore} → {after}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end", gap: 2 }}>
          <Text
            style={[
              styles.reviewDelta,
              {
                color: delta > 0 ? ios.system.greenInk : delta < 0 ? ios.system.redInk : ios.label2,
              },
            ]}
          >
            {delta >= 0 ? "+" : ""}
            {delta}
          </Text>
          {varianceMoney !== 0 ? (
            <Text style={styles.reviewDeltaMoney}>
              {varianceMoney > 0 ? "+" : ""}
              {fmtCurrency(varianceMoney)}
            </Text>
          ) : null}
        </View>
        <Pressable onPress={() => onRemove(row.productId)} hitSlop={8}>
          <Ionicons name="close-circle-outline" size={18} color={ios.label3} />
        </Pressable>
      </View>

      <View style={styles.reviewEditRow}>
        {boxed ? (
          <View style={styles.boxPieceRow}>
            <TextInput
              style={styles.smallInput}
              value={String(row.boxes ?? 0)}
              onChangeText={(v) =>
                onSetBoxesPieces(
                  row.productId,
                  Number(sanitizeIntInput(v)) || 0,
                  row.pieces ?? 0,
                  row.unitsPerBox!,
                )
              }
              keyboardType="number-pad"
            />
            <Text style={styles.boxPieceLabel}>box</Text>
            <TextInput
              style={styles.smallInput}
              value={String(row.pieces ?? 0)}
              onChangeText={(v) =>
                onSetBoxesPieces(
                  row.productId,
                  row.boxes ?? 0,
                  Number(sanitizeIntInput(v)) || 0,
                  row.unitsPerBox!,
                )
              }
              keyboardType="number-pad"
            />
            <Text style={styles.boxPieceLabel}>pcs</Text>
          </View>
        ) : (
          <TextInput
            style={styles.smallInput}
            value={String(row.counted)}
            onChangeText={(v) => onSetCounted(row.productId, Number(sanitizeIntInput(v)) || 0)}
            keyboardType="number-pad"
          />
        )}

        <View style={styles.unitCostField}>
          <Text style={styles.unitCostLabel}>Unit cost</Text>
          <TextInput
            style={styles.unitCostInput}
            value={costDraft}
            onChangeText={setCostDraft}
            onBlur={() => {
              const n = Number(costDraft);
              onSetUnitCost(
                row.productId,
                costDraft.trim() === "" || !Number.isFinite(n) ? undefined : n,
              );
            }}
            keyboardType="decimal-pad"
            placeholder={row.averageCost != null ? row.averageCost.toFixed(4) : "0.0000"}
            placeholderTextColor={ios.label3}
          />
        </View>
      </View>
      <Text style={styles.unitCostHint}>Sets cost basis, not just count</Text>
    </View>
  );
}

function ReadOnlySessionView({
  session,
  rows,
  onBack,
  onAmend,
  amending,
}: {
  session: {
    status: StockCountSessionStatus;
    name?: string | null;
    notes?: string | null;
    committedAt?: string | null;
    committedBy?: { username: string } | null;
    startedBy?: { username: string } | null;
    startedAt: string;
    movementReference?: string | null;
  };
  rows: StockCountRow[];
  onBack: () => void;
  onAmend?: () => void;
  amending: boolean;
}) {
  const { matched, changed } = groupRowsByVariance(rows);
  const summary = buildRowCommitSummary(rows);
  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={session.name?.trim() || "Stock count"}
        leading={<NavBackButton label="Back" onPress={onBack} />}
      />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Pill variant={STATUS_PILL[session.status]}>{session.status}</Pill>
          </View>
          <Text style={styles.reviewSummary}>
            Started by {session.startedBy?.username ?? "—"} on {fmtDate(session.startedAt)}.
            {session.status === "COMMITTED"
              ? ` Committed by ${session.committedBy?.username ?? "—"} on ${fmtDate(session.committedAt)}. ${
                  summary.changedCount
                } product${summary.changedCount === 1 ? "" : "s"} adjusted${
                  summary.netVarianceMoney !== 0
                    ? ` (${fmtCurrency(summary.netVarianceMoney)} net)`
                    : ""
                }.`
              : " This count was discarded — no stock was adjusted."}
          </Text>
          {session.notes ? <Text style={styles.reviewSummary}>Notes: {session.notes}</Text> : null}
        </View>

        {rows.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>
              {changed.length} changed · {matched.length} matched
            </Text>
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
                  <Text style={styles.rowName}>{r.name}</Text>
                  <Text style={styles.rowVariance}>
                    {r.stockBefore} → {after} ({delta >= 0 ? "+" : ""}
                    {delta})
                  </Text>
                </View>
              );
            })}
          </View>
        ) : null}

        {onAmend ? (
          <Pressable
            style={[styles.reviewBtn, amending && { opacity: 0.6 }]}
            onPress={onAmend}
            disabled={amending}
          >
            <Text style={styles.reviewBtnText}>{amending ? "Starting…" : "Amend this count"}</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14 },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, marginBottom: 8 },
  settingRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 },
  settingLabel: { flex: 1, fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  settingHint: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 6 },
  addBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.brand },
  undoBtn: { flexDirection: "row", alignItems: "center", gap: 6, marginLeft: "auto" },
  undoBtnText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },
  unsavedBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 6,
    backgroundColor: ios.system.orangeWash,
  },
  unsavedText: { fontSize: 12.5, fontFamily: "Inter_600SemiBold", color: ios.system.orangeInk },
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
  summaryCard: { backgroundColor: ios.brandWash, borderRadius: 12, padding: 12 },
  reviewSummary: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  matchedHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  reviewRowWrap: { paddingVertical: 10, gap: 8 },
  reviewRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  reviewName: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  reviewExpected: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  reviewDelta: { fontSize: 14, fontFamily: "Inter_600SemiBold", fontVariant: ["tabular-nums"] },
  reviewDeltaMoney: {
    fontSize: 11.5,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
    fontVariant: ["tabular-nums"],
  },
  reviewEditRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  boxPieceRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  boxPieceLabel: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  smallInput: {
    width: 52,
    height: 32,
    backgroundColor: ios.fill3,
    borderRadius: 8,
    textAlign: "center",
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
  },
  unitCostField: { flex: 1, alignItems: "flex-end" },
  unitCostLabel: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label3 },
  unitCostInput: {
    width: 90,
    height: 32,
    backgroundColor: ios.fill3,
    borderRadius: 8,
    textAlign: "right",
    paddingHorizontal: 8,
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
  },
  unitCostHint: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label3, marginTop: -2 },
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
