"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function FinanceCustomersRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/finance/reports?report=customer-balance");
  }, [router]);
  return null;
}
