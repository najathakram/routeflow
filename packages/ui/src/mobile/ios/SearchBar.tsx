import React from "react";
import { Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "../../tokens";

export interface SearchBarProps {
  value?: string;
  onChangeText?: (s: string) => void;
  placeholder?: string;
  /** Optional right-aligned accessory (e.g. barcode/filter icon). */
  trailing?: React.ReactNode;
  /**
   * Enter/submit handler — hardware (wedge) barcode scanners type the code
   * then send Enter, so scan-aware consumers treat submit as "scan complete".
   * When set, the field KEEPS FOCUS on submit (blurOnSubmit false) so the
   * next wedge scan lands in the same box without a tap.
   */
  onSubmitEditing?: () => void;
}

export function SearchBar({
  value,
  onChangeText,
  placeholder = "Search",
  trailing,
  onSubmitEditing,
}: SearchBarProps) {
  return (
    <View style={styles.wrap}>
      <Ionicons name="search" size={16} color={ios.gray[1]} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={ios.gray[1]}
        style={styles.input}
        clearButtonMode="while-editing"
        onSubmitEditing={onSubmitEditing}
        blurOnSubmit={onSubmitEditing ? false : undefined}
        returnKeyType={onSubmitEditing ? "search" : undefined}
      />
      {/* clearButtonMode is iOS-NATIVE only — a no-op on Android and
          react-native-web (the primary operator surface), which previously had
          no one-tap clear at all. Skipped on iOS native, where the built-in
          clear button already shows (two Xs otherwise). Rendered before
          `trailing` so the scan icon keeps its edge position. */}
      {Platform.OS !== "ios" && value && onChangeText ? (
        <Pressable
          onPress={() => onChangeText("")}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Clear search"
        >
          <Ionicons name="close-circle" size={18} color={ios.gray[1]} />
        </Pressable>
      ) : null}
      {trailing}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginHorizontal: 16,
    marginVertical: 10,
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  input: {
    flex: 1,
    // Inert on native (Yoga's min-size for a flex item is already 0). On
    // react-native-web it neutralises the <input>'s `min-width: auto`, so the
    // field can shrink instead of pushing a trailing accessory off the row.
    minWidth: 0,
    fontSize: 17,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    paddingVertical: 0,
  },
});
