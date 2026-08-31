import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { IosTabBar } from "@routeflow/ui/mobile/ios";
import { OfflineBanner } from "../../components/OfflineBanner";
import { useSocket } from "../../hooks/useSocket";

export default function DriverLayout() {
  // RF-002: keep the driver app subscribed to real-time route/stop events so
  // operator dispatches and stop updates land without a manual refresh.
  useSocket();
  return (
    <View style={{ flex: 1, backgroundColor: ios.bg }}>
      <OfflineBanner />
      <Tabs
        tabBar={(props) => <IosTabBar {...(props as any)} />}
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: ios.brand,
          tabBarInactiveTintColor: ios.gray[1],
        }}
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
              <Ionicons name="list-outline" size={size} color={color} />
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
          name="driver-menu"
          options={{
            title: "More",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="ellipsis-horizontal" size={size} color={color} />
            ),
          }}
        />
        {/* Hidden stacks & direct screens. These use driver-prefixed file
            names so they don't collide with the operator group's same-named
            files (both groups would resolve to the same root-level URL
            otherwise, causing cross-group navigation bugs). */}
        <Tabs.Screen name="driver-messages" options={{ href: null }} />
        <Tabs.Screen name="driver-profile" options={{ href: null }} />
        <Tabs.Screen name="driver-change-password" options={{ href: null }} />
        <Tabs.Screen name="driver-new-order" options={{ href: null }} />
      </Tabs>
    </View>
  );
}
