import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { sanitizeIntInput } from "../lib/qty";
import { QTY_INPUT_WIDTH } from "../lib/row-layout";

/**
 * The Boxes / Pieces / Qty stepper row of the operator order edit-items screen. Moved verbatim out
 * of app/(operator)/(tabs)/orders/[id]/edit-items.tsx (size ratchet, SA-065), with its styles.
 */
export function StepperRow({
  label,
  value,
  onChange,
  onIncrement,
  onDecrement,
  max,
  hint,
  disabled = false,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  onIncrement?: () => void;
  onDecrement?: () => void;
  max?: number;
  hint?: string;
  /** #2232: a LOCKED unit line (needsRepair) — no count can be edited; shown dimmed. */
  disabled?: boolean;
}) {
  // Local draft so the user can clear the input without it snapping back to 0.
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
    <View style={styles.stepperRow}>
      <View style={{ flex: 1 }}>
        {/* Clamped: unclamped, a squeezed column renders the label one letter
            per line on react-native-web. See lib/row-layout.ts. */}
        <Text style={styles.stepperLabel} numberOfLines={1}>
          {label}
        </Text>
        {hint ? (
          <Text style={styles.stepperHint} numberOfLines={1}>
            {hint}
          </Text>
        ) : null}
      </View>
      <View
        style={[styles.stepper, disabled && { opacity: 0.4 }]}
        accessibilityState={{ disabled }}
      >
        <Pressable style={styles.stepBtn} onPress={dec} hitSlop={6} disabled={disabled}>
          <Text style={styles.stepText}>−</Text>
        </Pressable>
        <TextInput
          style={styles.qtyInput}
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
            if (draft === "") onChange(0);
            setDraft(String(value));
          }}
          keyboardType="number-pad"
          returnKeyType="done"
          maxLength={5}
          selectTextOnFocus
          editable={!disabled}
        />
        <Pressable style={styles.stepBtn} onPress={inc} hitSlop={6} disabled={disabled}>
          <Text style={styles.stepText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  stepperLabel: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.label,
  },
  stepperHint: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: ios.label3,
    marginTop: 1,
  },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: ios.fill3,
    borderRadius: 10,
    padding: 3,
  },
  stepBtn: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  stepText: { color: ios.brand, fontSize: 18 },
  qtyInput: {
    // Definite width, not minWidth — see lib/row-layout.ts. This is a
    // hand-rolled copy of QtyStepper; it needs the same bound.
    width: QTY_INPUT_WIDTH.edit,
    flexShrink: 0,
    paddingHorizontal: 4,
    textAlign: "center",
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
    paddingVertical: 2,
  },
});
