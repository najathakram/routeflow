import { Tabs, router } from "expo-router";
import { Pressable, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@routeflow/ui/tokens";
import { useEffect } from "react";
import * as Notifications from "expo-notifications";

function ProfileButton() {
  return (
    <Pressable
      onPress={() => router.push("/(customer)/profile")}
      hitSlop={10}
      style={{ paddingRight: 8 }}
      accessibilityLabel="Profile"
      accessibilityRole="button"
    >
      <Ionicons name="person-circle-outline" size={28} color={colors.navy.DEFAULT} />
    </Pressable>
  );
}

const headerRight = () => <ProfileButton />;

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
        headerRight,
      }}
    >
      <Tabs.Screen
        name="shop"
        options={{
          title: "Shop",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="bag-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="order"
        options={{
          title: "My Order",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="clipboard-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: "History",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="time-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="invoices"
        options={{
          title: "Invoices",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="document-text-outline" size={size} color={color} />
          ),
        }}
      />
      {/* Hidden screens — accessible via router.push but not shown in tab bar */}
      <Tabs.Screen name="profile" options={{ href: null }} />
      <Tabs.Screen name="change-password" options={{ href: null }} />
      <Tabs.Screen name="standing-orders" options={{ href: null }} />
      <Tabs.Screen name="returns" options={{ href: null }} />
    </Tabs>
  );
}
