"use client";

import * as React from "react";
import { Button } from "@routeflow/ui/web";
import { Store } from "lucide-react";
import { completeAtCounterOffered } from "@routeflow/pricing";
import { COUNTER_COPY } from "@routeflow/types";
import type { Order } from "@/lib/api/orders";
import { useCounterSaleGate } from "@/lib/api/counter-sale";

/**
 * I-120 (SA-861 rules 1-3, G7): "Complete at counter" finishes an open order at the store in one step (hand over,
 * invoice, take payment like the till) through the pickup hand-over engine. A SECONDARY action next to the order's primary
 * status action. Where it shows is the ONE shared rule `completeAtCounterOffered` (@routeflow/pricing): the till
 * permission and a business that hands over at the store, an open order, never beside the pickup hand-over (the same
 * engine), and held for OWNER-QUEUE 7a. The server refuses everything else on its own.
 */
export function CompleteAtCounterButton({ order, onOpen }: { order: Order; onOpen: () => void }) {
  const { mayUseTill, capability, loading } = useCounterSaleGate();
  const offered =
    !loading &&
    completeAtCounterOffered({
      mayUseTill,
      methods: capability?.methods,
      counter: capability?.counter,
      status: order.status,
      fulfillPath: order.fulfillPath,
      counterSale: (order as { counterSale?: boolean | null }).counterSale,
      shippedAt: (order as { shippedAt?: string | null }).shippedAt,
    });
  if (!offered) return null;
  return (
    <Button size="sm" variant="secondary" leftIcon={<Store className="h-4 w-4" />} onClick={onOpen}>
      {COUNTER_COPY.completeAtCounter}
    </Button>
  );
}
