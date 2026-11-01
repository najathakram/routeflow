"use client";

import * as React from "react";
import { Button } from "@routeflow/ui/web";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useReadyForPickupRecord } from "@/lib/api/ready-for-pickup";
import { readyLineCopy, readyStageOf, readyWhen } from "@/lib/ready-for-pickup-copy";
import { useTenantTimeZone } from "@/lib/tenant-timezone";
import { useReadyForPickupAction } from "./use-ready-for-pickup";

/**
 * The one line under a pickup order's actions (W-1060, SA-1070 rule 6): what the customer was last emailed, or what
 * marking ready would do. Body text, not a pill: a state is not a badge. "Send again" (a sent email) and "Send email"
 * (a failed one) sit on the line only once the order is Ready; a second send to a customer already emailed asks first.
 */
export function ReadyEmailLine({
  orderId,
  status,
  customerName,
  onError,
}: {
  orderId: string;
  /** The order's status: the preview shows only while Ready for pickup can be pressed, the buttons only once Ready. */
  status: string | null | undefined;
  customerName: string | null | undefined;
  onError: (err: unknown) => void;
}) {
  const { data } = useReadyForPickupRecord(orderId, true);
  const zone = useTenantTimeZone();
  const [confirming, setConfirming] = React.useState(false);
  const action = useReadyForPickupAction({ orderId, customerName, onReady: () => {}, onError });
  if (!data?.preview) return null; // not the record shape (no staff access, or a stale answer): say nothing
  const line = readyLineCopy(data, readyStageOf(status), zone);
  if (!line) return null;
  const sentAt = data.last ? readyWhen(data.last.at, zone) : null;
  const send = () => {
    setConfirming(false);
    action.resend();
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-navy/70">
      <p data-testid="ready-email-line" className="min-w-0 break-words">
        {line.text}
      </p>
      {line.action && (
        <Button
          variant="ghost"
          size="sm"
          disabled={action.pending}
          onClick={line.action === "SEND_AGAIN" ? () => setConfirming(true) : send}
        >
          {line.action === "SEND_AGAIN" ? "Send again" : "Send email"}
        </Button>
      )}
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={send}
        title="Email this customer again?"
        description={
          sentAt && data.last?.email
            ? `${data.last.email} was emailed on ${sentAt.day} at ${sentAt.time}.`
            : "This customer was already emailed."
        }
        confirmLabel="Send again"
        variant="warning"
        loading={action.pending}
      />
    </div>
  );
}
