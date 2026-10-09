"use client";

import * as React from "react";
import type { CounterSalePaymentMethod, CounterSaleResponse } from "@routeflow/types";
import { useTenant } from "@/components/tenant-provider";
import { useOptionalAuth } from "@/lib/auth-context";
import {
  buildCounterReceipt,
  type ReceiptBusinessProfile,
  type ReceiptLineInput,
} from "@/lib/counter-receipt";
import { CounterReceiptView } from "./CounterReceiptView";

/**
 * The printable counter-sale receipt body: store header, numbers + date, lines (qty × unit = total), totals and tender, and
 * a Print button. A failed or empty settings read just leaves the header out; the server's error text is never shown.
 */
export function CounterReceiptBody({
  receipt,
  lines,
  enteredTender,
  profile,
  fallbackMethod,
  headingRef,
  customerName,
}: {
  receipt: CounterSaleResponse;
  lines: readonly ReceiptLineInput[];
  enteredTender: number | null;
  /** the screen's own `GET /settings` answer (address + phone); no fetch happens here */
  profile?: ReceiptBusinessProfile | null;
  fallbackMethod?: CounterSalePaymentMethod;
  /** POS-1: the screen focuses this heading when the receipt appears. */
  headingRef?: React.Ref<HTMLHeadingElement>;
  /** the named customer on the sale; omit for a walk-in */
  customerName?: string | null;
}) {
  const { branding } = useTenant();
  const cashier = useOptionalAuth()?.user?.username ?? null;
  const [now] = React.useState(() => new Date());
  const m = buildCounterReceipt({
    receipt,
    lines,
    enteredTender,
    fallbackMethod,
    cashier,
    customerName,
    now,
    profile: {
      ...profile,
      businessName: branding?.businessName || profile?.businessName,
    },
  });
  return (
    <CounterReceiptView model={m} logoUrl={branding?.logoUrl ?? null} headingRef={headingRef} />
  );
}
