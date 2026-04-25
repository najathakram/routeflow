import { useEffect, useRef } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Slot, useRouter, useSegments } from "expo-router";
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import * as SplashScreen from "expo-splash-screen";
import * as Notifications from "expo-notifications";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UserRole } from "@routeflow/types";
import { ios } from "@routeflow/ui/tokens";
import { useAuthStore } from "../lib/auth-store";
import { useTenantStore } from "../lib/tenant-store";
import { useBuyerSessionStore } from "../lib/buyer-session-store";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

function RootLayoutNav() {
  const { user, isLoading, activeRole, initialize } = useAuthStore();
  const { slug: tenantSlug, isLoading: tenantLoading, initialize: initTenant } = useTenantStore();
  const { buyer, activeSeller, isLoading: buyerLoading, initialize: initBuyer } = useBuyerSessionStore();
  const router = useRouter();
  const segments: string[] = useSegments();
  const notificationListener = useRef<ReturnType<typeof Notifications.addNotificationReceivedListener> | null>(null);

  useEffect(() => {
    initTenant();
    initialize();
    initBuyer();
  }, []);

  useEffect(() => {
    notificationListener.current = Notifications.addNotificationReceivedListener(() => {});
    return () => {
      if (notificationListener.current) notificationListener.current.remove();
    };
  }, []);

  useEffect(() => {
    if (isLoading || tenantLoading || buyerLoading) return;

    // Buyer portal: if logged in as buyer (and not also as staff), route to customer section
    if (buyer && activeSeller && !user) {
      if (segments[0] !== "(customer)") {
        router.replace("/(customer)/orders");
      }
      return;
    }

    // Not authenticated as either buyer or staff — allow only landing + auth screens
    if (!user) {
      if (segments.length > 0 && segments[0] !== "(auth)") {
        router.replace("/");
      }
      return;
    }

    // Staff is authenticated — tenant slug must exist (sanity guard)
    if (!tenantSlug) {
      if (segments[0] !== "(auth)") {
        router.replace("/(auth)/company-code");
      }
      return;
    }

    // Step 3: forced password change
    if (user.forcePasswordChange) {
      if (!(segments[0] === "(auth)" && segments[1] === "force-change-password")) {
        router.replace("/(auth)/force-change-password");
      }
      return;
    }

    // SUPER_ADMIN has no mobile UI
    if ((user.role as string) === "SUPER_ADMIN") {
      if (segments[0] !== "(auth)" || segments[1] !== "operator-blocked") {
        router.replace("/(auth)/operator-blocked");
      }
      return;
    }

    // CUSTOMER role is no longer supported on mobile (B2B portal removed)
    if (user.role === UserRole.CUSTOMER) {
      if (segments[0] !== "(auth)" || segments[1] !== "operator-blocked") {
        router.replace("/(auth)/operator-blocked");
      }
      return;
    }

    // Step 4: role-aware routing.
    // "all"      → unified (tenant) home (owner/admin who holds both roles)
    // "operator" → operator tabs
    // "driver"   → driver tabs
    if (activeRole === "all") {
      if (segments[0] !== "(tenant)") {
        router.replace("/(tenant)/today");
      }
      return;
    }
    if (activeRole === "operator") {
      if (segments[0] !== "(operator)") {
        router.replace("/(operator)/home");
      }
      return;
    }
    if (activeRole === "driver") {
      if (segments[0] !== "(driver)") {
        router.replace("/(driver)/route");
      }
      return;
    }
  }, [user, isLoading, tenantSlug, tenantLoading, activeRole, buyer, activeSeller, buyerLoading, segments]);

  // On web viewed from a desktop browser the phone-sized layout stretches
  // uncomfortably wide. Clamp the app to a phone-ish width and center it
  // on a neutral backdrop. Native builds ignore this entirely.
  if (Platform.OS === "web") {
    return (
      <View style={webStyles.page}>
        <View style={webStyles.phoneFrame}>
          <Slot />
        </View>
      </View>
    );
  }

  return <Slot />;
}

const webStyles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: "#E5E7EB",
    alignItems: "center",
  },
  phoneFrame: {
    flex: 1,
    width: "100%",
    maxWidth: 480,
    backgroundColor: ios.bg,
  },
});

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded) SplashScreen.hideAsync();
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <RootLayoutNav />
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
