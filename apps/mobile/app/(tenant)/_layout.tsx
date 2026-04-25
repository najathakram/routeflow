import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { IosTabBar } from "@routeflow/ui/mobile/ios";

export default function TenantTabsLayout() {
  return (
    <View style={{ flex: 1, backgroundColor: ios.bg }}>
      <Tabs
        tabBar={(props) => <IosTabBar {...(props as any)} />}
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: ios.brand,
          tabBarInactiveTintColor: ios.gray[1],
        }}
      >
        <Tabs.Screen
          name="today"
          options={{
            title: "Today",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="sunny-outline" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="dispatch"
          options={{
            title: "Dispatch",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="car-outline" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="finance"
          options={{
            title: "Finance",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="receipt-outline" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="warehouse"
          options={{
            title: "Warehouse",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="business-outline" size={size} color={color} />
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
      </Tabs>
    </View>
  );
}
