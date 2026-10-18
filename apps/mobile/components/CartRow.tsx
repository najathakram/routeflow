import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import {
  classifyMargin,
  computeLineSubtotal,
  computeMarginFraction,
  costPerSellingUnit,
  effectiveQty,
  priceForMarginFloor,
} from "@routeflow/pricing";
import { displayProductName as displayName } from "../lib/product-display";
import { marginFactorFor, unitPriceBase, type UnitOption } from "../lib/unit-options";
import { MONEY_INPUT_MAX_WIDTH } from "../lib/row-layout";
import { effectiveUnitPrice, toNumber, type LineState, type Product } from "../lib/cart-line-state";
import { isPendingDefaultUnit } from "../lib/default-unit-line";
import { MoneyTextInput } from "./MoneyTextInput";
import { SellByToggle } from "./SellByToggle";
import { CostHistorySheet } from "./CostHistorySheet";
import { UnitPickerRow } from "./UnitPickerRow";
import { CartStepperRow } from "./CartStepperRow";
import { canRemoveLooseUnits, looseUnitsVisible } from "../lib/loose-units";

/**
 * Moved out of NewOrderScreen.tsx (size-ratchet: that file was 3 lines under its cap before
 * this branch's UnitPickerRow mount, then went 91 over) — verbatim, no logic changes.
 */
export function CartRow({
  product,
  line,
  catalogPrice,
  isSpecial,
  tier,
  layerUnitBase,
  pricesUnconfirmed,
  marginFloor,
  historyPrice,
  onChangeBoxes,
  onChangePieces,
  onChangeUnits,
  onChangeSellBy,
  onChangeUnit,
  onChangeQty,
  onChangePrice,
  onChangeNote,
  onToggleNote,
  showCostEye,
  acked,
  onSellAnyway,
  onIncrement,
  onDecrement,
  onRemove,
}: {
  product: Product;
  line: LineState;
  /** The customer's effective tier price for this product (the base to compare
   *  an override against and to fall back to when no override is set). */
  catalogPrice: number;
  /** SPECIAL (tier≠1) price: the input is locked and overrides are ignored. */
  isSpecial: boolean;
  /** units_v1: the EFFECTIVE numeric tier for `UnitPickerRow` to resolve the ladder price at. */
  tier: number;
  /** S19b: a unit line whose unit is in the customer's price layer compares against THAT price, not the pack-level `catalogPrice`. */
  layerUnitBase?: number;
  /** S19b: the layer is not confirmed, so the unit picker shows an ellipsis and stays closed. */
  pricesUnconfirmed?: boolean;
  /** Category margin floor (fraction) for the live cost/margin hint. */
  marginFloor: number;
  historyPrice?: number;
  onChangeBoxes: (n: number) => void;
  onChangePieces: (n: number) => void;
  /** Unit mode: total unit count, routed through setLineUnits. */
  onChangeUnits: (n: number) => void;
  onChangeSellBy: (sellBy: "case" | "unit") => void;
  /** units_v1: a `UnitPickerRow` choice, routed through setUnitLabel. */
  onChangeUnit: (option: UnitOption) => void;
  onChangeQty: (n: number) => void;
  onChangePrice: (value: number | null) => void;
  onChangeNote: (text: string) => void;
  onToggleNote: () => void;
  showCostEye: boolean;
  /** Whether this line was already acked as "sell anyway" below the floor. */
  acked: boolean;
  onSellAnyway: () => void;
  onIncrement: () => void;
  onDecrement: () => void;
  onRemove: () => void;
}) {
  const upb = Number(product.unitsPerBox ?? 0);
  // units_v1: a unit-sold line is never boxed UI — its qty is a plain count and unitPrice is
  // already per-unit (boxes/pieces are cleared by setUnitLabel), so it renders through the same
  // non-boxed branch a factor-1 product does.
  const isBoxed = upb > 1 && !line.unitLabel;
  const sellBy = line.sellBy ?? "case";
  // units_v1: see lib/unit-options.ts#unitPriceBase.
  const priceBase = layerUnitBase ?? unitPriceBase(line, catalogPrice);
  const effUnit = isSpecial ? priceBase : effectiveUnitPrice(line, priceBase);
  const isOverridden = !isSpecial && line.unitPrice != null && line.unitPrice !== priceBase;
  const qty = effectiveQty(line, product.unitsPerBox);
  const lineTotal = computeLineSubtotal({
    unitPrice: effUnit,
    qty,
    boxes: line.boxes ?? null,
    pieces: line.pieces ?? null,
    unitsPerBox: product.unitsPerBox ?? null,
  });

  // Cost eye + live margin hint (mirror web): both read one per-piece cost —
  // averageCost, else standardCost. Cost eye is hidden by default (session-local);
  // the margin pill (classifyMargin vs the category floor) hides when no cost.
  const [costVisible, setCostVisible] = useState(false);
  // #2698 (#2696(d) parity): one unit sold — loose units on a Case line are opt-in.
  const [looseUnitsOpen, setLooseUnitsOpen] = useState(false);
  const showLooseUnits = looseUnitsVisible(looseUnitsOpen, line.pieces);
  const pieceCost =
    product.averageCost != null
      ? toNumber(product.averageCost)
      : product.standardCost != null
        ? toNumber(product.standardCost)
        : null;
  // 0 is a real cost; only null hides the eye/hint entirely.
  const hasCost = pieceCost != null && Number.isFinite(pieceCost);
  // units_v1 (SA-085f HIGH #3): a unit-sold line's cost basis is the CHOSEN unit's own
  // factor, never the pack's unitsPerBox — see lib/unit-options.ts#marginFactorFor.
  const marginFactor = marginFactorFor(line, product.unitsPerBox);
  const sellingUnitCost = hasCost ? costPerSellingUnit(pieceCost!, marginFactor) : null;
  const marginFrac = hasCost ? computeMarginFraction(effUnit, pieceCost, marginFactor) : null;
  const marginClass = classifyMargin(marginFrac, marginFloor);
  // Negotiation floor (pos-cost-roles-spec §1): the one-tap fix price + the
  // below-floor/below-cost gate. `historyOpen` opens the cost-tap sheet.
  const [historyOpen, setHistoryOpen] = useState(false);
  const floorPrice =
    hasCost && marginClass != null
      ? priceForMarginFloor(pieceCost!, marginFloor, marginFactor)
      : null;
  const below = marginClass === "belowCost" || marginClass === "belowFloor";

  return (
    <View style={styles.cartRow}>
      <View style={styles.cartRowHeader}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.cartRowName} numberOfLines={2}>
            {displayName(product)}
          </Text>
          <Text style={styles.cartRowMeta} numberOfLines={1}>
            {isBoxed ? `case of ${upb}` : product.unit ? `per ${product.unit}` : ""}
            {product.sku ? `${isBoxed || product.unit ? " · " : ""}${product.sku}` : ""}
          </Text>
          {/* R5/B195: an archived product is kept on the order (it is still
              orderable) — flagged, never silently deleted on draft-resume. */}
          {product.isActive === false ? (
            <Text style={styles.cartRowArchived} numberOfLines={1}>
              Archived — no longer in the catalog
            </Text>
          ) : null}
        </View>
        <Pressable onPress={onRemove} hitSlop={8} style={styles.cartRowRemove}>
          <Ionicons name="trash-outline" size={18} color={ios.system.redInk} />
        </Pressable>
      </View>

      {/* Editable price — the "discounted price". Defaults to the catalog price;
          typing a lower value records a one-time override sent as the line's
          unitPrice. SPECIAL (tier≠1) lines lock it (web parity: the input is
          hidden there — a tier price is the customer's permanent price). */}
      <View style={styles.cartPriceRow}>
        <Text style={styles.cartPriceLabel}>Price{isBoxed ? " / case" : ""}</Text>
        <View style={styles.cartPriceInputWrap}>
          <Text style={styles.cartPriceCurrency}>$</Text>
          {isSpecial ? (
            <>
              <Text style={styles.cartPriceFixed}>{priceBase.toFixed(2)}</Text>
              <Text style={styles.cartPriceLockNote} numberOfLines={1}>
                Customer price
              </Text>
            </>
          ) : (
            <>
              <MoneyTextInput
                style={[styles.cartPriceInput, isOverridden && styles.cartPriceInputActive]}
                value={line.unitPrice ?? null}
                onChangeValue={onChangePrice}
                placeholder={priceBase.toFixed(2)}
                returnKeyType="done"
              />
              {isOverridden && line.unitPrice != null && line.unitPrice > priceBase ? (
                <Text
                  style={{ color: ios.system.greenInk, fontSize: 11, fontWeight: "600" }}
                  numberOfLines={1}
                >
                  Upsell
                </Text>
              ) : isOverridden ? (
                <Text style={styles.cartPriceWas} numberOfLines={1}>
                  Current: ${priceBase.toFixed(2)}
                </Text>
              ) : !line.unitLabel && historyPrice != null && historyPrice !== catalogPrice ? (
                <Text style={styles.cartPriceWas} numberOfLines={1}>
                  Last: ${historyPrice.toFixed(2)}
                </Text>
              ) : null}
            </>
          )}
        </View>
      </View>

      {/* Live margin hint — margin on the effective price vs the product's cost. */}
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

      {/* Below-floor one-tap fix + ack, mirrors web MarginHint. */}
      {below && !acked && floorPrice != null ? (
        <View style={{ flexDirection: "row", gap: 10, marginTop: 2 }}>
          <Pressable onPress={() => onChangePrice(floorPrice!)} style={styles.floorFixBtn}>
            <Text style={styles.floorFixBtnText}>Set to floor ${floorPrice.toFixed(2)}</Text>
          </Pressable>
          <Pressable onPress={onSellAnyway} hitSlop={6}>
            <Text style={styles.sellAnywayText}>Sell anyway</Text>
          </Pressable>
        </View>
      ) : null}

      <UnitPickerRow
        line={{
          productId: product.id,
          unitPrice: effUnit,
          unitLabel: line.unitLabel,
          derivedBase: line.derivedBase,
        }}
        product={product}
        tier={tier}
        // Only while no qty/price edit consumed the flag (the screen clears it) and no operator price (Opus #2865 B2/r2).
        startOnDefaultUnit={isPendingDefaultUnit(line)}
        pricesUnconfirmed={pricesUnconfirmed}
        onChange={onChangeUnit}
        style={{ marginBottom: isBoxed ? 2 : 8 }}
      />

      {isBoxed ? (
        <>
          <View style={{ marginBottom: 2 }}>
            <SellByToggle value={sellBy} onChange={onChangeSellBy} />
          </View>
          {sellBy === "unit" ? (
            <CartStepperRow
              label={`Total ${product.unit ? `${product.unit}s` : "units"}`}
              value={qty}
              onChange={onChangeUnits}
              hint={`${upb} per case`}
            />
          ) : (
            <>
              <CartStepperRow label="Cases" value={line.boxes ?? 0} onChange={onChangeBoxes} />
              {showLooseUnits ? (
                <View style={styles.looseRow}>
                  <View style={{ flex: 1 }}>
                    <CartStepperRow
                      label="Extra loose units"
                      value={line.pieces ?? 0}
                      onChange={onChangePieces}
                      max={upb - 1}
                      hint={`${product.unit ?? "units"} · ${upb} per case`}
                    />
                  </View>
                  {canRemoveLooseUnits(line.boxes) ? (
                    <Pressable
                      onPress={() => {
                        onChangePieces(0);
                        setLooseUnitsOpen(false);
                      }}
                      hitSlop={8}
                      style={styles.looseRemove}
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
                  style={styles.looseAdd}
                  accessibilityRole="button"
                  accessibilityLabel="Add extra loose units"
                >
                  <Text style={styles.looseAddText}>+ units</Text>
                </Pressable>
              )}
            </>
          )}
        </>
      ) : (
        <CartStepperRow
          label={`Qty${line.unitLabel ? ` (${line.unitLabel})` : product.unit ? ` (${product.unit})` : ""}`}
          value={line.qty ?? 0}
          onChange={onChangeQty}
          onIncrement={onIncrement}
          onDecrement={onDecrement}
        />
      )}

      {/* Cost eye — OFF by default; reveals the selling-unit cost + margin.
          Once visible, the cost text itself is tappable → cost history sheet. */}
      {showCostEye && hasCost ? (
        <View style={styles.cartNoteAdd}>
          <Pressable
            onPress={() => setCostVisible((v) => !v)}
            hitSlop={6}
            style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
          >
            <Ionicons
              name={costVisible ? "eye-off-outline" : "eye-outline"}
              size={14}
              color={costVisible ? ios.label2 : ios.brand}
            />
            {!costVisible ? <Text style={styles.cartNoteAddText}>Cost</Text> : null}
          </Pressable>
          {costVisible ? (
            <Pressable onPress={() => setHistoryOpen(true)} hitSlop={6}>
              <Text style={styles.cartCostText}>
                Cost ${sellingUnitCost!.toFixed(2)}
                {isBoxed ? " / box" : ""}
                {marginFrac != null ? ` · ${(marginFrac * 100).toFixed(1)}%` : ""}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* Per-line note — carried onto the invoice line (buyer-visible). */}
      {line.noteOpen || line.note?.trim() ? (
        <TextInput
          value={line.note ?? ""}
          onChangeText={onChangeNote}
          placeholder="Flavor or note for this item (prints on invoice)"
          placeholderTextColor={ios.label3}
          maxLength={2000}
          multiline
          style={styles.cartNoteInput}
        />
      ) : (
        <Pressable onPress={onToggleNote} hitSlop={6} style={styles.cartNoteAdd}>
          <Ionicons name="create-outline" size={14} color={ios.brand} />
          <Text style={styles.cartNoteAddText}>Add flavor / note</Text>
        </Pressable>
      )}

      <View style={styles.cartRowFooter}>
        <Text style={styles.cartRowFooterLabel}>Line total</Text>
        <Text style={styles.cartRowFooterValue}>${lineTotal.toFixed(2)}</Text>
      </View>

      <CostHistorySheet
        visible={historyOpen}
        productId={product.id}
        onClose={() => setHistoryOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  cartRow: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 12,
    gap: 10,
  },
  cartRowHeader: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  cartRowName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  cartRowMeta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 2,
    fontVariant: ["tabular-nums"],
  },
  cartRowArchived: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.system.orangeInk,
    marginTop: 2,
  },
  cartRowRemove: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: ios.fill3,
    alignItems: "center",
    justifyContent: "center",
  },
  cartPriceRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  cartPriceLabel: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: ios.label,
  },
  cartPriceInputWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    // Let the wrap give ground before the row overflows. Only binds when the
    // row is already over-subscribed, which on a narrow phone it can be.
    flexShrink: 1,
    minWidth: 0,
  },
  cartPriceCurrency: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },
  cartPriceInput: {
    minWidth: 70,
    // Caps the web intrinsic width (~177px) without capping native, where
    // "99999.99" at 15px is ~84px and this never binds. Paired with
    // flexShrink: 0 so the shrinkable wrap above can't collapse the field.
    maxWidth: MONEY_INPUT_MAX_WIDTH,
    flexShrink: 0,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
    borderRadius: 8,
    textAlign: "right",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  cartPriceInputActive: { borderColor: ios.brand, color: ios.brand },
  // SPECIAL-line locked price: same weight as the input's text, no field chrome.
  cartPriceFixed: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  cartPriceLockNote: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    flexShrink: 1,
  },
  marginHint: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    marginTop: -4,
    marginBottom: 2,
    textAlign: "right",
  },
  cartPriceWas: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textDecorationLine: "line-through",
    flexShrink: 1,
  },
  floorFixBtn: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.system.red,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  floorFixBtnText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.system.redInk,
  },
  sellAnywayText: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
    textDecorationLine: "underline",
  },
  cartCostText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
    fontVariant: ["tabular-nums"],
  },
  // cartNoteAdd/cartNoteAddText are also defined in NewOrderScreen.tsx's own styles —
  // UnlistedCartRow (which stayed behind) uses them too. Duplicated here rather than
  // shared, since the two are simple style-value constants (see PR body).
  cartNoteAdd: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
  },
  cartNoteAddText: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.brand },
  cartNoteInput: {
    backgroundColor: ios.fill3,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    marginBottom: 6,
  },
  cartRowFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  cartRowFooterLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
  },
  cartRowFooterValue: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  // #2698: the opt-in loose-units control (dashed, small) and its remove button.
  looseRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  looseRemove: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: ios.fill,
  },
  looseAdd: {
    alignSelf: "flex-start",
    marginTop: 2,
    marginBottom: 6,
    paddingHorizontal: 12,
    minHeight: 32,
    justifyContent: "center",
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: ios.separator,
  },
  looseAddText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.brand },
});
