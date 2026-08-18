import * as React from "react";
import {
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
import { FormField, FormTextInput } from "./FormSheet";
import { useProduct } from "../lib/api/products";
import { roundMoney } from "../lib/pricing";
import {
  toBillLine,
  type BillLineDenomination,
  type PieceSnapshot,
  type ScanLineUnit,
} from "../lib/scan-line-units";
import { pieceSnapshotFromLine, unitFromLine, initialPpbDraft } from "../lib/vendor-bill-scan";

/** The bits of a scanned line `LineEditSheet` needs — subset of `ScannedItemEx`. */
export interface LineEditLine {
  extractedName: string;
  qty: number;
  unitCost: number;
  packSize?: number | null;
  matchedProductId?: string | null;
}

/** What the sheet hands back on Save — the raw ingredients `applyLineEdit`
 *  needs, so the caller (the review screen) owns merging it into state. */
export interface LineEditCommit {
  snap: PieceSnapshot;
  unit: ScanLineUnit;
  piecesPerBox: number | null;
  catalogUnitsPerBox: number | null;
}

/** Trim a rounded float to a clean display string — no "30.0000", no
 *  "1.2500000000002". Empty string in, empty string out. */
function trimNum(n: number, dp: number): string {
  if (!Number.isFinite(n)) return "";
  return parseFloat(n.toFixed(dp)).toString();
}

type LineWarning = NonNullable<BillLineDenomination["warning"]>;

const WARNING_COPY: Record<LineWarning, (ppb: number | null) => string> = {
  NOT_DIVISIBLE: () =>
    "This piece count doesn't divide evenly into full boxes at that size — kept in pieces so stock never drifts.",
  PPB_MISMATCH: (ppb) =>
    `The catalog product says a different box size — using ${ppb ?? "?"}/box as shown here.`,
};

/**
 * FormSheet-pattern modal (mirrors `ReasonSheet`/`InlineCreateProductSheet`)
 * for re-denominating one scanned vendor-bill line between Boxes and Pieces.
 * All the actual unit math is `toBillLine` (`lib/scan-line-units.ts`, the A3
 * contract) — this component only seeds it (OCR-then-product pieces-per-box,
 * a stable canonical `PieceSnapshot` for a lossless toggle) and reports the
 * operator's final choice back through `onSave`; the caller commits it via
 * `applyLineEdit` so `packSize` is always written explicitly.
 */
export function LineEditSheet({
  visible,
  line,
  onClose,
  onSave,
}: {
  visible: boolean;
  line: LineEditLine | null;
  onClose: () => void;
  onSave: (commit: LineEditCommit) => void;
}) {
  const { data: product } = useProduct(line?.matchedProductId ?? "");
  const catalogUnitsPerBox: number | null =
    typeof product?.unitsPerBox === "number" && product.unitsPerBox > 1
      ? product.unitsPerBox
      : null;

  const [unit, setUnit] = React.useState<ScanLineUnit>("pieces");
  // The stable toggle baseline — only touched by qty/cost edits or a fresh
  // open, NEVER by the toggle itself, so repeated Boxes<->Pieces flips with
  // no other edits restore the exact original numbers (A3 losslessness).
  const [snap, setSnap] = React.useState<PieceSnapshot>({ qtyPieces: 0, costPerPiece: 0 });
  const [ppbStr, setPpbStr] = React.useState("");
  const [qtyStr, setQtyStr] = React.useState("");
  const [costStr, setCostStr] = React.useState("");
  // The caveat from the LAST conversion, kept in state rather than derived:
  // `unit` follows the conversion's `packSize` (see `handleUnitToggle`), so it
  // can no longer express "Boxes was asked for and refused" on its own.
  // Mirrors web's `ReviewItem.unitWarning`.
  const [warning, setWarning] = React.useState<LineWarning | undefined>(undefined);

  // Re-seed once per opening (or when a different line's numbers arrive) —
  // never on every render, or the operator's own typing would be stomped.
  // `catalogUnitsPerBox` is deliberately NOT a dependency: it arrives from an
  // async product fetch that can land mid-edit, and re-seeding then would
  // discard the unit/qty/cost the operator just entered. Its late arrival is
  // applied non-destructively by the effect below.
  React.useEffect(() => {
    if (!visible || !line) return;
    const initialUnit = unitFromLine(line);
    const initialSnap = pieceSnapshotFromLine(line);
    const initialPpb = initialPpbDraft(line, catalogUnitsPerBox);
    const denom = toBillLine(initialSnap, initialUnit, initialPpb, catalogUnitsPerBox);
    setUnit(denom.packSize != null ? "boxes" : "pieces");
    setSnap(initialSnap);
    setPpbStr(initialPpb != null ? String(initialPpb) : "");
    setQtyStr(trimNum(denom.qty, 3));
    setCostStr(trimNum(denom.unitCost, 4));
    setWarning(denom.warning);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, line?.extractedName, line?.qty, line?.unitCost, line?.packSize]);

  // A cold product fetch can deliver the catalog case size AFTER the sheet
  // opened. Apply it non-destructively — prefill the pieces-per-box field only
  // while it is still empty (i.e. the line is in pieces and OCR printed no
  // case size), which just arms the Boxes toggle. Never re-derive qty/cost.
  React.useEffect(() => {
    if (catalogUnitsPerBox == null) return;
    setPpbStr((prev) => (prev.trim() ? prev : String(catalogUnitsPerBox)));
  }, [catalogUnitsPerBox]);

  const ppb = ppbStr.trim() ? Math.trunc(Number(ppbStr)) : null;
  const parsedQty = Number(qtyStr);
  const parsedCost = Number(costStr);
  const liveTotal = roundMoney(
    (Number.isFinite(parsedQty) ? parsedQty : 0) * (Number.isFinite(parsedCost) ? parsedCost : 0),
  );
  const canSave =
    Number.isFinite(parsedQty) && parsedQty > 0 && Number.isFinite(parsedCost) && parsedCost >= 0;

  /** Direct field edits move the truth: re-derive the canonical snapshot from
   *  whatever's now on screen (in the CURRENT unit) so the next toggle starts
   *  from the operator's latest numbers. */
  const recommitSnap = (
    nextQtyStr: string,
    nextCostStr: string,
    forUnit: ScanLineUnit,
    forPpb: number | null,
  ) => {
    const q = Number(nextQtyStr);
    const c = Number(nextCostStr);
    if (!Number.isFinite(q) || !Number.isFinite(c)) return;
    const nextSnap = pieceSnapshotFromLine({
      qty: q,
      unitCost: c,
      packSize: forUnit === "boxes" ? forPpb : null,
    });
    setSnap(nextSnap);
    setWarning(toBillLine(nextSnap, forUnit, forPpb, catalogUnitsPerBox).warning);
  };

  /** Write a conversion result to the screen. The unit is DERIVED from the
   *  result's `packSize` (exactly like web's `unitOfItem`), never from what was
   *  asked for: a Boxes request that falls back to pieces (NOT_DIVISIBLE)
   *  returns piece-denominated numbers, and leaving the sheet labelled "Boxes"
   *  over them would make the next qty/cost edit be re-read as cases —
   *  multiplying the line's piece count by piecesPerBox at receive. */
  const commitDenom = (denom: BillLineDenomination) => {
    setUnit(denom.packSize != null ? "boxes" : "pieces");
    setQtyStr(trimNum(denom.qty, 3));
    setCostStr(trimNum(denom.unitCost, 4));
    setWarning(denom.warning);
  };

  const handleQtyChange = (v: string) => {
    setQtyStr(v);
    recommitSnap(v, costStr, unit, ppb);
  };
  const handleCostChange = (v: string) => {
    setCostStr(v);
    recommitSnap(qtyStr, v, unit, ppb);
  };
  const handlePpbChange = (v: string) => {
    setPpbStr(v);
    if (unit !== "boxes") return;
    const newPpb = v.trim() ? Math.trunc(Number(v)) : null;
    const denom = toBillLine(snap, "boxes", newPpb, catalogUnitsPerBox);
    commitDenom(denom);
  };
  const handleUnitToggle = (newUnit: ScanLineUnit) => {
    if (newUnit === unit) return;
    // Derived from the STABLE snap, not the on-screen strings — the lossless
    // round-trip this sheet exists to guarantee.
    const denom = toBillLine(snap, newUnit, ppb, catalogUnitsPerBox);
    commitDenom(denom);
  };

  const handleSave = () => {
    if (!canSave) return;
    onSave({ snap, unit, piecesPerBox: ppb, catalogUnitsPerBox });
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.sheetWrap}
      >
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Edit line</Text>
              <Text style={styles.subtitle} numberOfLines={1}>
                {line?.extractedName ?? ""}
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close">
              <Ionicons name="close" size={20} color={ios.label2} />
            </Pressable>
          </View>

          <ScrollView
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingBottom: 8 }}
          >
            <FormField label="Bill in">
              <View style={styles.pillRow}>
                <Pressable
                  style={[styles.pill, unit === "pieces" && styles.pillActive]}
                  onPress={() => handleUnitToggle("pieces")}
                >
                  <Text style={[styles.pillText, unit === "pieces" && styles.pillTextActive]}>
                    Pieces
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.pill, unit === "boxes" && styles.pillActive]}
                  onPress={() => handleUnitToggle("boxes")}
                >
                  <Text style={[styles.pillText, unit === "boxes" && styles.pillTextActive]}>
                    Boxes
                  </Text>
                </Pressable>
              </View>
            </FormField>

            <FormField
              label="Pieces per box"
              hint={
                catalogUnitsPerBox != null
                  ? `Catalog product is ${catalogUnitsPerBox}/box.`
                  : "From the invoice line, if it printed one."
              }
            >
              <FormTextInput
                value={ppbStr}
                onChangeText={handlePpbChange}
                placeholder="e.g. 24"
                keyboardType="number-pad"
              />
            </FormField>

            <View style={styles.row2}>
              <View style={{ flex: 1 }}>
                <FormField label={unit === "boxes" ? "Boxes" : "Pieces"}>
                  <FormTextInput
                    value={qtyStr}
                    onChangeText={handleQtyChange}
                    placeholder="0"
                    keyboardType="decimal-pad"
                  />
                </FormField>
              </View>
              <View style={{ flex: 1 }}>
                <FormField label={unit === "boxes" ? "Cost / box" : "Cost / piece"}>
                  <FormTextInput
                    value={costStr}
                    onChangeText={handleCostChange}
                    placeholder="0.00"
                    keyboardType="decimal-pad"
                  />
                </FormField>
              </View>
            </View>

            {warning ? (
              <View style={styles.warningBanner}>
                <Ionicons name="alert-circle" size={16} color={ios.system.orangeInk} />
                <Text style={styles.warningText}>{WARNING_COPY[warning](ppb)}</Text>
              </View>
            ) : null}

            {unit === "boxes" && !warning ? (
              <Text style={styles.fromNote}>
                from {trimNum(snap.qtyPieces, 3)} pcs @ ${trimNum(snap.costPerPiece, 4)}
              </Text>
            ) : null}

            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Line total</Text>
              <Text style={styles.totalValue}>${liveTotal.toFixed(2)}</Text>
            </View>
          </ScrollView>

          <Pressable
            style={[styles.submitBtn, !canSave && styles.submitBtnDisabled]}
            onPress={handleSave}
            disabled={!canSave}
          >
            <Text style={styles.submitText}>Save</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheetWrap: { position: "absolute", left: 0, right: 0, bottom: 0 },
  sheet: {
    maxHeight: "88%",
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
  row2: { flexDirection: "row", gap: 12 },
  pillRow: {
    flexDirection: "row",
    backgroundColor: ios.fill3,
    borderRadius: 10,
    padding: 3,
    gap: 3,
  },
  pill: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 8,
    alignItems: "center",
  },
  pillActive: { backgroundColor: ios.brand },
  pillText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label2 },
  pillTextActive: { color: "#fff" },
  warningBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: ios.system.orangeWash,
    borderRadius: 10,
    padding: 10,
    marginTop: 4,
  },
  warningText: {
    flex: 1,
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: ios.system.orangeInk,
    lineHeight: 16,
  },
  fromNote: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label3,
    marginTop: 4,
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 14,
  },
  totalLabel: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label2 },
  totalValue: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  submitBtn: {
    marginTop: 10,
    backgroundColor: ios.brand,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  submitBtnDisabled: { opacity: 0.4 },
  submitText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "#fff" },
});
