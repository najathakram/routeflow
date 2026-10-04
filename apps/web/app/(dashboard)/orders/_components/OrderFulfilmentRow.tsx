"use client";

import * as React from "react";
import { Select, useToast } from "@routeflow/ui/web";
import { usePatchOrderFulfillPath } from "@/lib/api/orders";
import { codedToastCopy } from "@/lib/generic-toast-copy";

/** Order-detail "Fulfillment" summary row: ROUTE/SHIP picker. Rendered only when the account offers a choice. */
export function OrderFulfilmentRow({
  orderId,
  fulfillPath,
  locked,
}: {
  orderId: string;
  fulfillPath: "ROUTE" | "SHIP";
  locked: boolean;
}) {
  const { toast } = useToast();
  const patchFulfillPath = usePatchOrderFulfillPath({ localErrorToast: true });
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-navy/70">Fulfillment</dt>
      <dd className="flex flex-col items-end gap-0.5">
        <div className="w-40">
          <Select
            options={[
              { value: "ROUTE", label: "Delivery route" },
              { value: "SHIP", label: "Ship via carrier" },
            ]}
            value={fulfillPath}
            disabled={locked || patchFulfillPath.isPending}
            title={
              locked ? "Fulfillment path can only be changed while the order is open" : undefined
            }
            onChange={(e) => {
              patchFulfillPath.mutate(
                { id: orderId, fulfillPath: e.target.value as "ROUTE" | "SHIP" },
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
