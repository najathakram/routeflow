"use client";

import { Button } from "@routeflow/ui/web";
import { RotateCcw } from "lucide-react";
import { ActionTier } from "./ActionTier";

/**
 * SA-1101 §2.5 / §4.3: the one action on a REFUSED order. "Deliver again" puts it back to CONFIRMED so it can go
 * on a run again. It is not a demotion, so there is no reason box: the driver's reason is already on the stop.
 * It renders nothing for any other status, so it can sit beside the other status blocks without a guard.
 * The page owns the status call (`handleDeliverAgain`), so a credit or restriction 409 reaches its guard dialogs.
 */
export function DeliverAgainTier({
  status,
  onDeliverAgain,
  loading = false,
}: {
  status: string;
  onDeliverAgain: () => void;
  loading?: boolean;
}) {
  if (status !== "REFUSED") return null;
  return (
    <ActionTier tier="secondary">
      <div className="flex flex-col items-start gap-1">
        <Button
          size="sm"
          variant="secondary"
          leftIcon={<RotateCcw className="h-4 w-4" />}
          onClick={onDeliverAgain}
          loading={loading}
        >
          Deliver again
        </Button>
        <p className="text-[11px] text-navy/50" data-testid="refused-note">
          Refused at delivery. Deliver again puts it back to Confirmed.
        </p>
      </div>
    </ActionTier>
  );
}
