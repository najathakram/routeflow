import { Pressable, StyleSheet, Text, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { QtyStepper } from "./QtyStepper";
import { boxedLineSummary, type BoxedSummaryLine } from "../lib/boxed-line-summary";

export interface BoxedQtyBandProps {
  /** Raw line fields, exactly as the builder's footer memo passes them. */
  line: BoxedSummaryLine;
  unitsPerBox: number;
  /** Loose-unit noun ("bottle"); falls back to "units". */
  unit?: string | null;
  /**
   * RESOLVED per-case price (override else tier/catalog). Never a Product —
   * the two builders resolve price differently (tier-aware vs not).
   */
  unitPrice: number;
  /** For the Edit chip's accessibility label. */
  productName: string;
  onChangeBoxes: (n: number) => void;
  onChangePieces: (n: number) => void;
  /**
   * Opens the full per-line editor (price override, note, cost/margin) — the
   * ONE progressive-disclosure entry point for exceptions. Quantities are the
   * every-line action and live here on the row.
   *
   * OMIT it when the row has nothing to disclose (e.g. a STANDARD-costed
   * product, whose operator-set cost must not move) — the chip is then not
   * rendered at all, rather than sitting there doing nothing when tapped.
   */
  onEdit?: () => void;
}

/**
 * Inline qty entry for an added case-packed row. Renders as FRAGMENT children
 * of ProductRow's `band` (flexDirection row, flexWrap, gap 10):
 *
 *   line 1 — "Cases" + "Loose <unit>" mini steppers (104px pills; 218px total,
 *            fits the 268px band at the 320px viewport floor);
 *   line 2 — summary + Edit chip, forced to wrap via flexBasis "100%" on the
 *            WRAPPER (basis on the Text alone would push the chip to line 3).
 *
 * Desktop enters cases + loose inline per line; before this component, loose
 * pieces cost a round-trip through the Review sheet on mobile. Geometry is
 * asserted in __tests__/row-layout.test.ts.
 */
export function BoxedQtyBand({
  line,
  unitsPerBox,
  unit,
  unitPrice,
  productName,
  onChangeBoxes,
  onChangePieces,
  onEdit,
}: BoxedQtyBandProps) {
  return (
    <>
      <View style={styles.control}>
        <Text style={styles.label} numberOfLines={1}>
          Cases
        </Text>
        <QtyStepper size="mini" value={line.boxes ?? 0} onChangeQty={onChangeBoxes} />
      </View>
      <View style={styles.control}>
        {/* Clamped + width-capped: "Loose containers" must not widen the
            control past its 104px pill or line 1 stops fitting at 320px. */}
        <Text style={styles.label} numberOfLines={1}>
          {`Loose ${unit ?? "units"}`}
        </Text>
        <QtyStepper
          size="mini"
          value={line.pieces ?? 0}
          onChangeQty={onChangePieces}
          // Mirror the Review sheet's clamp (setLinePieces itself doesn't):
          // a full case's worth of loose belongs in the Cases stepper.
          max={unitsPerBox - 1}
        />
      </View>
      <View style={styles.summaryRow}>
        <Text style={styles.summary} numberOfLines={1}>
          {boxedLineSummary(line, unitsPerBox, unitPrice)}
        </Text>
        {onEdit ? (
          <Pressable
            onPress={onEdit}
            hitSlop={8}
            style={styles.editBtn}
            accessibilityRole="button"
            accessibilityLabel={`Edit ${productName}`}
          >
            <Text style={styles.editText}>Edit</Text>
          </Pressable>
        ) : null}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  // maxWidth = the mini stepper pill width (see row-layout.test.ts): a long
  // unit noun ellipsizes instead of widening the control.
  control: { alignItems: "center", gap: 4, maxWidth: 104 },
  label: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.3,
  },
  // flexBasis 100% forces the wrap inside ProductRow.band's flexWrap row;
  // the band's own 10px gap provides the line spacing.
  summaryRow: { flexBasis: "100%", flexDirection: "row", alignItems: "center", gap: 10 },
  summary: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
    fontVariant: ["tabular-nums"],
  },
  // Compact visual (~30px) + hitSlop 8 keeps a >=44px effective touch target
  // without the old minHeight: 44 costing 14px of row height.
  editBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: ios.brandWash,
  },
  editText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.brand },
});
