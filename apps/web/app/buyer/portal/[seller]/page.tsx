"use client";

import { useEffect } from "react";
import { useRouter, useParams } from "next/navigation";

/**
 * /buyer/portal/[seller] — redirect to the orders sub-page so that
 * direct navigation and back-button behaviour work correctly instead
 * of rendering a 404.
 */
export default function BuyerSellerRoot() {
  const router = useRouter();
  const params = useParams();
  const seller = params.seller as string;

  useEffect(() => {
    router.replace(`/buyer/portal/${seller}/orders`);
  }, [router, seller]);

  return null;
}
