import { Alert, Platform } from "react-native";

/**
 * Cross-platform confirmation dialog.
 * On web, uses window.confirm (synchronous). On native, uses Alert.alert.
 */
export function confirm(
  title: string,
  message: string,
  onConfirm: () => void,
  options?: { confirmText?: string; destructive?: boolean },
): void {
  if (Platform.OS === "web") {
    const text = message ? `${title}\n\n${message}` : title;
    if (window.confirm(text)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    {
      text: options?.confirmText ?? "OK",
      style: options?.destructive ? "destructive" : "default",
      onPress: onConfirm,
    },
  ]);
}

/**
 * Cross-platform info alert. Uses window.alert on web so the message is not lost.
 */
export function alertInfo(title: string, message?: string): void {
  if (Platform.OS === "web") {
    window.alert(message ? `${title}\n\n${message}` : title);
    return;
  }
  Alert.alert(title, message ?? "", [{ text: "OK" }]);
}
