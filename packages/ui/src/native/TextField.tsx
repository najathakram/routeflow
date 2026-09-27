import * as React from "react";
import { Pressable, Text, TextInput, View, type TextInputProps } from "react-native";
import Svg, { Circle, Line, Path } from "react-native-svg";
import { resolveFieldStyle, type ResolvedFieldStyle } from "./field-style";
import { MoneyTextInput, type MoneyTextInputProps } from "./MoneyInput";
import { slopFor } from "./button-style";

/** Label, helper and error around a control: web `Input`'s `flex flex-col gap-1`. */
export interface FieldChromeProps {
  label?: string;
  /** Native addition: a caption under the control, hidden while an error shows. */
  helper?: string;
  error?: string;
}

function FieldShell({
  label,
  helper,
  error,
  styles,
  children,
}: FieldChromeProps & { styles: ResolvedFieldStyle; children: React.ReactNode }) {
  return (
    <View style={{ gap: 4 }}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      {children}
      {error ? (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : helper ? (
        <Text style={styles.helper}>{helper}</Text>
      ) : null}
    </View>
  );
}

/** Focus state, merged with the caller's own onFocus/onBlur (RHF passes onBlur). */
function useFocus(onFocus?: TextInputProps["onFocus"], onBlur?: TextInputProps["onBlur"]) {
  const [focused, setFocused] = React.useState(false);
  return {
    focused,
    onFocus: ((e) => {
      setFocused(true);
      onFocus?.(e);
    }) as NonNullable<TextInputProps["onFocus"]>,
    onBlur: ((e) => {
      setFocused(false);
      onBlur?.(e);
    }) as NonNullable<TextInputProps["onBlur"]>,
  };
}

export interface TextFieldProps extends Omit<TextInputProps, "style">, FieldChromeProps {
  disabled?: boolean;
}

/** Native kit TextField (#2331): web `Input`. Works with RHF's `Controller` (value/onChangeText/onBlur). */
export const TextField = React.forwardRef<TextInput, TextFieldProps>(function TextField(
  { label, helper, error, disabled, onFocus, onBlur, multiline, ...props },
  ref,
) {
  const f = useFocus(onFocus, onBlur);
  const styles = resolveFieldStyle({
    focused: f.focused,
    error: !!error,
    disabled: !!disabled,
    multiline,
  });
  return (
    <FieldShell label={label} helper={helper} error={error} styles={styles}>
      <TextInput
        ref={ref}
        accessibilityLabel={label}
        accessibilityHint={error}
        editable={!disabled}
        multiline={multiline}
        placeholderTextColor={styles.placeholderTextColor}
        style={styles.input}
        onFocus={f.onFocus}
        onBlur={f.onBlur}
        {...props}
      />
    </FieldShell>
  );
});

/** Native kit TextArea (#2331): web `Textarea` (min height 80, top-aligned). */
export const TextArea = React.forwardRef<TextInput, TextFieldProps>(function TextArea(props, ref) {
  return <TextField ref={ref} multiline {...props} />;
});

const TOGGLE = 32;

function EyeIcon({ open, color }: { open: boolean; color: string }) {
  // Same glyphs as web `PasswordInput` (feather eye / eye-off, 16px, stroke 2).
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}>
      {open ? (
        <>
          <Path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
          <Line x1={1} y1={1} x2={23} y2={23} />
        </>
      ) : (
        <>
          <Path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <Circle cx={12} cy={12} r={3} />
        </>
      )}
    </Svg>
  );
}

export type PasswordFieldProps = Omit<TextFieldProps, "secureTextEntry" | "multiline">;

/** Native kit PasswordField (#2331): web `PasswordInput`, with a show/hide toggle. */
export const PasswordField = React.forwardRef<TextInput, PasswordFieldProps>(function PasswordField(
  { label, helper, error, disabled, onFocus, onBlur, ...props },
  ref,
) {
  const [visible, setVisible] = React.useState(false);
  const f = useFocus(onFocus, onBlur);
  const styles = resolveFieldStyle({
    focused: f.focused,
    error: !!error,
    disabled: !!disabled,
    trailingInset: TOGGLE - 4,
  });
  const slop = slopFor(TOGGLE);
  return (
    <FieldShell label={label} helper={helper} error={error} styles={styles}>
      <View style={{ justifyContent: "center" }}>
        <TextInput
          ref={ref}
          accessibilityLabel={label}
          accessibilityHint={error}
          editable={!disabled}
          secureTextEntry={!visible}
          autoCapitalize="none"
          autoCorrect={false}
          placeholderTextColor={styles.placeholderTextColor}
          style={styles.input}
          onFocus={f.onFocus}
          onBlur={f.onBlur}
          {...props}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={visible ? "Hide password" : "Show password"}
          disabled={disabled}
          onPress={() => setVisible((v) => !v)}
          hitSlop={slop}
          style={{
            position: "absolute",
            right: 4,
            width: TOGGLE,
            height: TOGGLE,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <EyeIcon open={visible} color={styles.placeholderTextColor} />
        </Pressable>
      </View>
    </FieldShell>
  );
});

export interface MoneyFieldProps
  extends Omit<MoneyTextInputProps, "style" | "editable">, FieldChromeProps {
  disabled?: boolean;
}

/**
 * Native kit MoneyField (#2331): the kit's MoneyInput (never reformats while typing) inside the
 * field chrome. Same UI face as the other fields, as web `MoneyInput` (`text-sm`, not mono).
 */
export function MoneyField({
  label,
  helper,
  error,
  disabled,
  onFocus,
  onBlur,
  ...props
}: MoneyFieldProps) {
  const f = useFocus(onFocus, onBlur);
  const styles = resolveFieldStyle({ focused: f.focused, error: !!error, disabled: !!disabled });
  return (
    <FieldShell label={label} helper={helper} error={error} styles={styles}>
      <MoneyTextInput
        accessibilityLabel={label}
        accessibilityHint={error}
        editable={!disabled}
        placeholderTextColor={styles.placeholderTextColor}
        style={styles.input}
        onFocus={f.onFocus}
        onBlur={f.onBlur}
        {...props}
      />
    </FieldShell>
  );
}
