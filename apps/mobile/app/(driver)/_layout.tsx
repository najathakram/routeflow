import { useState } from "react";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Pressable, View, Text, StyleSheet } from "react-native";
import { colors } from "@routeflow/ui/tokens";
import { useNetworkSync } from "../../hooks/useNetworkSync";
import { DrawerMenu } from "../../components/DrawerMenu";
import { HeaderBackButton } from "../../components/HeaderBackButton";

function OfflineBanner() {
  const { isOnline, queueLength } = useNetworkSync();
  if (isOnline) return null;
  return (
    <View style={styles.offlineBanner}>
      <Ionicons name="cloud-offline-outline" size={16} color="#fff" />
      <Text style={styles.offlineText}>
        Offline{queueLength > 0 ? ` — ${queueLength} action${queueLength !== 1 ? "s" : ""} queued` : ""}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  offlineBanner: {
    backgroundColor: "#64748b",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 16,
  },
  offlineText: {
    color: "#fff",
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
});

export default function DriverLayout() {
  const [drawerOpen, setDrawerOpen] = useState(false);

  const menuButton = () => (
    <Pressable
      onPress={() => setDrawerOpen(true)}
      style={{ padding: 8, paddingLeft: 16 }}
      accessibilityLabel="Open menu"
    >
      <Ionicons name="menu-outline" size={24} color={colors.navy.DEFAULT} />
    </Pressable>
  );

  return (
    <View style={{ flex: 1 }}>
      <OfflineBanner />
      <Tabs
        screenOptions={{
          tabBarActiveTintColor: colors.brand[600],
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
        {/* ── Visible tabs ─────────────────────────────────── */}
        <Tabs.Screen
          name="dashboard"
          options={{
            title: "Home",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="home-outline" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="route"
          options={{
            title: "My Route",
            headerShown: false,
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="map-outline" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="profile"
          options={{
            title: "Profile",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="person-outline" size={size} color={color} />
            ),
          }}
        />
        {/* ── Hidden sub-stack screens — Stack owns the header ─ */}
        <Tabs.Screen name="customers"       options={{ href: null, title: "Customers",        headerShown: false }} />
        <Tabs.Screen name="inventory"       options={{ href: null, title: "Stock",             headerShown: false }} />
        <Tabs.Screen name="history"         options={{ href: null, title: "History",           headerShown: false }} />
        <Tabs.Screen name="orders"          options={{ href: null, title: "Create Order",      headerShown: false }} />
        <Tabs.Screen name="standing-orders"  options={{ href: null, title: "Standing Orders",   headerShown: false }} />
        <Tabs.Screen name="purchase-orders"  options={{ href: null, title: "Purchase Orders",   headerShown: false }} />
        {/* ── Hidden direct screen — Tabs owns the header ────── */}
        <Tabs.Screen name="change-password" options={{ href: null, title: "Change Password", headerLeft: () => <HeaderBackButton /> }} />
      </Tabs>
      <DrawerMenu visible={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </View>
  );
}
