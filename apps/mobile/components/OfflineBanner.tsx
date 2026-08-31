import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { useNetworkSync } from "../hooks/useNetworkSync";
import { chooseAction } from "../lib/confirm";
import { describeQueuedAction } from "../lib/queue-drain";

/**
 * Connectivity + failed-action banner, shared by the operator and driver
 * layouts (F30 · R6 · REG-B143 / REG-B111).
 *
 * The offline row is the old per-layout banner, unchanged. The failure row is
 * R6's badge leg: a queued action that hit a 4xx or exhausted its retries is
 * persisted to `failedActions`, but the alert that fires at drain time is
 * one-shot — dismissed with a tap, or fired while the app was backgrounded.
 * Without a standing count the failure is recorded and still invisible, which
 * is the exact symptom B143/B111 exist to remove. So this row stays up until
 * the operator acknowledges it, and — unlike the offline row — it renders
 * while ONLINE, because the drain that produces failures only runs online.
 *
 * Dismissing does not retry: a 4xx replay would fail identically, and a
 * retry-exhausted write may or may not have landed. The dialog says so.
 */
export function OfflineBanner() {
  const {
    isOnline,
    queueLength,
    failedCount,
    failedActions,
    clearFailedAction,
    clearFailedActions,
  } = useNetworkSync();

  if (isOnline && failedCount === 0) return null;

  const reviewFailures = () => {
    const [oldest, ...rest] = failedActions;
    if (!oldest) return;
    const shown = failedActions
      .slice(0, 3)
      .map((f) => `${describeQueuedAction(f.action)}\n${f.reason}`)
      .join("\n\n");
    const more = failedCount > 3 ? `\n\n…and ${failedCount - 3} more.` : "";
    chooseAction(
      `${failedCount} action${failedCount !== 1 ? "s" : ""} could not be sent`,
      `${shown}${more}\n\nDismissing does not resend — re-enter the affected work.`,
      rest.length > 0
        ? [
            { label: "Cancel", style: "cancel" },
            { label: "Dismiss oldest", onPress: () => clearFailedAction(oldest.action.id) },
            { label: "Dismiss all", style: "destructive", onPress: clearFailedActions },
          ]
        : [
            { label: "Cancel", style: "cancel" },
            { label: "Dismiss", style: "destructive", onPress: clearFailedActions },
          ],
    );
  };

  return (
    <View>
      {!isOnline ? (
        <View style={[styles.banner, styles.offlineBanner]}>
          <Ionicons name="cloud-offline-outline" size={14} color={ios.system.orangeInk} />
          <Text style={[styles.bannerText, styles.offlineText]}>
            Offline
            {queueLength > 0
              ? ` — ${queueLength} action${queueLength !== 1 ? "s" : ""} queued`
              : ""}
          </Text>
        </View>
      ) : null}
      {failedCount > 0 ? (
        <Pressable
          onPress={reviewFailures}
          accessibilityRole="button"
          accessibilityLabel={`${failedCount} action${failedCount !== 1 ? "s" : ""} could not be sent — tap to review`}
          style={[styles.banner, styles.failedBanner]}
        >
          <Ionicons name="alert-circle-outline" size={14} color={ios.system.redInk} />
          <Text style={[styles.bannerText, styles.failedText]}>
            {failedCount} action{failedCount !== 1 ? "s" : ""} could not be sent — tap to review
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  offlineBanner: {
    backgroundColor: ios.system.orangeWash,
    borderBottomColor: "rgba(255,149,0,0.3)",
  },
  failedBanner: {
    backgroundColor: ios.system.redWash,
    borderBottomColor: "rgba(255,59,48,0.3)",
  },
  bannerText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  offlineText: {
    color: ios.system.orangeInk,
  },
  failedText: {
    color: ios.system.redInk,
  },
});
