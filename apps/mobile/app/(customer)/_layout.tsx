import { useEffect } from "react";
import { Redirect, Stack, useRouter, useSegments } from "expo-router";
import { useBuyerSessionStore } from "../../lib/buyer-session-store";
import { useBuyerSocket } from "../../hooks/useBuyerSocket";
import { customerLayoutTarget } from "../../lib/buyer-route-guard";
import { SHELL_ON } from "../../lib/web-shell/shell-env";
import { SHELL_BUYER_ROUTE } from "../../lib/web-shell/shell-routing";

/**
 * W-830: with the hybrid shell on this group is never shown (the buyer portal is the web). The
 * redirect renders instead of the Stack, so no (customer) screen mounts and no buyer socket opens.
 * SHELL_ON is a build-time constant, so the hook order below never changes between renders.
 */
export default function CustomerLayout() {
  if (SHELL_ON) return <Redirect href={SHELL_BUYER_ROUTE as any} />;
  return <NativeCustomerLayout />;
}

function NativeCustomerLayout() {
  const { buyer, activeSeller, isLoading } = useBuyerSessionStore();
  const router = useRouter();
  const segments = useSegments() as string[];

  // RF-002: keep buyer-scoped queries fresh in real time across all customer
  // screens (orders, invoices, dashboard) without pull-to-refresh.
  useBuyerSocket();

  useEffect(() => {
    if (isLoading) return;
    // Signed out → customer-login; signed in with 0 sellers → sellers/connect only (#2341).
    const target = customerLayoutTarget({
      hasBuyer: !!buyer,
      hasSeller: !!activeSeller,
      segments,
      shellOn: SHELL_ON,
    });
    if (target) router.replace(target as any);
  }, [buyer, activeSeller, isLoading, segments.join("/")]);

  return <Stack screenOptions={{ headerShown: false }} />;
}
