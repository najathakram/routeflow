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

  // UX QA: the three lines are STACKED (sentence / reason / contact or the action), the contact printed once, and the
  // admin's action is a >= 44 px control, full width at 390.
  return (
    <div
      className={cn(
        "flex items-start gap-2 bg-amber-50 text-amber-800 ring-1 ring-amber-200",
        compact ? "px-4 py-2 text-sm" : "rounded-lg px-4 py-3 text-sm",
      )}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">
        {copy.lines.map((line, i, all) => (
          <p
            key={i}
            data-testid="read-only-line-part"
            className={i === 0 ? "font-bold" : undefined}
          >
            {line}
            {i < all.length - 1 || isAdmin ? " " : ""}
          </p>
        ))}
        {isAdmin ? (
          <a
            href="/choose-plan"
            onClick={(e) => {
              if (guardCounterLeave(() => window.location.assign("/choose-plan")))
                e.preventDefault(); // POS-7: not mid-sale
            }}
            className="mt-1 inline-flex min-h-[44px] w-full items-center justify-center rounded-ctl border border-amber-300 bg-paper px-3 font-medium text-amber-900 underline-offset-2 sm:w-auto"
          >
            Choose a plan
          </a>
        ) : null}
      </div>
    </div>
  );
}
