// The native kit entry point: `@routeflow/ui/native` (#2328 §2.3).
export * from "./tokens";
export * from "./theme";
export { accentForSurface, shadeHex } from "../tokens/accent";

// Kit A (#2331)
export * from "./button-style";
export * from "./field-style";
export { Button, type ButtonProps } from "./Button";
export { IconButton, type IconButtonProps } from "./IconButton";
export {
  TextField,
  TextArea,
  PasswordField,
  MoneyField,
  type FieldChromeProps,
  type TextFieldProps,
  type PasswordFieldProps,
  type MoneyFieldProps,
} from "./TextField";
export {
  MoneyTextInput as MoneyInput,
  type MoneyTextInputProps as MoneyInputProps,
} from "./MoneyInput";
export { parseMoney, sanitizeMoneyInput } from "./money-input";

// Badge (#2332)
export { Badge, type BadgeProps } from "./Badge";
export { resolveBadgeStyle, BADGE_HEIGHT } from "./badge-style";
export {
  STATUS_TONES,
  TONE_COLORS,
  resolveStatusTone,
  type BadgeStatus,
  type BadgeVariant,
  type StatusToneEntry,
} from "../status-tones";
