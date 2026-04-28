import React from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { ios } from "../../tokens";

export interface SegmentedControlProps {
  items: readonly string[];
  value: string;
  onChange: (v: string) => void;
  /** Optional — disable one of the items by label. */
  disabledItems?: readonly string[];
}

/** iOS-style segmented control — filled container with an active-pill + shadow. */
export function SegmentedControl({ items, value, onChange, disabledItems = [] }: SegmentedControlProps) {
  const isWeb = Platform.OS === "web";
  return (
    <View style={styles.container}>
      {items.map((item) => {
        const active = item === value;
        const disabled = disabledItems.includes(item);
        const itemStyle = [
          styles.item,
          active && styles.itemActive,
          disabled && styles.itemDisabled,
          isWeb && ({ cursor: disabled ? "default" : "pointer", userSelect: "none" } as any),
        ];
        if (isWeb) {
          // On web, RNW View forwards unknown props (e.g. onClick) to the underlying
          // DOM div, whereas Pressable silently drops them. Using View + onClick avoids
          // the double-click focus issue caused by RNW's responder system.
          return (
            <View
              key={item}
              style={itemStyle}
              {...({ onClick: () => !disabled && onChange(item) } as any)}
            >
              <Text style={[styles.label, active && styles.labelActive, disabled && styles.labelDisabled]} numberOfLines={1}>
                {item}
              </Text>
            </View>
          );
        }
        return (
          <Pressable
            key={item}
            style={itemStyle}
            onPressIn={() => !disabled && onChange(item)}
            disabled={disabled}
          >
            <Text style={[styles.label, active && styles.labelActive, disabled && styles.labelDisabled]} numberOfLines={1}>
              {item}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    backgroundColor: ios.fill3,
    borderRadius: 9,
    padding: 2,
  },
  item: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
    paddingVertical: 6,
    borderRadius: 7,
  },
  itemActive: {
    backgroundColor: ios.bgElev,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.12,
    shadowRadius: 3,
    elevation: 2,
  },
  itemDisabled: {
    opacity: 0.35,
  },
  label: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
    letterSpacing: -0.1,
  },
  labelActive: {
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
  },
  labelDisabled: {
    color: ios.label3,
  },
});
