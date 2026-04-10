import { useEffect, useRef } from "react";
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
import { useAuthStore } from "../lib/auth-store";
import { useTenantStore } from "../lib/tenant-store";
import { useBuyerAuthStore } from "../lib/buyer-auth-store";

// Configure how notifications are handled when the app is in the foreground
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
  const { user, isLoading, initialize } = useAuthStore();
  const { slug: tenantSlug, isLoading: tenantLoading, initialize: initTenant } = useTenantStore();
  const {
    buyer,
    isBuyerAuthenticated,
    isLoading: buyerLoading,
    activeSeller,
    initialize: initBuyer,
  } = useBuyerAuthStore();
  const router = useRouter();
  const segments: string[] = useSegments();
  const notificationListener = useRef<ReturnType<typeof Notifications.addNotificationReceivedListener> | null>(null);

  useEffect(() => {
    initTenant();
    initialize();
    initBuyer();
  }, []);

  // Set up foreground notification listener
  useEffect(() => {
    notificationListener.current = Notifications.addNotificationReceivedListener((_notification) => {
      // Foreground notifications are shown automatically via the handler above.
      // Add any custom in-app handling here if needed.
    });
    return () => {
      if (notificationListener.current) {
        notificationListener.current.remove();
      }
    };
  }, []);

  useEffect(() => {
    if (isLoading || tenantLoading || buyerLoading) return;

    // ── Buyer portal routing (checked before staff routing) ──────────────────
    if (isBuyerAuthenticated) {
      const inBuyerAuth = segments[0] === "(buyer-auth)";
      const inBuyer = segments[0] === "(buyer)";
      if (!activeSeller && !inBuyerAuth) {
        router.replace("/(buyer-auth)/sellers");
      } else if (activeSeller && !inBuyer) {
        router.replace("/(buyer)/orders");
      }
      return; // Don't fall through to staff routing
    }

    // ── Staff routing ────────────────────────────────────────────────────────

    // Step 1: Require a company code (tenant slug) before anything else
    if (!tenantSlug) {
      if (segments[0] !== "(auth)" || segments[1] !== "company-code") {
        router.replace("/(auth)/company-code");
      }
      return;
    }

    if (!user) {
      // Not logged in — send to login unless already there
      if (segments[0] !== "(auth)" || segments[1] !== "login") {
        router.replace("/(auth)/login");
      }
      return;
    }

    if (user.forcePasswordChange) {
      if (
        !(segments[0] === "(auth)" && segments[1] === "force-change-password")
      ) {
        router.replace("/(auth)/force-change-password");
      }
      return;
    }

    // OPERATOR and TENANT_ADMIN both go to the admin dashboard
    if (user.role === UserRole.OPERATOR || user.role === UserRole.TENANT_ADMIN) {
      if (segments[0] !== "(admin)") {
        router.replace("/(admin)/dashboard");
      }
      return;
    }

    // SUPER_ADMIN has no mobile UI — show a friendly not-supported screen
    if ((user.role as string) === "SUPER_ADMIN") {
      // Reuse the operator-blocked screen for now
      if (segments[0] !== "(auth)" || segments[1] !== "operator-blocked") {
        router.replace("/(auth)/operator-blocked");
      }
      return;
    }

    if (user.role === UserRole.CUSTOMER) {
      if (segments[0] !== "(customer)") {
        router.replace("/(customer)/shop");
      }
    } else if (user.role === UserRole.DRIVER) {
      if (segments[0] !== "(driver)") {
        router.replace("/(driver)/route");
      }
    }
  }, [user, isLoading, tenantSlug, tenantLoading, buyer, isBuyerAuthenticated, buyerLoading, activeSeller, segments]);

  return <Slot />;
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded) {
      SplashScreen.hideAsync();
    }
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
