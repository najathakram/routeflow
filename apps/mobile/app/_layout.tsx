import { useEffect } from "react";
import { Slot, useRouter, useSegments } from "expo-router";
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import * as SplashScreen from "expo-splash-screen";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UserRole } from "@routeflow/types";
import { useAuthStore } from "../lib/auth-store";

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

function RootLayoutNav() {
  const { user, isLoading, initialize } = useAuthStore();
  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    initialize();
  }, []);

  useEffect(() => {
    if (isLoading) return;

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

    if (user.role === UserRole.OPERATOR) {
      if (!(segments[0] === "(auth)" && segments[1] === "operator-blocked")) {
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
        router.replace("/(driver)");
      }
    }
  }, [user, isLoading, segments]);

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
