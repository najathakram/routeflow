import * as React from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import type { LadderProduct } from "@routeflow/pricing";
import { useProductUnits, useUnitsEnabled } from "../lib/api/product-units";
import {
  buildUnitOptions,
  defaultStartOption,
  unitOptionDetail,
  type UnitOption,
} from "../lib/unit-options";
import { OptionPickerSheet, type PickerOption } from "./OptionPickerSheet";

/** The line fields this control reads (structurally satisfied by CartRow's/DraftItemCard's own line). */
export interface UnitPickerLine {
  productId: string;
  isUnlisted?: boolean;
  /**
   * This line's CURRENT effective price — the pack's (a remembered discount/upsell applies to
   * pack lines only, v1 ruling) while `unitLabel` is unset, else the already-selected unit's own
   * price. Used as the pack option's `price` ONLY in the former case (mirroring web's
   * `packPrice`); once a unit is active there is no snapshot of what the pack was showing before
   * (mobile keeps no `packBase`, unlike web), so the pack option's price is instead freshly
   * resolved from the ladder/tier — never the active unit's price mislabelled as the pack's.
   */
  unitPrice: number;
  unitLabel?: string | null;
}

/**
 * The "Sell by" control for one cart/draft line (units_v1, mobile — mirrors web's
 * `OrderLineUnitPicker`: same contract, same `@routeflow/pricing`-backed option list, same
 * self-gating). Owns its own hooks (the flag + the product's ladder) so the caller's `.map()`
 * over cart/draft lines never calls a hook itself. Renders nothing unless the tenant has
 * `flag.units_v1` AND the product has levels — every other tenant/product sees today's row byte
 * for byte.
 *
 * Trigger + sheet, not a native `<select>` (mobile has none): mirrors the existing
 * Pressable-trigger-opens-OptionPickerSheet pattern (`ProductForm.tsx`'s regulated-type picker).
 */
export function UnitPickerRow({
  line,
  product,
  tier,
  onChange,
  style,
  startOnDefaultUnit = false,
}: {
  line: UnitPickerLine;
  /**
   * The REAL product's ladder inputs (pack unit/unitsPerBox + all 5 tier-price columns) —
   * SA-085f HIGH #2: a reconstructed mini-product built from the LINE's own fields (its
   * current listPrice, or a stored unit line's `unitsPerBox`, which the server snapshots as
   * the CHOSEN UNIT's own factor, not the pack's) silently mispriced every non-tier-1 customer
   * and every product with a level whose price derives from the pack. This must be the
   * product's own record, unclobbered by anything a line mutates.
   */
  product: LadderProduct;
  /** The EFFECTIVE tier for this product (`CustomerPrice.pricingTier ?? customer.pricingTier ?? 1`). */
  tier: number;
  onChange: (option: UnitOption) => void;
  /**
   * SA-085f LOW: spacing applied only when this control actually renders. A caller-side wrapper
   * View reserved this margin even with the flag off or a level-less product (self-gated below),
   * adding 2–8px of dead space to EVERY row for every tenant.
   */
  style?: StyleProp<ViewStyle>;
  /** #2784: a NEW line starts on the level flagged `isDefaultSelling` (once, never over a held unit). */
  startOnDefaultUnit?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const enabled = useUnitsEnabled();
  const { data: units } = useProductUnits(
    line.productId,
    enabled && !line.isUnlisted && !!line.productId,
  );
  // Only while STILL on the pack does `line.unitPrice` mean the pack's price — see the field doc.
  const packPrice = line.unitLabel ? undefined : line.unitPrice;
  const options = React.useMemo<UnitOption[]>(() => {
    if (!enabled || !units || units.length === 0) return [];
    try {
      return buildUnitOptions(product, units, tier, packPrice);
    } catch {
      return []; // display-only: a bad tier never blocks the cart (the server 400s on save)
    }
  }, [enabled, units, product, tier, packPrice]);

  const startedRef = React.useRef(false);
  React.useEffect(() => {
    if (!startOnDefaultUnit || startedRef.current || options.length <= 1 || !units) return;
    startedRef.current = true; // one shot per mount: a later choice is never re-overridden
    const start = defaultStartOption(product, units, tier, { hasUnit: !!line.unitLabel });
    if (start) onChange(start);
  }, [startOnDefaultUnit, options, units, product, tier, line.unitLabel, onChange]);

  // Mirrors web's UnitPicker: a product with no ladder (or only the pack) shows no control at all.
  if (options.length <= 1) return null;

  const selected = options.find((o) => o.value === (line.unitLabel ?? "")) ?? options[0]!;
  const pickerOptions: PickerOption[] = options.map((o) => ({
    id: o.value,
    label: o.label,
    subtitle: unitOptionDetail(o),
  }));

  return (
    <View style={style}>
      <Pressable
        style={styles.trigger}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`Sell by, currently ${selected.label}`}
      >
        <Text style={styles.triggerLabel}>Sell by</Text>
        <View style={styles.triggerValue}>
          <Text style={styles.triggerValueText} numberOfLines={1}>
            {selected.label}
          </Text>
          <Ionicons name="chevron-down" size={14} color={ios.label3} />
        </View>
      </Pressable>
      <OptionPickerSheet
        visible={open}
        title="Sell by"
        options={pickerOptions}
        selectedId={selected.value}
        onClose={() => setOpen(false)}
        onSelect={(opt) => {
          setOpen(false);
          const chosen = options.find((o) => o.value === opt.id);
          if (chosen) onChange(chosen);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  triggerLabel: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.label2 },
  triggerValue: { flexDirection: "row", alignItems: "center", gap: 4 },
  triggerValueText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
});
