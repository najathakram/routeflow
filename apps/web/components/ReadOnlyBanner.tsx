"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import { guardCounterLeave } from "@/lib/counter-cart-signal";
import { readOnlyCopy } from "@/lib/read-only-copy";

// ─── ReadOnlyBanner (RO-1) ───────────────────────────────────────────────────
// Shared read-only-workspace notice — the billing page's full-width card version and the
// dashboard shell's compact persistent slot (next to ImpersonationBanner) both render this.
// Mirrors TrialBanner's markup/styling (settings/billing/page.tsx) at the same visual weight.

export interface ReadOnlyBannerProps {
  status: string;
  readOnlyReason?: string | null;
  /** Condensed single-line variant for the dashboard-wide banner slot. */
  compact?: boolean;
  /** The amount owed (dollars) when the reason is `payment_overdue` (admins only; the server trims it for others). */
  overdueAmount?: number | null;
  /** `SubscriptionView.billingContactEmail`: the non-admin's "contact your admin" line. */
  billingContactEmail?: string | null;
  /** A TENANT_ADMIN sees the Choose a plan action; anyone else the contact line. Defaults to admin (old shape). */
  isAdmin?: boolean;
}

/**
 * SA-776: the owner's sentence + the mapped reason line + (non-admin) the contact line, composed in
 * `lib/read-only-copy.ts`; a TENANT_ADMIN gets the "Choose a plan" action in place of the contact line.
 */
export function ReadOnlyBanner({
  status,
  readOnlyReason,
  compact = false,
  overdueAmount,
  billingContactEmail,
  isAdmin = true,
}: ReadOnlyBannerProps) {
  if (status !== "READ_ONLY") return null;
  const copy = readOnlyCopy({
    reason: readOnlyReason,
    overdueAmount,
    billingContactEmail,
    isAdmin,
  });

  return (
    <div
      className={cn(
        "flex items-center gap-2 bg-amber-50 text-amber-800 ring-1 ring-amber-200",
        compact ? "px-4 py-2 text-sm" : "rounded-lg px-4 py-3 text-sm",
      )}
    >
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>
        <strong>{copy.sentence}</strong>
        {copy.reasonLine ? ` ${copy.reasonLine}` : ""}
        {copy.contactLine ? ` ${copy.contactLine}` : ""}
        {isAdmin ? (
          <>
            {" "}
            <a
              href="/choose-plan"
              onClick={(e) => {
                if (guardCounterLeave(() => window.location.assign("/choose-plan")))
                  e.preventDefault(); // POS-7: not mid-sale
              }}
              className="font-medium underline underline-offset-2"
            >
              Choose a plan
            </a>
          </>
        ) : null}
      </span>
    </div>
  );
}
