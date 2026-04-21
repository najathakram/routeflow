import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { IosTabBar } from "@routeflow/ui/mobile/ios";

export default function OperatorLayout() {
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
          name="home"
          options={{
            title: "Home",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="home-outline" size={size} color={color} />
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
          name="invoices"
          options={{
            title: "Invoices",
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
        {/* Hidden screens accessible from More / deep links */}
        <Tabs.Screen name="pick" options={{ href: null }} />
        <Tabs.Screen name="driver" options={{ href: null }} />
        <Tabs.Screen name="exceptions" options={{ href: null }} />
        <Tabs.Screen name="messages" options={{ href: null }} />
        <Tabs.Screen name="profile" options={{ href: null }} />
        <Tabs.Screen name="change-password" options={{ href: null }} />
        <Tabs.Screen name="new-order" options={{ href: null }} />
        <Tabs.Screen name="orders" options={{ href: null }} />
        <Tabs.Screen name="products" options={{ href: null }} />
        <Tabs.Screen name="customers" options={{ href: null }} />
        <Tabs.Screen name="fleet" options={{ href: null }} />
        <Tabs.Screen name="purchase-orders" options={{ href: null }} />
        <Tabs.Screen name="routes" options={{ href: null }} />
        <Tabs.Screen name="drivers" options={{ href: null }} />
        <Tabs.Screen name="returns" options={{ href: null }} />
        <Tabs.Screen name="settings" options={{ href: null }} />
        <Tabs.Screen name="analytics" options={{ href: null }} />
      </Tabs>
    </View>
  );
}
