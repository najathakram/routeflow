"use client";

import * as React from "react";
import { Info, X } from "lucide-react";
import type { PaymentDueView } from "@routeflow/types";
import { Button, cn } from "@routeflow/ui/web";
import { useBillingPortal } from "@/lib/api/billing";
import { usePayPaymentDue } from "@/lib/api/payment-due";
import { dismissBanner, isBannerDismissed } from "@/lib/banner-dismiss";
import {
  cardReminderCopy,
  cardReminderDismiss,
  failedRenewalCopy,
  paymentDueCopy,
} from "@/lib/payment-due";
import type { BannerDismiss, BannerRole } from "@/lib/subscription-banner-state";
import { useTenantTimeZoneQuery } from "@/lib/tenant-timezone";
import { useGuardedRouter } from "@/lib/use-guarded-router";

/**
 * Row 542: the "payment due" banner, and its failed-renewal variant, in the dashboard shell's one billing slot
 * (where the SubscriptionStrip sits). Copy comes from `lib/payment-due.ts`; whether it shows comes from
 * `paymentDueSlot`. Amber, never red; in the normal flow (never over the counter's cart); a payment due is dismissible
 * for the day by an operator only (an admin cannot until it is paid), the failed-renewal variant keeps the strip's own dismiss rule (`dismiss`).
 * SA-801: mode "card-reminder" is the same banner for a stub-free catch-up (nothing owed, add the card before the first
 * charge); its Add card is the same pay mutation, and its dismiss rule is `cardReminderDismiss`.
 */
export function PaymentDueBanner({
  mode,
  due,
  role,
  dismiss = null,
  hideBillingLink = false,
}: {
  mode: "payment-due" | "failed-renewal" | "card-reminder";
  /** The server's payment-due read (mode "payment-due"). */
  due?: PaymentDueView | null;
  role: BannerRole;
  /** The strip's dismiss rule, for the failed-renewal variant only. */
  dismiss?: BannerDismiss | null;
  /** The page is /settings/billing itself: "View billing" would point at the page already open. */
  hideBillingLink?: boolean;
}) {
  const pay = usePayPaymentDue();
  const portal = useBillingPortal();
  const router = useGuardedRouter();
  const [tick, setTick] = React.useState(0);
  // the card reminder prints a date: in the business's own zone, never the browser's (UTC if the zone cannot be read)
  const tz = useTenantTimeZoneQuery(mode === "card-reminder");
  // Failed renewal: the strip's own rule. Payment due: an operator may hide it for the day (it is not theirs to
  // pay); an admin cannot until it is paid. The key carries the period so a new month's invoice shows again.
  const effectiveDismiss: BannerDismiss | null =
    mode === "failed-renewal"
      ? (dismiss ?? null)
      : mode === "card-reminder"
        ? cardReminderDismiss(due, role)
        : role !== "admin" && due
          ? { scope: "day", key: `payment-due:${due.periodStart ?? "now"}` }
          : null;
  const dismissKey = effectiveDismiss?.key;
  const dismissed = React.useMemo(
    () => (effectiveDismiss ? isBannerDismissed(effectiveDismiss) : false),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the dismissal's identity + our own tick
    [dismissKey, tick],
  );

  const zone = tz.zone ?? (tz.isError ? "UTC" : null);
  const copy =
    mode === "failed-renewal"
      ? failedRenewalCopy(role)
      : mode === "card-reminder"
        ? zone
          ? cardReminderCopy(due, role, zone)
          : null
        : paymentDueCopy(due, role);
  if (!copy || dismissed) return null;
  const canDismiss = !!effectiveDismiss;

  const HIT = "min-h-[44px] min-w-[44px]";
  const primary = copy.primary;
  return (
    <div
      data-testid={mode === "card-reminder" ? "card-reminder-banner" : "payment-due-banner"}
      data-state={copy.kind}
      role="status"
      className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 bg-amber-50 px-3 py-1.5 text-[13px] text-amber-900 ring-1 ring-amber-200 md:min-h-9 md:px-4 md:text-sm"
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0 self-start" aria-hidden="true" />
      <div className="min-w-0 flex-1 basis-[12rem] space-y-0.5">
        <p className="break-words font-medium">{copy.title}</p>
        <p className="break-words">{copy.body}</p>
        {copy.note && <p className="break-words">{copy.note}</p>}
      </div>
      <div className="flex w-full items-center gap-2 sm:w-auto">
        {primary && (
          <Button
            size="sm"
            variant="secondary"
            className={cn(HIT, "min-w-0 flex-1 sm:flex-none")}
            loading={primary.intent === "pay" ? pay.isPending : portal.isPending}
            onClick={() =>
              primary.intent === "pay" ? pay.mutate() : portal.mutate({ intent: "update-payment" })
            }
          >
            {primary.label}
          </Button>
        )}
        {!hideBillingLink && (
          <a
            href={copy.secondary.href}
            onClick={(e) => {
              e.preventDefault();
              router.push(copy.secondary.href); // guarded: never drops an open cart silently
            }}
            className={cn(
              HIT,
              "inline-flex min-w-0 flex-1 items-center justify-center rounded-ctl border border-line-strong bg-paper px-3 text-[13px] font-medium text-navy sm:flex-none",
            )}
          >
            {copy.secondary.label}
          </a>
        )}
        {canDismiss && (
          <button
            type="button"
            aria-label="Dismiss"
            className={cn(
              HIT,
              "inline-flex shrink-0 items-center justify-center rounded hover:bg-black/5",
            )}
            onClick={() => {
              dismissBanner(effectiveDismiss!);
              setTick((n) => n + 1);
            }}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
