import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { sanitizeIntInput } from "../lib/qty";
import { QTY_INPUT_WIDTH } from "../lib/row-layout";

/**
 * Moved out of NewOrderScreen.tsx (size-ratchet, alongside CartRow) — verbatim, no logic
 * changes. Shared by CartRow and UnlistedCartRow (NewOrderScreen.tsx).
 */
export function CartStepperRow({
  label,
  value,
  onChange,
  onIncrement,
  onDecrement,
  max,
  hint,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  onIncrement?: () => void;
  onDecrement?: () => void;
  max?: number;
  hint?: string;
}) {
  // Local string state so the user can clear the input mid-edit without it
  // snapping back to "0". Synced to `value` whenever the parent updates it
  // (e.g. via the stepper buttons or another row affecting the line state).
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const dec = () => {
    if (onDecrement) onDecrement();
    else onChange(Math.max(0, value - 1));
  };
  const inc = () => {
    if (onIncrement) onIncrement();
    else {
      const next = max != null ? Math.min(max, value + 1) : value + 1;
      onChange(next);
    }
  };

  return (
    <View style={styles.cartStepperRow}>
      <View style={{ flex: 1 }}>
        {/* Clamped: unclamped, a squeezed column renders "Qty (Jar)" one
            letter per line on react-native-web. See lib/row-layout.ts. */}
        <Text style={styles.cartStepperLabel} numberOfLines={1}>
          {label}
        </Text>
        {hint ? (
          <Text style={styles.cartStepperHint} numberOfLines={1}>
            {hint}
          </Text>
        ) : null}
      </View>
      <View style={styles.stepper}>
        <Pressable style={styles.stepBtn} onPress={dec} hitSlop={6}>
          <Text style={styles.stepBtnText}>−</Text>
        </Pressable>
        <TextInput
          style={styles.cartStepperInput}
          value={draft}
          onChangeText={(txt) => {
            // Integer-only: strip non-digits + leading zeros live (no "05", no
            // decimals even when Android shows a decimal key); allow empty mid-edit.
            const clean = sanitizeIntInput(txt);
            setDraft(clean);
            if (clean === "") return;
            const n = parseInt(clean, 10);
            if (Number.isFinite(n)) {
              const clamped = max != null ? Math.min(max, n) : n;
              onChange(clamped);
            }
          }}
          onBlur={() => {
            // Empty input → commit 0 (which removes the line if both fields are 0)
            if (draft === "") onChange(0);
            setDraft(String(value));
          }}
          keyboardType="number-pad"
          returnKeyType="done"
          maxLength={5}
          selectTextOnFocus
        />
        <Pressable style={styles.stepBtn} onPress={inc} hitSlop={6}>
          <Text style={styles.stepBtnText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: ios.bgElev,
    borderRadius: 10,
    padding: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
  },
  stepBtn: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  stepBtnText: { color: ios.brand, fontSize: 18 },
  cartStepperRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  cartStepperLabel: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: ios.label,
  },
  cartStepperHint: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: ios.label3,
    marginTop: 1,
  },
  cartStepperInput: {
    // Definite width, not minWidth — see lib/row-layout.ts for why.
    width: QTY_INPUT_WIDTH.cart,
    flexShrink: 0,
    paddingHorizontal: 6,
    paddingVertical: 4,
    textAlign: "center",
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
});
