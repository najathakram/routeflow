import * as React from "react";
import type { TenantCapability } from "@routeflow/types";

/**
 * SA-649 R1: shown when a tenant's fulfilment mode says delivery but no fleet module is effective. Fleet comes only
 * from the modules; the warning tells the admin to turn one on (or change the mode). Fixed copy.
 */
export function CapabilityWarning({ capability }: { capability: TenantCapability | null }) {
  if (!capability || capability.consistent !== false) return null;
  return (
    <p
      role="status"
      data-testid="capability-warning"
      className="rounded-lg bg-amber-900/30 px-3 py-2 text-xs text-amber-300 ring-1 ring-amber-600/30"
    >
      Orders are set to use delivery, but no fleet feature is on. Turn on Recurring routes or Order
      delivery, or change the fulfilment mode.
    </p>
  );
}
