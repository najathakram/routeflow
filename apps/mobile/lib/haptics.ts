import { Platform } from "react-native";
import * as Haptics from "expo-haptics";

/**
 * Confirmation-only haptics for continuous scanning: the operator is looking at
 * the camera, not the tray, so acceptance has to be felt. Reserve this for the
 * scan outcome — ordinary taps stay silent, or the signal stops meaning anything.
 *
 * Web has no haptics engine; the call is a no-op there rather than a rejected
 * promise. Failures are swallowed: a device without a vibrator must not break a scan.
 */
export function scanHaptic(kind: "added" | "error"): void {
  if (Platform.OS === "web") return;
  const type =
    kind === "added"
      ? Haptics.NotificationFeedbackType.Success
      : Haptics.NotificationFeedbackType.Warning;
  void Haptics.notificationAsync(type).catch(() => undefined);
}
