import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { useAuthStore } from "../../lib/auth-store";
import { useBuyerSessionStore } from "../../lib/buyer-session-store";

/**
 * Safety-net deep-link handler for the Google OAuth callback.
 *
 * On iOS + Android, expo-web-browser's openAuthSessionAsync catches the
 * routeflow:// redirect inline and the caller handles tokens directly —
 * this route isn't hit in normal flows.
 *
 * On web, or on any device where the system misses the in-app resolve,
 * the OS opens the app via the scheme and lands us here with the tokens
 * in query params. We persist them and let RootLayoutNav re-route based
 * on role.
 */
export default function GoogleCallbackScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    accessToken?: string;
    refreshToken?: string;
    type?: string;
    error?: string;
  }>();
  const setUser = useAuthStore((s) => s.setUser);
  const { setBuyer } = useBuyerSessionStore();

  useEffect(() => {
    (async () => {
      if (params.error) {
        router.replace(params.type === "BUYER" ? "/(auth)/customer-login" : "/(auth)/login");
        return;
      }
      const { accessToken, refreshToken, type } = params;
      if (!accessToken || !refreshToken) {
        router.replace("/(auth)/login");
        return;
      }

      const [, payloadPart] = accessToken.split(".");
      let payload: Record<string, unknown> | null = null;
      if (payloadPart) {
        try {
          payload = JSON.parse(atob(payloadPart.replace(/-/g, "+").replace(/_/g, "/")));
        } catch {
          // fall through
        }
      }

      const { default: SecureStore } = await import("expo-secure-store");
      const isWeb = typeof window !== "undefined" && window.localStorage;

      if (type === "BUYER") {
        // Buyer Google callback — store buyer tokens and session
        if (isWeb) {
          window.localStorage.setItem("buyerAccessToken", accessToken);
          window.localStorage.setItem("buyerRefreshToken", refreshToken);
        } else {
          await SecureStore.setItemAsync("buyerAccessToken", accessToken);
          await SecureStore.setItemAsync("buyerRefreshToken", refreshToken);
        }
        if (payload) {
          setBuyer({
            id: payload.sub as string,
            email: payload.email as string,
            name: (payload.name as string) ?? "",
          });
        }
        // Fetch sellers + select — let customer-login handle multi-seller; here
        // we just route to orders and let the customer layout guard handle it
        router.replace("/(customer)/orders");
      } else {
        // Staff Google callback
        if (isWeb) {
          window.localStorage.setItem("accessToken", accessToken);
          window.localStorage.setItem("refreshToken", refreshToken);
        } else {
          await SecureStore.setItemAsync("accessToken", accessToken);
          await SecureStore.setItemAsync("refreshToken", refreshToken);
        }
        if (payload) {
          setUser({
            id: payload.sub as string,
            username: payload.username as string,
            role: payload.role as any,
            status: (payload.status as any) ?? "ACTIVE",
            forcePasswordChange: (payload.forcePasswordChange as boolean) ?? false,
            isAdmin: (payload.isAdmin as boolean) ?? false,
            canActAsDriver: (payload.canActAsDriver as boolean) ?? false,
          });
        }
        // RootLayoutNav will redirect based on role
      }
    })();
  }, []);

  return (
    <View style={styles.root}>
      <ActivityIndicator color={ios.brand} />
      <Text style={styles.label}>Completing sign-in…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: ios.bgElev,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  label: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
  },
});
