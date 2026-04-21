import { Stack } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { useNetworkSync } from "../../hooks/useNetworkSync";

function OfflineBanner() {
  const { isOnline, queueLength } = useNetworkSync();
  if (isOnline) return null;
  return (
    <View style={styles.offlineBanner}>
      <Ionicons name="cloud-offline-outline" size={14} color={ios.system.orangeInk} />
      <Text style={styles.offlineText}>
        Offline{queueLength > 0 ? ` — ${queueLength} action${queueLength !== 1 ? "s" : ""} queued` : ""}
      </Text>
    </View>
  );
}

export default function OperatorLayout() {
  return (
    <View style={{ flex: 1, backgroundColor: ios.bg }}>
      <OfflineBanner />
      <Stack screenOptions={{ headerShown: false }} />
    </View>
  );
}

const styles = StyleSheet.create({
  offlineBanner: {
    backgroundColor: ios.system.orangeWash,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,149,0,0.3)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  offlineText: {
    color: ios.system.orangeInk,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
});
