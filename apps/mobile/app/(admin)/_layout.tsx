import { useState } from "react";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Pressable, View } from "react-native";
import { colors } from "@routeflow/ui/tokens";
import { DrawerMenu } from "../../components/DrawerMenu";
import { HeaderBackButton } from "../../components/HeaderBackButton";

export default function AdminLayout() {
  const [drawerOpen, setDrawerOpen] = useState(false);

  const menuButton = () => (
    <Pressable
      onPress={() => setDrawerOpen(true)}
      style={{ padding: 8, paddingLeft: 16 }}
    >
      <Ionicons name="menu-outline" size={24} color={colors.navy.DEFAULT} />
    </Pressable>
  );

  return (
    <View style={{ flex: 1 }}>
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
          headerLeft: menuButton,
        }}
      >
        <Tabs.Screen
          name="dashboard"
          options={{
            title: "Dashboard",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="home-outline" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="orders"
          options={{
            title: "Orders",
            headerShown: false,
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="receipt-outline" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="customers"
          options={{
            title: "Customers",
            headerShown: false,
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="people-outline" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="finance"
          options={{
            title: "Finance",
            headerShown: false,
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="wallet-outline" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="more"
          options={{
            title: "More",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="grid-outline" size={size} color={color} />
            ),
          }}
        />
        {/* Hidden stacks */}
        <Tabs.Screen name="products" options={{ href: null, headerShown: false }} />
        <Tabs.Screen name="routes" options={{ href: null, headerShown: false }} />
        <Tabs.Screen name="drivers" options={{ href: null, headerShown: false }} />
        <Tabs.Screen name="returns" options={{ href: null, headerShown: false }} />
        <Tabs.Screen
          name="profile"
          options={{
            href: null,
            title: "Profile",
            headerLeft: () => <HeaderBackButton />,
          }}
        />
        <Tabs.Screen
          name="change-password"
          options={{
            href: null,
            title: "Change Password",
            headerLeft: () => <HeaderBackButton />,
          }}
        />
        <Tabs.Screen name="analytics" options={{ href: null, headerShown: false }} />
        <Tabs.Screen name="reports" options={{ href: null, headerShown: false }} />
        <Tabs.Screen name="settings" options={{ href: null, headerShown: false }} />
      </Tabs>
      <DrawerMenu visible={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </View>
  );
}
