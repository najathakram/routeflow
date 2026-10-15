// #2340 prefactor: moved verbatim out of app/(operator)/(tabs)/orders/[id]/edit-items.tsx
// (size ratchet, plan #2328 R1). Behaviour-neutral — no logic changed in the move.
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { UnitPickerRow } from "../../components/UnitPickerRow";
import { unitPriceBase, type UnitOption } from "../../lib/unit-options";
import { priceUnitSuffix } from "../../lib/invoice-line-display";
import {
  classifyMargin,
  computeLineSubtotal,
  computeMarginFraction,
  effectiveQty,
  perUnitPrice,
} from "@routeflow/pricing";
import { marginFloorPrice } from "../../lib/margin-floor-price";
import { freeUnitsLabel } from "../../lib/buyer-cart-logic";
import { setLineUnits } from "../../lib/sale-line";
import {
  draftFreeUnits,
  ladderProductFor,
  startsOnDefaultUnit,
  type DraftItem,
} from "../../lib/edit-items-draft";
import { StepperRow } from "../../components/EditItemsStepperRow";
import { SellByToggle } from "../../components/SellByToggle";
import { canRemoveLooseUnits, looseUnitsVisible } from "../../lib/loose-units";
import { toNumber } from "../../lib/cart-line-state";
import { styles } from "./styles";

// ─── Per-row card ────────────────────────────────────────────────────────────

/**
 * Draft line as a card with three zones:
 *   ┌─────────────────────────────────────────────┐
 *   │ Name                            $line total │  ← header
 *   │ $unit · per box of N · SKU                  │  ← meta
 *   ├─────────────────────────────────────────────┤
 *   │ Boxes  [- 2 +]    Loose pieces  [- 3 +]     │  ← editor (boxed)
 *   │   or                                        │
 *   │ Qty    [- 4 +]                              │  ← editor (loose)
 *   ├─────────────────────────────────────────────┤
 *   │ [Sub]  [Override]  [trash]                  │  ← actions
 *   └─────────────────────────────────────────────┘
 *
 * The previous design crammed everything into one row + tiny trash + tiny
 * stepper, which the user called out as ugly and missing the box/piece
 * controls. This stacked layout gives each function room to breathe.
 */
export function DraftItemCard({
  item,
  canSplitBoxes,
  canEditPrice,
  pricingReady,
  tier,
  marginFloor,
  acked,
  onSetToFloor,
  onSellAnyway,
  onIncQty,
  onDecQty,
  onSetQty,
  onSetBoxes,
  onSetPieces,
  onSetUnits,
  onSetSellBy,
  onSetUnit,
  onSetNote,
  onPressPrice,
  onPressSubstitute,
  onRemove,
}: {
  item: DraftItem;
  canSplitBoxes: boolean;
  /** Price / discount editing is offered while the order is editable (DRAFT/PENDING/CONFIRMED). */
  canEditPrice: boolean;
  /** units_v1: the EFFECTIVE numeric tier for `UnitPickerRow` to resolve the ladder price at. */
  tier: number;
  /** B62 (REG-B62): false while the customer/customer-price queries are in
   *  flight — gates Substitute, which prices (and SENDS) the replacement line
   *  off the tier that isn't known yet. */
  pricingReady: boolean;
  /** Category margin floor (fraction) for the live cost/margin hint. */
  marginFloor: number;
  /** Whether this line was already acked as "sell anyway" below the floor. */
  acked: boolean;
  onSetToFloor: (price: number) => void;
  onSellAnyway: () => void;
  onIncQty: () => void;
  onDecQty: () => void;
  onSetQty: (n: number) => void;
  onSetBoxes: (n: number) => void;
  onSetPieces: (n: number) => void;
  /** Unit mode: total unit count, routed through setLineUnits. */
  onSetUnits: (n: number) => void;
  onSetSellBy: (sellBy: "case" | "unit") => void;
  /** units_v1: a `UnitPickerRow` choice, routed through setUnitLabel. */
  onSetUnit: (option: UnitOption) => void;
  onSetNote: (notes: string) => void;
  onPressPrice: () => void;
  onPressSubstitute: () => void;
  onRemove: () => void;
}) {
  const [noteOpen, setNoteOpen] = useState(Boolean(item.notes?.trim()));
  // units_v1: while a unit is active, `unitBasePrice` (that unit's own resolved tier price,
  // set alongside `unitPrice` by setUnitLabel) is the correct override-comparison base —
  // `catalogPrice` is the PACK's price, which a Case's price always differs from regardless of
  // any operator override — see lib/unit-options.ts#unitPriceBase.
  const priceBase = unitPriceBase(item, item.catalogPrice);
  const isOverridden = item.unitPrice !== priceBase;
  const isUpsell = item.unitPrice > priceBase;
  // Green for an upsell (sold above catalog), orange for a discount.
  const overrideColor = isUpsell ? ios.system.greenInk : ios.system.orangeInk;
  const upb = Number(item.unitsPerBox ?? 0);
  // units_v1: a unit-sold line is never boxed UI — see CartRow's identical gate.
  const isBoxed = upb > 1 && canSplitBoxes && !item.unitLabel;
  // #2698 (SA-564): one unit sold — loose units are opt-in, the same rule as CartRow.
  const [looseUnitsOpen, setLooseUnitsOpen] = useState(false);
  const showLoose = looseUnitsVisible(looseUnitsOpen, item.pieces);
  const sellBy = item.sellBy ?? "case";
  const qty = effectiveQty(item, item.unitsPerBox);
  const freeUnits = draftFreeUnits(item);
  const freeLabel = freeUnitsLabel(freeUnits);
  const lineTotal = computeLineSubtotal({
    unitPrice: item.unitPrice,
    qty,
    boxes: item.boxes ?? null,
    pieces: item.pieces ?? null,
    unitsPerBox: item.unitsPerBox ?? null,
    freeUnits,
  });

  // Live cost/margin hint (P10-POS-1) — hides entirely when cost is unknown
  // (product never sold yet). Mirrors NewOrderScreen's CartRow.
  const pieceCost = item.averageCost != null ? toNumber(item.averageCost) : null;
  const hasCost = pieceCost != null && Number.isFinite(pieceCost);
  const marginFrac = hasCost
    ? computeMarginFraction(item.unitPrice, pieceCost, item.unitsPerBox)
    : null;
  const marginClass = classifyMargin(marginFrac, marginFloor);
  // Same derivation the picker's last-added strip reads (one helper, two
  // surfaces) — unchanged behaviour: `classifyMargin` is null exactly when
  // the cost is unknown, which is exactly when `hasCost` is false.
  const floorPrice = marginFloorPrice(item, marginFloor);
  const below = marginClass === "belowCost" || marginClass === "belowFloor";
  // Display-only per-unit hint on the case price — never fed back into math.
  const perUnitHint = isBoxed ? perUnitPrice(item.unitPrice, upb) : null;

  return (
    <View style={styles.card}>
      {/* Header: name + line total */}
      <View style={styles.cardHeader}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.cardName} numberOfLines={2}>
            {item.name}
          </Text>
          {/* Meta line: unit price + box hint + override badge.
              Editable (tappable) on DRAFT/PENDING/CONFIRMED; read-only otherwise. */}
          <View style={styles.cardMetaRow}>
            {canEditPrice ? (
              <Pressable onPress={onPressPrice} style={styles.priceTap} hitSlop={6}>
                {isOverridden && !isUpsell ? (
                  <Text style={styles.priceStrike}>${priceBase.toFixed(2)}</Text>
                ) : null}
                <Text
                  style={[styles.cardMeta, isOverridden && { color: overrideColor }]}
                  numberOfLines={2}
                >
                  ${item.unitPrice.toFixed(2)}
                  {priceUnitSuffix(item, upb)}
                  {perUnitHint != null ? ` · ≈ $${perUnitHint.toFixed(2)}/unit` : ""}
                </Text>
                {isUpsell ? (
                  <Text style={{ color: ios.system.greenInk, fontSize: 11, fontWeight: "600" }}>
                    Upsell
                  </Text>
                ) : null}
                <Ionicons
                  name="pencil-outline"
                  size={11}
                  color={isOverridden ? overrideColor : ios.label3}
                />
              </Pressable>
            ) : (
              <View style={styles.priceTap}>
                {isOverridden && !isUpsell ? (
                  <Text style={styles.priceStrike}>${priceBase.toFixed(2)}</Text>
                ) : null}
                <Text
                  style={[styles.cardMeta, isOverridden && { color: overrideColor }]}
                  numberOfLines={2}
                >
                  ${item.unitPrice.toFixed(2)}
                  {priceUnitSuffix(item, upb)}
                  {perUnitHint != null ? ` · ≈ $${perUnitHint.toFixed(2)}/unit` : ""}
                </Text>
                {isUpsell ? (
                  <Text style={{ color: ios.system.greenInk, fontSize: 11, fontWeight: "600" }}>
                    Upsell
                  </Text>
                ) : null}
              </View>
            )}
          </View>
          {/* BUY_N_GET_M: name the free units, or the reduced line total reads
              as a pricing error (mirrors web's order/invoice line rows). */}
          {freeLabel ? <Text style={styles.freeLabel}>{freeLabel}</Text> : null}
        </View>
        <Text style={styles.cardTotal}>${lineTotal.toFixed(2)}</Text>
      </View>

      {/* Live margin hint (pos-cost-roles-spec §1) — margin on the current
          unit price vs. the product's cost. */}
      {marginFrac != null ? (
        <Text
          style={[
            styles.marginHint,
            marginClass === "belowCost" || marginClass === "belowFloor"
              ? { color: ios.system.red }
              : marginClass === "warn"
                ? { color: ios.system.orange }
                : { color: ios.label2 },
          ]}
        >
          {marginClass === "belowCost"
            ? `Below cost (${Math.round(marginFrac * 100)}%)`
            : marginClass === "belowFloor"
              ? `Below floor · ${Math.round(marginFrac * 100)}% margin`
              : `${Math.round(marginFrac * 100)}% margin`}
        </Text>
      ) : null}

      {/* Below-floor one-tap fix + ack — only while price editing is allowed. */}
      {canEditPrice && below && !acked && floorPrice != null ? (
        <View style={{ flexDirection: "row", gap: 10, marginTop: -4 }}>
          <Pressable onPress={() => onSetToFloor(floorPrice!)} style={styles.floorFixBtn}>
            <Text style={styles.floorFixBtnText}>Set to floor ${floorPrice.toFixed(2)}</Text>
          </Pressable>
          <Pressable onPress={onSellAnyway} hitSlop={6}>
            <Text style={styles.sellAnywayText}>Sell anyway</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Editor — a Cases/Units segmented control switches entry mode. Cases
          mode dials Boxes and Loose units independently; Units mode is a
          single uncapped total-unit stepper routed through setLineUnits. */}
      <UnitPickerRow
        line={{
          productId: item.productId,
          unitPrice: item.unitPrice,
          unitLabel: item.unitLabel,
          derivedBase: item.derivedBase,
        }}
        product={ladderProductFor(item)}
        tier={tier}
        // A line added this session starts on the product's default selling unit (once, never over a held unit).
        startOnDefaultUnit={startsOnDefaultUnit(item)}
        onChange={onSetUnit}
        style={{ marginBottom: isBoxed ? 2 : 8 }}
      />

      {isBoxed ? (
        <View style={{ gap: 8 }}>
          <SellByToggle value={sellBy} onChange={onSetSellBy} />
          {sellBy === "unit" ? (
            <StepperRow
              label={`Total ${item.unit ? `${item.unit}s` : "units"}`}
              value={qty}
              onChange={onSetUnits}
              hint={`${upb} per case`}
            />
          ) : (
            <>
              <StepperRow label="Cases" value={item.boxes ?? 0} onChange={onSetBoxes} />
              {showLoose ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <View style={{ flex: 1 }}>
                    <StepperRow
                      label="Extra loose units"
                      value={item.pieces ?? 0}
                      onChange={onSetPieces}
                      max={upb - 1}
                      hint={`${item.unit ?? "units"} · ${upb} per case`}
                    />
                  </View>
                  {canRemoveLooseUnits(item.boxes) ? (
                    <Pressable
                      onPress={() => {
                        onSetPieces(0);
                        setLooseUnitsOpen(false);
                      }}
                      hitSlop={8}
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 16,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: ios.fill,
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Remove extra units"
                    >
                      <Ionicons name="close" size={16} color={ios.label2} />
                    </Pressable>
                  ) : null}
                </View>
              ) : (
                <Pressable
                  onPress={() => setLooseUnitsOpen(true)}
                  hitSlop={8}
                  style={{
                    alignSelf: "flex-start",
                    paddingHorizontal: 12,
                    minHeight: 32,
                    justifyContent: "center",
                    borderRadius: 8,
                    borderWidth: 1,
                    borderStyle: "dashed",
                    borderColor: ios.separator,
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Add extra loose units"
                >
                  <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.brand }}>
                    + units
                  </Text>
                </Pressable>
              )}
            </>
          )}
        </View>
      ) : (
        <StepperRow
          label={`Qty${item.unitLabel ? ` (${item.unitLabel})` : item.unit ? ` (${item.unit})` : ""}`}
          value={item.qty}
          onChange={onSetQty}
          onIncrement={onIncQty}
          onDecrement={onDecQty}
          disabled={!!item.needsRepair}
          hint={item.needsRepair ? "Needs repair — the count can't be edited" : undefined}
        />
      )}

      {/* Flavor / note (R5.2) */}
      {noteOpen || item.notes?.trim() ? (
        <TextInput
          value={item.notes ?? ""}
          onChangeText={onSetNote}
          placeholder="Flavor or note for this item (prints on invoice)"
          placeholderTextColor={ios.label3}
          maxLength={2000}
          multiline
          style={styles.cartNoteInput}
        />
      ) : (
        <Pressable onPress={() => setNoteOpen(true)} hitSlop={6} style={styles.cartNoteAdd}>
          <Ionicons name="create-outline" size={14} color={ios.brand} />
          <Text style={styles.cartNoteAddText}>Add flavor / note</Text>
        </Pressable>
      )}

      {/* Actions */}
      <View style={styles.cardActions}>
        <Pressable
          style={[styles.actionChip, !pricingReady && styles.actionChipDisabled]}
          onPress={onPressSubstitute}
          disabled={!pricingReady}
          hitSlop={4}
        >
          <Ionicons name="swap-horizontal-outline" size={14} color={ios.brand} />
          <Text style={styles.actionChipText}>Substitute</Text>
        </Pressable>
        {canEditPrice ? (
          <Pressable
            style={[styles.actionChip, isOverridden && styles.actionChipActive]}
            onPress={onPressPrice}
            hitSlop={4}
          >
            <Ionicons
              name="pricetag-outline"
              size={14}
              color={isOverridden ? ios.system.orangeInk : ios.brand}
            />
            <Text style={[styles.actionChipText, isOverridden && { color: ios.system.orangeInk }]}>
              {isOverridden ? "Price overridden" : "Override price"}
            </Text>
          </Pressable>
        ) : null}
        <View style={{ flex: 1 }} />
        <Pressable style={styles.deleteBtn} onPress={onRemove} hitSlop={6}>
          <Ionicons name="trash-outline" size={16} color={ios.system.redInk} />
        </Pressable>
      </View>
    </View>
  );
}
