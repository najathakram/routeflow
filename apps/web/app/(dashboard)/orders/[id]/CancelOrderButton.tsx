"use client";

import * as React from "react";
import { XCircle } from "lucide-react";
import { Button } from "@routeflow/ui/web";

/** Fixed copy for a cancel the server refuses (ORDER_WITH_CARRIER_NO_CANCEL): same words as the 409. */
export const WITH_CARRIER_COPY =
  "This order is already with the carrier. Use a return instead of cancelling.";

/**
 * "Cancel Order". When the server says the parcel is with the carrier (`cancelBlockedReason`), there is
 * no button, only the explanation: cancelling would put its stock back while the parcel is still out.
 * The reason is the server's one answer (B1083); the web never derives it from the status.
 */
export function CancelOrderButton({
  blockedReason,
  onClick,
}: {
  blockedReason?: "WITH_CARRIER" | null;
  onClick: () => void;
}) {
  if (blockedReason === "WITH_CARRIER") {
    return (
      <p role="note" className="text-xs text-navy/70">
        {WITH_CARRIER_COPY}
      </p>
    );
  }
  return (
    <Button size="sm" variant="danger" leftIcon={<XCircle className="h-4 w-4" />} onClick={onClick}>
      Cancel Order
    </Button>
  );
}
