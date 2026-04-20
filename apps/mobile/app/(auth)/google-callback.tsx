import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { useAuthStore } from "../../lib/auth-store";

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
    error?: string;
  }>();
  const setUser = useAuthStore((s) => s.setUser);

  useEffect(() => {
    (async () => {
      if (params.error) {
        router.replace("/(auth)/login");
        return;
      }
      const { accessToken, refreshToken } = params;
      if (!accessToken || !refreshToken) {
        router.replace("/(auth)/login");
        return;
      }

      // Persist tokens + decode user — same shape as loginWithGoogle
      const [, payloadPart] = accessToken.split(".");
      let user = null;
      if (payloadPart) {
        try {
          const payload = JSON.parse(
            atob(payloadPart.replace(/-/g, "+").replace(/_/g, "/")),
          );
          user = {
            id: payload.sub,
            username: payload.username,
            role: payload.role,
            status: payload.status ?? "ACTIVE",
            forcePasswordChange: payload.forcePasswordChange ?? false,
          };
        } catch {
          // fall through
        }
      }

      const { default: SecureStore } = await import("expo-secure-store");
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem("accessToken", accessToken);
        window.localStorage.setItem("refreshToken", refreshToken);
      } else {
        await SecureStore.setItemAsync("accessToken", accessToken);
        await SecureStore.setItemAsync("refreshToken", refreshToken);
      }

      if (user) setUser(user);
      // RootLayoutNav will redirect based on role
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
