import { Alert, Platform } from "react-native";
import { useConfirmStore } from "./confirm-store";

export function confirm(
  title: string,
  message: string,
  onConfirm: () => void,
  options?: { confirmText?: string; destructive?: boolean },
): void {
  if (Platform.OS === "web") {
    useConfirmStore.getState().show({
      title,
      message,
      confirmText: options?.confirmText ?? "OK",
      destructive: options?.destructive ?? false,
      onConfirm,
    });
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

export function alertInfo(title: string, message?: string): void {
  if (Platform.OS === "web") {
    useConfirmStore.getState().show({
      title,
      message: message ?? "",
      confirmText: "OK",
      destructive: false,
      onConfirm: () => {},
    });
    return;
  }
  Alert.alert(title, message ?? "", [{ text: "OK" }]);
}
