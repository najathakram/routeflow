"use client";

import { Button } from "@routeflow/ui/web";
import { RotateCcw } from "lucide-react";
import { ActionTier } from "./ActionTier";

/** The DELIVERED "Reopen order" tier. A paid walk-in sale stays closed (the server refuses it too). */
export function ReopenDeliveredTier({
  locked,
  onReopen,
}: {
  locked: boolean;
  onReopen: () => void;
}) {
  if (locked) return null;
  return (
    <ActionTier tier="secondary">
      <div className="flex flex-col items-start gap-1">
        <Button
          size="sm"
          variant="secondary"
          leftIcon={<RotateCcw className="h-4 w-4" />}
          onClick={onReopen}
        >
          Reopen order
        </Button>
        <p className="text-[11px] text-navy/50">
          Reopening keeps the invoice in sync while you edit. Orders delivered on a route reopen at
          their original stop.
        </p>
      </div>
    </ActionTier>
  );
}
