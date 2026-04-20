import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { IosTabBar } from "@routeflow/ui/mobile/ios";
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

export default function DriverLayout() {
  return (
    <View style={{ flex: 1, backgroundColor: ios.bg }}>
      <OfflineBanner />
      <Tabs
        tabBar={(props) => <IosTabBar {...(props as any)} />}
        screenOptions={{ headerShown: false, tabBarActiveTintColor: ios.brand, tabBarInactiveTintColor: ios.gray[1] }}
      >
        <Tabs.Screen
          name="route"
          options={{
            title: "Route",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="git-branch-outline" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="map"
          options={{
            title: "Map",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="map-outline" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="orders"
          options={{
            title: "Orders",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="calendar-outline" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="cash"
          options={{
            title: "Cash",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="cash-outline" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="more"
          options={{
            title: "More",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="ellipsis-horizontal" size={size} color={color} />
            ),
          }}
        />
        {/* Hidden stacks & direct screens */}
        <Tabs.Screen name="messages" options={{ href: null }} />
        <Tabs.Screen name="profile" options={{ href: null }} />
        <Tabs.Screen name="change-password" options={{ href: null }} />
      </Tabs>
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
