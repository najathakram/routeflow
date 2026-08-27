import { useEffect, useRef } from "react";
import { ActivityIndicator, Platform, StyleSheet, View } from "react-native";
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
import { useDeveloperMode } from "../lib/api/addons";
import { ConfirmModal } from "../components/ConfirmModal";
import { initSentry } from "../lib/sentry";

initSentry();

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
  const { user, isLoading, activeRole, setActiveRole, initialize } = useAuthStore();
  const { slug: tenantSlug, isLoading: tenantLoading, initialize: initTenant } = useTenantStore();
  const {
    buyer,
    activeSeller,
    isLoading: buyerLoading,
    initialize: initBuyer,
  } = useBuyerSessionStore();
  // Self-disables pre-auth (see lib/api/addons.ts); safe to call unconditionally
  // here since this component is inside QueryClientProvider.
  const { enabled: devMode, isLoading: devLoading, resolved: devResolved } = useDeveloperMode();
  const router = useRouter();
  const segments: string[] = useSegments();
  const notificationListener = useRef<ReturnType<
    typeof Notifications.addNotificationReceivedListener
  > | null>(null);

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
    // RF-218: land on the dashboard home tab.
    if (buyer && activeSeller && !user) {
      if (segments[0] !== "(customer)") {
        router.replace("/(customer)/(tabs)/home");
      }
      return;
    }

    // Not authenticated as either buyer or staff — allow only landing + auth screens.
    // BUG-B2-5: when the requested route is buyer-protected (e.g. a deep-linked
    // /invoices/<uuid>), send the user to /customer-login with returnTo so post-
    // login they land back on the intended page instead of the marketing home.
    if (!user) {
      if (segments.length > 0 && segments[0] !== "(auth)") {
        const isBuyerRoute = segments[0] === "(customer)";
        const isStaffRoute = segments[0] === "(operator)" || segments[0] === "(driver)";
        if (isBuyerRoute || isStaffRoute) {
          const returnTo =
            Platform.OS === "web" && typeof window !== "undefined"
              ? window.location.pathname + window.location.search
              : "";
          const target = isBuyerRoute ? "/(auth)/customer-login" : "/(auth)/login";
          if (returnTo && returnTo !== "/") {
            router.replace({ pathname: target, params: { returnTo } } as any);
          } else {
            router.replace(target as any);
          }
        } else {
          router.replace("/");
        }
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
    // "operator" → operator tabs
    // "driver"   → driver tabs
    //
    // RF-087: staff users must be able to access /(auth)/customer-login to sign
    // in to the buyer portal. Do NOT redirect them away from that screen.
    const onCustomerLogin = segments[0] === "(auth)" && segments[1] === "customer-login";

    // BUG-OPS1-3: shared resource paths like /invoices/[id] live under both
    // (operator)/(tabs)/invoices/[id] and (customer)/invoices/[id]. Expo
    // Router picks one deterministically; when an operator URL-bar deep-links
    // to /invoices/<uuid>, they may land on the (customer) variant. Instead
    // of bouncing them to /home — destroying the deep-link intent — map the
    // shared paths over to the operator equivalent.
    function mapSharedCustomerPathToOperator(): string | null {
      if (segments[0] !== "(customer)") return null;
      // segments[1] is the route segment (no leading "/").
      if (segments[1] === "invoices" && segments[2]) {
        return `/(operator)/(tabs)/invoices/${segments[2]}`;
      }
      if (segments[1] === "orders" && segments[2]) {
        return `/(operator)/(tabs)/orders/${segments[2]}`;
      }
      return null;
    }

    if (activeRole === "operator") {
      if (segments[0] !== "(operator)" && !onCustomerLogin) {
        const mapped = mapSharedCustomerPathToOperator();
        router.replace(mapped ?? "/(operator)/home");
      }
      return;
    }
    if (activeRole === "driver") {
      if (devLoading) return; // bootstrapping spinner covers this
      // Fail OPEN when the addon read did not land (offline, timeout, API 5xx):
      // a failed fetch leaves devMode false, and treating that as "not a dev
      // tenant" would strand a dev-mode tenant's pure DRIVER user on
      // operator-blocked — whose only control is Sign Out — with no refetch to
      // rescue them. Block only on a positively-read flag.
      if (devResolved && !devMode) {
        if (user.role === "DRIVER") {
          // Pure driver of a non-dev-mode tenant: no driver UI exists for them.
          // Guarded like the SUPER_ADMIN/CUSTOMER blocks above so a driver who
          // is already on operator-blocked doesn't get repeatedly replaced.
          if (segments[0] !== "(auth)" || segments[1] !== "operator-blocked") {
            router.replace("/(auth)/operator-blocked");
          }
          return;
        }
        // Dual-role user snaps back; effect re-runs into the operator branch.
        setActiveRole("operator");
        return;
      }
      if (segments[0] !== "(driver)" && !onCustomerLogin) {
        router.replace("/(driver)/route");
      }
      return;
    }
  }, [
    user,
    isLoading,
    tenantSlug,
    tenantLoading,
    activeRole,
    buyer,
    activeSeller,
    buyerLoading,
    segments,
    devMode,
    devLoading,
    devResolved,
  ]);

  // While auth/tenant/buyer state is being rehydrated from storage, render a
  // spinner instead of <Slot/>. Without this, on a hard URL refresh the child
  // routes mount with no auth context, fire API calls that 401, and the
  // interceptor can wipe tokens before bootstrap finishes.
  // Also covers the in-flight developer-mode addons fetch for a driver-role
  // active user, so the routing effect above never flashes driver UI (or the
  // operator-blocked screen) before the addon check resolves.
  const bootstrapping =
    isLoading || tenantLoading || buyerLoading || (!!user && activeRole === "driver" && devLoading);

  // On web viewed from a desktop browser the phone-sized layout stretches
  // uncomfortably wide. Clamp the app to a phone-ish width and center it
  // on a neutral backdrop. Native builds ignore this entirely.
  if (Platform.OS === "web") {
    return (
      <View style={webStyles.page}>
        <View style={webStyles.phoneFrame}>
          {bootstrapping ? (
            <View style={webStyles.center}>
              <ActivityIndicator color={ios.brand} />
            </View>
          ) : (
            <Slot />
          )}
        </View>
      </View>
    );
  }

  if (bootstrapping) {
    return (
      <View style={webStyles.center}>
        <ActivityIndicator color={ios.brand} />
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
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});

export default function RootLayout() {
  const [fontsLoaded, fontsError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontsError) SplashScreen.hideAsync();
  }, [fontsLoaded, fontsError]);

  // Font loading is best-effort. The previous gate
  // (`if (!fontsLoaded) return null`) caused the web bundle to render an
  // empty <div id="root"> when expo-font's promise hung or errored. Render
  // immediately with the system font fallback; the tree re-renders once the
  // Inter family is available. fontsError unblocks the splash screen so it
  // can never sit forever if font loading genuinely fails.

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <RootLayoutNav />
          <ConfirmModal />
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
