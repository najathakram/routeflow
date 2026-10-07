import * as React from "react";
import { StyleSheet, Text, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { Pill } from "@routeflow/ui/mobile/ios";
import type { OrderLineCardModel } from "../lib/order-line-display";

/**
 * One operator order-detail line as a card (order-ui-redesign-spec §3, T8 — the RN mirror of web's
 * `LineItemRowReadOnly`). Layout only: every string, tag and total comes from
 * `orderLineCardModel` (pure, unit-tested), so this file holds no business logic.
 *
 * The name is the point of the redesign: the family STEM clamps to 2 lines head-first, and the
 * flavor / pack ANCHOR is never given `numberOfLines` (the old row's `numberOfLines={1}` cut the
 * tail — exactly the part that tells two SKUs apart). A flat name with no separator gets a plain
 * 3-line clamp.
 */
export function OrderLineCard({
  model,
  first,
}: {
  model: OrderLineCardModel;
  /** No top hairline on the first row. */
  first?: boolean;
}) {
  const { stem, anchor } = model;
  return (
    <View
      style={[
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: ios.separator },
        model.cancelled && styles.cancelled,
      ]}
      // One spoken sentence per line (`model.spoken`). `accessible`
      // makes the row a single element (a plain View is skipped by VoiceOver, and its label with it).
      accessible
      accessibilityLabel={model.spoken}
    >
      <View style={styles.body}>
        {stem ? (
          <Text style={[styles.stem, model.cancelled && styles.struck]} numberOfLines={2}>
            {stem}
          </Text>
        ) : null}
        <Text
          style={[styles.anchor, model.cancelled && styles.struck]}
          {...(stem ? {} : { numberOfLines: 3 })}
        >
          {anchor}
        </Text>
        {model.sku ? <Text style={styles.sku}>SKU {model.sku}</Text> : null}
        {model.custom ? (
          <View style={styles.customTag}>
            <Text style={styles.customTagText}>Custom</Text>
          </View>
        ) : null}
        {model.backorderPieces > 0 ? (
          <View style={styles.customTag} testID="line-backorder-tag">
            <Text style={styles.customTagText}>Backorder</Text>
          </View>
        ) : null}
        <Text style={styles.sub}>{model.qtyPriceLine}</Text>
        {model.tag ? (
          <View style={styles.tagRow}>
            {model.tag.originalText ? (
              <Text style={[styles.sub, styles.struck]}>{model.tag.originalText}</Text>
            ) : null}
            <Text
              style={[
                styles.tag,
                { color: model.tag.tone === "green" ? ios.system.greenInk : ios.system.orangeInk },
              ]}
            >
              {model.tag.label}
            </Text>
          </View>
        ) : null}
        {model.freeLabel ? <Text style={styles.free}>{model.freeLabel}</Text> : null}
        {model.deliveryText ? <Text style={styles.sub}>{model.deliveryText}</Text> : null}
        {model.note ? (
          <Text style={[styles.sub, { fontStyle: "italic" }]} numberOfLines={2}>
            {model.note}
          </Text>
        ) : null}
        {model.subLines?.map((text, i) => (
          <Text key={i} style={styles.sub} testID="line-component-sub-line">
            {text}
          </Text>
        ))}
        {model.status ? (
          <View style={{ marginTop: 6, alignSelf: "flex-start" }}>
            <Pill variant={model.status.variant} small dot={false}>
              {model.status.label}
            </Pill>
          </View>
        ) : null}
      </View>
      <Text style={[styles.total, model.total == null && { color: ios.label3 }]}>
        {model.total ?? "—"}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 10 },
  cancelled: { opacity: 0.5 },
  body: { flex: 1, minWidth: 0 },
  stem: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  anchor: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  struck: { textDecorationLine: "line-through" },
  sku: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label3, marginTop: 2 },
  sub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  tagRow: { flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 2 },
  tag: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  free: { fontSize: 11, fontFamily: "Inter_600SemiBold", color: ios.brand, marginTop: 2 },
  customTag: {
    alignSelf: "flex-start",
    backgroundColor: ios.system.orangeWash,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginTop: 4,
  },
  customTagText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.system.orangeInk,
    letterSpacing: 0.2,
  },
  total: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
});
