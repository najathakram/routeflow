import { Stack } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { useNetworkSync } from "../../hooks/useNetworkSync";
import { useSocket } from "../../hooks/useSocket";
import { OperatorTabBar } from "../../components/OperatorTabBar";

function OfflineBanner() {
  const { isOnline, queueLength } = useNetworkSync();
  if (isOnline) return null;
  return (
    <View style={styles.offlineBanner}>
      <Ionicons name="cloud-offline-outline" size={14} color={ios.system.orangeInk} />
      <Text style={styles.offlineText}>
        Offline
        {queueLength > 0 ? ` — ${queueLength} action${queueLength !== 1 ? "s" : ""} queued` : ""}
      </Text>
    </View>
  );
}

export default function OperatorLayout() {
  // RF-002: hoist Socket.IO subscription to layout level so real-time events
  // (order.created, order.statusChanged, route.stop.completed, etc.) keep
  // active queries fresh across every operator screen, not only the home tab.
  useSocket();
  return (
    <View style={{ flex: 1, backgroundColor: ios.bg }}>
      <OfflineBanner />
      {/* <Stack> carries flex:1 on both platforms, so the bar is a plain in-flow
          sibling below it — same shape as OfflineBanner above, and the same shape
          React Navigation's own BottomTabView uses. That means the screen viewport
          is simply shorter and NO screen needs bottom padding. It also means the
          bar survives every push, which is the whole point: only 18 of ~106
          operator screens live inside the (tabs) navigator, so a bar owned by that
          navigator vanishes on the other 88. */}
      <Stack screenOptions={{ headerShown: false }} />
      <OperatorTabBar />
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
