import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useBuyerAuthStore } from "../../lib/buyer-auth-store";

export default function BuyerLayout() {
  const activeSeller = useBuyerAuthStore((s) => s.activeSeller);
  const sellerName = activeSeller?.tenant.name ?? "Buyer Portal";

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: "#4f46e5",
        tabBarInactiveTintColor: "#94a3b8",
        tabBarStyle: {
          borderTopColor: "#e2e8f0",
          backgroundColor: "#fff",
        },
        headerStyle: { backgroundColor: "#fff" },
        headerShadowVisible: false,
        headerTitleStyle: {
          fontFamily: "Inter_600SemiBold",
          fontSize: 17,
          color: "#1B3A5C",
        },
        headerSubtitle: sellerName,
      }}
    >
      <Tabs.Screen
        name="orders"
        options={{
          title: "Orders",
          headerTitle: sellerName,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="receipt-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="invoices"
        options={{
          title: "Invoices",
          headerTitle: sellerName,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="document-text-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: "Account",
          headerTitle: sellerName,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person-circle-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
