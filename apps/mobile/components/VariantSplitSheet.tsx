import * as React from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormTextInput } from "./FormSheet";
import { BoxedQtyBand } from "./BoxedQtyBand";
import { QtyStepper } from "./QtyStepper";
import { useAssignToVariants, type VariantAssignResult } from "../lib/api/variant-assign";
import {
  applyRowQtyChange,
  buildVariantAssignPayload,
  parseCostText,
  remainingPool,
  type SplitRow,
} from "../lib/variant-split-logic";

export interface VariantSplitParent {
  id: string;
  name: string;
  currentStock: number | string;
  averageCost?: number | string | null;
  unitsPerBox?: number | null;
  costingMethod?: string | null;
  unit?: string | null;
}

export interface VariantSplitVariant {
  id: string;
  name: string;
  variantName?: string | null;
}

function toNum(v: number | string | null | undefined): number {
  const n = typeof v === "string" ? Number(v) : (v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Stable key for the one inline "new variant" row — mirrors web's `NEW_ROW_ID`. */
const NEW_ROW_KEY = "__new__";

/**
 * FormSheet-pattern modal (mirrors `LineEditSheet`/`InlineCreateProductSheet`)
 * for splitting a generic parent's unassigned stock across its variants —
 * `POST /inventory/variant-assign` via `lib/api/variant-assign.ts`. One row
 * per existing variant plus one inline "new variant" row (mirrors
 * `apps/web/components/VariantSplitModal.tsx` exactly — the same reusable
 * flow, UI-only differences); the qty math (remaining pool, live clamping,
 * boxes/pieces) is pure and tested in `lib/variant-split-logic.ts`.
 *
 * Mobile has no toast action slot (and `showToast` is a no-op on iOS), and
 * the movements screen only takes `productId`/`productName` — so success is
 * confirmed IN-SCREEN (a summary + "View movements" by product), never a
 * `?reference=` link.
 */
export function VariantSplitSheet({
  visible,
  parent,
  variants,
  pool,
  onClose,
  onViewMovements,
}: {
  visible: boolean;
  parent: VariantSplitParent;
  /** The parent's own active variants — rendered one row each. */
  variants: VariantSplitVariant[];
  /** Unassigned pool to split. Defaults to the parent's own `currentStock`. */
  pool?: number;
  onClose: () => void;
  /** Navigate to the parent's movements (by productId, not reference) after a successful split. */
  onViewMovements: () => void;
}) {
  const assignMut = useAssignToVariants();
  const unitsPerBox = parent.unitsPerBox ?? null;
  const boxed = Number(unitsPerBox ?? 0) > 1;
  const isStandardCosted = (parent.costingMethod ?? "") === "STANDARD";
  const baseCost = toNum(parent.averageCost);
  const poolTotal = pool ?? toNum(parent.currentStock);

  const [rows, setRows] = React.useState<SplitRow[]>([]);
  const [costOpenKeys, setCostOpenKeys] = React.useState<Set<string>>(new Set());
  const [notes, setNotes] = React.useState("");
  const [result, setResult] = React.useState<VariantAssignResult | null>(null);

  // Re-seed once per opening: one zero-qty row per existing active variant,
  // plus the one always-present (empty) new-variant row. Deliberately NOT
  // re-seeding on every `variants` change while open — a background refetch
  // mid-edit must never stomp what the operator has typed (mirrors
  // LineEditSheet's re-seed guard).
  React.useEffect(() => {
    if (!visible) return;
    setRows([
      ...variants.map((v) => ({ key: v.id, productId: v.id, qty: 0, boxes: 0, pieces: 0 })),
      { key: NEW_ROW_KEY, newVariantName: "", qty: 0, boxes: 0, pieces: 0 },
    ]);
    setCostOpenKeys(new Set());
    setNotes("");
    setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const remaining = remainingPool(poolTotal, rows, unitsPerBox);

  const updateQty = (key: string, patch: Partial<Pick<SplitRow, "qty" | "boxes" | "pieces">>) => {
    setRows((prev) => applyRowQtyChange(prev, key, patch, poolTotal, unitsPerBox));
  };

  const updateRow = (key: string, patch: Partial<SplitRow>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const toggleCostOpen = (key: string) => {
    setCostOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const payload = buildVariantAssignPayload(parent.id, rows, unitsPerBox, notes);
  const assignedCount = payload?.assignments.length ?? 0;
  const canSubmit = !!payload && !assignMut.isPending;

  const handleSubmit = () => {
    if (!payload) return;
    assignMut.mutate(payload, { onSuccess: (res) => setResult(res) });
  };

  const handleClose = () => {
    assignMut.reset();
    onClose();
  };

  const existingRows = rows.filter((r) => !!r.productId);
  const newRow = rows.find((r) => r.key === NEW_ROW_KEY);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
      <Pressable style={styles.backdrop} onPress={handleClose} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.sheetWrap}
      >
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Assign to variants</Text>
              <Text style={styles.subtitle} numberOfLines={1}>
                {parent.name}
              </Text>
            </View>
            <Pressable onPress={handleClose} hitSlop={10} accessibilityLabel="Close">
              <Ionicons name="close" size={20} color={ios.label2} />
            </Pressable>
          </View>

          {result ? (
            <SuccessView
              result={result}
              onViewMovements={() => {
                onViewMovements();
                handleClose();
              }}
              onDone={handleClose}
            />
          ) : (
            <>
              <View style={styles.remainingBanner}>
                <Text style={styles.remainingLabel}>Remaining</Text>
                <Text style={styles.remainingValue}>
                  {remaining} {parent.unit ?? ""}
                </Text>
              </View>

              <ScrollView
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ paddingBottom: 8 }}
              >
                {assignMut.isError ? (
                  <View style={styles.errorBanner}>
                    <Ionicons name="warning-outline" size={16} color={ios.system.redInk} />
                    <Text style={styles.errorText}>
                      {(assignMut.error as any)?.response?.data?.message ??
                        (assignMut.error as any)?.message ??
                        "Couldn't assign stock. Try again."}
                    </Text>
                  </View>
                ) : null}

                {existingRows.length > 0 ? (
                  <FormSection title="Existing variants">
                    {existingRows.map((row) => {
                      const variant = variants.find((v) => v.id === row.productId);
                      const label = variant?.variantName || variant?.name || "Variant";
                      return (
                        <VariantRow
                          key={row.key}
                          label={label}
                          row={row}
                          boxed={boxed}
                          unitsPerBox={unitsPerBox}
                          unit={parent.unit}
                          baseCost={baseCost}
                          costEditable={!isStandardCosted}
                          costOpen={costOpenKeys.has(row.key)}
                          onChangeBoxes={(n) => updateQty(row.key, { boxes: n })}
                          onChangePieces={(n) => updateQty(row.key, { pieces: n })}
                          onChangeQty={(n) => updateQty(row.key, { qty: n })}
                          onToggleCost={() => toggleCostOpen(row.key)}
                          onChangeCost={(v) => updateRow(row.key, { unitCostText: v })}
                        />
                      );
                    })}
                  </FormSection>
                ) : null}

                {newRow ? (
                  <FormSection title="New variant">
                    <FormField label="Name">
                      <FormTextInput
                        value={newRow.newVariantName ?? ""}
                        onChangeText={(v) => updateRow(NEW_ROW_KEY, { newVariantName: v })}
                        placeholder="e.g. Cherry"
                        autoCapitalize="sentences"
                        maxLength={120}
                      />
                    </FormField>
                    <VariantRow
                      label={null}
                      row={newRow}
                      boxed={boxed}
                      unitsPerBox={unitsPerBox}
                      unit={parent.unit}
                      baseCost={baseCost}
                      costEditable={!isStandardCosted}
                      costOpen={costOpenKeys.has(NEW_ROW_KEY)}
                      onChangeBoxes={(n) => updateQty(NEW_ROW_KEY, { boxes: n })}
                      onChangePieces={(n) => updateQty(NEW_ROW_KEY, { pieces: n })}
                      onChangeQty={(n) => updateQty(NEW_ROW_KEY, { qty: n })}
                      onToggleCost={() => toggleCostOpen(NEW_ROW_KEY)}
                      onChangeCost={(v) => updateRow(NEW_ROW_KEY, { unitCostText: v })}
                    />
                  </FormSection>
                ) : null}

                <FormField label="Notes (optional)">
                  <FormTextInput
                    value={notes}
                    onChangeText={setNotes}
                    placeholder="e.g. First split of this delivery"
                    autoCapitalize="sentences"
                    maxLength={500}
                  />
                </FormField>
              </ScrollView>

              <Pressable
                style={[styles.submitBtn, !canSubmit && styles.submitBtnDisabled]}
                onPress={handleSubmit}
                disabled={!canSubmit}
              >
                {assignMut.isPending ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.submitText}>
                    {assignedCount > 0
                      ? `Assign to ${assignedCount} variant${assignedCount === 1 ? "" : "s"}`
                      : "Assign to variants"}
                  </Text>
                )}
              </Pressable>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** One variant's qty (+ collapsed cost override) row. `label` is null for an
 *  inline new-variant row, which renders its own Name field above this. */
function VariantRow({
  label,
  row,
  boxed,
  unitsPerBox,
  unit,
  baseCost,
  costEditable,
  costOpen,
  onChangeBoxes,
  onChangePieces,
  onChangeQty,
  onToggleCost,
  onChangeCost,
}: {
  label: string | null;
  row: SplitRow;
  boxed: boolean;
  unitsPerBox: number | null;
  unit?: string | null;
  baseCost: number;
  costEditable: boolean;
  costOpen: boolean;
  onChangeBoxes: (n: number) => void;
  onChangePieces: (n: number) => void;
  onChangeQty: (n: number) => void;
  onToggleCost: () => void;
  onChangeCost: (v: string) => void;
}) {
  const upb = Number(unitsPerBox ?? 1);
  const rowUnitCost = parseCostText(row.unitCostText) ?? baseCost;
  return (
    <View style={styles.row}>
      {label ? <Text style={styles.rowLabel}>{label}</Text> : null}
      {boxed ? (
        <View style={styles.band}>
          <BoxedQtyBand
            line={{ qty: row.qty, boxes: row.boxes ?? 0, pieces: row.pieces ?? 0 }}
            unitsPerBox={upb}
            unit={unit}
            // BoxedQtyBand's summary bills a PER-CASE figure (its subtotal is
            // `unitPrice * (boxes + pieces/unitsPerBox)`), but every cost here
            // — the parent's averageCost and the override alike — is per BASE
            // UNIT. Case-denominate it or the row would understate the money
            // by a factor of unitsPerBox.
            unitPrice={rowUnitCost * upb}
            productName={label ?? row.newVariantName ?? "new variant"}
            onChangeBoxes={onChangeBoxes}
            onChangePieces={onChangePieces}
            // The "Edit" chip is BoxedQtyBand's one progressive-disclosure entry
            // point — repurposed here to reveal the (rare) per-row cost override
            // instead of a price override. Omitted entirely when the parent is
            // STANDARD-costed (that cost is operator-set and must never move),
            // so there's no chip that does nothing — mirrors web dropping the
            // whole Cost column for a STANDARD parent.
            onEdit={costEditable ? onToggleCost : undefined}
          />
        </View>
      ) : (
        <View style={styles.plainQtyRow}>
          <QtyStepper size="md" value={row.qty} onChangeQty={onChangeQty} />
          {costEditable ? (
            <Pressable onPress={onToggleCost} hitSlop={8}>
              <Text style={styles.costToggleText}>
                {costOpen ? "Use default cost" : "Different cost?"}
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}
      {costEditable && costOpen ? (
        <FormField label="Cost override" hint={`Default: $${baseCost.toFixed(2)} (parent average)`}>
          {/* Raw text, parsed once at submit (`parseCostText`). A controlled
              input backed by a number re-renders "2." as "2" and swallows the
              decimal point, so $2.75 would be untypable. */}
          <FormTextInput
            value={row.unitCostText ?? ""}
            onChangeText={onChangeCost}
            placeholder={baseCost.toFixed(2)}
            keyboardType="decimal-pad"
          />
        </FormField>
      ) : null}
    </View>
  );
}

/** In-screen confirmation replacing the form body on success — mobile has no
 *  toast action slot and `showToast` is a no-op on iOS. */
function SuccessView({
  result,
  onViewMovements,
  onDone,
}: {
  result: VariantAssignResult;
  onViewMovements: () => void;
  onDone: () => void;
}) {
  return (
    <View style={styles.successWrap}>
      <View style={styles.successIcon}>
        <Ionicons name="checkmark" size={26} color="#fff" />
      </View>
      <Text style={styles.successTitle}>Stock assigned</Text>
      <ScrollView style={styles.successList} showsVerticalScrollIndicator={false}>
        {result.assignments.map((a, i) => (
          <View
            key={a.productId}
            style={[styles.successRow, i > 0 ? styles.successRowBordered : null]}
          >
            <Text style={styles.successRowLabel} numberOfLines={1}>
              {a.variantName || "Variant"}
              {a.created ? " (new)" : ""}
            </Text>
            <Text style={styles.successRowQty}>+{a.qty}</Text>
          </View>
        ))}
      </ScrollView>
      <Text style={styles.successRemaining}>
        {result.parentRemaining} left unassigned on the generic
      </Text>
      <Pressable style={styles.viewMovementsBtn} onPress={onViewMovements}>
        <Text style={styles.viewMovementsText}>View movements</Text>
      </Pressable>
      <Pressable style={styles.doneBtn} onPress={onDone}>
        <Text style={styles.doneText}>Done</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheetWrap: { position: "absolute", left: 0, right: 0, bottom: 0 },
  sheet: {
    maxHeight: "90%",
    backgroundColor: ios.bg,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 16,
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
    paddingVertical: 10,
  },
  title: { fontSize: 16, fontFamily: "Inter_700Bold", color: ios.label },
  subtitle: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  remainingBanner: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: ios.brandWash,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 12,
  },
  remainingLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.brandInk,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  remainingValue: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: ios.brandInk,
    fontVariant: ["tabular-nums"],
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: ios.system.redWash,
    padding: 10,
    borderRadius: 10,
    marginBottom: 10,
  },
  errorText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.system.redInk, flex: 1 },
  row: { gap: 8 },
  rowLabel: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  band: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 },
  plainQtyRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  costToggleText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.brand },
  submitBtn: {
    marginTop: 10,
    backgroundColor: ios.brand,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  submitBtnDisabled: { opacity: 0.4 },
  submitText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "#fff" },
  successWrap: { alignItems: "center", paddingVertical: 12, gap: 10 },
  successIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: ios.system.green,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  successTitle: { fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label },
  successList: { maxHeight: 220, alignSelf: "stretch" },
  successRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
  },
  successRowBordered: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: ios.separator },
  successRowLabel: { flex: 1, fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  successRowQty: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: ios.system.greenInk,
    fontVariant: ["tabular-nums"],
  },
  successRemaining: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  viewMovementsBtn: {
    alignSelf: "stretch",
    backgroundColor: ios.brand,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: 6,
  },
  viewMovementsText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#fff" },
  doneBtn: { alignSelf: "stretch", paddingVertical: 10, alignItems: "center" },
  doneText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label2 },
});
