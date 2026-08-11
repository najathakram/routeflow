import { Pressable, StyleSheet, Text, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";

export type SellBy = "case" | "unit";

/**
 * Compact Cases/Units segmented control for a case-packed line's qty entry mode.
 *
 * Extracted from NewOrderScreen and edit-items, which each carried a copy —
 * edit-items' track was `fill3` with no border; this canonical version keeps
 * NewOrderScreen's `bgElev` + hairline treatment (matches the QtyStepper pill).
 */
export function SellByToggle({
  value,
  onChange,
}: {
  value: SellBy;
  onChange: (v: SellBy) => void;
}) {
  return (
    <View style={styles.segment}>
      {(["case", "unit"] as const).map((opt) => (
        <Pressable
          key={opt}
          onPress={() => onChange(opt)}
          style={[styles.btn, value === opt && styles.btnActive]}
          accessibilityRole="button"
          accessibilityState={value === opt ? { selected: true } : {}}
        >
          <Text style={[styles.text, value === opt && styles.textActive]}>
            {opt === "case" ? "Cases" : "Units"}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  segment: {
    flexDirection: "row",
    // Hug the two buttons. Both call sites put this in a column, whose default
    // alignItems: stretch would otherwise pull the track full-width (which is
    // what NewOrderScreen's old copy did — an empty track trailing off right).
    alignSelf: "flex-start",
    backgroundColor: ios.bgElev,
    borderRadius: 8,
    padding: 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
  },
  btn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  btnActive: { backgroundColor: ios.brand },
  text: { fontSize: 11, fontFamily: "Inter_600SemiBold", color: ios.label2 },
  textActive: { color: "#fff" },
});
