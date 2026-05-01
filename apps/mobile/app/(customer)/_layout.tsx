import { useEffect } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { useBuyerSessionStore } from "../../lib/buyer-session-store";
import { useBuyerSocket } from "../../hooks/useBuyerSocket";

export default function CustomerLayout() {
  const { buyer, activeSeller, isLoading } = useBuyerSessionStore();
  const router = useRouter();
  const segments = useSegments() as string[];

  // RF-002: keep buyer-scoped queries fresh in real time across all customer
  // screens (orders, invoices, dashboard) without pull-to-refresh.
  useBuyerSocket();

  useEffect(() => {
    if (isLoading) return;
    if (!buyer || !activeSeller) {
      // Not authenticated as buyer — redirect to login
      if (!(segments[0] === "(auth)" && segments[1] === "customer-login")) {
        router.replace("/(auth)/customer-login");
      }
    }
  }, [buyer, activeSeller, isLoading]);

  return <Stack screenOptions={{ headerShown: false }} />;
}
