"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

/**
 * A ledger "transaction" is an Invoice row (its id is the invoice id), so an old /bookkeeping/<id> link
 * opens the invoice page, which carries the tenant's branding and the payments (UX guide B13).
 */
export default function BookkeepingTransactionRedirect() {
  const router = useRouter();
  const { transactionId } = useParams<{ transactionId: string }>();
  useEffect(() => {
    router.replace(`/invoices/${transactionId}`);
  }, [router, transactionId]);
  return null;
}
