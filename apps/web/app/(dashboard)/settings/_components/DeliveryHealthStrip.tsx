"use client";

import Link from "next/link";
import { cn } from "@routeflow/ui/web";
import { useDeliveryHealth } from "@/lib/api/messaging";
import { deliveryFixTarget, describeDeliveryOutcome } from "@/lib/reason-copy";

/**
 * Trailing-N-day email delivery health (#1965 / spec 08-C). Renders nothing until the delivery
 * endpoint exists. Reason codes are mapped to a counted sentence + a fix link — the raw code or any
 * provider text is never shown. Failures get a warning surface; the fix link is admin-only.
 */
export function DeliveryHealthStrip({ isAdmin }: { isAdmin: boolean }) {
  const { data } = useDeliveryHealth();
  // A missing or malformed payload (e.g. an older API) renders nothing rather than crashing the page.
  if (
    !data ||
    [data.windowDays, data.sent, data.failed, data.skipped].some((n) => typeof n !== "number") ||
    !Array.isArray(data.byReason)
  )
    return null;

  const warn = data.failed > 0;
  return (
    <section
      aria-label={`Email delivery, last ${data.windowDays} days`}
      className={cn(
        "rounded-lg border p-3",
        warn ? "border-amber-300 bg-amber-50" : "border-surface-border bg-surface-raised/40",
      )}
    >
      <p className="text-sm font-medium text-navy">
        <span>{`Last ${data.windowDays} days: ${data.sent} sent · `}</span>
        <span className={warn ? "font-semibold text-danger" : undefined}>
          {`${data.failed} failed`}
        </span>
        <span>{` · ${data.skipped} skipped`}</span>
      </p>
      {data.byReason.length > 0 && (
        <ul className="mt-2 space-y-1">
          {data.byReason.map((r) => {
            const fix = isAdmin ? deliveryFixTarget(r.fixLink) : null;
            return (
              <li key={r.reasonCode} className="text-xs text-navy/70">
                {describeDeliveryOutcome(r.reasonCode, r.count)}{" "}
                {fix && (
                  <Link href={fix.href} className="font-medium text-brand-700 hover:underline">
                    {`${fix.label} →`}
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
