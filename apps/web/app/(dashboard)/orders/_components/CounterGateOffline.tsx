"use client";

import * as React from "react";
import { Button } from "@routeflow/ui/web";
import { COUNTER_GATE_CHECK_FAILED_COPY } from "@/lib/counter-sale";

/**
 * CQ-30: shown when the counter-sale capability lookup FAILED (no network, a server error). It is not the "not turned on"
 * answer, which only a successful lookup may give. No sale UI renders; Retry asks again.
 */
export function CounterGateOffline({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="mx-auto flex max-w-md flex-col items-start gap-3 p-4 text-sm"
      data-testid="counter-sale-offline"
    >
      <p>{COUNTER_GATE_CHECK_FAILED_COPY}</p>
      <Button className="min-h-[44px]" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
