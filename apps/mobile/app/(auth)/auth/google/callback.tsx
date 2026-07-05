import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { apiClient } from "../../../../lib/api-client";
import { OP_KEYS, DRIVER_KEYS, BUYER_KEYS, CURRENT_ROLE_KEY } from "../../../../lib/auth-keys";

/**
 * Web Google OAuth callback (F8-001 one-time-code exchange).
 *
 * The mobile-web build (which phones are proxied to at www.routeflow.info) can't
 * use the native routeflow:// deep-link flow, so lib/auth.ts's loginWithGoogle
 * does a full-page redirect on web. The API lands the browser back here
 * (WEB_URL/auth/google/callback?code=…); we trade the code for tokens via
 * /auth/google/exchange, persist them under the role-namespaced keys, then do a
 * hard reload so RootLayout.initialize() re-reads them cleanly and routes by role
 * (a soft setState would race the initialize() that runs on this fresh page load).
 * Native apps never reach this route.
 */
export default function GoogleWebCallbackScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ code?: string; error?: string }>();
  const [message, setMessage] = useState("Completing sign-in…");

  useEffect(() => {
    void (async () => {
      const setItem = (k: string, v: string) => {
        if (typeof window !== "undefined" && window.localStorage) window.localStorage.setItem(k, v);
      };
      const backToLogin = () => router.replace("/(auth)/login");

      if (params.error) return backToLogin();
      const code = typeof params.code === "string" ? params.code : "";
      if (!code) return backToLogin();

      let bundle: Record<string, string>;
      try {
        const { data } = await apiClient.post<Record<string, string>>("/auth/google/exchange", {
          code,
        });
        bundle = data;
      } catch {
        setMessage("Sign-in failed. Returning to login…");
        setTimeout(backToLogin, 1500);
        return;
      }

      const { accessToken, refreshToken, role, tenantSlug, type } = bundle;
      if (!accessToken || !refreshToken) return backToLogin();

      if (type === "BUYER") {
        setItem(BUYER_KEYS.accessToken, accessToken);
        setItem(BUYER_KEYS.refreshToken, refreshToken);
        setItem(CURRENT_ROLE_KEY, "buyer");
      } else {
        const staffKeys = role === "DRIVER" ? DRIVER_KEYS : OP_KEYS;
        setItem(staffKeys.accessToken, accessToken);
        setItem(staffKeys.refreshToken, refreshToken);
        setItem(CURRENT_ROLE_KEY, role === "DRIVER" ? "driver" : "operator");
        if (tenantSlug) setItem("tenantSlug", tenantSlug);
      }

      // Hard reload — RootLayout.initialize() reads the freshly-stored tokens on the
      // next load and routes to the role home (no soft-setState/initialize race).
      if (typeof window !== "undefined") window.location.replace("/");
      else router.replace("/(auth)/login");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.root}>
      <ActivityIndicator color={ios.brand} />
      <Text style={styles.label}>{message}</Text>
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
