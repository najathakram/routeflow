import { Tabs, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { IosTabBar } from "@routeflow/ui/mobile/ios";

/**
 * When a tab is pressed, react-navigation's default is to restore the LAST
 * sub-screen the user was on inside that tab's stack. The user reported this
 * as a bug: "when I go to home and press orders again, still goes to where
 * it was before [an order's edit screen]." Override the press so each tab
 * pops to its root whenever pressed.
 *
 * We only intercept when the tab's nested stack is not already at index 0 —
 * otherwise default behavior (no-op when already focused on the root) wins,
 * which is the right thing for the most common case.
 */
function popTabToRoot(navigation: any, tabName: string, rootHref: string) {
  return (e: { preventDefault: () => void }) => {
    const state = navigation.getState?.();
    const tab = state?.routes?.find((r: any) => r.name === tabName);
    const innerIdx = tab?.state?.index ?? 0;
    if (innerIdx > 0) {
      e.preventDefault();
      router.replace(rootHref as any);
    }
  };
}

export default function OperatorTabsLayout() {
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
          listeners={({ navigation }) => ({
            tabPress: popTabToRoot(navigation, "home", "/(operator)/(tabs)/home"),
          })}
        />
        <Tabs.Screen
          name="dispatch"
          options={{
            title: "Dispatch",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="car-outline" size={size} color={color} />
            ),
          }}
          listeners={({ navigation }) => ({
            tabPress: popTabToRoot(navigation, "dispatch", "/(operator)/(tabs)/dispatch"),
          })}
        />
        <Tabs.Screen
          name="orders"
          options={{
            title: "Orders",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="receipt-outline" size={size} color={color} />
            ),
          }}
          listeners={({ navigation }) => ({
            tabPress: popTabToRoot(navigation, "orders", "/(operator)/(tabs)/orders"),
          })}
        />
        <Tabs.Screen name="finance" options={{ href: null }} />
        <Tabs.Screen
          name="warehouse"
          options={{
            title: "Warehouse",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="business-outline" size={size} color={color} />
            ),
          }}
          listeners={({ navigation }) => ({
            tabPress: popTabToRoot(navigation, "warehouse", "/(operator)/(tabs)/warehouse"),
          })}
        />
        <Tabs.Screen
          name="more"
          options={{
            title: "More",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="ellipsis-horizontal" size={size} color={color} />
            ),
          }}
          listeners={({ navigation }) => ({
            tabPress: popTabToRoot(navigation, "more", "/(operator)/(tabs)/more"),
          })}
        />
      </Tabs>
    </View>
  );
}
