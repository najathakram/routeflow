import React from "react";
import { Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { ios } from "../../tokens";

export interface FilterChip {
  label: string;
  /** Optional count rendered as " · N". */
  count?: number | string;
}

export interface FilterChipRowProps {
  chips: readonly FilterChip[];
  value: string;
  onChange: (label: string) => void;
  /** Horizontal padding outside the scroll view. */
  paddingHorizontal?: number;
}

/** Horizontal scrolling filter chips — active = brand fill + white text. */
export function FilterChipRow({
  chips,
  value,
  onChange,
  paddingHorizontal = 16,
}: FilterChipRowProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.row}
      contentContainerStyle={[styles.contents, { paddingHorizontal }]}
    >
      {chips.map((c) => {
        const active = c.label === value;
        return (
          <Pressable
            key={c.label}
            onPress={() => onChange(c.label)}
            style={[styles.chip, active ? styles.chipActive : styles.chipInactive]}
          >
            <Text style={[styles.label, active ? styles.labelActive : styles.labelInactive]}>
              {c.label}
              {c.count !== undefined ? ` · ${c.count}` : ""}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: {
    height: 44,
    // ScrollView's BASE style is `{ flexGrow: 1, flexShrink: 1 }` — identically in
    // React Native core and react-native-web. All three of these are required:
    //
    //   flexShrink: 0  stops the row collapsing to nothing when the parent is
    //                  over-subscribed (added in 56f582c8 — the chip strip went
    //                  invisible on the invoices/expenses lists).
    //   flexGrow: 0    stops the row GROWING to eat every spare pixel. `height`
    //                  is not a cap — only max-height is — so flex-basis resolves
    //                  to 44px and grow takes it from there. Beside a `flex: 1`
    //                  list the two split the free space 50/50, and because
    //                  `contents` centres vertically you get a ~290px band with
    //                  the chips floating in the middle of it (the owner's "the
    //                  top menu moves down" on New order).
    //   height: 44     the actual row height, once neither of the above applies.
    //
    // Don't reach for an alignment fix instead: ScrollView throws a dev invariant
    // if `alignItems`/`justifyContent` appear in its `style` prop.
    flexGrow: 0,
    flexShrink: 0,
  },
  contents: {
    gap: 8,
    paddingVertical: 8,
    alignItems: "center",
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    minHeight: 28,
    alignSelf: "center",
    justifyContent: "center",
  },
  chipActive: {
    backgroundColor: ios.brand,
  },
  chipInactive: {
    backgroundColor: ios.fill3,
  },
  label: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    letterSpacing: -0.1,
  },
  labelActive: {
    color: "#fff",
  },
  labelInactive: {
    color: ios.label,
  },
});
