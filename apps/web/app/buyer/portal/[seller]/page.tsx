"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { BuyerAnalytics } from "@routeflow/types";
import { buyerApiClient } from "@/lib/buyer-api-client";
import { useBuyerAuth } from "@/lib/buyer-auth-context";

/**
 * /buyer/portal/[seller] — the portal home. It decides where this buyer lands (SA-1211 A1.2):
 * a buyer with 0 counted orders (the summary's totalOrders, which skips CANCELLED and DRAFT) lands
 * on Invoices; an ordering buyer keeps the page they had (Orders when they came from the seller
 * list with `?then=orders`, otherwise the dashboard). A loader shows while the read is in flight,
 * and a failed read sends the buyer where they went before.
 */
function PortalHome() {
  const router = useRouter();
  const params = useParams();
  const search = useSearchParams();
  const seller = params.seller as string;
  const { activeSeller, isLoading: authLoading } = useBuyerAuth();

  const orderingTarget = search.get("then") === "orders" ? "orders" : "dashboard";
  const sellerReady = !authLoading && activeSeller?.tenant.slug === seller;

  const { data, isError, isPending } = useQuery<BuyerAnalytics>({
    queryKey: ["buyer", "portal-home", seller],
    queryFn: () => buyerApiClient.get("/buyer/analytics").then((r) => r.data),
    enabled: sellerReady,
    retry: false,
  });

  // No matching active seller once auth settled: nothing to read, go where we went before.
  const settled = !authLoading && (!sellerReady || !isPending || isError);
  const target = data?.summary.totalOrders === 0 ? "invoices" : orderingTarget;

  useEffect(() => {
    if (settled) router.replace(`/buyer/portal/${seller}/${target}`);
  }, [settled, router, seller, target]);

  return (
    <div role="status" aria-label="Loading" className="flex items-center justify-center py-16">
      <Loader2 className="h-8 w-8 animate-spin text-buyer-500" />
    </div>
  );
}

export default function BuyerSellerRoot() {
  return (
    <Suspense fallback={null}>
      <PortalHome />
    </Suspense>
  );
}
