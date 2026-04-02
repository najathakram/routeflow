"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import React from "react";

function PurchasesRedirectContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = searchParams.get("tab");

  useEffect(() => {
    // Map old tab names to new ones
    const mapped = tab === "bills" ? "inventory" : tab === "expenses" ? "other" : null;
    router.replace(mapped ? `/finance/expenses?tab=${mapped}` : "/finance/expenses");
  }, [router, tab]);

  return null;
}

export default function PurchasesRedirect() {
  return (
    <React.Suspense fallback={null}>
      <PurchasesRedirectContent />
    </React.Suspense>
  );
}
