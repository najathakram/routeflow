import * as React from "react";
import Link from "next/link";
import { orderRevisionLogHref, overpaidText, revisedBadgeText } from "@/lib/invoice-revision";
import { useTenantTimeZone } from "@/lib/tenant-timezone";

const BADGE =
  "inline-flex items-center rounded-full bg-warning-bg px-2 py-0.5 text-xs font-medium text-navy ring-1 ring-black/5";

/** P-4: "Revised {date}" badge and "Overpaid by $X" line. Both come from optional API fields; absent = nothing renders. */
export function InvoiceRevisionMarks({
  revisedAt,
  overpaidBy,
  timeZone,
  logHref,
}: {
  revisedAt?: string | null;
  overpaidBy?: number | null;
  /** The business's IANA zone; the revised day is read in it, not in the browser's zone. */
  timeZone?: string;
  /** Row 330d: where the badge goes (the order's edit log). Absent = a plain label. */
  logHref?: string | null;
}) {
  const revised = revisedBadgeText(revisedAt, timeZone);
  const overpaid = overpaidText(overpaidBy);
  if (!revised && !overpaid) return null;
  return (
    <>
      {revised &&
        (logHref ? (
          <Link
            href={logHref}
            data-testid="invoice-revised-badge"
            title="See what changed on the order"
            className={`${BADGE} underline-offset-2 hover:underline max-sm:min-h-11`}
          >
            {revised}
          </Link>
        ) : (
          <span data-testid="invoice-revised-badge" className={BADGE}>
            {revised}
          </span>
        ))}
      {overpaid && (
        <span
          data-testid="invoice-overpaid"
          className="inline-flex items-center rounded-full bg-warning-bg px-2 py-0.5 text-xs font-medium text-navy ring-1 ring-black/5"
        >
          {overpaid}
        </span>
      )}
    </>
  );
}

/** Staff screens: the same marks, with the revised day read in the tenant's zone (GET /settings `timezone`). */
export function TenantInvoiceRevisionMarks({
  orderId,
  ...props
}: Omit<React.ComponentProps<typeof InvoiceRevisionMarks>, "timeZone" | "logHref"> & {
  /** The invoice's order: the "Revised" badge links to its edit log (row 330d). */
  orderId?: string | null;
}) {
  const timeZone = useTenantTimeZone();
  return (
    <InvoiceRevisionMarks {...props} timeZone={timeZone} logHref={orderRevisionLogHref(orderId)} />
  );
}
