import React, { useState } from "react";
import { StyleSheet, Text, TextInput, type TextInputProps, View } from "react-native";
import { colors, borderRadius } from "../tokens";

export type KeyboardTypeOption = "default" | "numeric" | "email-address" | "phone-pad";

export interface MobileInputProps extends Omit<TextInputProps, "keyboardType"> {
  label?: string;
  error?: string;
  keyboardType?: KeyboardTypeOption;
}

export function MobileInput({
  label,
  error,
  keyboardType = "default",
  style,
  ...props
}: MobileInputProps) {
  const [focused, setFocused] = useState(false);

  return (
    <View style={styles.wrapper}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput
        keyboardType={keyboardType}
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          setFocused(false);
          props.onBlur?.(e);
        }}
        placeholderTextColor={colors.surface.border}
        style={[styles.input, focused && styles.inputFocused, !!error && styles.inputError, style]}
        {...props}
      />
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    gap: 4,
  },
  label: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
    marginBottom: 2,
  },
  input: {
    height: 44,
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.DEFAULT,
    paddingHorizontal: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    backgroundColor: "#fff",
  },
  inputFocused: {
    borderColor: colors.brand[500],
    borderWidth: 1.5,
  },
  inputError: {
    borderColor: colors.danger.DEFAULT,
  },
  errorText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: colors.danger.DEFAULT,
    marginTop: 2,
  },
});
