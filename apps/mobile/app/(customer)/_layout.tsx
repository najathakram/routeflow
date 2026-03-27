import { Tabs, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@routeflow/ui/tokens";
import { useEffect } from "react";
import * as Notifications from "expo-notifications";
import { HeaderBackButton } from "../../components/HeaderBackButton";

// Set handler so notifications show as banners when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export default function CustomerLayout() {
  useEffect(() => {
    // Handle notification taps — navigate to order detail
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const orderId = response.notification.request.content.data?.orderId as string | undefined;
      if (orderId) {
        router.push(`/(customer)/history/${orderId}` as any);
      }
    });
    return () => sub.remove();
  }, []);

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: "#2563EB",
        tabBarInactiveTintColor: "#94a3b8",
        tabBarStyle: {
          borderTopColor: colors.surface.border,
          backgroundColor: "#fff",
        },
        headerStyle: { backgroundColor: "#fff" },
        headerShadowVisible: false,
        headerTitleStyle: {
          fontFamily: "Inter_600SemiBold",
          fontSize: 17,
          color: colors.navy.DEFAULT,
        },
      }}
    >
      {/* Main tabs — headerShown: false so sub-layout Stack owns the header */}
      <Tabs.Screen
        name="shop"
        options={{
          title: "Shop",
          headerShown: false,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="bag-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="order"
        options={{
          title: "My Order",
          headerShown: false,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="clipboard-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: "History",
          headerShown: false,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="time-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="invoices"
        options={{
          title: "Invoices",
          headerShown: false,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="document-text-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Account",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person-circle-outline" size={size} color={color} />
          ),
        }}
      />
      {/* Hidden sub-stack screens — Stack owns the header */}
      <Tabs.Screen name="standing-orders" options={{ href: null, title: "Standing Orders", headerShown: false }} />
      <Tabs.Screen name="returns"         options={{ href: null, title: "Returns",          headerShown: false }} />
      <Tabs.Screen name="credit-notes"    options={{ href: null, title: "Credit Notes",     headerShown: false }} />
      {/* Hidden direct screens — Tabs owns the header, add back button */}
      <Tabs.Screen name="change-password"  options={{ href: null, title: "Change Password",  headerLeft: () => <HeaderBackButton /> }} />
      <Tabs.Screen name="account-statement" options={{ href: null, title: "Account Statement", headerLeft: () => <HeaderBackButton /> }} />
    </Tabs>
  );
}
