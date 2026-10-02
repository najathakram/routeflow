import * as React from "react";
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { sanitizeIntInput, parseIntQty, commitQtyDraft } from "../lib/qty";
import { QTY_INPUT_WIDTH } from "../lib/row-layout";

export interface QtyTextInputProps extends Omit<
  TextInputProps,
  "value" | "onChangeText" | "keyboardType"
> {
  value: number;
  onChangeQty: (n: number) => void;
  min?: number; // default 0
  max?: number;
  emptyMeansZero?: boolean; // default true (blur on empty commits 0)
}

/**
 * Integer qty TextInput: local draft so the field can be cleared mid-edit,
 * sanitized per keystroke, valid values committed live, blur resolves
 * empty/below-min via commitQtyDraft. Consolidates the copies previously
 * inlined in CartStepperRow / StepperRow / QtyStepperRow / short-pick.
 */
export function QtyTextInput({
  value,
  onChangeQty,
  min = 0,
  max,
  emptyMeansZero = true,
  style,
  ...rest
}: QtyTextInputProps) {
  const [draft, setDraft] = React.useState(String(value));
  React.useEffect(() => {
    setDraft(String(value));
  }, [value]);
  return (
    <TextInput
      style={style}
      value={draft}
      onChangeText={(txt) => {
        const clean = sanitizeIntInput(txt);
        setDraft(clean);
        if (clean === "") return;
        const n = parseIntQty(clean, value);
        if (n >= min) onChangeQty(max != null ? Math.min(max, n) : n);
      }}
      onBlur={() => {
        const committed = commitQtyDraft(draft, { min, max, emptyMeansZero });
        if (committed != null && committed !== value) onChangeQty(committed);
        setDraft(String(value)); // prop-sync effect corrects after parent updates
      }}
      keyboardType="number-pad"
      returnKeyType="done"
      maxLength={5}
      selectTextOnFocus
      {...rest}
    />
  );
}

/** Bordered −/input/+ pill matching styles.stepper (md) / miniStepper (mini). */
export function QtyStepper({
  value,
  onChangeQty,
  onIncrement,
  onDecrement,
  min = 0,
  max,
  emptyMeansZero = true,
  size = "md",
  suffix,
}: {
  value: number;
  onChangeQty: (n: number) => void;
  onIncrement?: () => void;
  onDecrement?: () => void;
  min?: number;
  max?: number;
  emptyMeansZero?: boolean;
  size?: "md" | "mini";
  suffix?: string;
}) {
  const dec = () => {
    if (onDecrement) onDecrement();
    else onChangeQty(Math.max(min, value - 1));
  };
  const inc = () => {
    if (onIncrement) onIncrement();
    else onChangeQty(max != null ? Math.min(max, value + 1) : value + 1);
  };
  const s = size === "mini" ? mini : md;
  return (
    <View style={s.pill}>
      <Pressable style={s.btn} onPress={dec} hitSlop={6}>
        <Text style={s.btnText}>−</Text>
      </Pressable>
      <QtyTextInput
        value={value}
        onChangeQty={onChangeQty}
        min={min}
        max={max}
        emptyMeansZero={emptyMeansZero}
        style={s.input}
      />
      {suffix ? <Text style={s.suffix}>{suffix}</Text> : null}
      <Pressable style={s.btn} onPress={inc} hitSlop={6}>
        <Text style={s.btnText}>+</Text>
      </Pressable>
    </View>
  );
}

const md = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: ios.bgElev,
    borderRadius: 10,
    padding: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
  },
  btn: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  btnText: { color: ios.brand, fontSize: 18 },
  input: {
    // Definite width, NOT minWidth. react-native-web renders TextInput as a
    // real <input>, whose base style declares no width — so it carries the UA
    // `size=20` intrinsic width (~177px) and the pill (flexShrink: 0) balloons,
    // squeezing the sibling name column to a few pixels until RNW's
    // `word-wrap: break-word` renders it one character per line. `minWidth` is
    // a floor and does nothing here; only a definite width bounds the flex base
    // size. QTY_INPUT_WIDTH.md is what the field already reaches at maxLength 5
    // on native, so nothing grows there — it just stops resizing as you type.
    width: QTY_INPUT_WIDTH.md,
    flexShrink: 0,
    textAlign: "center",
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
    paddingVertical: 0,
    paddingHorizontal: 2,
  },
  suffix: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
    paddingRight: 2,
  },
});
const mini = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: ios.bgElev,
    borderRadius: 10,
    padding: 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
  },
  btn: { width: 26, height: 26, alignItems: "center", justifyContent: "center" },
  btnText: { color: ios.brand, fontSize: 16 },
  input: {
    // See md.input — definite width, not minWidth.
    width: QTY_INPUT_WIDTH.mini,
    flexShrink: 0,
    textAlign: "center",
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
    paddingVertical: 0,
    paddingHorizontal: 2,
  },
  suffix: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
    paddingRight: 2,
  },
});
