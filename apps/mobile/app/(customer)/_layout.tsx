import { useEffect } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { useBuyerSessionStore } from "../../lib/buyer-session-store";

export default function CustomerLayout() {
  const { buyer, activeSeller, isLoading } = useBuyerSessionStore();
  const router = useRouter();
  const segments = useSegments();

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
