import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { View } from "react-native";
import { ios } from "@routeflow/ui/tokens";

/**
 * The operator bottom bar is NOT drawn here — it's rendered once in
 * `(operator)/_layout.tsx` as a sibling of the Stack, so it survives navigation
 * to the ~88 operator screens that live outside this navigator. `tabBar` returns
 * null so exactly one bar exists (a null tab bar reserves no space; nothing in
 * this app reads `useBottomTabBarHeight`).
 *
 * Consequence worth knowing: `tabPress` is only ever emitted BY a tab bar, so
 * with none rendered here the old `popTabToRoot` listeners could never fire.
 * They were deleted rather than left as dead code — pop-to-root now lives in
 * `components/OperatorTabBar.tsx`, which pops the destination tab's nested stack
 * itself.
 *
 * The <Tabs.Screen> entries stay: they still declare titles, icons and — for
 * `finance` — `href: null`, which keeps it out of routing.
 */
export default function OperatorTabsLayout() {
  return (
    <View style={{ flex: 1, backgroundColor: ios.bg }}>
      <Tabs
        tabBar={() => null}
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
          name="orders"
          options={{
            title: "Orders",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="receipt-outline" size={size} color={color} />
            ),
          }}
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
