import { useEffect } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { useBuyerSessionStore } from "../../lib/buyer-session-store";
import { useBuyerSocket } from "../../hooks/useBuyerSocket";
import { customerLayoutTarget } from "../../lib/buyer-route-guard";

export default function CustomerLayout() {
  const { buyer, activeSeller, isLoading } = useBuyerSessionStore();
  const router = useRouter();
  const segments = useSegments() as string[];

  // RF-002: keep buyer-scoped queries fresh in real time across all customer
  // screens (orders, invoices, dashboard) without pull-to-refresh.
  useBuyerSocket();

  useEffect(() => {
    if (isLoading) return;
    // Signed out → customer-login; signed in with 0 sellers → sellers/connect only (#2341).
    const target = customerLayoutTarget({ hasBuyer: !!buyer, hasSeller: !!activeSeller, segments });
    if (target) router.replace(target as any);
  }, [buyer, activeSeller, isLoading, segments.join("/")]);

  return <Stack screenOptions={{ headerShown: false }} />;
}
