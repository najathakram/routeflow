"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function InvoicePaymentsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/finance/payments");
  }, [router]);
  return null;
}
