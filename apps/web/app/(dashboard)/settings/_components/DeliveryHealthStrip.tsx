"use client";

import Link from "next/link";
import { useDeliveryHealth } from "@/lib/api/messaging";
import { deliveryFixTarget, describeDeliveryReason } from "@/lib/reason-copy";

/**
 * Trailing-7-day email delivery health (#1965 / spec 08-C). Renders nothing until the delivery
 * endpoint exists. Reason codes are mapped to sentences + a fix link — the raw code or any provider
 * text is never shown.
 */
export function DeliveryHealthStrip() {
  const { data } = useDeliveryHealth();
  // A missing or malformed payload (e.g. an older API) renders nothing rather than crashing the page.
  if (
    !data ||
    [data.windowDays, data.sent, data.failed, data.skipped].some((n) => typeof n !== "number") ||
    !Array.isArray(data.byReason)
  )
    return null;

  return (
    <section
      aria-label={`Email delivery, last ${data.windowDays} days`}
      className="rounded-lg border border-surface-border bg-surface-raised/40 p-3"
    >
      <p className="text-sm font-medium text-navy">
        {`Last ${data.windowDays} days: ${data.sent} sent · ${data.failed} failed · ${data.skipped} skipped`}
      </p>
      {data.byReason.length > 0 && (
        <ul className="mt-2 space-y-1">
          {data.byReason.map((r) => {
            const fix = deliveryFixTarget(r.fixLink);
            return (
              <li key={r.reasonCode} className="text-xs text-navy/70">
                {describeDeliveryReason(r.reasonCode)} ({r.count}){" "}
                {fix && (
                  <Link href={fix.href} className="font-medium text-brand-700 hover:underline">
                    {fix.label}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
