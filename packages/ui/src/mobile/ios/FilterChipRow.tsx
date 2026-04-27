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
