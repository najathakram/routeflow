"use client";

import { useToast } from "@routeflow/ui/web";
import { useReadyForPickup } from "@/lib/api/ready-for-pickup";
import { readyForPickupCopy, toldOnceCopy } from "@/lib/ready-for-pickup-copy";

/**
 * The order page's "Ready for pickup" press (W-1043): one POST, then the page follows the server (`onReady`) and
 * staff are told what happened to the email. A SENT notice is a toast that fades; every other notice stays until
 * dismissed, because somebody has to tell the customer another way. A refusal goes to the page's own handler.
 * A customer already emailed (`toldOnce`, W-1060) is a toast that fades too: the order moved, nothing went.
 * `resend` is "Send again": the one deliberate way to email a second time; its answer reads like a press.
 */
export function useReadyForPickupAction(p: {
  orderId: string | undefined;
  customerName: string | null | undefined;
  onReady: () => void;
  onError: (err: unknown) => void;
}) {
  const { toast } = useToast();
  const ready = useReadyForPickup();
  const run = (resend: boolean) => {
    if (!p.orderId) return;
    ready.mutate(resend ? { id: p.orderId, resend: true } : p.orderId, {
      onSuccess: (res) => {
        p.onReady();
        if ("alreadyReady" in res) return; // a repeat press: nothing moved, nothing was sent
        if ("toldOnce" in res) {
          toast({ title: toldOnceCopy(res, p.customerName), variant: "success" });
          return;
        }
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
  return { press: () => run(false), resend: () => run(true), pending: ready.isPending };
}
