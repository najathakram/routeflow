import { Alert, Platform } from "react-native";
import { useConfirmStore, type ConfirmAction } from "./confirm-store";

/**
 * Cross-platform confirm dialog (Cancel + one action). On native this
 * delegates to RN's Alert.alert; on web it uses our custom modal store
 * because RN Web's Alert.alert is a partial no-op for multi-button alerts.
 */
export function confirm(
  title: string,
  message: string,
  onConfirm: () => void,
  options?: { confirmText?: string; destructive?: boolean },
): void {
  const confirmText = options?.confirmText ?? "OK";
  const destructive = options?.destructive ?? false;

  if (Platform.OS === "web") {
    useConfirmStore.getState().show({
      title,
      message,
      actions: [
        { label: "Cancel", style: "cancel" },
        {
          label: confirmText,
          style: destructive ? "destructive" : "default",
          onPress: onConfirm,
        },
      ],
    });
    return;
  }
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    {
      text: confirmText,
      style: destructive ? "destructive" : "default",
      onPress: onConfirm,
    },
  ]);
}

/**
 * Single-button info dialog ("OK" only). Use for "saved", "error", or any
 * informational message that doesn't need a choice.
 */
export function alertInfo(title: string, message?: string): void {
  if (Platform.OS === "web") {
    useConfirmStore.getState().show({
      title,
      message: message ?? "",
      actions: [{ label: "OK", style: "default" }],
    });
    return;
  }
  Alert.alert(title, message ?? "", [{ text: "OK" }]);
}

/**
 * Multi-action choice dialog. Mirrors `Alert.alert(title, msg, buttons)`
 * cross-platform — RN Web's Alert.alert silently drops button arrays past
 * length 1, so a "Merge / Create separate / Cancel" prompt was invisible
 * on the Expo Web build. This routes through the custom modal store on web.
 *
 * Each action's `onPress` (when present) fires after the dialog closes.
 * `cancel`-styled actions don't need `onPress` — tapping them just dismisses.
 */
export function chooseAction(
  title: string,
  message: string,
  actions: ConfirmAction[],
): void {
  if (Platform.OS === "web") {
    useConfirmStore.getState().show({ title, message, actions });
    return;
  }
  Alert.alert(
    title,
    message,
    actions.map((a) => ({
      text: a.label,
      style: a.style,
      onPress: a.onPress,
    })),
    { cancelable: true },
  );
}
