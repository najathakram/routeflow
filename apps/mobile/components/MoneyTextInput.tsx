import * as React from "react";
import { TextInput, type TextInputProps } from "react-native";
import { sanitizeMoneyInput, parseMoney } from "../lib/money-input";

/**
 * Money TextInput that never reformats while typing (mobile mirror of web's
 * MoneyInput): the draft string is local state and only sanitized per
 * keystroke; the parent gets `parsed | null` live; `toFixed(2)` happens on
 * blur only; external value changes echo in only while unfocused.
 */
export interface MoneyTextInputProps extends Omit<
  TextInputProps,
  "value" | "onChangeText" | "keyboardType"
> {
  value: number | null;
  onChangeValue: (value: number | null) => void;
  decimals?: number;
}

export function MoneyTextInput({
  value,
  onChangeValue,
  decimals = 2,
  onFocus,
  onBlur,
  ...rest
}: MoneyTextInputProps) {
  const [draft, setDraft] = React.useState(value == null ? "" : value.toFixed(decimals));
  const focusedRef = React.useRef(false);

  React.useEffect(() => {
    if (focusedRef.current) return;
    const current = parseMoney(draft);
    const same =
      (value == null && current == null) ||
      (value != null && current != null && Math.abs(current - value) < 1e-9);
    if (!same) setDraft(value == null ? "" : value.toFixed(decimals));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, decimals]);

  return (
    <TextInput
      keyboardType="decimal-pad"
      selectTextOnFocus
      value={draft}
      onChangeText={(t) => {
        const sanitized = sanitizeMoneyInput(t, decimals);
        setDraft(sanitized);
        onChangeValue(parseMoney(sanitized));
      }}
      onFocus={(e) => {
        focusedRef.current = true;
        onFocus?.(e);
      }}
      onBlur={(e) => {
        focusedRef.current = false;
        const parsed = parseMoney(draft);
        setDraft(parsed == null ? "" : parsed.toFixed(decimals));
        onBlur?.(e);
      }}
      {...rest}
    />
  );
}
