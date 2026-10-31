"use client";

import { useToast } from "@routeflow/ui/web";
import { useReadyForPickup } from "@/lib/api/ready-for-pickup";
import { readyForPickupCopy } from "@/lib/ready-for-pickup-copy";

/**
 * The order page's "Ready for pickup" press (W-1043): one POST, then the page follows the server (`onReady`) and
 * staff are told what happened to the email. A SENT notice is a toast that fades; every other notice stays until
 * dismissed, because somebody has to tell the customer another way. A refusal goes to the page's own handler.
 */
export function useReadyForPickupAction(p: {
  orderId: string | undefined;
  customerName: string | null | undefined;
  onReady: () => void;
  onError: (err: unknown) => void;
}) {
  const { toast } = useToast();
  const ready = useReadyForPickup();
  const press = () => {
    if (!p.orderId) return;
    ready.mutate(p.orderId, {
      onSuccess: (res) => {
        p.onReady();
        if ("alreadyReady" in res) return; // a repeat press: nothing moved, nothing was sent
        const copy = readyForPickupCopy(res, p.customerName);
        toast(
          copy.success
            ? { title: copy.text, variant: "success" }
            : { title: copy.text, variant: "warning", duration: Infinity },
        );
      },
      onError: (err) => p.onError(err),
    });
  };
  return { press, pending: ready.isPending };
}
