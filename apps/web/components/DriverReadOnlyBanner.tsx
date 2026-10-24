"use client";

import * as React from "react";
import { API_ERROR_CODES } from "@routeflow/types";
import { useReadOnlyRefusal } from "@/lib/read-only-gate";
import { ReadOnlyBanner } from "./ReadOnlyBanner";

/**
 * The read-only banner for the DRIVER shell. A driver cannot read the subscription (the billing endpoint is
 * staff-only), so the banner appears when a write is refused with 403 READ_ONLY - that refusal carries the tenant's
 * reason - and stays while the gate's refusal is live. It is the same ReadOnlyBanner (owner's sentence + reason),
 * with no admin action; the contact line is the generic "contact your workspace admin" (the admin e-mail is staff-only data).
 */
export function DriverReadOnlyBanner() {
  const { refused, reason } = useReadOnlyRefusal();
  if (!refused) return null;
  // the tenant status word is the READ_ONLY constant (the status the refusal itself names)
  return (
    <ReadOnlyBanner
      status={API_ERROR_CODES.READ_ONLY}
      readOnlyReason={reason}
      isAdmin={false}
      contactFallback
      compact
    />
  );
}
