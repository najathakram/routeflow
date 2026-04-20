import { useEffect, useRef } from "react";
import { Platform, StyleSheet, View } from "react-native";
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
  const router = useRouter();
  const segments: string[] = useSegments();
  const notificationListener = useRef<ReturnType<typeof Notifications.addNotificationReceivedListener> | null>(null);

  useEffect(() => {
    initTenant();
    initialize();
  }, []);

  useEffect(() => {
    notificationListener.current = Notifications.addNotificationReceivedListener(() => {});
    return () => {
      if (notificationListener.current) notificationListener.current.remove();
    };
  }, []);

  useEffect(() => {
    if (isLoading || tenantLoading) return;

    // Step 1: company code (tenant slug) required
    if (!tenantSlug) {
      if (segments[0] !== "(auth)" || segments[1] !== "company-code") {
        router.replace("/(auth)/company-code");
      }
      return;
    }

    // Step 2: login
    if (!user) {
      if (segments[0] !== "(auth)" || segments[1] !== "login") {
        router.replace("/(auth)/login");
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

    // Step 4: role-aware routing. OPERATOR + TENANT_ADMIN → operator tabs;
    // DRIVER → driver tabs. activeRole is set by auth-store on login and can
    // be overridden by the role picker for dual-role users.
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
  }, [user, isLoading, tenantSlug, tenantLoading, activeRole, segments]);

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
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <RootLayoutNav />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
