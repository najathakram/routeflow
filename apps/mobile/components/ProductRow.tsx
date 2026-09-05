import * as React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { perUnitPrice } from "@routeflow/pricing";
import { QtyStepper } from "./QtyStepper";

export interface ProductRowProps {
  id: string;
  name: string;
  sku?: string | null;
  /** Loose-unit noun ("bottle"), shown when the product isn't case-packed. */
  unit?: string | null;
  unitsPerBox?: number | null;
  /** The customer's effective per-selling-unit price. */
  price: number;
  /** Catalog list price — struck through when `price` undercuts it. */
  listPrice: number;
  /** Total pieces on the line; 0 renders the add button instead of a stepper. */
  qty: number;
  onAdd: (id: string) => void;
  onChangeQty: (id: string, qty: number) => void;
  onIncrement: (id: string) => void;
  onDecrement: (id: string) => void;
  /** Case/unit entry band for a case-packed line that already has a qty. */
  children?: React.ReactNode;
}

/**
 * One catalog row in the sale builders: identity + price on the left, add or
 * adjust on the right. Case-packed lines get their entry band via `children`
 * so this stays presentational and free of line state.
 */
export const ProductRow = React.memo(function ProductRow({
  id,
  name,
  sku,
  unit,
  unitsPerBox,
  price,
  listPrice,
  qty,
  onAdd,
  onChangeQty,
  onIncrement,
  onDecrement,
  children,
}: ProductRowProps) {
  const upb = Number(unitsPerBox ?? 0);
  const isBoxed = upb > 1;
  const isSpecial = price < listPrice - 0.0001;
  // Display-only hint on the case price — never fed back into line math.
  const perUnitHint = isBoxed ? perUnitPrice(price, upb) : null;
  const showBand = isBoxed && qty > 0 && children != null;

  return (
    <View style={[styles.row, showBand && styles.rowStacked]}>
      <View style={styles.head}>
        <View style={styles.thumb} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.name} numberOfLines={1}>
            {name}
          </Text>
          {/* Clamped at 2, not 1: this legitimately wraps to two lines on
              native ("SKU X · $12.50 / case of 24 · ≈ $0.52/unit"). Unclamped,
              a squeezed web column renders it one character per line. */}
          <Text style={styles.meta} numberOfLines={2}>
            {sku ? `SKU ${sku} · ` : ""}
            {isSpecial ? <Text style={styles.metaWas}>${listPrice.toFixed(2)} </Text> : null}
            <Text style={isSpecial ? styles.metaSpecial : undefined}>${price.toFixed(2)}</Text>
            {isBoxed ? ` / case of ${upb}` : unit ? ` / ${unit}` : ""}
            {perUnitHint != null ? ` · ≈ $${perUnitHint.toFixed(2)}/unit` : ""}
          </Text>
        </View>
        {qty === 0 ? (
          <Pressable
            style={styles.addBtn}
            onPress={() => onAdd(id)}
            accessibilityRole="button"
            accessibilityLabel={`Add ${name}`}
          >
            <Text style={styles.addBtnText}>+</Text>
          </Pressable>
        ) : !isBoxed ? (
          <QtyStepper
            value={qty}
            onChangeQty={(n) => onChangeQty(id, n)}
            onIncrement={() => onIncrement(id)}
            onDecrement={() => onDecrement(id)}
          />
        ) : null}
      </View>

      {showBand ? <View style={styles.band}>{children}</View> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    backgroundColor: ios.bg,
    borderRadius: 14,
    padding: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  rowStacked: { flexDirection: "column", alignItems: "stretch" },
  head: { flexDirection: "row", alignItems: "center", gap: 12, width: "100%" },
  thumb: { width: 48, height: 48, borderRadius: 10, backgroundColor: ios.brandWash },
  name: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  meta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 1,
    fontVariant: ["tabular-nums"],
  },
  metaWas: { color: ios.label3, textDecorationLine: "line-through" },
  metaSpecial: { color: ios.brand, fontFamily: "Inter_600SemiBold" },
  addBtn: {
    width: 44,
    height: 44,
    backgroundColor: ios.brandWash,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  addBtnText: { color: ios.brand, fontSize: 22 },
  band: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 10,
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
});
