"use client";

import * as React from "react";
import { Select, useToast } from "@routeflow/ui/web";
import { usePatchOrderFulfillPath } from "@/lib/api/orders";
import { codedToastCopy } from "@/lib/generic-toast-copy";
import { fulfilPathOptions, type FulfilPath } from "@/lib/fulfil-path-options";

type Writable = "ROUTE" | "SHIP";

/** Order-detail "Fulfillment" summary row: ROUTE/SHIP picker; a PICKUP order lists "Pick up at store" as current. */
export function OrderFulfilmentRow({
  orderId,
  fulfillPath,
  locked,
  offered,
  onLeavePickup,
}: {
  orderId: string;
  fulfillPath: FulfilPath;
  locked: boolean;
  /** The ROUTE/SHIP paths the account offers. The order's own path is always listed too, so an order
   *  stranded on a path the account no longer offers (a ROUTE order in a ship-only account) can be moved. */
  offered?: Writable[];
  /** Called instead of patching when the order is on PICKUP: the page opens its move-off-pickup confirm. */
  onLeavePickup?: (path: Writable) => void;
}) {
  const { toast } = useToast();
  const patchFulfillPath = usePatchOrderFulfillPath({ localErrorToast: true });
  const allowed = new Set<FulfilPath>([fulfillPath, ...(offered ?? ["ROUTE", "SHIP"])]);
  const options = fulfilPathOptions(fulfillPath).filter((o) => allowed.has(o.value));
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-navy/70">Fulfillment</dt>
      <dd className="flex flex-col items-end gap-0.5">
        <div className="w-40">
          <Select
            options={options}
            value={fulfillPath}
            disabled={locked || patchFulfillPath.isPending}
            title={
              locked ? "Fulfillment path can only be changed while the order is open" : undefined
            }
            onChange={(e) => {
              const next = e.target.value as FulfilPath;
              if (next === fulfillPath || next === "PICKUP") return;
              if (fulfillPath === "PICKUP" && onLeavePickup) return onLeavePickup(next);
              patchFulfillPath.mutate(
                { id: orderId, fulfillPath: next },
                {
                  onSuccess: () => toast({ title: "Fulfillment updated", variant: "success" }),
                  onError: (err: any) =>
                    toast({
                      title: "Could not update fulfillment",
                      description: codedToastCopy(err) ?? err?.response?.data?.message,
                      variant: "error",
                    }),
                },
              );
            }}
          />
        </div>
        {fulfillPath === "SHIP" && (
          <span className="text-[11px] text-navy/50">
            Ships via carrier — won&apos;t appear on delivery routes.
          </span>
        )}
      </dd>
    </div>
  );
}
